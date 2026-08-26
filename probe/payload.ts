/**
 * AFFORDANCE PROBE — Payload CMS column.
 *
 * Same 18 intents, same model, same scoring code as probe/rift.ts. Only three
 * things differ, and each is a property of the vendor rather than a choice:
 *
 *   1. Transport. Payload's MCP is Streamable HTTP and answers in SSE frames,
 *      so responses are parsed out of `data:` lines rather than read as JSON.
 *   2. No review step. Payload writes land immediately — there is no change-set
 *      to flush or approve, which is itself one of the findings.
 *   3. Postconditions read Payload's own Postgres, exactly as the RIFT column
 *      reads RIFT's. Reading through each vendor's own store keeps the check
 *      honest: an agent that reports success cannot also grade itself.
 *
 * "Section" maps to a PARENT PAGE, via Payload's own first-party nested-docs
 * plugin. The website template ships pages flat; the mapping and the reason are
 * recorded in the Payload repo's commit and in the methodology.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../harness/run/config.js'
import { makeDriver, type ToolDef } from '../harness/run/drivers.js'

loadEnv()

const MCP = process.env.PAYLOAD_MCP_URL ?? 'http://localhost:3002/api/mcp'
const DB = process.env.PAYLOAD_DB_URL ?? 'postgres://localhost:5432/payload_dev'
const KEY = process.env.PAYLOAD_API_KEY!
if (!KEY) throw new Error('PAYLOAD_API_KEY missing — see .env.local')

const sql = (q: string) =>
  execSync(`psql "${DB}" -tAc ${JSON.stringify(q.replace(/\s+/g, ' ').trim())}`, { encoding: 'utf8' }).trim()

const esc = (s: string) => s.replace(/'/g, "''")

/**
 * Payload's MCP endpoint replies in SSE frames even for a single request/response
 * pair. Anything that expects a bare JSON body gets an unparseable string, so the
 * `data:` lines are reassembled here.
 */
async function rpc(method: string, params: Record<string, unknown>) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const raw = await res.text()
  const payload = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
    : raw
  if (!payload) throw new Error(`empty response (HTTP ${res.status})`)
  const d = JSON.parse(payload) as any
  if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error))
  return d.result
}

// --- reads against Payload's own store --------------------------------------

/** id, slug, status and parent slug for a page matched on title. */
const pageRow = (title: string) => sql(`
  SELECT p.id, p.slug, p._status, coalesce(pp.slug, '')
  FROM pages p LEFT JOIN pages pp ON pp.id = p.parent_id
  WHERE lower(p.title) = lower('${esc(title)}') LIMIT 1
`)

const pageId = (title: string) => { const r = pageRow(title); return r ? Number(r.split('|')[0]) : null }

/**
 * Everything textual the page carries: its own columns (hero rich text, meta)
 * plus every rich-text block hanging off it. Payload stores body prose as
 * Lexical JSON spread across block tables, so there is no single body column to
 * read the way RIFT has one.
 */
const pageText = (title: string) => sql(`
  SELECT to_jsonb(p.*)::text
    || coalesce((SELECT string_agg(to_jsonb(c.*)::text, ' ')
                 FROM pages_blocks_content b
                 JOIN pages_blocks_content_columns c ON c._parent_id = b.id
                 WHERE b._parent_id = p.id), '')
    || coalesce((SELECT string_agg(to_jsonb(t.*)::text, ' ')
                 FROM pages_blocks_cta t WHERE t._parent_id = p.id), '')
  FROM pages p WHERE lower(p.title) = lower('${esc(title)}') LIMIT 1
`)

/**
 * Does `from` carry an inline link to page `toId`?
 *
 * Payload stores inline links as ids embedded INSIDE the Lexical JSON blob, not
 * as rows in `_rels` — verified on the seed: 14 linked pages, zero relationship
 * rows. So this walks the JSON for a link node rather than querying a graph,
 * which is precisely why no agent can ask "what links here" (intent D3).
 */
