# -*- coding: utf-8 -*-
"""群聊调度引擎：群管理员编排模式（复刻智谱清言真实示例）。

核心流程：用户发消息 → 群管理员分解任务 + @指派成员 → 被指派成员发言
→ 管理员评估再协调 → … → 管理员发 [DONE] 总结 → 空闲。
用户随时可插话，管理员把反馈转化为新指令转发。

消息统一为带类型条目：{i, type, sender, content}
  type ∈ user / ai / notice / summary

线程模型：HTTP 每请求一线程，engine 用 Lock 保护状态；
worker 后台线程跑编排循环，stop_event 可打断，gen 代际防陈旧。
"""
import datetime
import json
import queue
import random
import re
import threading
import time

from llm_api import (MAX_MEMBERS, LLMError, build_transcript, chat,
                     config_path, get_active_provider_config, history_dir,
                     load_config, members_path, save_config)
from presets import DEFAULT_GROUP_NAME, PRESET_GROUPS, get_group
from search import format_results, web_search

STATE_IDLE = "idle"
STATE_RUNNING = "running"

ADMIN_NAME = "群管理员"
ADMIN_COLOR = "#B8860B"

ADMIN_PERSONA = (
    "你是群聊的「群管理员」，角色是项目经理。你的职责：\n"
    "1. 读取用户需求，将其分解为子任务，用 @成员名 指派给最合适的成员。"
    "每条指派必须附带详细的需求说明（不是泛泛讨论，是具体可执行的指令），"
    "可以同时指派多个成员。\n"
    "2. 成员交付后，评估成果，决定下一步：指派新成员、要求现有成员修改、"
    "或判断任务已完成。\n"
    "3. 用户插话时，把用户反馈转化为具体指令转发给相关成员。\n"
    "4. 任务完成后，发一条总结消息给用户（列出交付物、关键结论），"
    "并在消息开头标注 [DONE]。\n"
    "5. 你自己不做具体业务工作（不写攻略、不算账），只做分解、指派、协调、总结。\n\n"
    "回复格式：正常发言即可。指派时用 @成员名 开头。任务完成时第一行写 [DONE]。\n"
    "如需联网搜索实时信息，在回复中插入 [SEARCH: 关键词]，"
    "系统会自动搜索并把结果提供给你。"
)

CHAT_SYSTEM = (
    "你正在一个多人群聊中发言。群管理员会给你指派任务。\n"
    "发言要求：\n"
    "1. 严格按照群管理员的指派完成工作，输出你的成果。\n"
    "2. 可以引用、回应其他成员之前的发言内容。\n"
    "3. 言简意赅，内容详实，一般 100~500 字。\n"
    "4. 直接输出发言内容，不要输出你的名字前缀，不要输出任何多余说明。\n"
    "5. 如需产出文档（攻略、方案、报告等），用 ```md 或 ```html 代码块"
    "输出完整内容，代码块前一行注明文件名（如「## 文件：攻略.md」）。\n"
    "6. 如需联网搜索实时信息，在回复中插入 [SEARCH: 关键词]，"
    "系统会自动搜索并把结果提供给你。"
)

SUMMARY_SYSTEM = (
    "你是群聊主持人，负责把群聊讨论整理成会议纪要。"
    "输出结构化、简洁、可直接参考的内容。"
)


