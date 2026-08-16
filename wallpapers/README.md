# wallpapers

类 Wallpaper Engine 的 **dsh 页面动态壁纸**插件：扫描本地壁纸目录，把视频壁纸作为 dsh Web 页面的动态背景全屏播放，右下角悬浮按钮切换。

## 能力

- 扫描指定目录（Wallpaper Engine 创意工坊目录形态，读 `project.json`），识别可播放项：
  - `video` / `Video`：单个 `.mp4`（浏览器 `<video>` 直接播放）
（`web`/`Web` 与 `scene`/`Scene` 型已按用户拍板**彻底弃用**，不再进入可播放列表，仅计入 unsupported 提示数。）
- 右下角悬浮按钮（🖼）打开面板：无壁纸 / 具体壁纸列表。
- 展示模式固定为**全屏**（盖在最底层全屏铺开，不遮挡界面文字）。
- 面板顶部第二行提供**音量滑杆**（0–100%，拖动即发声）与**「离开此网页时静音」开关**。
- 选择、音量、静音开关用 `localStorage` 记忆。
- preset 依赖型、web、scene 一并仅在面板提示数量（列表不显示、不可选）。

## 目录配置

默认扫描 `E:\SteamLibrary\steamapps\workshop\content\431960`，可用环境变量 `DSH_WALLPAPERS_DIR` 覆盖（见 `src/catalog.mjs`）。

场景型（`.pkg`）与网页型（`index.html`）壁纸均已弃用，不再进入可播放列表。`src/scene.mjs` 与
`SCENE_PATH` / `ITEM_PATH` 路由保留为将来可能恢复的残余（无副作用），client 端不会请求/渲染。

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
