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
    // the state block is the agent's own message and the marker is at the
    // head of its text (0.2.4 rule): a marker in a user turn is somebody
    // else's text and exempts nothing
    raw.messages[3].content.unshift({ type: "text", text: state })
    const sent = send(raw, { ...DEFAULTS, state_marker: marker, saccade })
    expect(json(sent.messages[3].content[0])).toBe(json({ type: "text", text: state }))
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

// ── harness 注入的块不是用户的话 ──────────────────────────────────────
// Claude Code 把 <system-reminder> 作为自己的 user 消息追加：token 预算、
// 工具指引、文件变更通知。它讲的不是用户的问题，与任务没有共同词，
// 词面判定会以为换了话题，把整段历史折叠掉（2026-11-05 对抗验收发现）。

const REMINDER = "<system-reminder>\nAs you answer the user's questions, you can use the following context: the user has 12000 weighted tokens left. Do not use any other tools.\n</system-reminder>"

// The task must not share words with the reminder: the topic test is a
// word-overlap ratio, and one shared word ("context" once did) is enough to
// mask the bug — the case passed with the guard removed.
const REMINDER_TASK = "Fix the flaky scheduler test in internal/sched: the retry timing assertion fails under load. " + "zz ".repeat(200)

function claudeWithReminder(rounds, trailing) {
  const raw = claudeCode(rounds)
  raw.messages[0].content[0].text = REMINDER_TASK
  raw.messages.push({ role: "user", content: [{ type: "text", text: "the scheduler retry timing assertion still fails, keep going" }] })
  if (trailing) raw.messages.push({ role: "user", content: [{ type: "text", text: REMINDER }] })
  return raw
}

test("Claude Code Messages, saccade auto: a trailing system-reminder is not the user asking a new question", () => {
  const options = { ...DEFAULTS, saccade: "auto", keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 }
  for (const trailing of [false, true]) {
    const raw = claudeWithReminder(120, trailing)
    const sent = send(raw, options)
    expect(json(sent)).not.toContain("prior topic not carried")
  }
})

test("Claude Code Messages, saccade auto: a real new topic still collapses, with or without a system-reminder", () => {
  const options = { ...DEFAULTS, saccade: "auto", keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 }
  for (const trailing of [false, true]) {
    const raw = claudeWithReminder(120, trailing)
    raw.messages.push({ role: "user", content: [{ type: "text", text: "unrelated: draft a release announcement email aimed at marketing newsletter readers" }] })
    expect(json(send(raw, options))).toContain("prior topic not carried")
  }
})

test("Claude Code Messages, saccade auto: a system-reminder inside the task message does not become the task", () => {
  const options = { ...DEFAULTS, saccade: "auto", keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 }
  const raw = claudeCode(120)
  raw.messages[0].content[0].text = REMINDER_TASK
  raw.messages[0].content.push({ type: "text", text: REMINDER })
  raw.messages.push({ role: "user", content: [{ type: "text", text: "the scheduler retry timing assertion still fails, keep going" }] })
  expect(json(send(raw, options))).not.toContain("prior topic not carried")
})

// ── 工作集与开局消息（2026-11-17，Claude Code autocompact 抖动） ──────
// 一个会话反复读同一批文件时，裁掉它们不会省钱：模型会再读一次，而每次
// 重读都把原样消息加进 harness 自己统计的对话里——那才是把上下文撑满、
// 触发压缩的东西。所以窗口可以滑过历史，但不能滑过「重复读过的目标的最新
// 一次结果」。

const BIG_TOOL = "a tool output with a lot of text in it. ".repeat(120)

function fillerRound(i) {
  return [
    { role: "assistant", content: [{ type: "tool_use", id: "u" + i, name: "Shell", input: { command: "ls " + i } }] },
    // long enough to be worth thinning: saccade leaves short text as it is
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u" + i, content: "round " + i + " output. " + "filler ".repeat(220) }] },
  ]
}

function repeatedReadSession() {
  const messages = [{ role: "user", content: [{ type: "text", text: "fix the switcher" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "switcher.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: BIG_TOOL }] }]
  for (let i = 1; i <= 6; i++) messages.push(...fillerRound(i))
  // the model comes back to the same file
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "r2", name: "Read", input: { file_path: "switcher.ts" } }] })
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "r2", content: BIG_TOOL }] })
  for (let i = 7; i <= 10; i++) messages.push(...fillerRound(i))
  return { model: "m", messages }
}