def strip_md(text):
    """去掉常见 Markdown 标记（前端自行渲染，这里供存档/纪要纯文本场景）。"""
    text = re.sub(r"```[a-zA-Z0-9_+\-]*", "", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    return text.strip()


def strip_name_prefix(text, name):
    """模型偶尔带名字前缀，剥掉。"""
    for pat in ("%s：", "%s:", "「%s」：", "「%s」:", "%s说："):
        prefix = pat % name
        if text.startswith(prefix):
            return text[len(prefix):].strip()
    return text


def parse_order(text, names):
    """解析主持人回复的名字列表，只保留合法成员名并去重。"""
    if not text:
        return []
    order = []
    for part in re.split(r"[、,，\s]+", text.strip()):
        part = part.strip("。.！!？?")
        if part in names and part not in order:
            order.append(part)
    return order


def parse_assignments(text, member_names):
    """从管理员回复中提取被 @指派的成员名（按出现顺序，去重）。

    匹配 @后面到空白/标点为止的文本，只保留合法成员名。
    """
    if not text:
        return []
    found = []
    for match in re.finditer(r"@([^\s：:,，、@]+)", text):
        name = match.group(1).strip()
        if name in member_names and name not in found:
            found.append(name)
    return found


def has_done_marker(text):
    """管理员回复是否含 [DONE] 标记。"""
    return bool(text and "[DONE]" in text.upper())


_FILE_BLOCK_RE = re.compile(
    r"(?:##\s*文件[：:]\s*(\S+)\s*\n)?```(md|html|csv)\n(.*?)```",
    re.S)

_SAFE_NAME_RE = re.compile(r"[^\w\u4e00-\u9fff\-_.]")


def extract_files(content, base_path):
    """从 LLM 回复中提取 md/html/csv 代码块，存为文件。

    返回 (clean_text, [file_info])。file_info = {id, name, ext, size}。
    文件存到 base_path 目录（由调用方确保存在）。
    """
    files = []
    if not content:
        return content, files

    def _replace(match):
        named = match.group(1)
        ext = match.group(2)
        body = match.group(3).strip()
        # 文件名：优先用 LLM 提供的，否则自动生成
        if named:
            name = _SAFE_NAME_RE.sub("", named)
            if not name.endswith("." + ext):
                name = name.rsplit(".", 1)[0] if "." in name else name
                name = name + "." + ext
        else:
            name = "output_%d.%s" % (len(files) + 1, ext)
        # 安全：文件名只允许字母/数字/中文/-_.，限长
        name = _SAFE_NAME_RE.sub("", name)[:60] or "output.%s" % ext
        file_id = name.rsplit(".", 1)[0]
        file_path = base_path / name
        try:
            file_path.write_text(body, encoding="utf-8")
        except OSError:
            return match.group(0)  # 存失败则保留原文
        files.append({
            "id": file_id, "name": name, "ext": ext,
            "size": len(body.encode("utf-8")),
        })
        return "📄 %s（已生成，见下方文件卡片）" % name

    clean = _FILE_BLOCK_RE.sub(_replace, content)
    return clean.strip(), files


class GroupEngine:

    def __init__(self, config=None):
        self.config = config or load_config()
        self.members = self._load_members()
        self.messages = []          # [{i,type,sender,content}]
        self.topic = ""
        self.summary = ""
        self.round = 0
        self.admin_turns = 0        # 编排模式：管理员发言次数（进度追踪）
        self.state = STATE_IDLE
        self.status = "就绪"
        self.gen = 0
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.worker = None
        self.session_file = None
        self._seq = 0
        self.user_msg_queue = queue.Queue()  # 用户插话队列

    # ---------- 消息条目 ----------

    def _add(self, mtype, sender, content, files=None):
        with self.lock:
            self._seq += 1
            entry = {"i": self._seq, "type": mtype, "sender": sender,
                     "content": content}
            if files:
                entry["files"] = files
            self.messages.append(entry)
            return entry

    def _add_locked(self, mtype, sender, content):
        """调用方已持锁时用。"""
        self._seq += 1
        entry = {"i": self._seq, "type": mtype, "sender": sender,
                 "content": content}
        self.messages.append(entry)
        return entry

    def get_state(self, since=0):
        with self.lock:
            new_msgs = [m for m in self.messages if m["i"] > since]
            return {
                "state": self.state,
                "status": self.status,
                "topic": self.topic,
                "round": self.round,
                "admin_turns": self.admin_turns,
                "max_rounds": int(self.config.get("max_rounds", 15)),
                "members": list(self.members),
                "messages": new_msgs,
                "last_i": self._seq,
                "summary": self.summary,
            }

    # ---------- 成员 ----------

    def _load_members(self):
        path = members_path()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                members = [m for m in data.get("members", [])
                           if isinstance(m, dict) and m.get("name")]
                if members:
                    return members
            except (OSError, ValueError):
                pass
        members = get_group(DEFAULT_GROUP_NAME)
        self._save_members(members)
        return members

    def _save_members(self, members=None):
        members = self.members if members is None else members
        try:
            members_path().write_text(
                json.dumps({"members": members}, ensure_ascii=False, indent=2),
                encoding="utf-8")
        except OSError:
            pass

    def add_member(self, name, persona, color):
        with self.lock:
            if not name or not name.strip():
                return False, "名字不能为空"
            name = name.strip()
            if len(self.members) >= MAX_MEMBERS:
                return False, "成员最多 %d 个" % MAX_MEMBERS
            if any(m["name"] == name for m in self.members):
                return False, "已有同名成员"
            self.members.append({"name": name, "persona": persona,
                                 "color": color or "#2471A3"})
            self._save_members()
            return True, None

    def edit_member(self, old_name, name, persona, color):
        with self.lock:
            name = (name or "").strip()
            if not name:
                return False, "名字不能为空"
            if any(m["name"] == name for m in self.members if m["name"] != old_name):
                return False, "已有同名成员"
            for m in self.members:
                if m["name"] == old_name:
                    m["name"] = name
                    m["persona"] = persona
                    m["color"] = color or "#2471A3"
                    break
            self._save_members()
            return True, None

    def remove_member(self, name):
        with self.lock:
            self.members = [m for m in self.members if m["name"] != name]
            self._save_members()
            return True, None

    def apply_preset(self, group_name):
        members = get_group(group_name)
        if not members:
            return False, "未知预设组"
        with self.lock:
            self.members = members
            self._save_members()
            return True, None

    # ---------- 发送 / 编排 ----------

    def send(self, text):
        """用户发消息。空闲时启动编排；运行中作为插话入队。"""
        text = (text or "").strip()
        if not text:
            return False, "消息不能为空"
        with self.lock:
            if not self.members:
                return False, "群里还没有成员"
            if self.state == STATE_RUNNING:
                # 编排中：消息上屏 + 入队，worker 在下一步读取
                self._add_locked("user", "用户", text)
                self.user_msg_queue.put(text)
                return True, None
            # 空闲：启动编排
            if not self.topic:
                self.topic = text
            self._add_locked("user", "用户", text)
            self.gen += 1
            self.stop_event.clear()
            self.state = STATE_RUNNING
            self.status = "群管理员正在分析…"
            gen = self.gen
        self.worker = threading.Thread(target=self._orchestrate_worker,
                                       args=(gen,), daemon=True)
        self.worker.start()
        return True, None

    def _orchestrate_worker(self, gen):
        """群管理员编排循环：管理员分解→@指派→成员发言→管理员再协调→[DONE]。"""
        cfg = get_active_provider_config(self.config)
        max_rounds = int(self.config.get("max_rounds", 15))
        no_assignment_count = 0
        with self.lock:
            self.admin_turns = 0

        while not self.stop_event.is_set():
            if self._stale(gen):
                return

            # ---- 管理员发言 ----
            with self.lock:
                if self.gen != gen:
                    return
                members = [dict(m) for m in self.members]
                topic = self.topic
                messages = [m for m in self.messages
                            if m["type"] in ("user", "ai")]
            member_names = [m["name"] for m in members]
            names_line = "\n".join("· %s：%s" % (m["name"],
                                                 m["persona"][:60])
                                   for m in members)
            transcript_msgs = [(m["sender"], m["content"]) for m in messages]
            admin_user = ("群主题：%s\n\n群成员名单：\n%s\n\n聊天记录：\n%s\n\n"
                          "请根据用户需求和当前进展，决定下一步行动："
                          "分解任务并 @指派成员，或判断任务已完成并发 [DONE] 总结。"
                          % (topic or "（未设定）", names_line,
                             build_transcript(transcript_msgs,
                                              cfg.get("history_limit", 0))))
            self._set_status(gen, "群管理员正在分析…")
            admin_reply = self._call_with_retry(
                cfg, ADMIN_PERSONA, admin_user, gen, ADMIN_NAME)
            if admin_reply is None:
                return  # 被停止或陈旧

            # 剥掉 [DONE] 标记后上屏
            is_done = has_done_marker(admin_reply)
            clean_reply = admin_reply.replace("[DONE]", "").replace(
                "[done]", "").strip()
            if clean_reply:
                self._add("ai", ADMIN_NAME, clean_reply)

            if is_done:
                self._on_done(gen)
                return

            admin_turns = self.admin_turns + 1
            with self.lock:
                self.admin_turns = admin_turns
            if admin_turns >= max_rounds:
                self._add("notice", "", "已达最大协调次数，强制结束。")
                self._on_done(gen)
                return

            # ---- 解析 @指派 ----
            assigned = parse_assignments(admin_reply, member_names)
            if not assigned:
                no_assignment_count += 1
                if no_assignment_count >= 2:
                    self._add("notice", "",
                              "群管理员未指派成员，讨论结束。")
                    self._on_done(gen)
                    return
                # 管理员可能只是协调一下，继续循环让它再发言
                continue
            no_assignment_count = 0

            # ---- 被指派成员依次发言 ----
            by_name = {m["name"]: m for m in members}
            for name in assigned:
                if self.stop_event.is_set():
                    self._finish_stopped(gen)
                    return
                if self._stale(gen):
                    return
                # 成员间思考停顿
                for _ in range(6):
                    if self.stop_event.is_set():
                        break
                    time.sleep(0.1)
                if self.stop_event.is_set():
                    self._finish_stopped(gen)
                    return
                self._set_status(gen, "「%s」正在发言…" % name)
                member = by_name[name]
                system = ("你正在一个多人群聊中发言，你的身份是「%s」。"
                          "人设与专长：%s\n%s"
                          % (name, member.get("persona") or "", CHAT_SYSTEM))
                # 成员看到完整聊天记录 + 管理员最新指派
                with self.lock:
                    if self.gen != gen:
                        return
                    transcript_msgs = [(m["sender"], m["content"])
                                       for m in self.messages
                                       if m["type"] in ("user", "ai")]
                member_user = ("群主题：%s\n\n聊天记录：\n%s\n\n"
                               "群管理员刚才指派了你（%s）。请完成指派的任务并输"
                               "出你的成果。"
                               % (topic or "（未设定）",
                                  build_transcript(transcript_msgs,
                                                   cfg.get("history_limit", 0)),
                                  name))
                content = self._call_with_retry(
                    cfg, system, member_user, gen, name)
                if content is None:
                    return  # 被停止或陈旧
                if content:
                    # 提取文件（md/html/csv 代码块）
                    files_dir = history_dir() / "files"
                    try:
                        files_dir.mkdir(parents=True, exist_ok=True)
                    except OSError:
                        files_dir = None
                    clean_content, files = (extract_files(content, files_dir)
                                            if files_dir else (content, []))
                    self._add("ai", name, clean_content,
                              files=files if files else None)
                else:
                    self._add("notice", "",
                              "「%s」发言失败，已跳过。" % name)

            # 循环回到管理员，评估成果并决定下一步

    def _call_with_retry(self, cfg, system, user, gen, name):
        """调用 LLM 并重试。支持 [SEARCH:] 拦截：检测到搜索标记→搜索→
        结果拼回 prompt→重新调用。成功返回 content，被停止/陈旧返回 None，
        失败返回空字符串。"""
        search_enabled = bool(self.config.get("search_enabled", True))
        max_search = 3
        current_user = user
        search_count = 0
        while True:
            if self.stop_event.is_set() or self._stale(gen):
                return None
            reply = None
            for attempt in range(max(1, int(cfg.get("max_retries", 2)))):
                if self.stop_event.is_set() or self._stale(gen):
                    return None
                try:
                    reply = chat(cfg, system, current_user)
                except LLMError as e:
                    if attempt == max(1, int(cfg.get("max_retries", 2))) - 1:
                        self._add("notice", "",
                                  "%s 调用失败：%s" % (name, e))
                        return ""
                    continue
                break  # 成功拿到 reply
            if reply is None:
                return ""
            reply = strip_name_prefix(reply or "", name)
            if not reply.strip():
                return ""
            # ---- 搜索拦截 ----
            if search_enabled and search_count < max_search:
                search_match = re.search(r"\[SEARCH:\s*(.+?)\]", reply, re.I)
                if search_match:
                    query = search_match.group(1).strip()
                    search_count += 1
                    self._set_status(gen, "%s 正在搜索：%s…" % (name, query))
                    results = web_search(
                        query,
                        max_results=int(
                            self.config.get("search_max_results", 5)))
                    search_text = format_results(results)
                    current_user = (
                        current_user + "\n\n---\n搜索「%s」结果：\n%s\n"
                        "---\n请基于以上搜索结果继续完成你的任务。"
                        % (query, search_text))
                    continue  # 重新调用（不消耗 max_retries）
            return reply.strip()

    def _on_done(self, gen):
        """管理员发 [DONE] 或强制结束：存档 + 自动纪要 + 回到空闲。"""
        with self.lock:
            if self.gen != gen:
                return
            self.round += 1
            self.state = STATE_RUNNING
            self.status = "正在生成纪要…"
        self._save_session()
        self._summary_worker(gen)

    def _finish_stopped(self, gen):
        with self.lock:
            if self.gen != gen:
                return
            self.state = STATE_IDLE
            self.status = "已停止"
        self._save_session()

    def _stale(self, gen):
        with self.lock:
            return self.gen != gen

    def _set_status(self, gen, text):
        with self.lock:
            if self.gen == gen:
                self.status = text

    def _finish_stopped(self, gen):
        with self.lock:
            if self.gen != gen:
                return
            self.state = STATE_IDLE
            self.status = "已停止"
        self._save_session()

    # ---------- 纪要 ----------

    def request_summary(self):
        with self.lock:
            if self.state == STATE_RUNNING:
                return False, "讨论进行中，请先停止"
            if not self.messages:
                return False, "没有可总结的讨论"
            self.gen += 1
            self.stop_event.clear()
            self.state = STATE_RUNNING
            self.status = "正在生成纪要…"
            gen = self.gen
        threading.Thread(target=self._summary_worker, args=(gen,),
                         daemon=True).start()
        return True, None

    def _summary_worker(self, gen):
        cfg = get_active_provider_config(self.config)
        with self.lock:
            if self.gen != gen:
                return
            topic = self.topic
            transcript_msgs = [(m["sender"], m["content"])
                               for m in self.messages
                               if m["type"] in ("user", "ai")]
        if self.stop_event.is_set():
            self._finish_stopped(gen)
            return
        user = ("群主题：%s\n\n聊天记录：\n%s\n\n请生成会议纪要，格式严格要求：\n"
                "【核心观点】提炼主要共识，最多3条\n"
                "【分歧与讨论】列出不同视角的碰撞，最多3条\n"
                "【下一步建议】给出行动清单，最多3条\n"
                "总字数不超过%d字。不要客套话，不要复述聊天记录。"
                % (topic or "（未设定）", build_transcript(transcript_msgs),
                   int(cfg.get("summary_max_chars", 400))))
        try:
            text = chat(cfg, SUMMARY_SYSTEM, user)
        except LLMError as e:
            with self.lock:
                if self.gen == gen:
                    self.state = STATE_IDLE
                    self.status = "纪要生成失败：%s" % e
            return
        with self.lock:
            if self.gen != gen:
                return
            self.summary = text.strip()
            self._add_locked("summary", "", text.strip())
            self.round = 0
            self.state = STATE_IDLE
            self.status = "纪要已生成，可继续讨论"
        self._save_session()

    def stop(self):
        if self.state == STATE_RUNNING:
            self.stop_event.set()
            with self.lock:
                self.status = "正在停止…"

    def edit_topic(self, topic):
        with self.lock:
            if topic and topic.strip():
                self.topic = topic.strip()

    # ---------- 存档 ----------

    def _session_data(self):
        return {
            "topic": self.topic,
            "members": list(self.members),
            "messages": list(self.messages),
            "rounds": self.round,
            "admin_turns": self.admin_turns,
            "summary": self.summary,
            "updated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

    def _save_session(self):
        if not self.messages:
            return
        d = history_dir()
        try:
            d.mkdir(exist_ok=True)
            if self.session_file is None:
                self.session_file = d / (
                    datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")
            self.session_file.write_text(
                json.dumps(self._session_data(), ensure_ascii=False, indent=2),
                encoding="utf-8")
        except OSError:
            pass

    def list_history(self):
        d = history_dir()
        if not d.exists():
            return []
        out = []
        for f in sorted(d.glob("*.json"), reverse=True):
            title = f.stem
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                title = "%s  %s" % (f.stem, (data.get("topic") or "")[:24])
            except (OSError, ValueError):
                pass
            out.append({"name": f.stem, "path": str(f), "title": title})
        return out

    @staticmethod
    def _clean_legacy(sender, content):
        """历史会话兼容：剥掉旧数据中残留的 [DONE] 标记。"""
        if sender == ADMIN_NAME and content:
            return content.replace("[DONE]", "").replace(
                "[done]", "").strip()
        return content

    def open_history(self, name):
        d = history_dir()
        path = d / (name + ".json")
        if not path.exists():
            return False, "会话不存在"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            return False, "读取失败：%s" % e
        with self.lock:
            self.topic = data.get("topic") or ""
            self.summary = data.get("summary") or ""
            self.round = int(data.get("rounds") or 0)
            self.admin_turns = int(data.get("admin_turns") or 0)
            # 兼容旧格式 [sender, content] 和新格式 {i,type,sender,content}
            msgs = data.get("messages", [])
            self.messages = []
            self._seq = 0
            for m in msgs:
                if isinstance(m, list) and len(m) >= 2:
                    self._add_locked(
                        "user" if m[0] == "用户" else "ai", m[0],
                        self._clean_legacy(m[0], m[1]))
                elif isinstance(m, dict):
                    self._add_locked(m.get("type", "ai"),
                                     m.get("sender", ""),
                                     self._clean_legacy(m.get("sender", ""),
                                                        m.get("content", "")))
            file_members = [m for m in data.get("members", [])
                            if isinstance(m, dict) and m.get("name")]
            if file_members:
                self.members = file_members
                self._save_members()
            self.session_file = path
            self.state = STATE_IDLE
            self.status = "已载入历史会话，可继续讨论"
        return True, None

    def new_session(self):
        with self.lock:
            if self.state == STATE_RUNNING:
                return False, "讨论进行中，请先停止"
            self.messages = []
            self._seq = 0
            self.topic = ""
            self.summary = ""
            self.round = 0
            self.admin_turns = 0
            self.session_file = None
            self.state = STATE_IDLE
            self.status = "已清空"
        return True, None

    def _member_color(self, name):
        if name == ADMIN_NAME:
            return ADMIN_COLOR
        for m in self.members:
            if m.get("name") == name:
                return m.get("color") or "#888888"
        return "#888888"

    @staticmethod
    def _render_md_python(src):
        """Python 版零依赖 Markdown 渲染（移植前端 JS renderMD）。
        输出 HTML 片段，供 export_html 使用。"""
        if not src:
            return ""
        import html as _html
        lines = src.split("\n")
        out = []
        in_code = False
        in_list = False
        in_ol = False

        def inline(t):
            t = _html.escape(t)
            t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
            t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
            t = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", t)
            t = re.sub(
                r"\[([^\]]+)\]\(([^)]+)\)",
                r'<a href="\2" target="_blank">\1</a>', t)
            return t

        for line in lines:
            if line.startswith("```"):
                if in_code:
                    out.append("</code></pre>")
                    in_code = False
                else:
                    out.append("<pre><code>")
                    in_code = True
                continue
            if in_code:
                out.append(_html.escape(line))
                continue
            if re.match(r"^\s*#{1,3}\s", line):
                if in_list:
                    out.append("</ul>")
                    in_list = False
                if in_ol:
                    out.append("</ol>")
                    in_ol = False
                h = len(re.match(r"^#{1,3}", line).group(0))
                out.append("<h%d>%s</h%d>" % (
                    h, inline(re.sub(r"^\s*#{1,3}\s*", "", line)), h))
                continue
            if re.match(r"^\s*[-*]\s", line):
                if not in_list:
                    out.append("<ul>")
                    in_list = True
                out.append("<li>%s</li>" % inline(
                    re.sub(r"^\s*[-*]\s*", "", line)))
                continue
            if re.match(r"^\s*\d+\.\s", line):
                if not in_ol:
                    out.append("<ol>")
                    in_ol = True
                out.append("<li>%s</li>" % inline(
                    re.sub(r"^\s*\d+\.\s*", "", line)))
                continue
            if line.strip() == "":
                if in_list:
                    out.append("</ul>")
                    in_list = False
                if in_ol:
                    out.append("</ol>")
                    in_ol = False
                continue
            if in_list:
                out.append("</ul>")
                in_list = False
            if in_ol:
                out.append("</ol>")
                in_ol = False
            if line.startswith("> "):
                out.append("<blockquote>%s</blockquote>" % inline(
                    line[2:]))
                continue
            out.append("<p>%s</p>" % inline(line))
        if in_list:
            out.append("</ul>")
        if in_ol:
            out.append("</ol>")
        if in_code:
            out.append("</code></pre>")
        return "\n".join(out)

    def _format_files_md(self, files):
        """Markdown 格式的文件引用。"""
        parts = []
        for f in files:
            parts.append("[%s](/api/files/%s)" % (f["name"], f["id"]))
        return "📎 产出文件：" + " · ".join(parts)

    def _format_files_html(self, files):
        """HTML 格式的文件卡片。"""
        import html as _html
        cards = []
        for f in files:
            icon = {"html": "&#127760;", "csv": "&#128202;",
                    "md": "&#128196;"}.get(f["ext"], "&#128196;")
            size_kb = round(f["size"] / 1024 * 10) / 10
            cards.append(
                '<div style="border:1px solid #e0e0e0;border-radius:8px;'
                'padding:8px 12px;display:inline-flex;align-items:center;'
                'gap:8px;margin:4px 4px 0 0;background:#f7f7f8">'
                '<span style="font-size:20px">%s</span>'
                '<div><div style="font-size:13px;font-weight:600">%s</div>'
                '<div style="font-size:11px;color:#8a8a8a">%sKB</div></div>'
                '<a href="/api/files/%s" download style="font-size:12px;'
                'padding:3px 8px;border:1px solid #e0e0e0;border-radius:5px;'
                'text-decoration:none;color:#333">下载</a>'
                '<a href="/api/files/%s/preview" target="_blank" '
                'style="font-size:12px;padding:3px 8px;border:1px solid '
                '#e0e0e0;border-radius:5px;text-decoration:none;'
                'color:#333">预览</a></div>'
                % (icon, _html.escape(f["name"]), size_kb,
                   f["id"], f["id"]))
        return "".join(cards)

    def export_markdown(self):
        if not self.messages:
            return ""
        import html as _html
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        lines = ["# 群聊：%s" % (self.topic or "(未设定)"), "",
                 "> 导出时间：%s" % ts, "",
                 "## 群成员", ""]
        for m in self.members:
            lines.append("- **%s**：%s" % (
                m["name"], (m.get("persona") or "")[:80]))
        lines += ["", "---", ""]
        for m in self.messages:
            files = m.get("files") or []
            if m["type"] == "summary":
                lines += ["---", "", "## 会议纪要", "",
                          m["content"].strip(), ""]
                continue
            if m["type"] == "notice":
                lines.append("> %s" % m["content"].strip())
                lines.append("")
                continue
            if m["type"] == "user":
                lines.append("**%s**" % m["sender"])
            else:
                role = " (管理员)" if m["sender"] == ADMIN_NAME else ""
                lines.append("**%s%s**" % (m["sender"], role))
            lines.append("")
            lines.append(m["content"].strip())
            if files:
                lines.append("")
                lines.append(self._format_files_md(files))
            lines.append("")
        return "\n".join(lines)

    def export_html(self):
        if not self.messages:
            return ""
        import html as _html
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        # 成员列表
        member_items = "".join(
            '<div style="display:flex;align-items:center;gap:6px;'
            'padding:4px 0"><div style="width:12px;height:12px;'
            'border-radius:50%%;background:%s"></div>'
            '<span style="font-size:14px;font-weight:600">%s</span>'
            '<span style="font-size:12px;color:#8a8a8a">%s</span></div>'
            % (m.get("color") or "#888", _html.escape(m["name"]),
               _html.escape((m.get("persona") or "")[:60]))
            for m in self.members)
        # 消息列表
        msg_html = []
        for m in self.messages:
            files = m.get("files") or []
            if m["type"] == "summary":
                msg_html.append(
                    '<div style="border:1px solid #e0e0e0;border-radius:12px;'
                    'padding:14px 16px;margin:16px 0;background:#fff">'
                    '<div style="font-weight:700;color:#4d6bfe;margin-bottom:6px;'
                    'text-align:center">会议纪要</div>'
                    '<div style="font-size:14px;line-height:1.8">%s</div>'
                    '</div>' % self._render_md_python(m["content"]))
                continue
            if m["type"] == "notice":
                msg_html.append(
                    '<div style="color:#8a8a8a;font-size:13px;text-align:center;'
                    'margin:8px 0;font-style:italic">%s</div>'
                    % _html.escape(m["content"]))
                continue
            if m["type"] == "user":
                msg_html.append(
                    '<div style="display:flex;justify-content:flex-end;'
                    'margin-bottom:14px"><div style="background:#4d6bfe;'
                    'color:#fff;padding:9px 15px;border-radius:16px;'
                    'max-width:70%%;word-wrap:break-word">%s</div></div>'
                    % _html.escape(m["content"]))
                continue
            # AI 消息
            color = self._member_color(m["sender"])
            name = _html.escape(m["sender"])
            if m["sender"] == ADMIN_NAME:
                tag = (' <span style="font-size:11px;background:#B8860B;'
                       'color:#fff;padding:1px 6px;border-radius:4px;'
                       'margin-left:4px">管理员</span>')
            else:
                tag = ""
            body = self._render_md_python(m["content"])
            files_html = self._format_files_html(files) if files else ""
            msg_html.append(
                '<div style="margin-bottom:14px;max-width:80%%">'
                '<div style="font-weight:700;font-size:13px;margin-bottom:2px;'
                'color:%s">%s%s</div>'
                '<div style="font-size:15px;line-height:1.75;'
                'word-wrap:break-word">%s</div>%s</div>'
                % (color, name, tag, body, files_html))
        # 末尾模板用拼接而非 % 格式化，避免消息内容里的 % 干扰
        topic_esc = _html.escape(self.topic or "(未设定)")
        return (
            '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
            '<meta charset="UTF-8">\n'
            '<meta name="viewport" content="width=device-width,'
            'initial-scale=1.0">\n'
            '<title>群聊：' + topic_esc + '</title>\n</head>\n'
            '<body style="font-family:-apple-system,BlinkMacSystemFont,'
            "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;"
            'background:#f7f7f8;color:#1a1a1a;font-size:15px;'
            'line-height:1.7;margin:0;padding:0">\n'
            '<div style="max-width:820px;margin:0 auto;padding:20px">\n'
            '<h1 style="font-size:20px;margin-bottom:8px">' + topic_esc + '</h1>\n'
            '<div style="color:#8a8a8a;font-size:13px;margin-bottom:16px">'
            '导出时间：' + ts + '</div>\n'
            '<div style="background:#fff;border:1px solid #e5e5e8;'
            'border-radius:12px;padding:12px 16px;margin-bottom:20px">'
            '<div style="font-weight:700;font-size:14px;margin-bottom:8px">'
            '群成员</div>' + member_items + '</div>\n'
            '<div style="background:#fff;border:1px solid #e5e5e8;'
            'border-radius:12px;padding:16px 20px">\n' +
            "\n".join(msg_html) + '\n</div>\n'
            '<div style="text-align:center;color:#8a8a8a;font-size:12px;'
            'margin-top:20px">由 AI 群聊生成 · ' + ts + '</div>\n'
            '</div>\n</body>\n</html>'
        )

    def get_config(self):
        cfg = dict(self.config)
        cfg.pop("_说明", None)
        return cfg

    def update_config(self, new_cfg):
        merged = dict(self.config)
        for k in ("temperature", "max_tokens", "timeout", "max_retries",
                  "max_rounds", "history_limit", "summary_max_chars", "port"):
            if k in new_cfg:
                try:
                    merged[k] = (float(new_cfg[k]) if k == "temperature"
                                 else int(new_cfg[k]))
                except (ValueError, TypeError):
                    pass
        if "order_by_llm" in new_cfg:
            merged["order_by_llm"] = bool(new_cfg["order_by_llm"])
        if "search_enabled" in new_cfg:
            merged["search_enabled"] = bool(new_cfg["search_enabled"])
        if "search_max_results" in new_cfg:
            try:
                merged["search_max_results"] = int(new_cfg["search_max_results"])
            except (ValueError, TypeError):
                pass
        if "auto_open_browser" in new_cfg:
            merged["auto_open_browser"] = bool(new_cfg["auto_open_browser"])
        if "active_provider" in new_cfg:
            merged["active_provider"] = str(new_cfg["active_provider"])
        if "custom_providers" in new_cfg and isinstance(
                new_cfg["custom_providers"], list):
            merged["custom_providers"] = new_cfg["custom_providers"]
        if "provider_settings" in new_cfg and isinstance(
                new_cfg["provider_settings"], dict):
            merged["provider_settings"] = new_cfg["provider_settings"]
        try:
            save_config(config_path(), merged)
        except OSError:
            return False, "保存失败"
        self.config = merged
        return True, None
