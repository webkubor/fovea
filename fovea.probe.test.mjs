// Multi-turn probes in the shapes real clients send, run with the options
// the package ships. This is yetone's measurement from the PR #467 / #640
// reviews made permanent: hand-written fixtures in fovea.test.mjs check one
// rule at a time; these check the contract over a whole session, turn after
// turn — what must stay byte-identical, what the prompt cache sees, and
// whether thinning actually costs less than not thinning.
//
// Each turn is the previous turn's history plus one round, as an agent
// re-sends it. The middleware works on a copy; the agent's own history is
// never what the gateway sent upstream, so each turn starts from raw input.
import { test, expect } from "bun:test"
import { onRequest } from "./fovea.middleware.js"
import { DEFAULTS, TASK, SHAPES, claudeCode, codex, json, send, session as run } from "./scripts/sessions.mjs"

// ── what must not change ───────────────────────────────────────────────

function strings(v, out = []) {
  if (typeof v === "string") out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === "object") for (const k of Object.keys(v)) strings(v[k], out)
  return out
}

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function countKey(v, key) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countKey(x, key), 0)
  if (!v || typeof v !== "object") return 0
  let n = key in v ? 1 : 0
  for (const k of Object.keys(v)) n += countKey(v[k], key)
  return n
}

// Everything that is the client's or the provider's, not the history's
// prose: ids, pairing halves, signed and encrypted blocks, documents.
function machinery(item) {
  const out = { role: item.role, type: item.type, call_id: item.call_id, tool_call_id: item.tool_call_id,
    tool_calls: item.tool_calls, reasoning_content: item.reasoning_content }
  if (item.type === "reasoning" || item.type === "function_call") out.whole = item
  if (Array.isArray(item.content)) {
    out.blocks = item.content.map((b) => {
      if (!b || typeof b !== "object") return b
      if (b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use" || b.type === "document") return b
      return { type: b.type === "image" || b.type === "input_image" ? "image-or-note" : b.type === "text" && b.text?.startsWith("[fovea:") ? "image-or-note" : b.type,
        tool_use_id: b.tool_use_id, cache_control: b.cache_control }
    })
  }
  return out
}

function assertContract(shape, before, after) {
  for (const key of ["model", "system", "tools", "instructions"]) expect(json(after[key])).toBe(json(before[key]))
  const a = shape.list(before), b = shape.list(after)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) expect(json(machinery(b[i]))).toBe(json(machinery(a[i])))
  expect(countKey(after, "cache_control")).toBe(countKey(before, "cache_control"))
  for (const s of strings(after)) if (LONE.test(s)) throw new Error("lone surrogate in: " + json(s.slice(0, 80)))
}

// every turn of every session runs the contract check
const session = (shape, options) => run(shape, options, (raw, sent) => assertContract(shape, raw, sent))

for (const shape of SHAPES) {
  test(`${shape.name}: ${shape.turns[1] - shape.turns[0]} turns with shipped defaults keep the contract, thin the history and cost less`, () => {
    const s = session(shape)
    // it actually thins: a probe that never cuts proves nothing
    expect(s.sizeAfter).toBeLessThan(s.sizeBefore * 0.6)
    // the cut prefix moves in blocks: at most one break per cut_step messages
    expect(s.breaks).toBeGreaterThan(0)
    expect(s.breaks).toBeLessThanOrEqual(Math.ceil(s.turns * shape.step / DEFAULTS.cut_step) + 1)
    // and with the cache counted, the thinned session is the cheaper one
    expect(s.cost).toBeLessThan(s.baseline)
  })

  test(`${shape.name}: the break count is the cut_step at work (cut_step 1 breaks nearly every turn)`, () => {
    const fine = session(shape, { ...DEFAULTS, cut_step: 1 })
    const blocky = session(shape)
    expect(fine.breaks).toBeGreaterThan(blocky.breaks * 4)
  })
}

test("Codex Responses: the whole preamble (developer, AGENTS.md, environment_context, task) reaches upstream byte-identical on every turn", () => {
  for (let t = 5; t <= 70; t++) {
    const raw = codex(t)
    const sent = send(raw)
    for (let i = 0; i < 4; i++) expect(json(sent.input[i])).toBe(json(raw.input[i]))
  }
})

