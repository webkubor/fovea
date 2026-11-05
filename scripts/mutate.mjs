// Mutation check: does the test suite actually guard the contract?
//
// yetone's review of PR #467 deleted the marker-idempotence guard and every
// test still passed. A test that stays green when the code it guards is
// gone is not guarding it. This script breaks each guard in a scratch copy,
// one at a time, rebuilds the page bundle, runs `bun test`, and expects red.
//
//   bun scripts/mutate.mjs
//
// A mutant that survives (tests still green) is a hole in the tests: add the
// case that kills it. A mutant whose `find` no longer matches exactly once is
// stale (the code moved): update it rather than delete it. Either fails this
// script, so CI keeps the list honest as the middleware changes.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// Each mutant reverts one promise the README or a review made. `why` says
// which, so a survivor reads as the claim left untested.
export const MUTANTS = [
  { name: "the length gate keeps a cut result from being cut again", why: "0.2.3: idempotence by length, not by a marker an untrusted tool output could forge",
    find: `if (typeof text !== "string" || text.length <= head + tail + 80) return text`,
    replace: `if (typeof text !== "string") return text` },
  { name: "a forged marker does not exempt old content", why: "0.2.3: the marker in the content itself must exempt nothing",
    find: `if (typeof text !== "string" || text.length <= head + tail + 80) return text`,
    replace: `if (typeof text !== "string" || (text.length <= head + tail + 80 && !text.includes("[" + MARK + ":"))) return text` },
  { name: "a state marker counts only at the head of the agent's own text", why: "0.2.4: a marker quoted in a user turn or a tool result exempts nothing",
    find: `return text.trimStart().startsWith(marker)`, replace: `return text.includes(marker)` },
  { name: "surrogate pair, head end", why: "#467 review §3",
    find: `low(text.charCodeAt(n))) return n - 1`, replace: `low(text.charCodeAt(n))) return n` },
  { name: "surrogate pair, tail end", why: "#467 review §3",
    find: `low(text.charCodeAt(n))) return n + 1`, replace: `low(text.charCodeAt(n))) return n` },
  { name: "cut boundary moves in cut_step blocks", why: "#467 review §1: a sliding boundary breaks the cache every turn",
    find: `const start = Math.floor(at / cfg.cutStep) * cfg.cutStep`, replace: `const start = at` },
  { name: "old image keeps its cache_control", why: "#640 review §3",
    find: `if (cacheControl) part.cache_control = cacheControl`, replace: "" },
  { name: "a document is not an image", why: "#467 review §2",
    find: `return type === "image" || type === "image_url" || type === "input_image"`,
    replace: `return type === "image" || type === "image_url" || type === "input_image" || type === "document"` },
  { name: "the leading preamble keeps its exemption", why: "#640 review §4 (Codex: AGENTS.md first, task third): the task must stay whole",
    find: `const taskEnd = hasState ? 0 : leadingUserEnd(list, start)`,
    replace: `const taskEnd = 0` },
  { name: "a custom_tool_call is an answer too", why: "2026-11-05: a Responses body whose first answer was a custom_tool_call lost the preamble exemption",
    find: `"custom_tool_call", "custom_tool_call_output",`, replace: `` },
  { name: "the legacy functions API answer is thinned", why: "role \"function\" carried the oldest clients' tool output, untouched",
    find: `if (m.role === "tool" || m.role === "function") return slimContent(m, "content", cfg.toolHead, cfg.toolTail, cfg)`,
    replace: `if (m.role === "tool") return slimContent(m, "content", cfg.toolHead, cfg.toolTail, cfg)` },
  { name: "gemini function responses are thinned", why: "the Gemini tool output is the big one",
    find: `if (p.functionResponse) {
      changed = slimFunctionResponse(p, cfg) || changed`,
    replace: `if (p.functionResponse) {
      changed = false` },
  { name: "harness blocks are not the user's words", why: "2026-11-05: a trailing <system-reminder> read as a new question collapsed the history",
    find: `const spoken = withoutHarness(t)`, replace: `const spoken = t` },
  { name: "saccade judges against the task, not AGENTS.md", why: "#640 re-review §1",
    find: `const end = leadingUserEnd(list, list.length)`, replace: `const end = 0` },
  { name: "protect, default mode", why: "README: protect patterns stay whole",
    find: `if (cfg.protect.length && cfg.protect.some((re) => re.test(text))) return text\n`, replace: "" },
  { name: "protect, saccade mode", why: "README: protect is honoured in collapse mode too",
    find: `if (cfg.protect.some((re) => re.test(t))) return false\n`, replace: "" },
  { name: "the state block itself is never touched", why: "README: state_marker contract",
    find: `if (cfg.stateMarker && carriesState(item, cfg.stateMarker)) continue\n`, replace: "" },
  { name: "a state block lifts the task exemption", why: "README: state_marker contract",
    find: `const taskEnd = hasState ? 0 : leadingUserEnd(list, start)`, replace: `const taskEnd = leadingUserEnd(list, start)` },
  { name: "the message that tips the token budget is outside the window", why: "0.2.0 fix: the walk stopped on the overflow message",
    find: `return Math.min(byCount, Math.max(0, i + 1))`, replace: `return Math.min(byCount, Math.max(0, i))` },
  { name: "the larger of the two windows is kept", why: "README: keep_recent and keep_recent_tokens, larger wins",
    find: `return Math.min(byCount, Math.max(0, i + 1))`, replace: `return Math.max(byCount, Math.max(0, i + 1))` },
  { name: "under the threshold the body passes as it came", why: "README: threshold",
    find: `if (cfg.threshold > 0 && sizeOf(body) < cfg.threshold) return\n`, replace: "" },
  { name: "a short follow-up keeps the old context", why: "CHANGELOG 0.2.0: 「继续」类短跟进不触发",
    find: `if (a.size < 4 || b.size < 4) return false\n`, replace: "" },
  { name: "short old text survives a saccade", why: "saccade leaves text under NOTE_MIN as it is",
    find: `t === NOTE || t.length <= NOTE_MIN) return false`, replace: `t === NOTE) return false` },
  { name: "drop_old_images: false keeps old images", why: "README: drop_old_images option",
    find: `dropImages: o.drop_old_images !== false,`, replace: `dropImages: true,` },
  { name: "a tool call's answer is shortened, not removed", why: "README: tool pairing stays",
    find: `if (u !== c) { holder[key] = u; return true }`, replace: `if (u !== c) { delete holder[key]; return true }` },
  { name: "thinking blocks and tool_use are not ours", why: "#640 review: signatures byte-identical",
    find: `if (b && b.type === "text" && typeof b.text === "string") {\n          const u = cut(b.text`,
    replace: `if (b && typeof (b.text ?? b.thinking) === "string") {\n          if (b.thinking !== undefined) b.thinking = cut(b.thinking, cfg.textHead, cfg.textTail, "text", cfg)\n          if (typeof b.text !== "string") continue\n          const u = cut(b.text` },
]

