# who-are-you 🔍

知乎用户"查成分"工具——采集公开数据，分析政治/经济/文化三维左右倾向，生成词云图与单文件 HTML 报告。

## 是什么

给一个知乎用户"查成分"：采集其公开数据（主页简介、回答列表、最高赞回答、特征用户是否关注），用 jieba 词性过滤 + TF-IDF 提取关键词，wordcloud 生成词云，LLM 分析三维倾向，输出单文件 HTML 报告。

## 特点

- 🔍 **一键查成分** — 油猴脚本在知乎主页添加按钮，点击即采即分析
- 📊 **三维倾向分析** — 政治/经济/文化左右倾向，由 LLM 根据公开回答内容评估
- ☁️ **词云可视化** — jieba 分词 + TF-IDF 提关键词，wordcloud 生成词云内嵌报告
- 📄 **单文件报告** — HTML 报告自包含，可直接浏览器打开分享
- 🔌 **多 LLM 供应商** — 内置 OpenAI/Anthropic/DeepSeek/智谱/月之暗面/USTC/自定义

## 使用

详细步骤见 [`使用说明.md`](使用说明.md)。

快速开始：

1. 安装依赖：`pip install -r requirements.txt`
2. 编辑 `config.json`，填入 LLM API key 和 BrowserSkill 路径
3. 安装油猴脚本 `zhihu-chemfen.user.js` 到 Tampermonkey
4. 双击 `run.bat` 启动（或 `python server.py`）
5. 在 Edge 里打开知乎用户主页，点击右下角"🔍 查成分"按钮

也可命令行直接运行：

```
python main.py "https://www.zhihu.com/people/某用户" --answers 600 --top 1
```

## 配置

编辑 `config.json`：
- `api_key` / `base_url` — LLM API 配置（**api_key 需自行填写**）
- `bsk_path` / `bsk_home` — BrowserSkill CLI 路径（**需自行填写**）
- `feature_token` — 特征用户 url_token（用于判断是否关注，可留空）
- `model` — LLM 模型名

## 命令行参数

```
python main.py <用户URL或url_token> [选项]

选项：
  --answers N    最多采集回答数 (默认 600)
  --top N        读取全文的最高赞回答数 (默认 1)
  --no-llm       不调用 LLM, 只采集+词云
  --reuse-data   复用已采集的数据 (不启动浏览器)
  --out PATH     报告输出路径
```

## 结构

| 文件 | 角色 |
|------|------|
| `run.bat` | 双击启动器：启动 bsk + Edge + 本地服务 |
| `server.py` | 本地 HTTP 服务 (127.0.0.1:9588)，接收油猴脚本请求 |
| `zhihu-chemfen.user.js` | 油猴脚本：在知乎主页添加"查成分"按钮 |
| `main.py` | 主程序：采集 + 分析 + 报告生成 |
| `_llm.py` | LLM 客户端（openai/anthropic 双规范） |
| `config.json` | 配置（LLM API + bsk 路径 + 特征用户） |
| `requirements.txt` | 依赖列表 |

## 免责声明

本工具由 AI 根据公开数据自动生成，倾向分数为模型估计而非事实定性，仅供了解参考。分析过程中用户内容曾发送至所配置的 LLM 服务。请勿用于人身攻击或网络暴力。

## License

MIT