test("the working set stays whole: a target the model reads twice keeps its newest read, the rest still thins", () => {
  const raw = repeatedReadSession()
  const r2 = raw.messages.findIndex((m) => m.role === "user" && m.content?.[0]?.tool_use_id === "r2")
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  expect(json(sent.messages[r2])).toBe(json(raw.messages[r2]))
  // the older duplicate is still thinned: only the newest read must stay
  const r1 = raw.messages.findIndex((m) => m.role === "user" && m.content?.[0]?.tool_use_id === "r1")
  expect(sent.messages[r1].content[0].content).toContain("[fovea:")
  // and so is unrelated old content (the first filler's tool result)
  expect(sent.messages[4].content[0].content).toContain("[fovea:")
})

// 2026-11-17 review, the first design: the working set was protected by
// pulling the window back to it. The cut is a prefix, so that kept
// everything after it whole as well — an 800-message session then sent
// 100% uncut. The working set is now a hole in the cut, and this session
// (a target read twice at the very start, then a long stretch of other
// work) must still be thinned.
test("a working set read long ago does not switch the trimming off", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "the task this session began with, and then some more of it. " + "context ".repeat(60) }] }]
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Read", input: { file_path: "old.ts" } }] })
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: BIG_TOOL }] })
  for (let i = 1; i <= 8; i++) messages.push(...fillerRound(i))
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "a2", name: "Read", input: { file_path: "old.ts" } }] })
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "a2", content: BIG_TOOL }] })
  for (let i = 9; i <= 160; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "g" + i, name: "Shell", input: { command: "ls " + i } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "g" + i, content: "round " + i + " output. " + "filler ".repeat(1000) }] })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 12, cut_step: 24 })
  const before = json(raw).length, after = json(sent).length
  expect(after).toBeLessThan(before * 0.5)
  // the newest read of the repeated target is still whole
  const a2 = raw.messages.findIndex((m) => m.role === "user" && m.content?.[0]?.tool_use_id === "a2")
  expect(json(sent.messages[a2])).toBe(json(raw.messages[a2]))
})

// Gemini pairs a function response by name where the request leaves the id
// out — the working set must be found there too, or the guard misses it.
test("Gemini: a function called twice without ids is still recognised as a working set", () => {
  const call = (id, args) => ({ role: "model", parts: [{ functionCall: { id, name: "read_file", args } }] })
  const answer = (id, text) => ({ role: "user", parts: [{ functionResponse: { id, name: "read_file", response: { output: text } } }] })
  const messages = [{ role: "user", parts: [{ text: "the task" }] }]
  for (let i = 1; i <= 6; i++) {
    messages.push(call("c" + i, { path: "f" + i + ".go" }))
    messages.push(answer("c" + i, "output " + i + " " + "x".repeat(2000)))
  }
  messages.push(call(undefined, { path: "old.go" }))
  messages.push(answer(undefined, "old output " + "y".repeat(2000)))
  for (let i = 7; i <= 12; i++) {
    messages.push(call("c" + i, { path: "f" + i + ".go" }))
    messages.push(answer("c" + i, "output " + i + " " + "x".repeat(2000)))
  }
  messages.push(call(undefined, { path: "old.go" }))
  messages.push(answer(undefined, "old output " + "y".repeat(2000)))
  const raw = { model: "m", contents: messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const last = sent.contents.length - 1
  expect(json(sent.contents[last])).toBe(json(raw.contents[last]))
})

test("the opening message is the session's state: a saccade does not collapse it", () => {
  const raw = { model: "m", messages: [
    // long enough to be collapsible, or removing the guard changes nothing
    { role: "user", content: [{ type: "text", text: "the original task this session began with, spelled out at some length. " + "context ".repeat(60) }] },
  ] }
  for (let i = 1; i <= 8; i++) raw.messages.push(...fillerRound(i))
  raw.messages.push({ role: "user", content: [{ type: "text", text: "unrelated: draft a release announcement email aimed at marketing newsletter readers" }] })
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1, saccade: "always" })
  expect(json(sent.messages[0])).toBe(json(raw.messages[0]))
  // the rest of the history is still dropped as a saccade drops it
  expect(json(sent)).toContain("prior topic not carried")
})


// The pinned result must sit OUTSIDE the recent window, or the assertion
// passes without the guard doing anything: with keep_recent 1 the last
// message is kept whole anyway.
const FILLED = 6

