# deskpet

轻量 **DSH Web GUI 桌面宠物**（右下角悬浮形态），精简自 [whale-girl](https://github.com/vlln/whale-girl)。

- 右下角悬浮、可拖拽、右键换角色
- 12 状态机：`idle` / `think`（会话思考中）/ `working`（思考期随机「认真干活」）/ `celebrate`（回合完成 / 戳一戳）/ `sleep`（空闲 60s 打盹）+ 扩展 `walk` / `eat` / `play` / `joy` / `wait` / `wake`
- 点击戳一戳 → 随机轮换 `celebrate` / `joy` / `play`；空闲自动打盹；互动即醒（播 `wake` 过渡）
- 自发行为：空闲时散步（`walk`，水平移动 + 方向镜像翻转）、进食（`eat`）、玩耍（`play`）、待机变体（`wait` wiggle）
- motion 动效：`float`（思考浮空）/ `wiggle`（摇摆）/ `tilt`（拖拽倾斜）/ `shake`（抖动，框架保留）
- 活动频率三档（`chill` / `normal` / `hyper`），参数集中于 `pickRhythm`，默认 `normal`（预留 UI 开关）
- 零负反馈：无饥饿/心情衰减；`error` / `disappointed` 素材刻意不接入
- 精灵帧 sheet 播放（loop / pingpong / once / blink），帧推进单源（`logic.nextFrame` + `shouldAdvance`）
- 默认复用 whale-girl 的鲸鱼娘形象（MIT）

## 结构

```
index.mjs                 # Node half：Cordis entry（静态素材 + 活动信号路由）
src/routes.mjs            # 路由前缀单一来源
src/assets.mjs            # 静态服务守卫（路径净化 + MIME）
client/index.mjs          # client 源码（自渲染 DOM：渲染 / motion / 散步 / 交互）
client/logic.mjs          # 状态机 + 帧推进 + 频率档位（纯函数，单一权威源）
client/character.mjs      # 角色清单解析（纯函数）
tests/run.mjs             # 单进程断言跑测（避开 sandbox spawn EPERM）
client.js                 # 构建产物（勿手改，由 scripts/build-client.mjs 生成）
scripts/build-client.mjs  # 极简内联打包器（无 esbuild 依赖，规避 sandbox spawn EPERM）
assets/characters/*.png   # whale-girl 精灵 sheet
assets/manifest.json      # 角色清单
cordis.patch.yml          # bundle 组合层
```

## 构建

```sh
node scripts/build-client.mjs            # 生成 client.js（内联 bundler，产出 __ModuleLoader__.load 包装）
node scripts/build-client.mjs --check    # 校验 client.js 新鲜
```

> 说明：不用 esbuild（其内部 spawn 原生服务 worker，在受限沙箱下 EPERM），
> 改为极简内联打包器——解析 client/index.mjs 的相对 import 递归内联，再包 `__ModuleLoader__.load`
> 官方契约。产出的 client.js 与 esbuild 结果功能等价。

## 测试与回滚

```sh
node tests/run.mjs     # 单进程断言：状态机优先级 / 帧推进 / 频率档位 / 角色解析
```

> 不用 `node --test`（会 spawn 子进程，受限沙箱下 EPERM）；`tests/run.mjs` 单进程直跑，断言不通过返回非零退出码。

回滚：改动前会留 `.rollback-<时间戳>/` 快照（含 `client/logic.mjs`、`client/index.mjs`、`client.js`、`tests/run.mjs` 原版），
需要回退时把快照内文件复制回原位再 `node scripts/build-client.mjs` 重建即可。

## 安装

```sh
dsh plugin --profile web add <本目录绝对路径>   # 或 git 源
# 重启 dsh web
```

右下角出现宠物；右键弹出换角色菜单，拖拽移动，单击戳一戳。

## 关于形象

`assets/manifest.json` 使用 `characters` 索引（多角色），当前仅内置 whale-girl 的鲸鱼娘。
新增角色：在 `assets/characters/<id>/` 放同构 sprite sheet，并在 manifest 的 `characters` 里
加条目即可（状态名见 `client/logic.mjs` 的 `STATE_NAMES`）。

## License

MIT（复用 whale-girl 形象素材，原 MIT）。