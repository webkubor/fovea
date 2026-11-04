// Renders promo/chart.html to the PNGs fovea's numbers are posted with: two
// cards (cache, knob) in two languages, 1600x900 CSS px at 2x. It reruns
// scripts/metrics.mjs first, so a card is never older than the code.
//
//   bun scripts/promo.mjs            # needs Chrome; or CHROME=/path/to/chrome
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CHROME = process.env.CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync)
if (!CHROME) {
  console.error("no Chrome found; set CHROME=/path/to/chrome")
  process.exit(1)
}

const metrics = spawnSync(process.execPath, [join(ROOT, "scripts", "metrics.mjs")], { stdio: "inherit" })
if (metrics.status !== 0) process.exit(metrics.status ?? 1)

const profile = mkdtempSync(join(tmpdir(), "fovea-promo-"))
try {
  for (const card of ["cache", "knob"]) {
    for (const lang of ["en", "zh"]) {
      const out = join(ROOT, "promo", `fovea-${card}-${lang}.png`)
      rmSync(out, { force: true })
      const url = pathToFileURL(join(ROOT, "promo", "chart.html")).href + `?card=${card}&lang=${lang}`
      const r = spawnSync(CHROME, [
        "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
        `--user-data-dir=${profile}`, "--window-size=1600,900", "--force-device-scale-factor=2",
        "--virtual-time-budget=4000", `--screenshot=${out}`, url,
      ], { encoding: "utf8", timeout: 90_000 })
      if (r.status !== 0 || !existsSync(out)) {
        console.error(`render failed: ${card} ${lang}\n${r.stderr || r.error || ""}`)
        process.exit(1)
      }
      console.log(`${out}  ${Math.round(statSync(out).size / 1024)} KB`)
    }
  }
} finally {
  rmSync(profile, { recursive: true, force: true })
}
