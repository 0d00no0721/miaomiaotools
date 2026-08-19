# 知乎「只看图片」油猴脚本

筛选知乎问题页中带图片的回答，可自定义「至少 X 张图」阈值。

## 文件

- `zhihu-image-filter.user.js` — 油猴脚本本体

## 安装

1. Chrome/Edge 安装 Tampermonkey 扩展
2. Tampermonkey 仪表盘 → 工具 → 「导入」选择本文件，或直接把文件拖进浏览器
3. 打开任意知乎问题页 `https://www.zhihu.com/question/*`（需登录知乎）

## 功能

- **只看图片**：开关开启后，隐藏图片数低于阈值的回答
- **阈值输入**：默认 1，可改「至少 X 张图」，改动即生效
- **计数显示**：实时显示 `带图 X / 总 Y`
- **徽标**：每个达到阈值的回答右上角展示 `X图` 小徽标
- **懒加载适配**：滚动加载新回答自动判定
- **状态记忆**：开关与阈值通过 GM_setValue 保存，刷新后保持

## 实现要点

- 图片计数**不依赖 DOM 渲染**：从 `<script id="js-initialData">` 里
  `initialState.entities.answers.<id>.content` 的完整 HTML 统计。
  因此折叠/长文截断的回答也能数到图。解析失败时退化为直接扫 DOM。
- 计数口径：排除内联表情图（`img[eeimg]`）、链接卡片缩略图（`.LinkCard` 内 img）、
  头像（本就不在正文），只统计正文内容图。
- 隐藏仅 `display:none`，不修改知乎数据，刷新即还原。
- SPA 路由切换（同页 A 问题切 B 问题）通过 `window.onurlchange` 自动重新初始化。