// ── 工作集在四种协议里都要认得出来（2026-11-17 第二轮验收） ──────────
// 上一版只在 Anthropic 与 Gemini 无 id 两种形状上有测试：Gemini 带 id 的
// 真实形状下洞根本不生效（id 在 functionCall 里，不在 part 上），Chat 与
// Responses 的配对路径也没有测试守着。
//
// 每个用例都把「被钉住的那次读」放在窗口之外（后面还有 FILLED 轮），
// 否则断言会自己通过：keep_recent 1 时最后一条消息本来就不会被裁。

function expectPinnedOutside(raw, index) {
  expect(index).toBeGreaterThan(raw.length - FILLED * 2 - 3)
}

test("Anthropic: a file read twice keeps its newest read whole", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "the task" }] }]
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: "f" + i + ".ts" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: BIG_TOOL }] })
  }
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "x1", name: "Read", input: { file_path: "old.ts" } }] })
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: BIG_TOOL }] })
  for (let i = 7; i <= 12; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: "f" + i + ".ts" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: BIG_TOOL }] })
  }
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "x2", name: "Read", input: { file_path: "old.ts" } }] })
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "x2", content: BIG_TOOL }] })
  for (let i = 13; i <= 18; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: "f" + i + ".ts" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: BIG_TOOL }] })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const pinned = raw.messages.findIndex((m) => m.role === "user" && m.content?.[0]?.tool_use_id === "x2")
  expectPinnedOutside(raw.messages, pinned)
  expect(json(sent.messages[pinned])).toBe(json(raw.messages[pinned]))
  expect(json(sent.messages[2])).toContain("[fovea:")
})

test("Chat: a file read twice keeps its newest tool result whole", () => {
  const messages = [{ role: "user", content: "the task" }]
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "old" }) } }] })
  messages.push({ role: "tool", tool_call_id: "x1", content: BIG_TOOL })
  for (let i = 7; i <= 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "x2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "old" }) } }] })
  messages.push({ role: "tool", tool_call_id: "x2", content: BIG_TOOL })
  for (let i = 13; i <= 18; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const pinned = raw.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "x2")
  expectPinnedOutside(raw.messages, pinned)
  expect(json(sent.messages[pinned])).toBe(json(raw.messages[pinned]))
  expect(json(sent.messages[2])).toContain("[fovea:")
})

test("Responses: a file read twice keeps its newest output whole", () => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "the task" }] }]
  for (let i = 1; i <= 6; i++) {
    input.push({ type: "function_call", id: "fc" + i, call_id: "c" + i, name: "shell", arguments: JSON.stringify({ command: ["cat", "f" + i] }) })
    input.push({ type: "function_call_output", call_id: "c" + i, output: BIG_TOOL })
  }
  input.push({ type: "function_call", id: "fx1", call_id: "cx1", name: "shell", arguments: JSON.stringify({ command: ["cat", "old"] }) })
  input.push({ type: "function_call_output", call_id: "cx1", output: BIG_TOOL })
  for (let i = 7; i <= 12; i++) {
    input.push({ type: "function_call", id: "fc" + i, call_id: "c" + i, name: "shell", arguments: JSON.stringify({ command: ["cat", "f" + i] }) })
    input.push({ type: "function_call_output", call_id: "c" + i, output: BIG_TOOL })
  }
  input.push({ type: "function_call", id: "fx2", call_id: "cx2", name: "shell", arguments: JSON.stringify({ command: ["cat", "old"] }) })
  input.push({ type: "function_call_output", call_id: "cx2", output: BIG_TOOL })
  for (let i = 13; i <= 18; i++) {
    input.push({ type: "function_call", id: "fc" + i, call_id: "c" + i, name: "shell", arguments: JSON.stringify({ command: ["cat", "f" + i] }) })
    input.push({ type: "function_call_output", call_id: "c" + i, output: BIG_TOOL })
  }
  const raw = { model: "m", input }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const pinned = raw.input.findIndex((m) => m.type === "function_call_output" && m.call_id === "cx2")
  expectPinnedOutside(raw.input, pinned)
  expect(json(sent.input[pinned])).toBe(json(raw.input[pinned]))
  expect(json(sent.input[2])).toContain("[fovea:")
})

