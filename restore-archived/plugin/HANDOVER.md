# restore-archived 插件交接备忘（发布版）

- 状态：MVP 可用。
- 宿主依赖：`host-patch.diff`，随发布包在插件上层。
- 本插件只提供 UI。
- 客户端测试：`node tests/run.mjs` → `all 8 passed`。
- client.js 由 `scripts/build-client.mjs` 生成。