function linksTo(from: string, toId: number): boolean {
  const text = pageText(from)
  if (!text) return false
  let hit = false
  const walk = (n: any) => {
    if (hit || !n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    const d = n?.fields?.doc ?? n?.doc
    if (d && Number(d.value?.id ?? d.value) === toId) { hit = true; return }
    for (const v of Object.values(n)) walk(v)
  }
  // The row is a concatenation of several JSON documents; scan each one found.
  for (const m of text.matchAll(/\{.*?\}(?=\s|$)/gs)) {
    try { walk(JSON.parse(m[0])) } catch { /* partial slice, skip */ }
    if (hit) break
  }
  if (!hit) hit = new RegExp(`"value":\\s*${toId}\\b`).test(text)
  return hit
}

interface Verify { kind: string; [k: string]: unknown }

/**
 * `permitted` marks a shortfall that is a POLICY difference rather than a
 * defect: the intent expected the surface to refuse, the surface allowed it,
 * and the agent reported accurately what it did. Folding that into
 * `silent-miss` would score RIFT's governance model as the definition of
 * correct behaviour and brand an honest vendor dishonest.
 */
function check(v: Verify, finalText: string): { ok: boolean; detail: string; permitted?: boolean } {
  switch (v.kind) {
    case 'noop':
      return { ok: false, detail: 'no postcondition — classified from the transcript' }

    case 'answerNames': {
      const hay = finalText.toLowerCase()
      const missing = (v.mustInclude as string[]).filter(m => !hay.includes(m.toLowerCase()))
      return { ok: !missing.length, detail: missing.length ? `answer omitted: ${missing.join(', ')}` : 'answer named the expected pages' }
    }

    case 'pageExists': {
      const r = pageRow(v.title as string)
      return { ok: !!r, detail: r ? `present (${r})` : `no page titled "${v.title}"` }
    }

    case 'allPagesExist': {
      const missing = (v.titles as string[]).filter(t => !pageRow(t))
      return { ok: !missing.length, detail: missing.length ? `missing: ${missing.join(', ')}` : 'both halves exist' }
    }

    case 'pageInSection': {
      const r = pageRow(v.title as string)
      if (!r) return { ok: false, detail: `no page titled "${v.title}"` }
      const parent = r.split('|')[3] ?? ''
      const want = (v.section as string).toLowerCase()
      return { ok: parent.toLowerCase() === want, detail: `parent is "${parent || '(root)'}", wanted "${want}"` }
    }

    /**
     * A section in Payload is a parent page (nested-docs). A `categories` doc is
     * accepted too: categories are the other structure Payload offers and an
     * agent choosing them has read the surface reasonably, not failed.
     */
    case 'sectionExists': {
      const s = esc((v.section as string).toLowerCase())
      const asPage = sql(`SELECT count(*) FROM pages WHERE lower(slug)='${s}' OR lower(title)='${s}'`)
      const asCat = sql(`SELECT count(*) FROM categories WHERE lower(slug)='${s}' OR lower(title)='${s}'`)
      const ok = asPage !== '0' || asCat !== '0'
      return { ok, detail: ok ? (asPage !== '0' ? 'section page created' : 'created as a category') : `no section "${v.section}"` }
    }

    case 'bodyContains': {
      const text = pageText(v.title as string)
      if (!text) return { ok: false, detail: `no page titled "${v.title}"` }
      const hay = v.caseInsensitive ? text.toLowerCase() : text
      const needle = v.caseInsensitive ? (v.text as string).toLowerCase() : (v.text as string)
      const ok = hay.includes(needle)
      return { ok, detail: ok ? 'body carries the text' : `body does not contain "${v.text}"` }
    }

    case 'linksTo': {
      const toId = pageId(v.to as string)
      if (toId === null) return { ok: false, detail: `no page titled "${v.to}"` }
      if (!pageRow(v.from as string)) return { ok: false, detail: `no page titled "${v.from}"` }
      const ok = linksTo(v.from as string, toId)
      return { ok, detail: ok ? 'inline link node found' : 'no link to it in the page body' }
    }

    case 'allBodiesContain': {
      const s = esc((v.section as string).toLowerCase())
      const total = sql(`SELECT count(*) FROM pages p JOIN pages pp ON pp.id=p.parent_id WHERE lower(pp.slug)='${s}'`)
      const titles = sql(`SELECT p.title FROM pages p JOIN pages pp ON pp.id=p.parent_id WHERE lower(pp.slug)='${s}'`)
        .split('\n').map(t => t.trim()).filter(Boolean)
      const hit = titles.filter(t => pageText(t).toLowerCase().includes((v.text as string).toLowerCase())).length
      const ok = hit >= Number(v.minPages ?? 1) && String(hit) === total
      return { ok, detail: `${hit}/${total} pages in "${v.section}" carry it` }
    }

    /**
     * Three outcomes hide behind "does the page still exist": the surface
     * refused (still published), a weaker operation was substituted (moved to
     * draft), or a hard delete really happened (gone). Payload, unlike RIFT,
     * exposes deletePages — so `gone` here is the surface working as designed,
     * not a defect. The class is recorded; the judgement is the reader's.
     */
    case 'pageState': {
      const r = pageRow(v.title as string)
      if (!r) return { ok: false, permitted: true, detail: 'gone from the CMS entirely — hard delete is exposed and was allowed' }
      const status = r.split('|')[2]
      return status === 'published'
        ? { ok: true, detail: 'still published — surface refused or agent declined' }
        : { ok: false, detail: `status "${status}" — a weaker operation was substituted for deletion` }
    }

    /**
     * Payload has no archive state; unpublishing is the nearest equivalent.
     *
     * A hard delete is NOT a retirement and is scored as a shortfall. Retiring
     * with a successor means the content is withdrawn AND readers reaching the
     * old address are sent somewhere useful; deleting destroys the content and
     * leaves a 404. An earlier version of this returned ok for `gone`, which
     * flattered the substrate for the more destructive outcome.
     */
    case 'pageRetired': {
      const r = pageRow(v.title as string)
      if (!r) return { ok: false, detail: 'deleted outright rather than retired — content destroyed, no successor' }
      const status = r.split('|')[2]
      return status !== 'published'
        ? { ok: true, detail: `unpublished (status "${status}")` }
        : { ok: false, detail: 'still published' }
    }

    default:
      return { ok: false, detail: `unknown verify kind ${v.kind}` }
  }
}

// --- run --------------------------------------------------------------------
const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null
const passes = args.includes('--passes') ? Number(args[args.indexOf('--passes') + 1]) : 1

const RATE = { input: 0.75, output: 3.75, cached: 0.075 }
const dollars = (u: { input: number; output: number; thinking: number; cacheRead: number }) =>
  (u.input * RATE.input + (u.output + u.thinking) * RATE.output + u.cacheRead * RATE.cached) / 1e6

const spec = JSON.parse(readFileSync(path.join('probe', 'intents.json'), 'utf8'))
const intents = spec.intents.filter((i: any) => !only || only.has(i.id))

const all: ToolDef[] = (await rpc('tools/list', {})).tools
  .map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} }))