test("Gemini with ids: a file read twice keeps its newest response whole", () => {
  const contents = [{ role: "user", parts: [{ text: "the task" }] }]
  for (let i = 1; i <= 6; i++) {
    contents.push({ role: "model", parts: [{ functionCall: { id: "fc" + i, name: "read_file", args: { path: "f" + i } } }] })
    contents.push({ role: "user", parts: [{ functionResponse: { id: "fc" + i, name: "read_file", response: { output: BIG_TOOL } } }] })
  }
  contents.push({ role: "model", parts: [{ functionCall: { id: "fx1", name: "read_file", args: { path: "old" } } }] })
  contents.push({ role: "user", parts: [{ functionResponse: { id: "fx1", name: "read_file", response: { output: BIG_TOOL } } }] })
  for (let i = 7; i <= 12; i++) {
    contents.push({ role: "model", parts: [{ functionCall: { id: "fc" + i, name: "read_file", args: { path: "f" + i } } }] })
    contents.push({ role: "user", parts: [{ functionResponse: { id: "fc" + i, name: "read_file", response: { output: BIG_TOOL } } }] })
  }
  contents.push({ role: "model", parts: [{ functionCall: { id: "fx2", name: "read_file", args: { path: "old" } } }] })
  contents.push({ role: "user", parts: [{ functionResponse: { id: "fx2", name: "read_file", response: { output: BIG_TOOL } } }] })
  for (let i = 13; i <= 18; i++) {
    contents.push({ role: "model", parts: [{ functionCall: { id: "fc" + i, name: "read_file", args: { path: "f" + i } } }] })
    contents.push({ role: "user", parts: [{ functionResponse: { id: "fc" + i, name: "read_file", response: { output: BIG_TOOL } } }] })
  }
  const raw = { model: "m", contents }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const pinned = raw.contents.findIndex((c) => c.role === "user" && c.parts?.[0]?.functionResponse?.id === "fx2")
  expectPinnedOutside(raw.contents, pinned)
  expect(json(sent.contents[pinned])).toBe(json(raw.contents[pinned]))
})

test("Gemini without ids, interleaved calls: the newest result of the repeated call is the one kept", () => {
  const contents = [{ role: "user", parts: [{ text: "the task" }] }]
  const call = (name, args) => ({ role: "model", parts: [{ functionCall: { name, args } }] })
  const answer = (name, text) => ({ role: "user", parts: [{ functionResponse: { name, response: { output: text } } }] })
  contents.push(call("read_a", { path: "a" })); contents.push(answer("read_a", "a " + "x".repeat(2000)))
  contents.push(call("read_b", { path: "b" })); contents.push(answer("read_b", "b " + "x".repeat(2000)))
  contents.push(call("read_a", { path: "a" })); contents.push(answer("read_a", "a " + "y".repeat(2000)))
  for (let i = 0; i < FILLED; i++) {
    contents.push(call("read_c", { path: "z" + i })); contents.push(answer("read_c", "z " + "x".repeat(2000)))
  }
  const raw = { model: "m", contents }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const answers = raw.contents.filter((c) => c.role === "user" && c.parts?.[0]?.functionResponse)
  const pinned = raw.contents.indexOf(answers[2])
  expect(json(sent.contents[pinned])).toBe(json(raw.contents[pinned]))
})

test("the same call written with another key order is still the same call", () => {
  const messages = [{ role: "user", content: "the task" }]
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "read", arguments: '{"path": "old"}' } }] })
  messages.push({ role: "tool", tool_call_id: "x1", content: BIG_TOOL })
  for (let i = 7; i <= 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "x2", type: "function", function: { name: "read", arguments: '{ "path" : "old" }' } }] })
  messages.push({ role: "tool", tool_call_id: "x2", content: BIG_TOOL })
  for (let i = 13; i <= 18; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const pinned = raw.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "x2")
  expectPinnedOutside(raw.messages, pinned)
  expect(json(sent.messages[pinned])).toBe(json(raw.messages[pinned]))
})

// Gemini with ids: the id pairs the answer with its own call even when the
// answers come back in another order. Falling back to the name alone would
// pair them by position and pin the wrong message (2026-11-17 round 2).
test("Gemini: ids pair the answer with its own call when the answers come back out of order", () => {
  const contents = [{ role: "user", parts: [{ text: "the task" }] }]
  const call = (id, args) => ({ role: "model", parts: [{ functionCall: { id, name: "read_file", args } }] })
  const answer = (id, text) => ({ role: "user", parts: [{ functionResponse: { id, name: "read_file", response: { output: text } } }] })
  contents.push(call("c1", { path: "x" }))
  contents.push(call("c2", { path: "y" }))
  contents.push(call("c3", { path: "x" }))
  contents.push(answer("c3", "the x answer again " + "z".repeat(2000)))  // out of order
  contents.push(answer("c1", "the x answer " + "x".repeat(2000)))
  contents.push(answer("c2", "the y answer " + "y".repeat(2000)))
  for (let i = 0; i < FILLED; i++) {
    contents.push(call("f" + i, { path: "f" + i }))
    contents.push(answer("f" + i, "filler " + "w".repeat(2000)))
  }
  const raw = { model: "m", contents }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const yAnswer = raw.contents.findIndex((c) => c.role === "user" && c.parts?.[0]?.functionResponse?.id === "c2")
  const xAgain = raw.contents.findIndex((c) => c.role === "user" && c.parts?.[0]?.functionResponse?.id === "c3")
  expect(xAgain).toBeLessThan(yAnswer)
  // the repeated x call keeps its newest answer whole
  expect(json(sent.contents[xAgain])).toBe(json(raw.contents[xAgain]))
  // and the answer of the other call is not pinned by mistake
  expect(json(sent.contents[yAnswer])).toContain("[fovea:")
})

