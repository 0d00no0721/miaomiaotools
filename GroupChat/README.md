# GroupChat 💬

复刻智谱清言 App「AI 群聊」——多个不同人设 AI 成员围绕主题自动讨论，群管理员编排指派。

## 是什么

本地后台服务 + 浏览器网页前端。用户发消息后，群管理员（固定角色）分解任务并 @指派成员，仅被指派的成员依次发言，管理员评估后再协调，循环直到完成并自动生成纪要。

## 功能

- 🎯 **群管理员编排** — 固定项目经理角色，分解任务 → @指派 → 评估 → 收尾
- 🗣️ **多 AI 成员** — 最多 8 个不同人设成员，被 @ 才发言，未被指派的沉默
- 🔍 **联网搜索** — 成员发言含 `[SEARCH: 关键词]` 时自动搜索并回填结果
- 📎 **文件产出** — 成员发言中的 `md`/`html`/`csv` 代码块自动提取存盘，前端渲染文件卡片
- 📋 **自动纪要** — 讨论结束后自动生成【核心观点】【分歧与讨论】【下一步建议】三段纪要
- 💾 **历史存档** — 每轮自动存档，可打开历史续聊、导出 Markdown/HTML
- 🔌 **多供应商** — 内置智谱/DeepSeek/USTC/OpenAI/Anthropic/OpenRouter/Moonshot/Ollama/自定义，配置可切换

## 使用

1. 编辑 `config.json`，填入你的 LLM API key
2. 启动服务：
   ```bash
   pip install requests
   python server.py
   ```
3. 浏览器访问 `http://127.0.0.1:8765`（端口可在 config.json 改）

## 打包

```bash
build.bat
```

构建后 `dist/GroupChat.exe`，需连同 `config.json`、`members.json`、`web/` 一起分发。

## 配置

编辑 `config.json`：
- `active_provider` — 当前激活的供应商 id（预设见 `providers.py`）
- `provider_settings` — 每供应商的 `base_url`/`api_key`/`model` 覆盖（**api_key 需自行填写**）
- `max_rounds` — 每次讨论最大轮数（默认 10，达到后自动生成纪要收尾）
- `port` — 后台服务端口（默认 8765）
- `search_enabled` — 是否启用联网搜索

## 结构

| 文件 | 角色 |
|------|------|
| `server.py` | HTTP 后台服务（ThreadingHTTPServer + JSON API + 静态托管 web/） |
| `engine.py` | 群聊调度引擎（群管理员编排/文件提取/搜索拦截/纪要/存档） |
| `llm_api.py` | LLM 客户端（供应商目录制 + 双规范 + 模型发现） |
| `providers.py` | 供应商预设目录（8 预设 + 自定义） |
| `search.py` | 免费爬虫搜索（DuckDuckGo Lite + Bing 降级） |
| `presets.py` | 内置预设人设组 |
| `web/index.html` | 单文件前端（内联 CSS/JS，约 850 行） |
| `members.json` | 当前成员名单（示例数据） |
| `config.json` | 供应商配置 + 全局讨论参数 |
| `build.bat` | PyInstaller 打包脚本 |

## License

MIT
