# PATCH-APPLY.md — 宿主补丁应用指南

`host-patch.diff` 是本发布包里对上游 `deepseek-harness` 的唯一源码补丁。它新增了：

- `WorkspaceRegistry.unarchiveSession`
- RPC `workspace.unarchiveSession`
- 客户端运行时的 `ctx.workspaces.unarchiveSession`
- 相应测试 fixture 与测试用例

## 对应基线

- 上游仓库：清单见 `UPSTREAM.md`
- base commit：以 `UPSTREAM.md` 中记录的为准。补丁只保证能应用到这个基线。

## 标准应用顺序

1. 先将 `deepseek-harness` 切到 `UPSTREAM.md` 里的 base commit：
   ```bat
   git -C <DSH_REPO> checkout <BASE_COMMIT>
   ```

2. 打开命令行，切到本包目录：
   ```bat
   cd /d <PUBLISH_ROOT>
   ```

3. 预检补丁：
   ```bat
   git -C <DSH_REPO> apply --check host-patch.diff
   ```

4. 如果预检无输出，正式打补丁：
   ```bat
   git -C <DSH_REPO> apply host-patch.diff
   ```

5. 构建宿主：
   ```bat
   cd /d <DSH_REPO>
   pnpm install
   pnpm run build:lib
   ```

## 失败时的恢复

- 提示 `patch does not apply`：先确认当前 HEAD 是否为 base commit；当前工作区是否已存在同内容补丁。
- 提示上下文冲突：可以尝试三路合并：
  ```bat
  git -C <DISH_REPO> apply --3way host-patch.diff
  ```
  注意这条命令可能产生冲突文件，不能省人工检查。
- 如果无论怎样打不上，不要改 `host-patch.diff` 本身；而是检查仓库是否已经含有所需功能。

## 常见问题

- `ctx.workspaces.unarchiveSession is not a function`
  - 说明宿主补丁没有打，或补丁打了但没执行 `pnpm run build:lib`，或 web 进程没有重启。
  - 先检查 `packages/client/runtime/lib/client.js` 中有没有 `unarchiveSession`。