// ── 配对逻辑的边界（2026-11-17 第三轮验收的盲区） ─────────────────────
// 上面几条护住了「哪种形状」，没护住「怎么配对」。这里补四件：没有 id 的
// 形状按位置配对（不是按后到先得）、参数不是 JSON 时空白也要归一、同一
// id 重复出现时按先到先得、一个调用的答案不会被后来的结果改指。

test("Gemini without ids: answers are paired by position, not by whoever answers last", () => {
  const contents = [{ role: "user", parts: [{ text: "the task" }] }]
  const call = (name, args) => ({ role: "model", parts: [{ functionCall: { name, args } }] })
  const answer = (name, text) => ({ role: "user", parts: [{ functionResponse: { name, response: { output: text } } }] })
  contents.push(call("read_a", { path: "a" }))
  contents.push(call("read_b", { path: "b" }))
  contents.push(answer("read_a", "the a answer " + "a".repeat(2000)))
  contents.push(answer("read_b", "the b answer " + "b".repeat(2000)))
  for (let i = 0; i < FILLED; i++) {
    contents.push(call("read_c", { path: "z" + i })); contents.push(answer("read_c", "z " + "x".repeat(2000)))
  }
  const raw = { model: "m", contents }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  // both answers are answers to different calls: neither is a working set
  expect(json(sent.contents[3])).toContain("[fovea:")
  expect(json(sent.contents[4])).toContain("[fovea:")
})

test("a client that reuses one id for several calls: the answers pair in call order", () => {
  const messages = [{ role: "user", content: "the task" }]
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "same", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "old" }) } }] })
    messages.push({ role: "tool", tool_call_id: "same", content: BIG_TOOL })
  }
  for (let i = 7; i <= 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "same", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "old" }) } }] })
  messages.push({ role: "tool", tool_call_id: "same", content: BIG_TOOL })
  for (let i = 13; i <= 18; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  // the answer to the most recent call under that id is the one kept whole
  const answers = raw.messages.filter((m) => m.role === "tool" && m.tool_call_id === "same")
  const pinned = raw.messages.indexOf(answers[answers.length - 1])
  expectPinnedOutside(raw.messages, pinned)
  expect(json(sent.messages[pinned])).toBe(json(raw.messages[pinned]))
})

test("arguments that are not JSON are compared with their whitespace folded", () => {
  const messages = [{ role: "user", content: "the task" }]
  for (let i = 1; i <= 6; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "run", arguments: "ls  -l   /tmp" } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "run", arguments: "grep -rn foo /repo" } }] })
  messages.push({ role: "tool", tool_call_id: "x1", content: BIG_TOOL })
  for (let i = 7; i <= 12; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "run", arguments: "ls  -l   /tmp" } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  // the same call, written with different spacing
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "x2", type: "function", function: { name: "run", arguments: "grep  -rn  foo   /repo" } }] })
  messages.push({ role: "tool", tool_call_id: "x2", content: BIG_TOOL })
  for (let i = 13; i <= 18; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "run", arguments: "ls  -l   /tmp" } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const pinned = raw.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "x2")
  expectPinnedOutside(raw.messages, pinned)
  expect(json(sent.messages[pinned])).toBe(json(raw.messages[pinned]))
})

