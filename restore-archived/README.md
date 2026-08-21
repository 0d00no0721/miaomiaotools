# restore-archived 发布包

「恢复归档的对话」功能发布包。本文件夹内容可以单独复制到任何机器、上传到 GitHub。

## 这个文件夹包含什么

```text
release/
├── README.md               ← 你现在看的是这个
├── AGENTS.md               ← 给 AI 代理看的操作手册
├── PATCH-APPLY.md          ← 宿主补丁应用指南（人+AI 通用）
├── UPSTREAM.md            ← 记录宿主仓库、base commit
├── host-patch.diff         ← 宿主源码改动（完整抽取）
├── plugin/                  ← 完整插件文件夹
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── index.mjs
│   ├── client.js
│   ├── client/
│   │   ├── index.mjs
│   │   ├── rows.mjs
│   │   └── style.mjs
│   ├── scripts/build-client.mjs
│   ├── tests/run.mjs
│   └── README.md
├── scripts/
│   ├── setup.mjs                       ← 一键应用补丁 + 打印安装步骤
│   └── verify-manifest.mjs            ← 校验文件完整性/是否缺失
├── manifest.json              ← 文件清单 + sha256 校验和
└── LICENSE.md                ← 许可证说明
```

## 最短配置路径：三层

在 `E:\deepseek_harness\restore-archived` 下创建 release 子目录。实际路径为：

```
ds = release\
```

下面是最终最短路径：复制到别的机器后，**先把本包内容完整放到任意路径**，例如：

```
D:\restore-archive-wrapper\
    ├─ host-patch.diff
    ├─ plugin\
    ├─ scripts\
    └── manifest.json
```

从命令行执行：

```bat
set "DSH_REPO=E:\deepseek_harness"
node scripts/setup.mjs "E:\deepseek_harness"
```

`setup.mjs` 会：

1. 检查目标仓库 baseline；
2. `git apply --check host-patch.diff` 预检；
3. 提示确认后再执行 `git apply host-patch.diff`；
4. 打印下一步 `pnpm install && pnpm run build:lib`；
5. 打印 `dsh plugin add` 命令。

## 人最短落地步骤（读了就能做）

1. 准备一个干净的 `deepseek-harness` 克隆，并切到 `UPSTREAM.md` 里写的 base commit。
2. 在包目录下运行：

```bat
set "DSH_REPO=E:\deepseek_harness"
node scripts/setup.mjs "E:\deepseek_harness"
```

2. 如果不想用 setup 脚本，替代地运行：

```bat
cd /d "E:\deepseek_harness"
git apply --check "D:\restore-archive-wrapper\host-patch.diff"
git apply "D:\restore-archive-wrapper\host-patch.diff"
pnpm install
pnpm run build:lib
```

3. 安装插件：

```bat
dsh plugin --profile web add "D:\restore-archive-wrapper\plugin"
```

4. 重启对应的 dsh web profile 就生效了。验证：左下角设置上方出现“恢复归档的对话”。

## 常见问题

| 问题 | 解法 |
|---|---|
| `ctx.workspaces.unarchiveSession is not a function` | 宿主补丁没打，或打了补丁没执行 `pnpm run build:lib`，或没有重启 web。 |
| `git apply` 报错 | 先 `git checkout` 到 `UPSTREAM.md` 里的 base commit，或者用 `git apply --3way` 尝试三路合并。 |
| web 启动报 cannot resolve profile 插件 | 跑一遍 `pnpm install`，确认 `node_modules/restore-archived` 指向正确。 |

更多规则翻阅 AGENTS.md 或交给 AI 处理。
