# @deepseek-ai/dsh-client-ui-skin-studio

> **这是从 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) monorepo 提取的客户端插件包源码，不是可独立运行的外部插件。** 它深度依赖 monorepo 的框架机制（React、Cordis slot 系统、settings scope、locale 等），必须在 deepseek-harness 工作区内集成后才能运行。本文件夹仅作源码归档/备份用途。

## 集成回 deepseek-harness 的步骤

1. 把本 `ui-skin-studio/` 目录复制到 `packages/client/ui-skin-studio/`。
2. 在 `packages/bundle/web-app/cordis.patch.yml` 的浏览器插件列表（与 `ui-trajectory` 等并列）插入：
   ```yaml
   - id: ui-skin-studio
     name: '@deepseek-ai/dsh-client-ui-skin-studio'
   ```
3. 在 `packages/bundle/web-app/package.json` 的 `dependencies` 加：
   ```json
   "@deepseek-ai/dsh-client-ui-skin-studio": "workspace:^",
   ```
4. 在 `tsconfig.client.json` 的 `references` 数组加：
   ```json
   { "path": "./packages/client/ui-skin-studio" },
   ```
5. 在 `packages/host/apiproxy/src/api-proxy.ts` 的 `WEB_SETTINGS_NAMESPACES` 数组加 `'ui-skin-studio'`（否则设置无法持久化——同一白名单同时门控读和写）。
6. 在仓库根运行：
   ```sh
   pnpm install
   pnpm run build:lib:host   # 让 api-proxy 白名单改动落到 lib/
   pnpm --filter @deepseek-ai/dsh-client-ui-skin-studio bundle  # 生成 client bundle
   ```
   重启 `dsh web` 后，设置页会出现「皮肤工作室」入口。

## 依赖

本包的 `peerDependencies` / `devDependencies` 依赖以下 `@deepseek-ai/*` monorepo 工作区包：`cordis`、`dsh-client-runtime`、`dsh-client-ui-settings`、`dsh-client-ui-slots`、`dsh-client-locale`、`dsh-api-remotes`、`dsh-client-connection`、`dsh-settings`、`schemastery`、`dsh-invariants`、`dsh-host-webserver`，以及 `react`。构建产物 `lib/` 与 `node_modules/` 已由 `.gitignore` 排除。

---

English | [中文](README.zh.md)

Skin studio plugin: preset skin switching (dsh-web-ui compatible) plus a custom skin editor with per-region background image, opacity, border, radius, shadow, and backdrop filter. Registers as a "Skin Studio" settings section.

The service owns the live skin state (active skin + custom skin definitions), reads and writes the durable settings scope (`ui-skin-studio` namespace), and applies the active skin to the DOM through a `BackgroundEngine` that writes CSS variables to `document.body` and injects a scoped stylesheet. The engine retracts known dsh-web-ui skin body attributes during application and restores them on dispose, so the two skin systems coexist without conflict.

Custom skins store per-region configuration (image data URL, opacity, border radius, border, shadow, backdrop filter) for four independently configurable regions: global background, sidebar, conversation, and details panel. The `BackgroundEngine` sets `[id='root']` to transparent and overrides `--dsw-alias-bg-*` tokens to translucent rgba() so the background image shows through the panels. Per-panel `backdrop-filter` is applied only on `[data-pane]` columns (whose overlays are React-portal'd to `document.body`), never on `body` or `#root` (an ancestor backdrop-filter traps fixed-position overlays).

Image upload compresses via Canvas (max 1920px wide, JPEG quality 0.7) to keep `settings.yaml` manageable.

## Model Experience

None, as the skin studio manages browser visual preferences; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Preset skin bundle loading is not yet implemented** — the service manages custom skins and the official default; loading dsh-web-ui preset skin bundles through the module system (the try-on engine pattern) is deferred.
- **Custom skins store the entire config in one settings field** — per-field writes would let a single image upload send only the changed path instead of the whole custom skins map.
- **No try-on preview** — the gallery applies skins directly; a live try-on with restore-on-exit is deferred.
