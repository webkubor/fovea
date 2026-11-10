# Changelog

本文件记录 fovea 的对外变化。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [0.2.6] — 2026-11-10 · 证据页跟随主题，霓虹 F 品牌统一

> **一句话摘要**：证据页接入 magpie 主题桥并统一霓虹 F 品牌，深浅主题下图标都看得见；附本版真实截图与页内可播放的演示视频。

### ✨ 新增特性 (What's New)

- **本版真实演示视频**：证据页的「粘贴复算」从填表到出数全流程录屏，页内直接播放。视频里那组数字是页面当场算出来的 —— 粘贴 22 条消息的请求（110,486 字符），点「计算前后差异」，页面自己算出 78,239 字符（71%），裁掉 3 条。不是动画，不是设计稿。

<video src="https://github.com/user-attachments/assets/4d8171f1-4862-45aa-ae68-9b8100b802be" controls width="820"></video>

（视频加载不出来？[直接打开视频](https://github.com/user-attachments/assets/4d8171f1-4862-45aa-ae68-9b8100b802be)）

- **本版证据页截图**（真实浏览器渲染，深浅两套主题各一张）：

<p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/evidence-page-light.webp" alt="fovea 证据页浅色主题：原始请求 47,777 字符，经过 fovea 14,148 字符，消息带显示旧消息被裁成头尾、最近窗口逐字保留" width="820"/></p>

<p align="center"><img src="https://cdn.jsdelivr.net/gh/webkubor/free-imgbed@main/fovea/evidence-page-dark.webp" alt="fovea 证据页深色主题：同一组对照数字，深色下霓虹 F 图标与紫色最近窗口清晰可见" width="820"/></p>

### ⚡️ 体验与性能优化 (Improvements)

- **证据页跟随 magpie 的窗口主题**：magpie 窗口切深色，证据页跟着切，不再固定成浅色。magpie 之外打开时回落到系统 `prefers-color-scheme`，两边都不失配。
- **品牌统一为霓虹 F**：logo / banner / 页面图标（`page/icon.svg`）改用同一套霓虹 F 标记（青 `#00F0FF` + 紫 `#7C5CFF` + 洋红重影），深浅背景各一版。manifest 里的品牌色与实际 SVG 逐字对齐。
- **侧栏图标在深色主题下可见**：此前深色下图标描边被背景吃掉，现在深浅都看得清。
- **图注改成人话**：消息带那行说明从「浅色是旧消息、深色是最近窗口」改成「虚线框是旧消息（只剩头尾），紫色块是最近窗口（逐字保留）」—— 原来那版描述的是配色，跟实际渲染对不上。

### 🐛 缺陷修复 (Bug Fixes)

- 侧栏图标在深色主题下不可见（见上）。
- 验证日志里残留本机绝对路径，已隐去。

### ⚠️ 破坏性变更与迁移 (Breaking Changes & Migration)

无破坏性变更。中间件裁剪逻辑本版未改：消息条数、顺序、id、工具配对、思考签名、加密推理全部照旧，`keep_recent` / `cut_step` / `tool_head` 等选项语义不变。

### 📦 安装与升级 (Install & Upgrade)

```bash
# 已装过的：跟随 magpie 的插件更新通道升级
magpie plugin update fovea

# 想直接跟本仓最新提交：
magpie plugin add github:webkubor/fovea
```

## [0.2.5] — 2026-11-05

本版与 magpie-community 主线对齐：0.2.3、0.2.4 的两处安全修复并入，另加三处新修复。

### Added

- 支持 Gemini 请求（`contents` 字段）：thought 与 thoughtSignature、functionCall 不动；functionResponse 保留 id / name / 键，其中的长字符串被裁；图片换成注记；文档与视频载荷不动。此前 Gemini 请求完全原样放行，装了也不省。

### Fixed

- 幂等性改由长度闸门保证（`head + tail + 80`）：不可信的工具输出或用户消息伪造 `[fovea:` 字样不再让整块旧内容永久免裁；已裁内容在后续请求中仍逐字节稳定。
- `state_marker` 只在 agent 自己写状态的位置生效：assistant 消息（Chat、Anthropic、Responses 的 message 项，或 Gemini 的 model 轮）中以标记开头的文本或文本块。工具结果、用户消息、嵌套块、文本中间出现同样字样都不再算状态块。
- `saccade: "auto"` 不再把 Claude Code 的 `<system-reminder>`（token 预算、工具指引）当成用户的新问题。它与任务没有共同词，旧规则判成换话题、整段历史折叠。
- Responses 请求的首个答案是 `custom_tool_call` / `computer_call` / `local_shell_call` 时，任务豁免范围算错，整条历史一条都不裁。
- Chat 旧版 functions API 的 `role: "function"` 消息此前完全没被处理，那正是最占钱的工具输出。

### Changed

- 测试从 47 增至 74 个用例：新增 `fovea.protocols.test.mjs`（四种协议各自的形状与边界，12 条）；变异检验从 20 处增至 26 处契约保护（CI 里跑）。

## [0.2.3] — 2026-11-05

### Added

- 支持 Gemini 请求（`contents` 字段）：thought 与 thoughtSignature、functionCall 不动；functionResponse 保留 id / name / 键，其中的长字符串被裁；图片换成注记；文档与视频载荷不动。此前 Gemini 请求完全原样放行，装了也不省。

### Fixed

- `saccade: "auto"` 不再把 Claude Code 的 `<system-reminder>`（token 预算、工具指引）当成用户的新问题。它与任务没有共同词，旧规则判成换话题、整段历史折叠。现在判定前先剥掉 harness 注入的块。
- Responses 请求的首个答案是 `custom_tool_call` / `computer_call` / `local_shell_call` 时，任务豁免范围算错，整条历史一条都不裁。
- Chat 旧版 functions API 的 `role: "function"` 消息此前完全没被处理，那正是最占钱的工具输出。

### Changed

- 测试从 47 增至 62 个用例，新增四种协议各自的形状与边界；变异检验从 20 处增至 24 处契约保护（CI 里跑）。

## [0.2.2] — 2026-11-04

### Fixed

- `saccade: "auto"` 的话题判定改用与任务豁免同一口径的「任务」：首条回答之前的前导 user 消息中的最后一条。Codex 形状下首条 user 是 AGENTS.md，旧规则拿它比对，于是同一任务的跟进被判成换话题、任务与工具输出整段折叠；反过来，真换题但碰巧与 AGENTS.md 同词时又不折叠。两向各有用例。

### Changed

- README 快速上手不再预设 `saccade: "auto"`，改为说明默认 `off` 适合带缓存的长工具循环，`auto` 的取舍写在旁边。

## [0.2.1] — 2026-11-03

### Fixed

- 旧图片换成注记时保留块的 `cache_control`——那是供应商缓存的一个断点，静默丢掉会少一个命中位（两模式均保留，有用例）。
- 任务豁免从「第一条 user 消息」改为「首条回答之前的整段前导」：Codex 形状下 AGENTS.md 与 environment_context 在任务之前，旧规则保护的是 AGENTS.md、裁的是真任务；新规则在首条 assistant 回复 / 工具调用 / reasoning 处截止。

## [0.2.0] — 2026-11-02

首个独立仓版本。前身是 magpie-community/plugins 中的 `context-slim` 草稿（PR #467，已关闭并迁移至此），yetone 的评审直接塑造了本版的缓存边界、document 与代理对处理。

### Added

- `cut_step`：裁剪边界按块移动，块内已裁前缀逐字节稳定，供应商 prompt cache 可连续命中；不足一块不动。附连续两轮与跨块边界的回归测试。
- `saccade`（`off` / `auto` / `always`）：最新问题与首条任务词面重叠趋近零时，旧上下文折叠为一行 `[fovea: prior topic not carried]`；「继续」类短跟进不触发。
- `state_marker`：agent 自带结构化状态块的契约——带标记的消息在两种模式下都完整，且原始任务消息随之可裁。
- `protect` 正则在折叠模式下同样生效。
- Responses API `function_call_output` 的数组 `output` 与字符串形式对称处理，`call_id` 永不动。
- 证据体系：`benchmark.mjs`（同一请求前后对照、共同前缀占比、已裁前缀逐字稳定）、`live-benchmark.mjs`（同模型 ABBA 受控实测，退出恢复插件选项）、插件内证据页（零权限、不联网、不保存正文）。
- `keep_recent_tokens` 预算窗口；品牌资产（logo 双色 / banner）；`bun test` 27 例离线全绿。

### Changed

- 更名 `context-slim` → `fovea`，标记从 `[context-slim: …]` 改为 `[fovea: …]`；名字即机制——中央凹看得清、周边视野只剩轮廓，saccade 是视线跳向新目标。

### Fixed

- 早期草稿中 `cut_step` 把不足一块的历史量化到 0、从不裁剪的问题。
- `keep_recent_tokens` 走窗停在溢出消息上、恰好保护了预算本应放弃的巨型消息的问题（评审 §1 修复过程中发现）。
- 旧版 `isImage` 把 document 块当图片换成注记的问题；代理对在头尾两端的劈开问题。

## [0.1.0] — 2026-10-28

- 初版：旧工具输出与长文本留头尾，旧图换注记，消息条数/顺序/id/配对不变。