function bunTest(dir) {
  const r = spawnSync("bun", ["test"], { cwd: dir, encoding: "utf8", timeout: 120_000 })
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") }
}

function main() {
  const src = readFileSync(join(ROOT, "fovea.middleware.js"), "utf8")
  const stale = MUTANTS.filter((m) => src.split(m.find).length - 1 !== 1)
  const work = mkdtempSync(join(tmpdir(), "fovea-mutate-"))
  try {
    cpSync(ROOT, work, { recursive: true, filter: (p) => !/[/\\](\.git|node_modules)([/\\]|$)/.test(p) })
    const base = bunTest(work)
    if (!base.ok) {
      console.error("the unmutated suite is not green; fix that first\n" + base.out.slice(-2000))
      process.exit(1)
    }
    const survivors = []
    for (const m of MUTANTS) {
      if (stale.includes(m)) continue
      writeFileSync(join(work, "fovea.middleware.js"), src.replace(m.find, m.replace))
      spawnSync("bun", ["build.mjs"], { cwd: work, encoding: "utf8" })
      const r = bunTest(work)
      console.log(`${r.ok ? "SURVIVED" : "killed  "}  ${m.name}`)
      if (r.ok) survivors.push(m)
    }
    writeFileSync(join(work, "fovea.middleware.js"), src)
    console.log("")
    for (const m of stale) console.error(`stale mutant (find matches ${src.split(m.find).length - 1}×, not once): ${m.name}`)
    for (const m of survivors) console.error(`survivor — no test guards this: ${m.name} (${m.why})`)
    if (stale.length || survivors.length) process.exit(1)
    console.log(`mutation check ok: ${MUTANTS.length} mutants, all killed`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
