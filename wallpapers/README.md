# wallpapers

类 Wallpaper Engine 的 **dsh 页面动态壁纸**插件：扫描本地壁纸目录，把视频/网页壁纸作为 dsh Web 页面的动态背景播放，右下角悬浮按钮切换。

## 能力

- 扫描指定目录（Wallpaper Engine 创意工坊目录形态，读 `project.json`），识别可播放项：
  - `video` / `Video`：单个 `.mp4`（浏览器 `<video>` 直接播放）
  - `web` / `Web`：`index.html`（浏览器 `<iframe>` 直接加载）
（`scene` / `Scene` 型已按用户拍板**彻底弃用**，不再进入可播放列表，仅计入 unsupported 提示数。）
- 右下角悬浮按钮（🖼）打开面板：无壁纸 / 随机切换 / 具体壁纸列表。
- 两种展示模式：**对话背景**（半透明铺底，不遮挡界面）/**全屏**（盖在最底层全屏铺开）。
- 选择与模式用 `localStorage` 记忆，随机模式每 2 分钟换一张。
- preset 依赖型暂不支持，与 scene 一并仅在面板提示数量（列表不显示、不可选）。

## 目录配置

默认扫描 `E:\SteamLibrary\steamapps\workshop\content\431960`，可用环境变量 `DSH_WALLPAPERS_DIR` 覆盖（见 `src/catalog.mjs`）。

场景型（`.pkg`）壁纸已弃用，不再进入可播放列表。`src/scene.mjs` 与 `SCENE_PATH` 路由保留为
将来可能恢复的残余（无副作用），但 client 端不会请求/渲染 scene。

## 结构

```
index.mjs                 # Node half：catalog 清单 + 媒体托管 + web item 入口
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
