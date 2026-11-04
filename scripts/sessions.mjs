// Whole agent sessions in the shapes real clients send, and what the
// provider's prompt cache makes of them. fovea.probe.test.mjs asserts the
// contract over these sessions; scripts/metrics.mjs reports their numbers.
// One source for both, so a number in a chart is a number a test ran on.
//
// Each turn is the previous turn's history plus one round, as an agent
// re-sends it. The middleware works on a copy; the agent's own history is
// never what the gateway sent upstream, so each turn starts from raw input.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { onRequest } from "../fovea.middleware.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const DEFAULTS = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).magpie.options

export const json = (v) => JSON.stringify(v)

export function send(body, options = DEFAULTS) {
  const copy = structuredClone(body)
  return onRequest(copy, { options }) ?? body
}

// A tool output whose head and tail cuts both land inside an emoji's
// surrogate pair at the shipped tool_head/tool_tail, and one that doesn't.
export function toolOutput(r) {
  const head = "x".repeat(DEFAULTS.tool_head - 1) + "😀"
  const tail = "😀" + "y".repeat(DEFAULTS.tool_tail - 1)
  const body = `round ${r}: ` + "src line 🙂 with text\n".repeat(240)
  return r % 2 ? head + body + tail : body + "end of output " + r
}

export const TASK = "Fix the flaky scheduler test in internal/sched: the retry timing assertion fails under load, and keep the public API unchanged. " + "context ".repeat(280)

export function claudeCode(rounds) {
  const messages = [{ role: "user", content: [{ type: "text", text: TASK }] }]
  for (let r = 1; r <= rounds; r++) {
    messages.push({ role: "assistant", content: [
      // real thinking runs long; every other round is over the text cut size
      { type: "thinking", thinking: `round ${r}: what to read next. ` + "t".repeat(r % 2 ? 700 : 2600), signature: `sig_${r}_` + "s".repeat(120) },
      { type: "text", text: `Reading file ${r}.` },
      { type: "tool_use", id: `toolu_${r}`, name: "Read", input: { file_path: `/repo/f${r}.go` } },
    ] })
    const content = [{ type: "tool_result", tool_use_id: `toolu_${r}`, content: toolOutput(r) }]
    if (r === 3) {
      content.push({ type: "text", text: "Here is the failing run." })
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" + "A".repeat(3000) }, cache_control: { type: "ephemeral" } })
    }
    if (r === 4) content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: "spec ".repeat(800) } })
    messages.push({ role: "user", content })
  }
  return {
    model: "claude-test",
    system: [{ type: "text", text: "You are a coding agent. " + "S".repeat(4000), cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
    messages,
  }
}

export function codex(rounds) {
  const input = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "sandbox policy " + "P".repeat(2000) }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\nUse pnpm, keep commits small, document public functions. " + "A".repeat(3000) }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/repo</cwd>\n<shell>zsh</shell>\n" + "E".repeat(600) }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: TASK }] },
  ]
  for (let r = 1; r <= rounds; r++) {
    input.push({ type: "reasoning", id: `rs_${r}`, summary: [], encrypted_content: `gAAAA${r}` + "e".repeat(1500) })
    input.push({ type: "function_call", id: `fc_${r}`, call_id: `call_${r}`, name: "shell", arguments: JSON.stringify({ command: ["cat", `f${r}.go`] }) })
    input.push({ type: "function_call_output", call_id: `call_${r}`, output: toolOutput(r) })
  }
  return { model: "gpt-test", instructions: "codex base instructions " + "I".repeat(2000), tools: [{ type: "function", name: "shell" }], input }
}

export function chat(rounds) {
  const messages = [{ role: "system", content: "You are a coding agent. " + "S".repeat(3000) }, { role: "user", content: TASK }]
  for (let r = 1; r <= rounds; r++) {
    messages.push({ role: "assistant", content: "", reasoning_content: `round ${r} reasoning ` + "r".repeat(600),
      tool_calls: [{ id: `call_${r}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${r}.go` }) } }] })
    messages.push({ role: "tool", tool_call_id: `call_${r}`, content: toolOutput(r) })
  }
  return { model: "chat-test", messages }
}

// Cache price multipliers on the base input price, by vendor. Anthropic
// charges a premium to write the cache (1.25x for the 5-minute cache) and
// 0.1x to read it; OpenAI writes at the plain input price and reads cached
// input at 0.1x (the GPT-5 family; older models read at 0.25x-0.5x, which
// makes thinning worth more, not less).
export const PRICING = {
  anthropic: { vendor: "Anthropic", read: 0.1, write: 1.25 },
  openai: { vendor: "OpenAI", read: 0.1, write: 1 },
}

// step: messages a round adds (cut_step counts messages, not rounds)
export const SHAPES = [
  { id: "claude-code", name: "Claude Code Messages", protocol: "Anthropic Messages", pricing: PRICING.anthropic, build: claudeCode, list: (b) => b.messages, turns: [5, 120], step: 2 },
  { id: "codex", name: "Codex Responses", protocol: "OpenAI Responses", pricing: PRICING.openai, build: codex, list: (b) => b.input, turns: [5, 70], step: 3 },
  { id: "chat", name: "Chat", protocol: "OpenAI Chat Completions", pricing: PRICING.openai, build: chat, list: (b) => b.messages, turns: [5, 70], step: 2 },
]

// ── what the prompt cache sees ─────────────────────────────────────────
// A turn reuses the provider's cache up to the first message that differs
// from the previous turn's request. Units, per char of request: the
// shape's vendor multipliers (PRICING) on what is read from the cache and
// what is written past it. The fields before the history (system, tools,
// instructions) never change, so both sides read them every turn.

function sharedMessages(prev, next) {
  let k = 0
  while (k < prev.length && k < next.length && json(prev[k]) === json(next[k])) k++
  return k
}

const size = (items) => items.reduce((n, m) => n + json(m).length, 0)

// check(raw, sent) runs on every turn (the probe test asserts the contract
// there). series has one row per turn: the body's chars before and after,
// and each side's cumulative cost units so far.
export function session(shape, options = DEFAULTS, check, pricing = shape.pricing) {
  const { read: R, write: W } = pricing
  let prev = null, breaks = 0, cost = 0, baseline = 0
  const series = []
  const [from, to] = shape.turns
  for (let t = from; t <= to; t++) {
    const raw = shape.build(t)
    const sent = send(raw, options)
    if (check) check(raw, sent)
    const now = shape.list(sent)
    const rawNow = shape.list(raw)
    const fixed = json(raw).length - size(rawNow)
    if (prev) {
      const k = sharedMessages(prev.items, now)
      if (k < prev.items.length) breaks++
      const read = size(now.slice(0, k))
      cost += R * (fixed + read) + W * (size(now) - read)
      const rawRead = size(rawNow.slice(0, prev.raw.length))
      baseline += R * (fixed + rawRead) + W * (size(rawNow) - rawRead)
    }
    series.push({ turn: t, raw: json(raw).length, sent: json(sent).length, cost, baseline })
    prev = { items: now, raw: rawNow }
  }
  const last = series.at(-1)
  return { breaks, turns: to - from, cost, baseline, sizeBefore: last.raw, sizeAfter: last.sent, series }
}
