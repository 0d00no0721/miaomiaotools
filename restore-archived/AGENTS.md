# AGENTS.md — 面向 AI 代理的部署手册

下面是一个 AI 代理负责执行「恢复归档对话」插件部署时，应当严格按顺序执行的操作清单。每一步都写明了命令、验收标准、失败了怎么处理。

## 0. 输入与验收总目标

- 部署结果是：
  - web profile 装上了插件 `restore-archived`
  - 宿主 `deepseek-harness` 打上了补丁并重建
  - 侧边栏设置上方出现入口词条（可选：入口面板可以打开）
  - 若调用恢复按钮，不出现 `unarchiveSession is not a function`

- 下面用 `DSH_REPO` 表示用户提供的 `deepseek-harness` 仓库路径。例如 Windows 用户填的是 `E:\deepseek_harness`，实际是一个包含 `package.json` 和 `.git` 的文件夹。

---

## 1. 确认先决条件

需要检查系统是否有：

- `git`
- `node`（版本 ≥ 22）
- `pnpm`（版本高不等于 11 也行，按仓库 README）
- `dsh` CLI 在 PATH 里

```bat
git --version
node -v
pnpm -v
dsh --version
```

验收：四个命令都有正常版本输出。

失败处理：缺什么装或提示什么。

---

## 2. 定位仓库

用户会给出一个路径，写作 `DSH_REPO`。在仓库根确认是目标仓库：

```bat
git -C "DSH_REPO" remote -v
```

预期看到：

```text
origin  https://github.com/deepseek-ai/deepseek-harness.git
```

验收：remote 含有 `deepseek-harness`。如果不是，向用户确认是否复用其它 fork；原则上可以用任何包含相同 base commit 的 fork，但必须 checkout。

---

## 3. 确认基线 commit

读取本包里的 `UPSTREAM.md` 获得 `BASE_COMMIT`。

在 dsh 仓库执行：

```bat
git -C "DSH_REPO" checkout BASE_COMMIT
```

验收： `git -C "DSH_REPO" rev-parse HEAD` 输出与 `UPSTREAM.md` 记录的完全一致。

失败处理：如果 checkout 失败，要求用户先保存/提交本仓库自己的改动；不要用不带参数的 `git checkout` 硬切。

---

## 4. 校验发布包完整性

在本包 root 运行：

```bat
node scripts/verify-manifest.mjs
```

验收：输出 `manifest OK`。

失败处理：若提示文件缺失或 hash 不符，请用户重新检查是否完整解压。不继续执行。

---

## 5. 应用宿主补丁

```bat
cd /d "PUBLISH_ROOT"
git -C "DSH_REPO" apply --check host-patch.diff
```

- 如果输出为空、退出码 0：继续。
- 如果失败：按 `PATCH-APPLY.md` 恢复。

然后：

```bat
git -C "DSH_REPO" apply "PUBLISH_ROOT\host-patch.diff"
```

验收：以下命令能搜到新增符号：

```bat
findstr /c:"unarchiveSession" "DSH_REPO\packages\workspace\workspace\src\index.ts"
findstr /c:"workspace.unarchiveSession" "DSH_REPO\packages\host\apiproxy\src\api\rpc-map.ts"
```

失败处理：若 patch 打不上，先确认 `git -C DSH_REPO status` 是否干净；若不干净先按用户指示保存改动，不要直接 `git reset --hard`。

---

## 6. 构建宿主侧

```bat
cd /d "DSH_REPO"
pnpm install
pnpm run build:lib
```

验收：退出码 0。

失败处理：
- 网络失败导致 pnpm 装不上：重启后再试，不要用 `--force` 乱修。
- 构建错误：上报具体文件与错误，不要跳过。

---

## 7. 安装插件

```bat
cd /d "DSH_REPO"
dsh plugin --profile web add "PUBLISH_ROOT\plugin"
```

验收：提示成功。然后验证 profile 包含插件：

```bat
cat "USERPROFILE\.dsh\profiles\web\package.json"
```

如果上述路径不是真实路径，以本机 `DSH_HOME` / profile 实际位置为准。JSON 里 `dependencies` 应有：

```text
"restore-archived": "link:...doroot..."
```

且 `dsh.profile.bundles` 数组里有 `"restore-archived"`。

失败处理：如果提示 `pnpm` 之类错误，请确认 dsh 能正常管理 profile；本步骤与补丁无关。

---

## 8. 终验

执行插件自身测试：

```bat
cd /d "PUBLISH_ROOT\plugin"
node tests/run.mjs
```

期望最后出现：

```text
all 8 passed
```

失败处理：查看失败名；多数与插件内纯函数有关，不是宿主问题。

人工验收请补充：

- 启动 web
- 左下角设置上方出现「恢复归档的对话」
- 打开面板后显示为空态或已有归档；点恢复不报 `ctx.workspaces.unarchiveSession is not a function`
