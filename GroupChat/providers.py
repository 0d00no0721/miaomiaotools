# -*- coding: utf-8 -*-
"""供应商目录：内置常用供应商预设 + 自定义供应商校验。

借鉴 deepseek_harness 的"目录继承 + 字段覆盖 + 任意自定义路由"配置模型，
缩小为零依赖 Python 版。预设只是参数预填建议（base_url / api 线协议 /
常见模型参考列表），不构成限制；自定义供应商 = 配置而非代码。

每个 preset 字段:
  id       唯一标识（config.json 的 active_provider 存这个）
  name     展示名
  base_url 默认接口地址
  api      线协议: "openai"（/v1/chat/completions）或 "anthropic"（/v1/messages）
  models   常见模型参考列表（仅预填建议，实际以 discover_models 拉取为准）
  key_url  申请密钥的网址（前端展示"获取密钥"链接）
  editable 预设 False（参数可改、不可删除/改名）；自定义 True
"""

PROVIDER_PRESETS = [
    {
        "id": "zhipu",
        "name": "智谱 BigModel",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "api": "openai",
        "models": ["glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-flash",
                   "glm-4-flash-250414"],
        "key_url": "https://open.bigmodel.cn/usercenter/apikeys",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "api": "openai",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "key_url": "https://platform.deepseek.com/api_keys",
    },
    {
        "id": "ustc",
        "name": "USTC 中科大",
        "base_url": "https://api.llm.ustc.edu.cn/v1",
        "api": "openai",
        "models": ["qwen3.6-chat", "deepseek-v4-flash-ascend"],
        "key_url": "",
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "api": "openai",
        "models": ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
        "key_url": "https://platform.openai.com/api-keys",
    },
    {
        "id": "anthropic",
        "name": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "api": "anthropic",
        "models": ["claude-sonnet-4-5", "claude-haiku-4-5"],
        "key_url": "https://console.anthropic.com/settings/keys",
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "api": "openai",
        "models": [],
        "key_url": "https://openrouter.ai/keys",
    },
    {
        "id": "moonshot",
        "name": "Moonshot Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "api": "openai",
        "models": ["kimi-k2-0905-preview", "moonshot-v1-8k"],
        "key_url": "https://platform.moonshot.cn/console/api-keys",
    },
    {
        "id": "ollama",
        "name": "Ollama (本地)",
        "base_url": "http://127.0.0.1:11434/v1",
        "api": "openai",
        "models": [],
        "key_url": "",
    },
    {
        "id": "custom",
        "name": "自定义供应商",
        "base_url": "",
        "api": "openai",
        "models": [],
        "key_url": "",
    },
]

APIS = ("openai", "anthropic")


def get_preset(provider_id):
    for p in PROVIDER_PRESETS:
        if p["id"] == provider_id:
            return dict(p)
    return None


def validate_provider(provider_id, base_url, api, name=None,
                      custom_providers=()):
    """fail-loud 校验（harness 模式）：写配置时就拒绝不可服务的供应商。

    返回 (ok, error)。预设只校验 base_url/api；自定义额外校验
    id/名字合法性与重复。
    """
    if not base_url or not str(base_url).strip():
        return False, "接口地址不能为空"
    if not str(base_url).strip().startswith(("http://", "https://")):
        return False, "接口地址必须以 http:// 或 https:// 开头"
    if api not in APIS:
        return False, "接口规范只支持 openai 或 anthropic"
    is_preset = get_preset(provider_id) is not None
    if not is_preset:
        pid = (provider_id or "").strip()
        if not pid:
            return False, "供应商标识不能为空"
        if len(pid) > 32 or not all(
                c.isascii() and (c.isalnum() or c in "-_") for c in pid):
            return False, "供应商标识只能包含英文字母/数字/-/_，最长 32 字符"
        if name is not None and not name.strip():
            return False, "供应商名称不能为空"
        for cp in custom_providers:
            if cp.get("id") == pid:
                if name is None:
                    return False, "已有同名供应商"
                break
    return True, None