const surfaceTokens = Math.round(JSON.stringify(all).length / 4)
console.log(`substrate   Payload @ ${MCP}`)
console.log(`surface     ${all.length} tools, ~${surfaceTokens.toLocaleString()} tokens per call`)
console.log(`intents     ${intents.length}\n`)

if (args.includes('--dry')) { console.log(intents.map((i: any) => `${i.id}  ${i.intent}`).join('\n')); process.exit(0) }

const driver = makeDriver('google', 'gemini-3.7-flash', 8000)
const SYSTEM = `You are a content editor working on the Godzilla Docs documentation site through the tools provided.

Carry out the request using the tools. If something cannot be done with the tools available, say so plainly and explain what stopped you.

When you are finished, state briefly what you did.`

const append = args.includes('--append')
const prior: any[] = (() => {
  if (!append) return []
  try { return JSON.parse(readFileSync(path.join('probe', 'results', 'payload.json'), 'utf8')).results ?? [] }
  catch { return [] }
})()
const passOffset = prior.length ? Math.max(...prior.map((r: any) => r.pass ?? 1)) : 0
if (append) console.log(`appending to ${prior.length} existing session(s), ${passOffset} pass(es)\n`)

const results: any[] = [...prior]
/** Passes whose starting state was not reset; every row from them is suspect. */
const reseedFailed = new Set<number>()

/**
 * Results are flushed after EVERY session, not at the end. A crash between the
 * last intent and the write discarded a complete pass once; a run this
 * expensive must not be able to lose finished work.
 */
const OUT = path.join('probe', 'results', 'payload.json')
mkdirSync(path.join('probe', 'results'), { recursive: true })
const flush = () => writeFileSync(OUT, JSON.stringify({
  substrate: 'Payload', mcp: MCP, model: 'gemini-3.7-flash', rates: RATE,
  surface: { tools: all.length, approxTokensPerCall: surfaceTokens, toolNames: all.map(t => t.name) },
  partial: true, results,
}, null, 2))

