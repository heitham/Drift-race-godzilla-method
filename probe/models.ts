/**
 * Model registry for the affordance probe.
 *
 * A column is (substrate × model), so the model must be a parameter rather than
 * a constant. The first columns were run on gemini-3.7-flash, and the single
 * most quotable result — one substrate reproducing its own outcome 17 times in
 * 18, the other 9 — invites exactly one objection: that a fast cheap model is
 * simply flaky. That objection is answered by running a strong model over the
 * same intents, not by argument.
 *
 * Rates are $ per million tokens. `cached` is the read price; `cacheWrite` is
 * the write premium. Both matter here far more than output price: 80% of this
 * workload's tokens are cache reads and barely 1% are output, because the work
 * is re-reading a tool schema every turn rather than generating prose.
 */
import type { Usage } from '../harness/run/drivers.js'

export interface ModelSpec {
  id: string
  provider: 'anthropic' | 'google'
  maxTokens: number
  /** $ per million. */
  rate: { input: number; output: number; cached: number; cacheWrite: number }
}

export const MODELS: Record<string, ModelSpec> = {
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash', provider: 'google', maxTokens: 8000,
    rate: { input: 0.75, output: 3.75, cached: 0.075, cacheWrite: 0.75 },
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5', provider: 'anthropic', maxTokens: 8000,
    rate: { input: 3, output: 15, cached: 0.30, cacheWrite: 3.75 },
  },
  'claude-opus-5': {
    id: 'claude-opus-5', provider: 'anthropic', maxTokens: 8000,
    rate: { input: 15, output: 75, cached: 1.50, cacheWrite: 18.75 },
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001', provider: 'anthropic', maxTokens: 8000,
    rate: { input: 1, output: 5, cached: 0.10, cacheWrite: 1.25 },
  },
}

export function resolveModel(argv: string[]): ModelSpec {
  const i = argv.indexOf('--model')
  const id = i >= 0 ? argv[i + 1] : 'gemini-3.7-flash'
  const m = MODELS[id]
  if (!m) throw new Error(`unknown model "${id}" — known: ${Object.keys(MODELS).join(', ')}`)
  return m
}

/** Thinking tokens are billed at the output rate, so they are charged as output. */
export const dollarsFor = (m: ModelSpec) => (u: Usage) =>
  (u.input * m.rate.input +
   (u.output + u.thinking) * m.rate.output +
   u.cacheRead * m.rate.cached +
   (u.cacheWrite ?? 0) * m.rate.cacheWrite) / 1e6

/**
 * Results are filed per (substrate, model). Writing every model to one file
 * would overwrite a column that cost real money to produce, and the whole point
 * of a second model is comparing it against the first.
 */
export const resultFile = (substrate: string, m: ModelSpec) =>
  m.id === 'gemini-3.7-flash' ? `${substrate}.json` : `${substrate}-${m.id}.json`
