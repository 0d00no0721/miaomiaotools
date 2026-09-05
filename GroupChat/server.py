# -*- coding: utf-8 -*-
"""AI 群聊本地后台服务：标准库 ThreadingHTTPServer + JSON API + 静态托管 web/。

启动：python server.py   （默认 http://127.0.0.1:8765，自动开浏览器）
不引入 Flask/FastAPI；前端单文件由本服务同源托管，无 CORS 问题。
"""
import json
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

from engine import GroupEngine
from llm_api import (LLMError, config_path, discover_models, load_config,
                     validate_api_key)
from presets import PRESET_GROUPS
from providers import PROVIDER_PRESETS, get_preset, validate_provider

WEB_DIR = Path(__file__).resolve().parent / "web"


def _web_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent / "web"
    return Path(__file__).resolve().parent / "web"


class Handler(BaseHTTPRequestHandler):

    engine = None  # set on class before serving

    def log_message(self, fmt, *args):
        pass  # 静默（或改为 print 到控制台）

    # ---------- 工具 ----------

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text, status=200, ctype="text/plain; charset=utf-8",
                   extra=None):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {}

    def _safe_path(self, rel):
        """防止路径穿越：把 rel 限定在 WEB_DIR 内。"""
        base = _web_dir().resolve()
        target = (base / rel).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            return None
        return target

    # ---------- 路由 ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        eng = self.engine

        if path == "/" or path == "/index.html":
            target = _web_dir() / "index.html"
            if target.exists():
                self._send_text(target.read_text(encoding="utf-8"),
                                ctype="text/html; charset=utf-8")
            else:
                self._send_text("web/index.html 不存在", status=404)
            return

        if path.startswith("/api/"):
            # 文件下载/预览（非 JSON API）
            if path.startswith("/api/files/"):
                self._route_files(path)
                return
            self._route_api_get(path, qs)
            return

        # 静态文件
        target = self._safe_path(path.lstrip("/"))
        if target and target.exists() and target.is_file():
            ctype = self._guess_ctype(target.name)
            self._send_text(target.read_text(encoding="utf-8")
                            if ctype.startswith("text")
                            else target.read_bytes(),
                            ctype=ctype)
        else:
            self._send_text("Not Found", status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        eng = self.engine
        body = self._read_body()

        if path == "/api/send":
            ok, err = eng.send(body.get("text", ""))
            self._send_json({"ok": ok, "error": err})
            return
        if path == "/api/stop":
            eng.stop()
            self._send_json({"ok": True})
            return
        if path == "/api/summary":
            ok, err = eng.request_summary()
            self._send_json({"ok": ok, "error": err})
            return
        if path == "/api/topic":
            eng.edit_topic(body.get("topic", ""))
            self._send_json({"ok": True})
            return
        if path == "/api/members":
            self._route_members_post(body)
            return
        if path == "/api/providers":
            self._route_providers_post(body)
            return
        if path == "/api/config":
            ok, err = eng.update_config(body)
            self._send_json({"ok": ok, "error": err})
            return
        if path == "/api/history/open":
            ok, err = eng.open_history(body.get("name", ""))
            self._send_json({"ok": ok, "error": err})
            return
        if path == "/api/history/new":
            ok, err = eng.new_session()
            self._send_json({"ok": ok, "error": err})
            return

        self._send_json({"error": "unknown"}, status=404)

    def _route_api_get(self, path, qs):
        eng = self.engine
        if path == "/api/state":
            since = int(qs.get("since", ["0"])[0] or 0)
            self._send_json(eng.get_state(since))
            return
        if path == "/api/presets":
            self._send_json({"groups": [g["name"] for g in PRESET_GROUPS]})
            return
        if path == "/api/providers":
            self._send_json(self._providers_payload())
            return
        if path == "/api/config":
            self._send_json(eng.get_config())
            return
        if path == "/api/history":
            self._send_json({"items": eng.list_history()})
            return
        if path == "/api/export":
            fmt = qs.get("format", ["md"])[0] or "md"
            if fmt == "html":
                html = eng.export_html()
                if not html:
                    self._send_json({"error": "no content"}, status=400)
                    return
                self._send_text(
                    html, ctype="text/html; charset=utf-8",
                    extra={"Content-Disposition":
                           "attachment; filename*=UTF-8''"
                           + quote("群聊.html")})
                return
            md = eng.export_markdown()
            if not md:
                self._send_json({"error": "no content"}, status=400)
                return
            self._send_text(
                md, ctype="text/markdown; charset=utf-8",
                extra={"Content-Disposition":
                       "attachment; filename*=UTF-8''"
                       + quote("群聊.md")})
            return
        self._send_json({"error": "unknown"}, status=404)

    def _route_members_post(self, body):
        eng = self.engine
        action = body.get("action", "")
        if action == "add":
            ok, err = eng.add_member(body.get("name", ""),
                                     body.get("persona", ""),
                                     body.get("color", ""))
        elif action == "edit":
            ok, err = eng.edit_member(body.get("old_name", ""),
                                      body.get("name", ""),
                                      body.get("persona", ""),
                                      body.get("color", ""))
        elif action == "delete":
            ok, err = eng.remove_member(body.get("name", ""))
        elif action == "preset":
            ok, err = eng.apply_preset(body.get("group", ""))
        else:
            self._send_json({"ok": False, "error": "未知操作"}, status=400)
            return
        self._send_json({"ok": ok, "error": err})

    def _route_files(self, path):
        """文件下载与预览：/api/files/{id} 和 /api/files/{id}/preview"""
        from llm_api import history_dir as _hd
        parts = path.split("/")
        if len(parts) < 4 or not parts[3]:
            self._send_text("Not Found", status=404)
            return
        file_id = parts[3]
        is_preview = len(parts) >= 5 and parts[4] == "preview"
        files_dir = _hd() / "files"
        target = None
        if files_dir.exists():
            for f in files_dir.iterdir():
                if f.is_file() and f.stem == file_id:
                    target = f
                    break
        if not target:
            self._send_text("File Not Found", status=404)
            return
        content = target.read_text(encoding="utf-8")
        ext = target.suffix.lstrip(".")
        if is_preview:
            if ext == "html":
                self._send_text(content, ctype="text/html; charset=utf-8")
            else:
                self._send_text(content,
                                ctype="text/plain; charset=utf-8")
        else:
            self._send_text(
                content,
                ctype=self._guess_ctype(target.name),
                extra={"Content-Disposition":
                       'attachment; filename="%s"' % target.name})

    @staticmethod
    def _mask_key(key):
        key = (key or "").strip()
        if not key:
            return ""
        if len(key) <= 8:
            return "***"
        return key[:4] + "***" + key[-4:]

    def _providers_payload(self):
        """预设目录 + custom_providers + active + 各供应商参数（key 打码）。"""
        eng = self.engine
        cfg = eng.get_config()
        settings = cfg.get("provider_settings") or {}
        items = []
        for p in PROVIDER_PRESETS:
            s = settings.get(p["id"]) or {}
            items.append({
                "id": p["id"], "name": p["name"],
                "base_url": s.get("base_url") or p["base_url"],
                "api": p["api"], "models": p.get("models") or [],
                "key_url": p.get("key_url") or "",
                "key_masked": self._mask_key(s.get("api_key")),
                "model": s.get("model") or "",
                "editable": False, "preset": True,
            })
        for c in cfg.get("custom_providers") or []:
            s = settings.get(c["id"]) or {}
            items.append({
                "id": c["id"], "name": c.get("name") or c["id"],
                "base_url": s.get("base_url") or c.get("base_url") or "",
                "api": c.get("api") or "openai", "models": [],
                "key_url": "",
                "key_masked": self._mask_key(s.get("api_key")),
                "model": s.get("model") or "",
                "editable": True, "preset": False,
            })
        return {"items": items, "active": cfg.get("active_provider")}

    def _route_providers_post(self, body):
        eng = self.engine
        action = body.get("action", "")
        cfg = eng.get_config()
        settings = dict(cfg.get("provider_settings") or {})
        customs = list(cfg.get("custom_providers") or [])

        if action == "activate":
            pid = body.get("id", "")
            if not get_preset(pid) and not any(
                    c["id"] == pid for c in customs):
                self._send_json({"ok": False, "error": "未知供应商"}, status=400)
                return
            ok, err = eng.update_config({"active_provider": pid})
            self._send_json({"ok": ok, "error": err})
            return

        if action == "save":
            pid = (body.get("id") or "").strip()
            base_url = (body.get("base_url") or "").strip()
            api = body.get("api") or (get_preset(pid) or {}).get("api") \
                or "openai"
            name = body.get("name")
            ok, err = validate_provider(pid, base_url, api, name
                                        if body.get("name") is not None
                                        else None, customs)
            if not ok:
                self._send_json({"ok": False, "error": err}, status=400)
                return
            is_preset = get_preset(pid) is not None
            if not is_preset:
                entry = {"id": pid, "name": (name or pid).strip(),
                         "base_url": base_url, "api": api}
                for i, c in enumerate(customs):
                    if c["id"] == pid:
                        entry["name"] = (name or c["name"]).strip()
                        customs[i] = entry
                        break
                else:
                    customs.append(entry)
            s = dict(settings.get(pid) or {})
            if base_url:
                s["base_url"] = base_url
            if body.get("model") is not None:
                s["model"] = body["model"].strip()
            key = (body.get("api_key") or "").strip()
            if key and not key.startswith("***"):
                ok, err = validate_api_key(key)
                if not ok:
                    self._send_json({"ok": False, "error": err}, status=400)
                    return
                s["api_key"] = key
            settings[pid] = s
            update = {"provider_settings": settings,
                      "active_provider": pid}
            if not is_preset:
                update["custom_providers"] = customs
            ok, err = eng.update_config(update)
            self._send_json({"ok": ok, "error": err})
            return

        if action == "delete":
            pid = body.get("id", "")
            if get_preset(pid):
                self._send_json({"ok": False, "error": "预设供应商不可删除"},
                                status=400)
                return
            customs = [c for c in customs if c["id"] != pid]
            settings.pop(pid, None)
            update = {"custom_providers": customs,
                      "provider_settings": settings}
            if cfg.get("active_provider") == pid:
                update["active_provider"] = "custom"
            ok, err = eng.update_config(update)
            self._send_json({"ok": ok, "error": err})
            return

        if action == "discover":
            base_url = (body.get("base_url") or "").strip()
            api_key = (body.get("api_key") or "").strip()
            if not base_url:
                self._send_json({"ok": False, "error": "接口地址不能为空"},
                                status=400)
                return
            try:
                models = discover_models(base_url, api_key)
            except LLMError as e:
                self._send_json({"ok": False,
                                 "error": "拉取失败（%s），请手动填写模型名" % e})
                return
            self._send_json({"ok": True, "models": models})
            return

        self._send_json({"ok": False, "error": "未知操作"}, status=400)

    @staticmethod
    def _guess_ctype(name):
        low = name.lower()
        if low.endswith(".html"):
            return "text/html; charset=utf-8"
        if low.endswith(".css"):
            return "text/css; charset=utf-8"
        if low.endswith(".js"):
            return "application/javascript; charset=utf-8"
        if low.endswith(".json"):
            return "application/json; charset=utf-8"
        if low.endswith(".svg"):
            return "image/svg+xml"
        if low.endswith(".png"):
            return "image/png"
        if low.endswith(".ico"):
            return "image/x-icon"
        return "application/octet-stream"


def main():
    config = load_config()
    port = int(config.get("port", 8765))
    Handler.engine = GroupEngine(config)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port
    print("=" * 50)
    print("  AI 群聊后台已启动")
    print("  打开浏览器访问：%s" % url)
    print("  按 Ctrl+C 停止服务")
    print("=" * 50)
    if config.get("auto_open_browser", True):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止…")
        server.shutdown()


if __name__ == "__main__":
    main()
