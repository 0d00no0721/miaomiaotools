# restore-archived 插件

在 DSH Web UI 左下角「设置」上方新增「恢复归档的对话」入口。点击后弹出居中面板，列出已归档会话的标题、所属工作区、最后更新时间，并可一键恢复。

## 前置

- 宿主仓库已按发布包里的 `host-patch.diff` 打过补丁
- 宿主已运行 `pnpm build` / 或由发布包脚本完成构建
- dsh CLI 可用

## 安装

```bat
dsh plugin --profile web add "<本发布包>\plugin"
```

然后重启 web。

## 开发命令

```bat
node scripts/build-client.mjs            # 生成 client.js
node scripts/build-client.mjs --check    # 校验 client.js 是否新鲜
node tests/run.mjs                       # 运行纯函数单测
```

`client.js` 是构建产物，请勿手改。

## 字段说明

| 字段 | 说明 |
|---|---|
| 触发入口 | 左下角“设置”正上方「恢复归档的对话」 |
| 行内容 | 会话标题 + 所属工作区 + 最后更新时间 |
| 排序 | 最近归档的排最上面 |
| 操作行为 | 恢复后回到原工作区原位置，不自动打开 |
| 空态 | 暂无归档 |
| 服务端幂等 | 未归档/未知会话恢复时静默成功 |
