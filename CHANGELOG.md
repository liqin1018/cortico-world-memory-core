# Changelog

## 0.2.0

- 补上扩展市场要的自描述与元数据：`describe.json`（工具、事件、环境提示词原文）、图标、四张演示截图，`cortico.locales` 中英简介。
- 标签改成词表里的：`memory`、`companion`、`internal-state`、`experimental`（原来的 `proactive` / `life` 不在词表里，市场会判为无效标签）。
- `CHANGELOG.md` 进包，市场详情页才能按版本显示更新日志。代码与 0.1.1 一致。

## 0.1.1

- 修正 `repository` / `homepage` / `bugs` 指向的 GitHub 地址（0.1.0 里写错了账号）。代码与 0.1.0 一致。

## 0.1.0

- 首个版本：一张卡片表（fact / self / episode / promise / note）、四个工具、一段静态环境提示词。
- 退休与版本链：编辑不覆盖，旧版标 `retired` 并由新卡记 `supersedes`；`closes` 取代旧记录后不再参与检索。
- 记忆域 `scope`、重复合并、疑似作废/垃圾识别，都在记忆地图的「维护」面板里先预览再执行。
- 记忆地图：图谱 / 时间线 / 列表 / 原文 / 文件五视图，右栏可折叠。
