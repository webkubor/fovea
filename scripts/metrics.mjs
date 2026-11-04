// The numbers behind promo/chart.html, from the same sessions the probe
// test asserts on (scripts/sessions.mjs), with the options the package
// ships. Offline and deterministic: no key, no network, same output each run.
//
//   bun scripts/metrics.mjs              # writes promo/metrics.json
//
// and promo/metrics.js, the same report as a script promo/chart.html loads
// (a page opened from disk cannot fetch a JSON file next to it).
//
// What is measured, and what is modelled:
// - chars: the request body the gateway sends upstream, exactly.
// - cost units: modelled per char with each protocol's own vendor cache
//   multipliers (scripts/sessions.mjs PRICING: Anthropic read 0.1x, write
//   1.25x; OpenAI read 0.1x, write 1x). A dollar bill depends on the
//   provider and model; `magpie usage --csv` is the bill.
// - "naive" is fovea with cut_step 1: the same thinning, but the cut
//   boundary slides one message a turn, as a plain history trimmer's does.
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULTS, SHAPES, PRICING, send, session } from "./sessions.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

// Everything a provider or client checks byte for byte: ids and pairing
// halves, signatures, encrypted reasoning, reasoning text, cache breakpoints.
const PROTECTED = new Set(["id", "tool_use_id", "call_id", "tool_call_id", "signature", "encrypted_content", "reasoning_content", "thinking", "cache_control", "tool_calls"])

function protectedValues(v, out = []) {
  if (Array.isArray(v)) for (const x of v) protectedValues(x, out)
  else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (PROTECTED.has(k)) out.push(k + "=" + JSON.stringify(v[k]))
      else protectedValues(v[k], out)
    }
  }
  return out
}

function contract() {
  let turns = 0, compared = 0, changed = 0
  for (const shape of SHAPES) {
    for (let t = shape.turns[0]; t <= shape.turns[1]; t++) {
      const raw = shape.build(t)
      const a = protectedValues(raw), b = protectedValues(send(raw))
      turns++
      compared += a.length
      if (a.length !== b.length) changed += Math.abs(a.length - b.length)
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) changed++
    }
  }
  return { turns, compared, changed }
}

const pct = (after, before) => Math.round((after / before - 1) * 1000) / 10

function shapeReport(shape) {
  const fovea = session(shape)
  const naive = session(shape, { ...DEFAULTS, cut_step: 1 })
  return {
    id: shape.id, name: shape.name, protocol: shape.protocol, pricing: shape.pricing, turns: fovea.turns,
    size: { before: fovea.sizeBefore, after: fovea.sizeAfter, change_pct: pct(fovea.sizeAfter, fovea.sizeBefore) },
    cost: { baseline: Math.round(fovea.baseline), fovea: Math.round(fovea.cost), naive: Math.round(naive.cost),
      fovea_pct: pct(fovea.cost, fovea.baseline), naive_pct: pct(naive.cost, naive.baseline) },
    cache_breaks: { fovea: fovea.breaks, naive: naive.breaks, baseline: 0 },
    series: fovea.series.map((r, i) => ({ turn: r.turn, raw: r.raw, fovea: r.sent, naive: naive.series[i].sent,
      cost_baseline: Math.round(r.baseline), cost_fovea: Math.round(r.cost), cost_naive: Math.round(naive.series[i].cost) })),
  }
}

// cut_step is the one knob that trades thinning against cache hits; sweep it
// on the Claude Code session, where the cache multipliers are Anthropic's own.
function sweep() {
  const shape = SHAPES[0]
  return [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96].map((cut_step) => {
    const s = session(shape, { ...DEFAULTS, cut_step })
    const mean = s.series.reduce((n, r) => n + r.sent / r.raw, 0) / s.series.length
    return { cut_step, cost_pct: pct(s.cost, s.baseline), cache_breaks: s.breaks, mean_size_pct: Math.round((mean - 1) * 1000) / 10 }
  })
}

// The commit the numbers came from, marked -dirty when the code that makes
// them has uncommitted changes: a number on a card must point at code
// anyone can check out.
let commit = ""
try {
  const git = (args) => execSync("git " + args, { cwd: ROOT, encoding: "utf8" }).trim()
  commit = git("rev-parse --short HEAD")
  if (git("status --porcelain -- fovea.middleware.js package.json scripts/sessions.mjs scripts/metrics.mjs")) commit += "-dirty"
} catch {}

const report = {
  package: pkg.name, version: pkg.version, commit,
  options: DEFAULTS,
  cost_model: { pricing: PRICING, unit: "chars x the shape's vendor multiplier" },
  shapes: SHAPES.map(shapeReport),
  sweep: sweep(),
  contract: contract(),
}

const out = join(ROOT, "promo", "metrics.json")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(report, null, 2) + "\n")
writeFileSync(join(ROOT, "promo", "metrics.js"), `globalThis.FoveaMetrics = ${JSON.stringify(report)};\n`)

for (const s of report.shapes) {
  console.log(`${s.name.padEnd(22)} ${s.turns} turns  size ${s.size.change_pct}%  cost ${s.cost.fovea_pct}% (naive ${s.cost.naive_pct > 0 ? "+" : ""}${s.cost.naive_pct}%)  cache breaks ${s.cache_breaks.fovea} (naive ${s.cache_breaks.naive})`)
}
console.log("cut_step sweep:", report.sweep.map((r) => `${r.cut_step}:${r.cost_pct}%/${r.cache_breaks}br`).join("  "))
console.log(`contract: ${report.contract.turns} turns, ${report.contract.compared} protected values compared, ${report.contract.changed} changed`)
console.log("wrote", out)