// A shape with no ids pairs its answers by position. When the answers come
// back in order that is the only sensible rule, and it is observable: the
// pin lands on the answer of the most recent call of the repeated target.
// Pairing by "whoever answers last" would pin a different message.
test("Gemini without ids: the pin is the answer of the most recent call of the repeated target", () => {
  const contents = [{ role: "user", parts: [{ text: "the task" }] }]
  const call = (name, args) => ({ role: "model", parts: [{ functionCall: { name, args } }] })
  const answer = (name, text) => ({ role: "user", parts: [{ functionResponse: { name, response: { output: text } } }] })
  // one turn, three calls, then the answers — the shape Gemini really sends
  contents.push(call("read_a", { path: "a" }))
  contents.push(call("read_b", { path: "b" }))
  contents.push(call("read_a", { path: "a" }))
  contents.push(answer("read_a", "the a answer " + "a".repeat(2000)))
  contents.push(answer("read_b", "the b answer " + "b".repeat(2000)))
  contents.push(answer("read_a", "the a answer again " + "z".repeat(2000)))
  for (let i = 0; i < FILLED; i++) {
    contents.push(call("read_c", { path: "z" + i })); contents.push(answer("read_c", "z " + "x".repeat(2000)))
  }
  const raw = { model: "m", contents }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const aAnswers = raw.contents.filter((c) => c.role === "user" && c.parts?.[0]?.functionResponse && c.parts[0].functionResponse.response.output.startsWith("the a answer"))
  const pinned = raw.contents.indexOf(aAnswers[1])
  expectPinnedOutside(raw.contents, pinned)
  expect(json(sent.contents[pinned])).toBe(json(raw.contents[pinned]))
})

// ── 配对方向的护栏（2026-11-17 第四轮验收） ──────────────────────────
// 一个 id 被复用时，答案按调用顺序配：批次里的两个调用先于答案回来时，
// 先到的答案属于先发的调用。这条契约写在 CHANGELOG 里，之前没有护栏。

test("a reused id: when the calls of one batch all come before their answers, the answers pair in call order", () => {
  const messages = [{ role: "user", content: "the task" }]
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "same", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "old" }) } }] })
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "same", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "old" }) } }] })
  messages.push({ role: "tool", tool_call_id: "same", content: "the first answer " + "a".repeat(2000) })
  messages.push({ role: "tool", tool_call_id: "same", content: "the second answer " + "b".repeat(2000) })
  for (let i = 1; i <= FILLED; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "f" + i }) } }] })
    messages.push({ role: "tool", tool_call_id: "c" + i, content: BIG_TOOL })
  }
  const raw = { model: "m", messages }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  // the second answer belongs to the most recent call of the repeated target
  const second = raw.messages.findIndex((m) => m.role === "tool" && m.content.startsWith("the second answer"))
  expectPinnedOutside(raw.messages, second)
  expect(json(sent.messages[second])).toBe(json(raw.messages[second]))
})

// A call whose id happens to be a tool name must not steal the answers of
// the calls that have no id at all: that was the second and third round
// defect, and it can come back silently.
test("a call id that is a tool name does not steal the answers of the calls without ids", () => {
  const contents = [{ role: "user", parts: [{ text: "the task" }] }]
  const call = (id, name, args) => ({ role: "model", parts: [{ functionCall: { id, name, args } }] })
  const answer = (id, name, text) => ({ role: "user", parts: [{ functionResponse: { id, name, response: { output: text } } }] })
  // a call whose id is the tool's own name
  contents.push(call("read_file", "read_file", { path: "decoy" }))
  // a call with no id, made twice
  contents.push(call(undefined, "read_file", { path: "old" }))
  contents.push(call(undefined, "read_file", { path: "old" }))
  // three answers with no id for two calls: if the name were folded into
  // the id, the first would collide with the decoy and the answers would
  // slide down the calls — the pinned answer would be a different one
  contents.push(answer(undefined, "read_file", "the old answer one " + "a".repeat(2000)))
  contents.push(answer(undefined, "read_file", "the old answer two " + "b".repeat(2000)))
  contents.push(answer(undefined, "read_file", "the old answer three " + "c".repeat(2000)))
  for (let i = 0; i < FILLED; i++) {
    contents.push(call("f" + i, "read_file", { path: "z" + i }))
    contents.push(answer("f" + i, "read_file", "z " + "x".repeat(2000)))
  }
  const raw = { model: "m", contents }
  const sent = send(raw, { ...DEFAULTS, threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  const oldAnswers = raw.contents.filter((c) => c.role === "user" && c.parts?.[0]?.functionResponse?.response?.output?.startsWith("the old answer"))
  // the second answer belongs to the most recent of the two calls
  const pinned = raw.contents.indexOf(oldAnswers[1])
  expectPinnedOutside(raw.contents, pinned)
  expect(json(sent.contents[pinned])).toBe(json(raw.contents[pinned]))
})
