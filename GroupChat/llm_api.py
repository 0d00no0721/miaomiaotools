# -*- coding: utf-8 -*-
"""LLM 客户端：供应商目录制配置（借鉴 deepseek_harness，缩小为零依赖版）。

公开接口：
- chat(config, system, user, timeout=None)  单轮非流式调用，按 active_provider 分发
- get_active_provider_config(config)        激活供应商的合并配置
- discover_models(base_url, api_key)        GET /models 拉取模型列表（宽容解析）
- load_config / save_config / config_path   config.json 读写（含旧配置迁移）
- build_transcript(messages, limit=0)       群聊记录 → 文本 prompt

配置模型：preset（providers.py 内置参数）+ provider_settings（每供应商
base_url/api_key/model 覆盖，切换时各自保留）+ active_provider（当前激活
id）。key 明文存 config.json（用户确认）。旧扁平配置自动迁移。
"""
import json
import re
import sys
from pathlib import Path

import requests

from presets import DEFAULT_GROUP_NAME  # noqa: F401  (保持模块兼容)
from providers import APIS, get_preset

DEFAULT_CONFIG = {
    "_说明": "AI群聊配置文件。修改后保存并重启程序生效，也可在网页「设置」里改。"
             "active_provider: 当前激活供应商 id（预设见 providers.py，自定义见 "
             "custom_providers）；custom_providers: 自定义供应商列表；"
             "provider_settings: 每供应商的 base_url/api_key/model 覆盖，切换时各自保留；"
             "temperature: 随机性 0~1；max_tokens: 单次回复上限；"
             "timeout: 请求超时秒数；max_retries: 调用失败重试次数；"
             "max_rounds: 每次讨论最大轮数（达到后自动生成纪要收尾）；"
             "order_by_llm: true=每轮由模型定发言顺序（失败降级随机）；history_limit: "
             "发给 AI 的上下文条数上限（0=全部）；summary_max_chars: 纪要字数上限；"
             "port: 后台服务端口（默认 8765）；auto_open_browser: 启动时自动打开浏览器。",
    "active_provider": "zhipu",
    "custom_providers": [],
    "provider_settings": {},
    # 以下为讨论/服务全局参数（不属于任何供应商）
    "temperature": 0.7,
    "max_tokens": 1024,
    "timeout": 120,
    "max_retries": 2,
    "max_rounds": 15,
    "order_by_llm": True,
    "history_limit": 0,
    "summary_max_chars": 400,
    "port": 8765,
    "auto_open_browser": True,
    "search_enabled": True,
    "search_max_results": 5,
}

MAX_MEMBERS = 8


class LLMError(Exception):
    pass


def config_path():
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).parent
    else:
        base = Path(__file__).resolve().parent
    return base / "config.json"


def members_path():
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).parent
    else:
        base = Path(__file__).resolve().parent
    return base / "members.json"


def history_dir():
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).parent
    else:
        base = Path(__file__).resolve().parent
    return base / "history"


def load_config(path=None):
    path = Path(path) if path else config_path()
    if not path.exists():
        try:
            save_config(path, DEFAULT_CONFIG)
        except OSError:
            pass
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in data.items() if not k.startswith("_")})
    # active_provider 若只来自 DEFAULT_CONFIG（旧扁平配置），视为未迁移
    if "active_provider" not in data:
        merged.pop("active_provider", None)
    return _migrate(merged)


def _migrate(cfg):
    """旧扁平配置（provider/base_url/api_key/model）→ 供应商目录制。

    无 active_provider 键视为旧配置：把旧字段迁移为第一个 provider_settings
    并按 base_url 匹配预设 id（USTC 现配不丢）。
    """
    if "active_provider" in cfg:
        cfg["provider_settings"] = cfg.get("provider_settings") or {}
        cfg["custom_providers"] = cfg.get("custom_providers") or []
        return cfg
    old_base = str(cfg.get("base_url") or "")
    old_key = str(cfg.get("api_key") or "")
    old_model = str(cfg.get("model") or "")
    pid = "custom"
    for p in PROVIDER_PRESETS_ALL():
        if p["base_url"] and old_base.rstrip("/") == p["base_url"].rstrip("/"):
            pid = p["id"]
            break
    else:
        if old_base:
            cfg.setdefault("custom_providers", []).append({
                "id": "custom", "name": "自定义供应商",
                "base_url": old_base, "api": str(
                    cfg.get("provider") or "openai").lower(),
            })
    cfg["active_provider"] = pid
    if old_base or old_key or old_model:
        cfg["provider_settings"] = {pid: {
            "base_url": old_base, "api_key": old_key, "model": old_model,
        }}
    else:
        cfg["provider_settings"] = {}
    return cfg


def PROVIDER_PRESETS_ALL():
    """预设 + 未导入的延迟 import（避免 providers→llm_api 反向依赖）。"""
    from providers import PROVIDER_PRESETS
    return PROVIDER_PRESETS


