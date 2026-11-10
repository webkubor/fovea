# Fovea 品牌化验证

分支：ui/page-polish-icon。基于 2583330 保留 magpie bridge 与主题同步逻辑。

- `bun test`：74 pass / 0 fail / 88001 expect() calls（tests.log）。
- `bun build.mjs`：page/measure.js written, 29281 bytes；`git diff --exit-code -- page/measure.js` exit 0。
- `git diff --check`：exit 0。
- A2 与 page/icon.svg 逐字比较，仅 fv-n / fv-t 改为 fovea-page-neon / fovea-page-tile。package.json magpie.icon 解码后与 SVG 一致；五份 SVG 渐变 ID 互不冲突。
- Chrome CDP：`bun brand/evidence/verify.mjs`。先启动 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --no-first-run --no-default-browser-check --disable-background-networking --user-data-dir="$PWD/brand/evidence/chrome-profile" --remote-debugging-port=19341 about:blank`。
- 桌面 1100×1520，深浅各一张；移动 390px，无横向溢出。验证 JSON 记录浏览器读取的主题 token、页面正文、错误／清空交互及 36 组对比度。所有组 ≥ 4.5，最小 5.87:1。
- 图标：普通 img，#0e0e0e 与 #fafafa 两底，16/32/64/128px。16px 可辨 F，细小间隔受抗锯齿影响，放大版保留完整重影和断口。
- lockups.png：透明 mark 和带路径字标的横版 logo，两套主题。字标由系统 Futura Medium 字形转轮廓，无运行时字体依赖。
- lead 独立查看页面 diff 与深浅主题／图标截图：无阻断视觉问题。

限制：本次 Chrome 直接打开仓库页面，通过 data-theme 驱动两套主题。未在 magpie 实机复验握手与窗口切换；原有桥接代码保持不变。未做屏幕阅读器验收。未推远端、未发版。模型实际归属 unknown。
