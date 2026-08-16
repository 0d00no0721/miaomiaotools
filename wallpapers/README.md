# wallpapers

类 Wallpaper Engine 的 **dsh 页面动态壁纸**插件：扫描本地壁纸目录，把视频 / 场景壁纸（低成本复刻）作为 dsh Web 页面的动态背景全屏播放，右下角悬浮按钮切换。

## 能力

- 扫描指定目录（Wallpaper Engine 创意工坊目录形态，读 `project.json`），识别可播放项：
  - `video` / `Video`：单个 `.mp4`（浏览器 `<video>` 直接播放）。
  - `scene` / `Scene` 与其他（含 `web`）的**低成本复刻**：用户在与 `.pkg`/`index.html` 同级的目录里放一张文件名含「屏幕截图」的图片作为背景；音频（可选）由同目录 `audio.json` 清单指定，一段放完随机切下一段；无清单则纯图壁纸不播声；没有「屏幕截图」图片的项直接忽略。
- 右下角悬浮按钮打开面板：无壁纸 / 具体壁纸列表。
- 展示模式固定为**全屏**（盖在最底层全屏铺开，不遮挡界面文字）。
- 面板顶部第二行提供**音量滑杆**（0–100%，默认 50%）与**「离开此网页时静音」开关**。
- 切壁纸时旧媒体立即停止（单例 `<audio>` 复用，不再叠加播放）。
- 选择、音量、静音开关用 `localStorage` 记忆。
- web 原生渲染（iframe live2d 等）、preset 依赖型等暂不支持，仅在面板提示数量（列表不显示、不可选）。

## 目录配置

默认扫描 `E:\SteamLibrary\steamapps\workshop\content\431960`，可用环境变量 `DSH_WALLPAPERS_DIR` 覆盖（见 `src/catalog.mjs`）。

### 低成本复刻约定（图 + 音频清单）

- 在壁纸项目目录（与 `project.json` 同级）放一张**文件名含「屏幕截图」的图片**，即作为该壁纸的背景图。
- 可选地放一个 `audio.json`，格式：

```json
{ "audios": ["相对路径", "…"] }
```

其中每个路径是**相对项目目录**的音频位置。两种写法：
  - 项目目录内的音频（如 web 壁纸自带的 `assets/audio/xxx.ogg`）→ 直接写相对路径，经 `/media` 托管；
  - 解包音频（`output/<id>/sounds/xxx.mp3`）→ 写 `sounds/xxx.mp3`（`sounds/` 前缀），经 `/scene-audio` 托管。

没有 `audio.json` 或清单为空 → 纯图壁纸、不播声音。

`src/scene.mjs` 与 `SCENE_PATH` / `ITEM_PATH` 路由保留为历史残余（无副作用，client 端不请求/渲染）。

## 结构

```
index.mjs                 # Node half：catalog 清单 + 媒体托管（流式 Range） + web item 入口（残余）
src/routes.mjs            # 路由前缀单一来源
src/catalog.mjs           # 目录扫描 + MIME + 安全路径守卫（纯函数，可单测）
src/scene.mjs             # scene.json 解析：图层清单（纯函数，可单测）
client/index.mjs          # client 源码：背景引擎 + 悬浮面板
client/logic.mjs          # 纯逻辑：清单规范化 + 选择解析（可单测）
client.js                 # 构建产物（勿手改，由 scripts/build-client.mjs 生成）
scripts/build-client.mjs  # 极简内联打包器（无 esbuild 依赖，规避 sandbox spawn EPERM）
tests/run.mjs             # 单进程断言跑测
cordis.patch.yml          # bundle 组合层
```

## 构建 / 测试 / 安装

```sh
node scripts/build-client.mjs            # 生成 client.js
node scripts/build-client.mjs --check    # 校验 client.js 新鲜
node tests/run.mjs                       # 单进程断言

dsh plugin --profile web add <本目录绝对路径>
# 重启 dsh web
```

## License

MIT