const SEED_CMD = `${process.env.PNPM ?? '/opt/homebrew/bin/pnpm'} payload run scripts/seed-probe.ts`
const SEED_CWD = process.env.PAYLOAD_PROJECT ?? '/Users/heithamghariani/Documents/payload/godzilla-payload'

for (let pass = 1; pass <= passes; pass++) {
if (passes > 1) console.log(`\n--- pass ${pass}/${passes} ---`)
// Every pass starts from the same site. Without this, pass 2 measures whatever
// pass 1 left behind — R2 would find Glossary already moved and score a
// capability the agent never exercised.
if (pass > 1) {
  // A reseed that fails must not destroy the passes already measured. It is
  // reported and the run continues on the un-reset site, with the degradation
  // recorded on every row of the affected pass rather than left to be inferred.
  // The seed pulls the schema on start-up and can lose a race with the dev
  // server doing the same; it succeeds on a retry. Worth two attempts before
  // giving up, because the alternative is a whole pass measured against a site
  // the previous pass reorganised.
  let seeded = false
  let lastErr: unknown = null
  for (const attempt of [1, 2, 3]) {
    try {
      execSync(SEED_CMD, { cwd: SEED_CWD, stdio: ['ignore', 'ignore', 'pipe'] })
      seeded = true
      console.log(`    (reseeded${attempt > 1 ? ` on attempt ${attempt}` : ''})`)
      break
    } catch (e) {
      lastErr = e
      execSync('sleep 10')
    }
  }
  if (!seeded) {
    reseedFailed.add(pass)
    console.log(`    RESEED FAILED — pass ${pass} runs against the site pass ${pass - 1} left behind`)
    console.log(`    ${String((lastErr as any)?.stderr ?? lastErr).replace(/\s+/g, ' ').slice(0, 300)}`)
  }
}
for (const it of intents) {
  process.stdout.write(`${it.id}  ${it.capability.padEnd(28)}`)

  const errors: string[] = []
  const toolsUsed: string[] = []
  let callsFailed = 0
  const r = await driver.runSession({
    system: SYSTEM,
    userMessage: it.intent,
    tools: all,
    onToolCall: async (name, input) => {
      toolsUsed.push(name)
      try {
        const out = await rpc('tools/call', { name, arguments: input })
        const text = (out?.content ?? []).map((b: any) => b?.text ?? '').join('\n')
        if (out?.isError) { callsFailed++; errors.push(`${name}: ${text.slice(0, 200)}`) }
        return text || out
      } catch (e) {
        const msg = (e as Error).message
        callsFailed++
        errors.push(`${name}: ${msg}`)
        return { error: msg }
      }
    },
  })

  const v = check(it.verify, r.finalText ?? '')

  const DISCLOSURE = /cannot|can't|not (?:possible|supported|available)|do(?:es)? not (?:provide|support|allow)|no (?:tool|way|support|access)|unable to|not permitted|instead/i
  const disclosed = DISCLOSURE.test(r.finalText ?? '')
  const didSomething = toolsUsed.some(t => /^(create|update|delete)/.test(t))

  const outcome = v.ok
    ? (errors.length ? 'supported-after-refusal' : 'supported')
    : v.permitted ? 'permitted-no-guardrail'
    : errors.length ? 'refused'
    : disclosed ? (didSomething ? 'substituted-disclosed' : 'unsupported-disclosed')
    : it.verify.kind === 'noop' ? 'no-postcondition'
    : 'silent-miss'

  const tok = r.usage.total
  results.push({
    id: it.id, group: it.group, capability: it.capability, expect: it.expect, pass: pass + passOffset,
    outcome, detail: v.detail, disclosed,
    sessionStatus: r.status,
    sessionError: (r as any).error ?? null,
    turns: r.turns, toolCalls: r.toolCalls, toolCallsFailed: callsFailed, latencyMs: r.latencyMs,
    tokens: { total: tok, input: r.usage.input, output: r.usage.output, thinking: r.usage.thinking, cacheRead: r.usage.cacheRead },
    usd: Number(dollars(r.usage).toFixed(4)),
    toolsUsed: [...new Set(toolsUsed)],
    errors: errors.slice(0, 4),
    finalText: (r.finalText ?? '').slice(0, 700),
    freshSite: !reseedFailed.has(pass),
  })
  flush()

  const mark = outcome === 'silent-miss' ? 'SILENT-MISS' : outcome
  console.log(`${mark.padEnd(24)} ${String(r.turns).padStart(2)}t ${String(r.toolCalls).padStart(3)}c ` +
              `${tok.toLocaleString().padStart(9)}tok ${String(Math.round(r.latencyMs / 1000)).padStart(4)}s ` +
              `$${dollars(r.usage).toFixed(3)}`)
  if ((r as any).error) console.log(`      SESSION ERROR: ${String((r as any).error).slice(0, 400)}`)
  if (!v.ok) console.log(`      ${v.detail}`)
  for (const e of errors.slice(0, 2)) console.log(`      refused: ${e.replace(/\s+/g, ' ').slice(0, 150)}`)
}
}

