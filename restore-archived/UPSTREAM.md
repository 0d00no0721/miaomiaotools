# UPSTREAM.md — 上游锚点

本发布包的宿主补丁 `host-patch.diff` 应用于下面的仓库和基线。

```text
repository: https://github.com/deepseek-ai/deepseek-harness.git
base_commit: 47f943859bef60e4160492346772ded9b24f765a
branch: master
commit_subject: Merge pull request #2519 from deepseek-harness/feat/npm-public
```

## 说明

- 如果未来 `deepseek-harness` 主线继续演进，原样补丁可能因为上下文变化而无法直接 `git apply`。
- 此时优先：`git checkout <base_commit>` 后再打补丁。
- 若必须打到更新的分支，使用 `git apply --3way` 或人工对每处冲突做迁移（迁移后不保证行为一致）。

## 补丁内容边界

`host-patch.diff` 只包含恢复归档功能相关改动：

- workspace 域 unarchive
- host API proxy RPC 链路
- client runtime 双实现与接口
- 相关 fixture / 测试

不包含任何个人环境路径、profile 配置或无关本机改动。
