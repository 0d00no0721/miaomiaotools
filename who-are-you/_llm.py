# -*- coding: utf-8 -*-
"""LLM 客户端 (openai / anthropic 双规范), 支持 providers 多厂商配置。

who_are_you 专用：config.json 含 providers 字典, 每个厂商声明 api 规范
(openai 或 anthropic)、base_url、api_key、model。chat() 按 provider 字段
路由到对应配置。
"""
import json
import time
from pathlib import Path

import requests

DEFAULT_CONFIG = {
    "provider": "ustc",
    "providers": {
        "openai":    {"api": "openai",    "base_url": "https://api.openai.com/v1",           "api_key": "", "model": "gpt-4o-mini",       "name": "OpenAI"},
        "anthropic": {"api": "anthropic", "base_url": "https://api.anthropic.com",            "api_key": "", "model": "claude-sonnet-4-5", "name": "Anthropic"},
        "deepseek":  {"api": "openai",    "base_url": "https://api.deepseek.com/v1",          "api_key": "", "model": "deepseek-chat",     "name": "DeepSeek"},
        "zhipu":     {"api": "openai",    "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "", "model": "glm-4.7-flash",    "name": "智谱 GLM"},
        "moonshot":  {"api": "openai",    "base_url": "https://api.moonshot.cn/v1",            "api_key": "", "model": "kimi-k2.5",        "name": "月之暗面 Kimi"},
        "ustc":      {"api": "openai",    "base_url": "https://api.llm.ustc.edu.cn/v1",        "api_key": "", "model": "deepseek-v4-flash-ascend", "name": "科大 USTC"},
        "custom":    {"api": "openai",    "base_url": "", "api_key": "", "model": "", "name": "自定义"},
    },
    "timeout": 120,
    "max_tokens": 1000,
}


class LLMError(Exception):
    pass


def _migrate_old_config(data):
    """旧扁平结构 (顶层 base_url/api_key/model) → providers.default。"""
    if "providers" in data:
        return data
    old = {k: data.get(k) for k in ("base_url", "api_key", "model", "provider") if k in data}
    if not old.get("base_url"):
        return dict(DEFAULT_CONFIG)
    provider_key = old.get("provider", "default")
    if provider_key == "openai" or provider_key == "anthropic":
        provider_key = "default"
    api = "anthropic" if old.get("provider") == "anthropic" else "openai"
    migrated = dict(DEFAULT_CONFIG)
    migrated["providers"] = dict(DEFAULT_CONFIG["providers"])
    migrated["providers"]["default"] = {
        "api": api,
        "base_url": old.get("base_url", ""),
        "api_key": old.get("api_key", ""),
        "model": old.get("model", ""),
        "name": "迁移的配置",
    }
    migrated["provider"] = "default"
    return migrated


def load_config(path=None):
    p = Path(path) if path else Path(__file__).resolve().parent / "config.json"
    if not p.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data = _migrate_old_config(data)
    # 补全缺失的 provider 预设
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in data.items() if not k.startswith("_")})
    if "providers" in data:
        base_providers = dict(DEFAULT_CONFIG["providers"])
        base_providers.update(data["providers"])
        merged["providers"] = base_providers
    return merged


def save_config(cfg, path=None):
    p = Path(path) if path else Path(__file__).resolve().parent / "config.json"
    # 保留 _说明 等下划线字段
    try:
        old = json.loads(p.read_text(encoding="utf-8"))
        for k, v in old.items():
            if k.startswith("_"):
                cfg.setdefault(k, v)
    except Exception:
        pass
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def get_provider_config(cfg):
    """从 cfg 取当前 provider 的实际配置 dict。"""
    key = cfg.get("provider", "ustc")
    providers = cfg.get("providers", {})
    pc = providers.get(key)
    if not pc:
        # 降级: 取第一个有 api_key 的
        for k, v in providers.items():
            if v.get("api_key"):
                pc = v
                key = k
                break
    if not pc:
        raise LLMError("未找到可用的 LLM provider, 请在设置中配置 api_key")
    return pc


def chat(cfg, system, user, timeout=None):
    """按 cfg["provider"] 路由到 openai 或 anthropic 规范。"""
    pc = get_provider_config(cfg)
    timeout = float(timeout if timeout is not None else cfg.get("timeout", 120))
    api = str(pc.get("api", "openai")).lower()
    if api == "anthropic":
        return _chat_anthropic(pc, cfg, system, user, timeout)
    return _chat_openai(pc, cfg, system, user, timeout)


def _chat_openai(pc, cfg, system, user, timeout):
    url = str(pc.get("base_url", "")).rstrip("/") + "/chat/completions"
    headers = {"Authorization": "Bearer " + str(pc.get("api_key", ""))}
    payload = {
        "model": pc.get("model", ""),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": float(cfg.get("temperature", 0.3)),
        "max_tokens": int(cfg.get("max_tokens", 1000)),
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


def _chat_anthropic(pc, cfg, system, user, timeout):
    base = str(pc.get("base_url", "")).rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    url = base + "/messages"
    headers = {
        "x-api-key": str(pc.get("api_key", "")),
        "anthropic-version": "2023-06-01",
    }
    payload = {
        "model": pc.get("model", ""),
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "max_tokens": int(cfg.get("max_tokens", 1000)),
        "temperature": float(cfg.get("temperature", 0.3)),
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


def test_connection(cfg, timeout=30):
    """测试当前 provider 连通性, 返回 (ok: bool, message: str)。"""
    try:
        pc = get_provider_config(cfg)
    except LLMError as e:
        return False, str(e)
    if not pc.get("api_key"):
        return False, "api_key 为空, 请先填写"
    if not pc.get("base_url"):
        return False, "base_url 为空, 请先填写"
    if not pc.get("model"):
        return False, "model 为空, 请先填写"
    t0 = time.time()
    try:
        reply = chat(cfg, "test", "说一个字", timeout=timeout)
        dt = time.time() - t0
        return True, "连接成功 (%.1fs, 模型返回: %s)" % (dt, (reply or "")[:50])
    except LLMError as e:
        return False, str(e)
    except Exception as e:
        return False, "未知错误: %s" % e