def get_active_provider_config(config):
    """激活供应商的合并配置：preset 参数 < provider_settings < 全局默认。

    返回的 dict 保持旧扁平 schema（provider/base_url/api_key/model/...），
    chat() 等旧代码零改动。
    """
    pid = str(config.get("active_provider") or "")
    preset = get_preset(pid) or {
        "id": pid, "name": pid, "base_url": "", "api": "openai",
        "models": [], "key_url": "",
    }
    settings = (config.get("provider_settings") or {}).get(pid) or {}
    custom = next((c for c in (config.get("custom_providers") or [])
                   if c.get("id") == pid), {})
    merged = {
        "provider": preset.get("api") or "openai",
        "base_url": preset.get("base_url") or "",
        "api_key": "",
        "model": (preset.get("models") or [""])[0] if preset.get("models") else "",
        "timeout": config.get("timeout", 120),
    }
    if custom:
        if custom.get("api"):
            merged["provider"] = custom["api"]
        if custom.get("base_url"):
            merged["base_url"] = custom["base_url"]
    for k in ("base_url", "api_key", "model"):
        v = settings.get(k)
        if v:
            merged[k] = v
    # temperature/max_tokens 属全局讨论参数，但保留在返回值里供 chat() 使用
    merged["temperature"] = config.get("temperature", 0.7)
    merged["max_tokens"] = config.get("max_tokens", 1024)
    merged["max_retries"] = config.get("max_retries", 2)
    return merged


_API_KEY_RE = re.compile(r"^[\x21-\x7E]+$")


def validate_api_key(key):
    """API key 本地校验（harness api-key.ts 模式）：trim + printable-ASCII。"""
    key = (key or "").strip()
    if not key:
        return False, "密钥不能为空"
    if not _API_KEY_RE.match(key):
        return False, "密钥含非法字符（须为可打印 ASCII）"
    return True, None


_DISCOVER_MAX_BYTES = 4 * 1024 * 1024


def discover_models(base_url, api_key, timeout=20):
    """GET {base_url}/models 拉取模型列表（宽容解析，harness discovery 模式）。

    只支持 OpenAI 形状（各家唯一共识）；失败抛 LLMError，前端回退手填。
    一次性凭据，调用完即弃，不落盘。
    """
    ok, err = validate_api_key(api_key or "x")
    url = str(base_url or "").rstrip("/") + "/models"
    headers = {"Authorization": "Bearer " + (api_key or "").strip()}
    try:
        resp = requests.get(url, headers=headers, timeout=timeout,
                            stream=True)
    except requests.RequestException as e:
        raise LLMError("连接失败: %s" % e) from e
    if resp.status_code != 200:
        raise LLMError("HTTP %s" % resp.status_code)
    # 响应字节硬上限，按实际读取量执行
    body = resp.raw.read(_DISCOVER_MAX_BYTES + 1)
    if len(body) > _DISCOVER_MAX_BYTES:
        raise LLMError("响应过大")
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except ValueError as e:
        raise LLMError("响应格式异常") from e
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise LLMError("响应格式异常")
    models = []
    for item in items:
        if not isinstance(item, dict):
            continue
        mid = item.get("id")
        if not mid or not isinstance(mid, str):
            continue  # 无 id 的条目跳过，不整体失败
        if mid not in models:
            models.append(mid)
    if not models:
        raise LLMError("未发现模型")
    return models


def save_config(path, cfg):
    Path(path).write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                          encoding="utf-8")


def chat(config, system, user, timeout=None):
    """config 可为旧扁平 schema（provider/base_url/...）——调用方零改动。

    engine 传入的 config 来自 get_active_provider_config()，字段一致。
    """
    provider = str(config.get("provider") or "openai").lower()
    timeout = float(timeout if timeout is not None else config.get("timeout", 120))
    if provider == "anthropic":
        return _chat_anthropic(config, system, user, timeout)
    return _chat_openai(config, system, user, timeout)


def _chat_openai(config, system, user, timeout):
    url = str(config.get("base_url") or "").rstrip("/") + "/chat/completions"
    headers = {"Authorization": "Bearer " + str(config.get("api_key") or "")}
    payload = {
        "model": config.get("model", ""),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": float(config.get("temperature", 0.7)),
        "max_tokens": int(config.get("max_tokens", 1024)),
    }
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
    except requests.RequestException as e:
        raise LLMError("请求失败: %s" % e) from e
    if resp.status_code != 200:
        raise LLMError("HTTP %s: %s" % (resp.status_code, resp.text[:300]))
    try:
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise LLMError("响应格式异常: %s" % str(resp.text)[:300]) from e


def _chat_anthropic(config, system, user, timeout):
    base = str(config.get("base_url") or "").rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    url = base + "/messages"
    headers = {
        "x-api-key": str(config.get("api_key") or ""),
        "anthropic-version": "2023-06-01",
    }
    payload = {
        "model": config.get("model", ""),
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "max_tokens": int(config.get("max_tokens", 1024)),
        "temperature": float(config.get("temperature", 0.7)),
    }
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
    except requests.RequestException as e:
        raise LLMError("请求失败: %s" % e) from e
    if resp.status_code != 200:
        raise LLMError("HTTP %s: %s" % (resp.status_code, resp.text[:300]))
    try:
        data = resp.json()
    except ValueError as e:
        raise LLMError("响应格式异常: %s" % str(resp.text)[:300]) from e
    for block in data.get("content", []) or []:
        if block.get("type") == "text" and block.get("text"):
            return block["text"]
    raise LLMError("响应中没有文本: %s" % str(data)[:300])


def build_transcript(messages, limit=0):
    """群聊消息列表 → 序列化文本。messages 元素: (sender, content)。

    sender 为成员名或"用户"。limit>0 时只保留最近 limit 条
    （内容过长时仍全量保留，截断交给 max_tokens/上下文窗口兜底）。
    """
    msgs = list(messages)
    if limit and limit > 0:
        msgs = msgs[-limit:]
    if not msgs:
        return "（群聊刚开始，还没有人发言。）"
    lines = []
    for i, (sender, content) in enumerate(msgs, 1):
        lines.append("%d.%s: %s" % (i, sender, content.strip()))
    return "\n".join(lines)
