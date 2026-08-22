/**
 * Model drivers — one agent loop, two providers.
 *
 * The harness owns this loop for every model. That is a correctness
 * requirement, not a convenience: if different models ran under different
 * scaffolding (different system prompts, tool implementations, or turn
 * limits), the benchmark would be measuring scaffolding rather than substrate,
 * and the paired raw-vs-governed comparison inside each model would be
 * contaminated too.
 *
 * Both drivers therefore expose exactly the same surface, and any behavioural
 * difference between them is confined to provider wire format.
 */

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>
}

export interface Usage {
  input: number
  output: number
  /** Reasoning tokens. Billed, and therefore counted in M3. */
  thinking: number
  total: number
  /** Tokens written to cache this run (billed ~1.25x input). */
  cacheWrite: number
  /** Tokens served from cache (billed ~0.1x input) — the saving, measured. */
  cacheRead: number
}

export interface SessionOptions {
  system: string
  userMessage: string
  tools: ToolDef[]
  onToolCall: (name: string, input: Record<string, unknown>) => Promise<unknown>
  maxTurns?: number
}

export interface SessionResult {
  status: 'completed' | 'max_turns' | 'error'
  turns: number
  toolCalls: number
  usage: Usage
  transcript: unknown[]
  finalText: string
  error?: string
  latencyMs: number
}

export interface ModelDriver {
  id: string
  provider: 'anthropic' | 'google'
  runSession(opts: SessionOptions): Promise<SessionResult>
}

/**
 * Turn ceiling.
 *
 * A session that hits it is recorded `partial`, so the ceiling itself becomes
 * a drift signal — which makes a low ceiling actively misleading. The Haiku
 * pilot reached exactly 40 on one raw operation and 38 on another: binding,
 * and binding on the arm with more mechanical work to do. Raised to 60 so the
 * limit is a runaway guard rather than a scoring artifact.
 */
const MAX_TURNS_DEFAULT = 60
const zeroUsage = (): Usage => ({ input: 0, output: 0, thinking: 0, total: 0, cacheWrite: 0, cacheRead: 0 })

/**
 * Reasoning configuration differs by model generation, and getting it wrong is
 * a hard 400 rather than a silent degradation:
 *   - Haiku 4.5 / Sonnet 4.5 take `{type:'enabled', budget_tokens}` and reject `effort`.
 *   - Sonnet 4.6 and later take `{type:'adaptive'}` + `effort`; `budget_tokens`
 *     is deprecated on 4.6 and REMOVED on Sonnet 5 (400).
 * A single hardcoded shape would run fine on Haiku and fail the whole Sonnet 5
 * run at operation 1, so it is resolved per model.
 */