test("Claude Code Messages: the task message and the old image's cache_control survive every turn", () => {
  for (let t = 5; t <= 120; t++) {
    const raw = claudeCode(t)
    const sent = send(raw)
    expect(json(sent.messages[0])).toBe(json(raw.messages[0]))
    const imageTurn = sent.messages[6].content
    expect(imageTurn[2].cache_control).toEqual({ type: "ephemeral" })
  }
})

test("Codex Responses, saccade auto: a session that stays on its task never collapses", () => {
  const options = { ...DEFAULTS, saccade: "auto" }
  for (let t = 5; t <= 70; t++) {
    const raw = codex(t)
    raw.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "the scheduler retry timing assertion in internal/sched still fails under load, keep going" }] })
    expect(json(send(raw, options))).not.toContain("prior topic not carried")
  }
})

test("Codex Responses, saccade auto: a real topic change collapses the old context and keeps pairing", () => {
  const options = { ...DEFAULTS, saccade: "auto" }
  const raw = codex(70)
  raw.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "unrelated: draft a release announcement email aimed at marketing newsletter readers" }] })
  const sent = send(raw, options)
  expect(json(sent)).toContain("prior topic not carried")
  assertContract(SHAPES[1], raw, sent)
})

// ── guards the mutation check found unguarded (scripts/mutate.mjs) ─────

test("under the shipped threshold a long session passes as it came, though the same body would be thinned at threshold 0", () => {
  // sized to sit under the threshold while the token window still leaves
  // whole cut_step blocks outside it, so threshold 0 would really cut
  const messages = [{ role: "user", content: "fix the scheduler test" }]
  for (let r = 1; r <= 70; r++) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${r}`, type: "function", function: { name: "read", arguments: "{}" } }] })
    messages.push({ role: "tool", tool_call_id: `c${r}`, content: "line of output\n".repeat(68) })
  }
  const body = { model: "m", messages }
  expect(json(body).length).toBeLessThan(DEFAULTS.threshold)
  expect(json(send(body, { ...DEFAULTS, threshold: 0 }))).not.toBe(json(body))
  expect(onRequest(structuredClone(body), { options: DEFAULTS })).toBeUndefined()
})

test("Codex Responses, saccade auto: a short follow-up (继续, 接着改) has no direction of its own and keeps the old context", () => {
  const options = { ...DEFAULTS, saccade: "auto" }
  for (const q of ["继续", "接着改", "go on"]) {
    const raw = codex(70)
    raw.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: q }] })
    expect(json(send(raw, options))).not.toContain("prior topic not carried")
  }
})

test("Claude Code Messages, state_marker: an old long state block stays whole in both modes, and the raw task is thinned instead", () => {
  const marker = "<!-- fovea:state -->"
  const state = marker + "\n" + JSON.stringify({ task: "fix sched retry timing", constraints: ["public API unchanged"], decisions: Array.from({ length: 60 }, (_, i) => `decision ${i}: kept`) })
  for (const saccade of ["off", "always"]) {
    const raw = claudeCode(80)
    raw.messages[2].content.push({ type: "text", text: state })
    const sent = send(raw, { ...DEFAULTS, state_marker: marker, saccade })
    expect(json(sent.messages[2].content.at(-1))).toBe(json({ type: "text", text: state }))
    expect(json(sent.messages[0])).not.toBe(json(raw.messages[0]))
  }
})

test("drop_old_images: false keeps an old image, in a message and inside a tool result", () => {
  const raw = claudeCode(80)
  raw.messages[8].content[0].content = [{ type: "text", text: "screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(2000) } }]
  const kept = send(raw, { ...DEFAULTS, drop_old_images: false })
  expect(json(kept.messages[6].content[2])).toBe(json(raw.messages[6].content[2]))
  expect(json(kept.messages[8].content[0].content[1])).toBe(json(raw.messages[8].content[0].content[1]))
  const dropped = send(raw)
  expect(dropped.messages[6].content[2].type).toBe("text")
  expect(dropped.messages[8].content[0].content[1].type).toBe("text")
})