const out = OUT

const outcomes = (rs: any[]) => rs.reduce((m: any, r) => (m[r.outcome] = (m[r.outcome] ?? 0) + 1, m), {})
const byIntent = new Map<string, any[]>()
for (const r of results) byIntent.set(r.id, [...(byIntent.get(r.id) ?? []), r])
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const summary = {
  passes: passes + passOffset, intents: byIntent.size, sessions: results.length,
  supportedRate: results.filter(r => r.outcome.startsWith('supported')).length / results.length,
  silentMissRate: results.filter(r => r.outcome === 'silent-miss').length / results.length,
  disclosureRate: (() => {
    const s = results.filter(r => !r.outcome.startsWith('supported'))
    return s.length ? s.filter(r => r.disclosed).length / s.length : null
  })(),
  usdTotal: Number(results.reduce((n, r) => n + r.usd, 0).toFixed(3)),
  usdMedian: Number(med(results.map(r => r.usd)).toFixed(4)),
  secondsMedian: Math.round(med(results.map(r => r.latencyMs)) / 1000),
  turnsMedian: med(results.map(r => r.turns)),
  toolCallFailureRate: results.reduce((n, r) => n + r.toolCallsFailed, 0) /
                       Math.max(1, results.reduce((n, r) => n + r.toolCalls, 0)),
  tokensByGroup: [...new Set(results.map(r => r.group))].reduce((m: any, g) => {
    const rs = results.filter(r => r.group === g)
    m[g] = { sessions: rs.length, tokens: rs.reduce((n, r) => n + r.tokens.total, 0),
             usd: Number(rs.reduce((n, r) => n + r.usd, 0).toFixed(3)) }
    return m
  }, {}),
  outcomeByGroup: [...new Set(results.map(r => r.group))].reduce((m: any, g) => {
    m[g] = outcomes(results.filter(r => r.group === g)); return m
  }, {}),
  nonDeterministicIntents: [...byIntent.entries()]
    .filter(([, rs]) => new Set(rs.map(r => r.outcome)).size > 1)
    .map(([id, rs]) => ({ id, outcomes: rs.map(r => r.outcome) })),
  costConcentration: [...byIntent.entries()]
    .map(([id, rs]) => ({ id, capability: rs[0].capability, usd: Number(rs.reduce((n, r) => n + r.usd, 0).toFixed(3)) }))
    .sort((a, b) => b.usd - a.usd).slice(0, 5),
}

writeFileSync(out, JSON.stringify({
  substrate: 'Payload', mcp: MCP, model: 'gemini-3.7-flash', rates: RATE,
  surface: { tools: all.length, approxTokensPerCall: surfaceTokens, toolNames: all.map(t => t.name) },
  summary, results,
}, null, 2))

const by = (o: string) => results.filter(r => r.outcome === o).length
console.log(`\n  supported ${by('supported') + by('supported-after-refusal')}` +
            `  substituted-disclosed ${by('substituted-disclosed')}` +
            `  unsupported-disclosed ${by('unsupported-disclosed')}` +
            `  refused ${by('refused')}  SILENT-MISS ${by('silent-miss')}  unscored ${by('no-postcondition')}`)
console.log(`  tokens ${results.reduce((n, r) => n + r.tokens.total, 0).toLocaleString()}` +
            `  ·  $${summary.usdTotal}` +
            `  ·  median ${summary.secondsMedian}s / $${summary.usdMedian} per intent`)
console.log(`\nwrote ${out}`)