function anthropicReasoning(model: string, budget: number): Record<string, unknown> {
  const adaptive = /sonnet-5|sonnet-4-6|opus-/.test(model)
  return adaptive
    ? { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
    : { thinking: { type: 'enabled', budget_tokens: budget } }
}

type Block = Record<string, unknown>

/**
 * Prompt caching for the agentic loop.
 *
 * Every turn resends the entire conversation, and with tool results returning
 * whole HTML pages that prefix dominates cost — in a measured run, ~1.6M of
 * 1.62M tokens. Cache reads bill at ~0.1x input, so a breakpoint on the newest
 * turn turns almost all of that re-sent prefix into cache reads.
 *
 * Two rolling breakpoints rather than one: a breakpoint only looks back 20
 * content blocks for a prior entry, and a turn answering several parallel tool
 * calls can add enough blocks to overshoot that window. The older breakpoint
 * keeps a reachable entry when it does. With the system breakpoint that is 3 of
 * the 4 allowed.
 */
function applyCacheBreakpoints(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out = messages.map(m => ({ ...m }))

  // Normalize to block arrays and clear previous breakpoints — a stale
  // breakpoint left in place both wastes one of the four slots and writes a
  // cache entry nothing will ever read.
  for (const m of out) {
    if (typeof m.content === 'string') m.content = [{ type: 'text', text: m.content }]
    if (Array.isArray(m.content)) {
      m.content = (m.content as Block[]).map(b => {
        if (b && typeof b === 'object' && 'cache_control' in b) {
          const { cache_control: _drop, ...rest } = b
          return rest
        }
        return b
      })
    }
  }

  const mark = (i: number) => {
    const blocks = out[i]?.content
    if (!Array.isArray(blocks) || blocks.length === 0) return
    const last = blocks[blocks.length - 1] as Block
    if (last && typeof last === 'object') last.cache_control = { type: 'ephemeral' }
  }

  mark(out.length - 1)
  if (out.length >= 3) mark(out.length - 3)
  return out
}
const addUsage = (a: Usage, b: Partial<Usage>): Usage => ({
  input: a.input + (b.input ?? 0),
  output: a.output + (b.output ?? 0),
  thinking: a.thinking + (b.thinking ?? 0),
  total: a.total + (b.total ?? 0),
  cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
  cacheRead: a.cacheRead + (b.cacheRead ?? 0),
})

/** Retry transient failures. Long runs die to rate limits otherwise. */
async function withRetry<T>(fn: () => Promise<Response>, label: string, attempts = 8): Promise<T> {
  let lastErr = ''
  for (let i = 1; i <= attempts; i++) {
    let res: Response
    try {
      res = await fn()
    } catch (e) {
      lastErr = String(e)
      await sleep(Math.min(2 ** i * 1000, 30_000))
      continue
    }
    if (res.ok) return (await res.json()) as T

    const body = await res.text()
    lastErr = `${res.status} ${body.slice(0, 300)}`

    // A 429 is ambiguous and the two meanings need opposite handling.
    //
    // Google returns RESOURCE_EXHAUSTED both for a per-MINUTE rate limit, which
    // clears on its own, and for a hard per-day or per-project cap, which does
    // not. An earlier version of this failed fast on the wording alone; that was
    // wrong, and it turned a recoverable pacing limit into a dead run. The
    // structured error is what actually distinguishes them:
    //   RetryInfo.retryDelay  -> the provider is telling us when to come back
    //   quotaId  …PerDay/PerMonth -> waiting cannot help
    let retryAfterMs = 0
    let hardCap = ''
    if (res.status === 429) {
      const hdr = Number(res.headers.get('retry-after'))
      if (hdr) retryAfterMs = hdr * 1000
      try {
        const details = JSON.parse(body)?.error?.details ?? []
        for (const d of details) {
          const t = String(d['@type'] ?? '')
          if (t.includes('RetryInfo') && d.retryDelay) {
            retryAfterMs = Math.max(retryAfterMs, (parseFloat(String(d.retryDelay)) || 0) * 1000)
          }
          if (t.includes('QuotaFailure')) {
            for (const v of d.violations ?? []) {
              if (/PerDay|PerMonth|Daily/i.test(String(v.quotaId ?? ''))) hardCap = String(v.quotaId)
            }
          }
        }
      } catch { /* unparseable body: fall through to ordinary backoff */ }

      if (hardCap) {
        throw new Error(
          `${label}: hard quota reached (${hardCap}).\n` +
          `  Waiting will not clear this one — raise the cap or use another key.`,
        )
      }
    }

    // 429-for-pacing and 5xx are transient; any other 4xx is a bug in our request.
    if (res.status !== 429 && res.status < 500) throw new Error(`${label}: ${lastErr}`)
    await sleep(retryAfterMs || Math.min(2 ** i * 1000, 60_000))
  }
  throw new Error(`${label}: exhausted retries — ${lastErr}`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export function anthropicDriver(model: string, thinkingBudget: number, apiKey: string): ModelDriver {
  return {
    id: model,
    provider: 'anthropic',
    async runSession(opts) {
      const started = Date.now()
      const maxTurns = opts.maxTurns ?? MAX_TURNS_DEFAULT
      const messages: Array<Record<string, unknown>> = [{ role: 'user', content: opts.userMessage }]
      const transcript: unknown[] = []
      let usage = zeroUsage()
      let turns = 0
      let toolCalls = 0
      let finalText = ''

      try {
        while (turns < maxTurns) {
          turns++
          const body = {
            model,
            // Must exceed thinking budget, or the request is rejected. Kept at
            // 16K so non-streaming requests stay under the SDK HTTP timeout.
            max_tokens: thinkingBudget + 8000,
            // Array form so the breakpoint can attach. Renders after `tools`,
            // so this one breakpoint caches the tool schemas and system prompt
            // together — the only genuinely static part of the request.
            system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
            messages: applyCacheBreakpoints(messages),
            tools: opts.tools.map(t => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
            ...anthropicReasoning(model, thinkingBudget),
          }

          const d = await withRetry<any>(
            () => fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
            }),
            `anthropic/${model}`,
          )

          // Anthropic folds reasoning tokens into output_tokens; surface them
          // separately so M3 can report reasoning cost explicitly.
          const thinkingTokens = (d.content ?? [])
            .filter((c: any) => c.type === 'thinking')
            .reduce((n: number, c: any) => n + Math.ceil((c.thinking?.length ?? 0) / 4), 0)

          const cacheWrite = d.usage?.cache_creation_input_tokens ?? 0
          const cacheRead = d.usage?.cache_read_input_tokens ?? 0
          usage = addUsage(usage, {
            input: d.usage?.input_tokens ?? 0,
            output: d.usage?.output_tokens ?? 0,
            thinking: thinkingTokens,
            cacheWrite,
            cacheRead,
            // input_tokens counts only the UNCACHED remainder — the cached
            // spans are reported separately and must be added back, or M3
            // silently under-reports the true prompt size once caching lands.
            total: (d.usage?.input_tokens ?? 0) + (d.usage?.output_tokens ?? 0) + cacheWrite + cacheRead,
          })

          transcript.push({ role: 'assistant', content: d.content, stop_reason: d.stop_reason })
          finalText = (d.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')

          const toolUses = (d.content ?? []).filter((c: any) => c.type === 'tool_use')
          if (d.stop_reason !== 'tool_use' || toolUses.length === 0) {
            // `max_tokens` means the model was CUT OFF mid-thought, not that it
            // finished. One operation ended after three read-only calls with its
            // sentence truncated and was recorded `completed`; the session ends
            // either way, but calling it completion hides a real failure mode
            // behind a clean-looking status.
            const truncated = d.stop_reason === 'max_tokens'
            return {
              status: truncated ? 'max_turns' : 'completed',
              turns, toolCalls, usage, transcript, finalText,
              latencyMs: Date.now() - started,
              ...(truncated ? { error: 'response truncated at max_tokens' } : {}),
            }
          }

          // Thinking blocks must be echoed back verbatim alongside tool_use,
          // or the provider rejects the continuation.
          messages.push({ role: 'assistant', content: d.content })

          const results = []
          for (const tu of toolUses) {
            toolCalls++
            let out: unknown
            try {
              out = await opts.onToolCall(tu.name, tu.input ?? {})
            } catch (e) {
              out = { error: String(e) }
            }
            const rendered = typeof out === 'string' ? out : JSON.stringify(out)
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: rendered })
            transcript.push({ role: 'tool', name: tu.name, input: tu.input, output: rendered.slice(0, 4000) })
          }
          messages.push({ role: 'user', content: results })
        }
        return { status: 'max_turns', turns, toolCalls, usage, transcript, finalText, latencyMs: Date.now() - started }
      } catch (e) {
        return { status: 'error', turns, toolCalls, usage, transcript, finalText, error: String(e), latencyMs: Date.now() - started }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export function googleDriver(model: string, thinkingBudget: number, apiKey: string): ModelDriver {
  return {
    id: model,
    provider: 'google',
    async runSession(opts) {
      const started = Date.now()
      const maxTurns = opts.maxTurns ?? MAX_TURNS_DEFAULT
      const contents: Array<Record<string, unknown>> = [{ role: 'user', parts: [{ text: opts.userMessage }] }]
      const transcript: unknown[] = []
      let usage = zeroUsage()
      let turns = 0
      let toolCalls = 0
      let finalText = ''

      try {
        while (turns < maxTurns) {
          turns++
          const body = {
            systemInstruction: { parts: [{ text: opts.system }] },
            contents,
            tools: [{
              functionDeclarations: opts.tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            }],
            generationConfig: {
              maxOutputTokens: thinkingBudget + 8000,
              thinkingConfig: { thinkingBudget },
            },
          }

          const d = await withRetry<any>(
            () => fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
            ),
            `google/${model}`,
          )

          const u = d.usageMetadata ?? {}
          // Gemini caches the repeated prefix IMPLICITLY — no cachedContent object
          // and no lifecycle to manage — and reports the hit as
          // cachedContentTokenCount. This driver did not read that field, so every
          // Gemini run reported cacheRead 0 and looked far more expensive than it
          // was: a two-turn probe showed 16,350 of 19,311 prompt tokens served from
          // cache while the harness recorded none of it.
          //
          // promptTokenCount INCLUDES the cached tokens (unlike Anthropic, whose
          // input_tokens excludes them), so `input` is reduced here to mean the same
          // thing in both providers — tokens actually charged at full input rate —
          // and totalTokenCount is already complete, so it is used as-is.
          const cachedIn = u.cachedContentTokenCount ?? 0
          usage = addUsage(usage, {
            input: Math.max(0, (u.promptTokenCount ?? 0) - cachedIn),
            output: u.candidatesTokenCount ?? 0,
            thinking: u.thoughtsTokenCount ?? 0,
            cacheRead: cachedIn,
            // Google reports reasoning separately from candidates; totalTokenCount
            // already includes it, so use it directly rather than re-adding.
            total: u.totalTokenCount ?? 0,
          })

          const parts: any[] = d.candidates?.[0]?.content?.parts ?? []
          transcript.push({ role: 'assistant', parts, finishReason: d.candidates?.[0]?.finishReason })
          finalText = parts.map(p => p.text ?? '').join('')

          const calls = parts.filter(p => p.functionCall)
          if (calls.length === 0) {
            return { status: 'completed', turns, toolCalls, usage, transcript, finalText, latencyMs: Date.now() - started }
          }

          // Echo parts back verbatim — thoughtSignature must survive the round
          // trip or reasoning continuity is lost between turns.
          contents.push({ role: 'model', parts })

          const responseParts = []
          for (const c of calls) {
            toolCalls++
            const name = c.functionCall.name
            let out: unknown
            try {
              out = await opts.onToolCall(name, c.functionCall.args ?? {})
            } catch (e) {
              out = { error: String(e) }
            }
            const rendered = typeof out === 'string' ? out : JSON.stringify(out)
            responseParts.push({ functionResponse: { name, response: { result: rendered } } })
            transcript.push({ role: 'tool', name, input: c.functionCall.args, output: rendered.slice(0, 4000) })
          }
          contents.push({ role: 'user', parts: responseParts })
        }
        return { status: 'max_turns', turns, toolCalls, usage, transcript, finalText, latencyMs: Date.now() - started }
      } catch (e) {
        return { status: 'error', turns, toolCalls, usage, transcript, finalText, error: String(e), latencyMs: Date.now() - started }
      }
    },
  }
}

export function makeDriver(
  provider: 'anthropic' | 'google',
  model: string,
  thinkingBudget: number,
): ModelDriver {
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY not set')
    return anthropicDriver(model, thinkingBudget, key)
  }
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  return googleDriver(model, thinkingBudget, key)
}
