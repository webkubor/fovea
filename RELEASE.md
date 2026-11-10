# 发版流程

发版只走 pull request，不直推 main。合并即发布：带 `release` 标签的 PR 合并后，[release workflow](.github/workflows/release.yml) 会重跑全部测试、校验版本三方一致（package.json == CHANGELOG == README 徽章），然后打 `v<x.y.z>` 标签并从 CHANGELOG 对应小节生成 Release Notes。Release 标题取 CHANGELOG 小节标题里 ` · ` 之后的中文一句话，形如 `v0.2.6 — 证据页跟随主题，霓虹 F 品牌统一`（不超过 25 字）。直接推到 main 的提交永远不触发发布。

## 步骤

```bash
# 1. 起版本号：package.json、README 徽章、CHANGELOG 三处一次改齐
bun scripts/release.mjs bump 0.2.2

# 2. 把 CHANGELOG 里「（待填）」换成这一版真实的变化；行为有变时同步改 README

# 3. 走 PR
git switch -c release/0.2.2
git commit -am "release: 0.2.2"
git push -u origin release/0.2.2
gh pr create --label release --title "release: 0.2.2" --fill

# 4. 合并 -> CI 绿 -> release workflow 自动打 tag、发 Release
```

忘了打 `release` 标签也不会丢版本：CI 对每次 push 和 PR 都跑 `bun scripts/release.mjs check`，版本三方不一致进不了主干；之后随时可手动 `gh release create v<x.y.z> --target <merge-commit>` 兜底发 Release。

## 校验命令

```bash
bun scripts/release.mjs check   # 版本三方一致，CI 每次都在跑
bun scripts/release.mjs bump    # 用法见 --help 输出的示例
```
