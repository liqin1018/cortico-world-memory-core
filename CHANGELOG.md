# Changelog

## 0.2.1

- **修掉「对话原文一直是 0 行」**：默认 `captureSenders` 白名单一个真实 senderKey 都匹配不上（实际是 `private:1940008084`、`desktop-pet.chat`，旧正则写的是 `qq.` / `desktop-pet.message`）。新默认认 QQ 私聊、桌宠对话/语音、星邮私聊，群聊仍然不收；读到旧默认值会自动换成新的，不用手改设置。
- **原文过期不再直接删**：超过 `rawRetentionDays` 的行按天挪进 `data/memory-core/archive/YYYY-MM-DD.jsonl`，新增 `rawArchiveDays`（默认 90 天，0 = 永久）。模型用 `mcore_recall` 的 `mode=archive` 能翻回更早的对话。
- **历史补录**：新增 `captureBackfill`，打开后重启一次会把水位倒回开头重扫宿主还留着的消息，补完自动停用；中途被打断会从断点接着跑。
- **诊断可见**：`state.json` 记录最近一次捕获的体检结果（扫了多少条、留下几条、被白名单挡掉的 key 样例），原文页没有数据时直接把样例显示出来。
- **召回打分**：标签单独加权（同一关键词命中标签比正文里顺带提到更靠前）；`uses` 惩罚封顶 8 次，常用的重要记忆不会越用越沉。
- **疑似作废**加了老化候选：90 天没被召回、权重低于 0.45、未完成的承诺除外——仍然只是候选，要人点一下才退休。
- 提示词跟着加了一句 `mode=archive` 的用法（697 → 720 字符）。

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
