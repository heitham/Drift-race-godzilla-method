/**
 * AFFORDANCE PROBE — Sanity column.
 *
 * Same 18 intents, same site fixture, same scoring code as the other columns.
 * Four things differ, and each belongs to the vendor rather than to a choice:
 *
 *   1. HOSTED. The MCP server is Sanity's, at mcp.sanity.io, not a local
 *      process. Wall-clock therefore includes network round-trips and is NOT
 *      comparable to the local columns; tokens and turns still are. Recorded
 *      as `hosted: true` so a reader cannot mistake one for the other.
 *   2. SESSION-BASED. Streamable HTTP with an Mcp-Session-Id, re-established
 *      per intent. RIFT and Payload are stateless per call.
 *   3. RESOURCE ARGUMENT. Every tool takes {projectId, dataset}. Injected here
 *      the way site_id is injected for RIFT, so the model is not scored on
 *      book-keeping the harness can do.
 *   4. DRAFTS ARE DOCUMENTS. `create_documents` yields drafts.* ids that are
 *      invisible to a published query until publish_documents runs. Every
 *      postcondition below therefore looks at BOTH, and reports which — an
 *      agent that created a draft and stopped has done something real but
 *      different from publishing, and collapsing the two would hide it.
 *
 * The tool surface is measured AS SHIPPED. Sanity exposes 38 tools of which
 * only nine are content operations; the rest are project admin, docs search,
 * image generation and CLI access. Filtering to a content subset would measure
 * a product nobody can buy, and the surface/work decomposition in
 * probe/matrix.ts separates the cost of breadth from the cost of mechanism
 * without anyone having to guess which tools "count".
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../harness/run/config.js'
import { makeDriver, type ToolDef } from '../harness/run/drivers.js'
import { resolveModel, dollarsFor } from './models.js'
import { DISCLOSURE } from './disclosure.js'

loadEnv()

const MCP = process.env.SANITY_MCP_URL ?? 'https://mcp.sanity.io/mcp'
const PROJECT = process.env.SANITY_PROJECT_ID!
const DATASET = process.env.SANITY_DATASET ?? 'production'
const TOKEN = process.env.SANITY_TOKEN!
if (!TOKEN) throw new Error('SANITY_TOKEN missing — see .env.local')

const RESOURCE = { projectId: PROJECT, dataset: DATASET }
const API = `https://${PROJECT}.api.sanity.io/v2024-01-01`

/* ---- postconditions, read through Sanity's own store --------------------- */

async function groq<T = unknown>(q: string): Promise<T> {
  const res = await fetch(`${API}/data/query/${DATASET}?query=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const body = await res.json() as any
  if (body.error) throw new Error(`GROQ: ${JSON.stringify(body.error).slice(0, 200)}`)
  return body.result as T
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** Published only. */
const pub = (t: string) =>
  `*[_type=="page" && !(_id in path("drafts.**")) && lower(title)==lower("${esc(t)}")][0]`
/** Draft or published — "does this exist at all". */
const any_ = (t: string) => `*[_type=="page" && lower(title)==lower("${esc(t)}")][0]`

interface PageState { _id: string; title: string; parent: string | null; draft: boolean }

async function findPage(title: string): Promise<PageState | null> {
  const r = await groq<any>(
    `${any_(title)}{_id, title, "parent": parent->slug.current}`,
  )
  if (!r) return null
  return { _id: r._id, title: r.title, parent: r.parent ?? null, draft: r._id.startsWith('drafts.') }
}

async function bodyText(title: string): Promise<string | null> {
  const r = await groq<any>(`${any_(title)}{body}`)
  if (!r) return null
  return JSON.stringify(r.body ?? '')
}

interface Verify { kind: string; [k: string]: unknown }
interface Result { ok: boolean; detail: string; permitted?: boolean }

async function check(v: Verify, finalText: string): Promise<Result> {
  switch (v.kind) {
    case 'noop':
      return { ok: false, detail: 'no postcondition — classified from the transcript' }

    case 'answerNames': {
      const hay = finalText.toLowerCase()
      const missing = (v.mustInclude as string[]).filter(m => !hay.includes(m.toLowerCase()))
      return { ok: !missing.length, detail: missing.length ? `answer omitted: ${missing.join(', ')}` : 'answer named the expected pages' }
    }

    case 'pageExists': {
      const p = await findPage(v.title as string)
      return { ok: !!p, detail: p ? `present${p.draft ? ' (draft only)' : ''}` : `no page titled "${v.title}"` }
    }

    case 'allPagesExist': {
      const found = await Promise.all((v.titles as string[]).map(t => findPage(t)))
      const missing = (v.titles as string[]).filter((_, i) => !found[i])
      return { ok: !missing.length, detail: missing.length ? `missing: ${missing.join(', ')}` : 'both halves exist' }
    }

    case 'pageInSection': {
      const p = await findPage(v.title as string)
      if (!p) return { ok: false, detail: `no page titled "${v.title}"` }
      const want = (v.section as string).toLowerCase()
      const got = (p.parent ?? '').toLowerCase()
      return { ok: got === want, detail: `parent is "${got || '(root)'}", wanted "${want}"` }
    }

    /** A section in Sanity is a page other pages point `parent` at. */
    case 'sectionExists': {
      const s = esc((v.section as string).toLowerCase())
      const n = await groq<number>(
        `count(*[_type=="page" && (lower(slug.current)=="${s}" || lower(title)=="${s}")])`,
      )
      return { ok: n > 0, detail: n > 0 ? 'section page created' : `no section "${v.section}"` }
    }

    case 'bodyContains': {
      const body = await bodyText(v.title as string)
      if (body === null) return { ok: false, detail: `no page titled "${v.title}"` }
      const hay = v.caseInsensitive ? body.toLowerCase() : body
      const needle = v.caseInsensitive ? (v.text as string).toLowerCase() : (v.text as string)
      const ok = hay.includes(needle)
      return { ok, detail: ok ? 'body carries the text' : `body does not contain "${v.text}"` }
    }

    /**
     * A link is an internalLink annotation resolving to the target. A plain
     * external-style href in the text does not count, for the same reason it
     * does not count on the other columns: the question is whether the store
     * knows about the edge.
     */
    case 'linksTo': {
      const to = await findPage(v.to as string)
      const from = await findPage(v.from as string)
      if (!to) return { ok: false, detail: `no page titled "${v.to}"` }
      if (!from) return { ok: false, detail: `no page titled "${v.from}"` }
      const bare = to._id.replace(/^drafts\./, '')
      const n = await groq<number>(
        `count(*[_id=="${from._id}"].body[].markDefs[_type=="internalLink" && ` +
        `(reference._ref=="${bare}" || reference._ref=="drafts.${bare}")])`,
      )
      if (n > 0) return { ok: true, detail: `${n} reference annotation(s)` }
      // Fall back to any reference at all from this doc to the target, in case
      // the agent modelled the link some other legitimate way.
      const anyRef = await groq<number>(`count(*[_id=="${from._id}" && references("${bare}")])`)
      return anyRef > 0
        ? { ok: true, detail: 'linked by a reference outside the body annotation' }
        : { ok: false, detail: 'no reference from that page to the target' }
    }

    case 'allBodiesContain': {
      const s = esc((v.section as string).toLowerCase())
      // The section's own landing page counts as a page IN the section: RIFT
      // stores it inside the folder, so excluding it would ask one substrate to
      // edit two pages where another is asked to edit three.
      // pt::text(), not string(). GROQ's string() returns NULL for an array of
      // Portable Text blocks, so every body read as empty and a section the
      // agent had correctly edited scored 0/3 — a silent-miss invented by the
      // scorer. Verified against the store: all three pages carried the line.
      const rows = await groq<{ title: string; body: string }[]>(
        `*[_type=="page" && (lower(slug.current)=="${s}" || parent->slug.current=="${s}")]` +
        `{title, "body": pt::text(body)}`,
      )
      const needle = (v.text as string).toLowerCase()
      const hit = rows.filter(r => (r.body ?? '').toLowerCase().includes(needle)).length
      const ok = hit >= Number(v.minPages ?? 1) && hit === rows.length && rows.length > 0
      return { ok, detail: `${hit}/${rows.length} pages in "${v.section}" carry it` }
    }

    /**
     * Three outcomes hide behind "does the page still exist": the surface
     * refused (still published), a weaker operation was substituted
     * (unpublished to draft), or a hard delete happened. Sanity exposes both
     * unpublish and delete, so `gone` is the surface working as designed — a
     * policy difference, not a defect.
     */
    case 'pageState': {
      const p = await findPage(v.title as string)
      if (!p) return { ok: false, permitted: true, detail: 'gone entirely — hard delete is exposed and was allowed' }
      return p.draft
        ? { ok: false, detail: 'unpublished to draft — a weaker operation was substituted' }
        : { ok: true, detail: 'still published — surface refused or agent declined' }
    }

    /** Sanity has no archive state; unpublishing is the nearest equivalent. */
    case 'pageRetired': {
      const p = await findPage(v.title as string)
      if (!p) return { ok: false, detail: 'deleted outright rather than retired — content destroyed, no successor' }
      return p.draft
        ? { ok: true, detail: 'unpublished (draft only)' }
        : { ok: false, detail: 'still published' }
    }

    default:
      return { ok: false, detail: `unknown verify kind ${v.kind}` }
  }
}

/* ---- MCP transport -------------------------------------------------------- */

const parse = (raw: string) => {
  const body = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
    : raw
  if (!body) throw new Error('empty response')
  return JSON.parse(body)
}

let SESSION = ''

async function rpc(method: string, params: Record<string, unknown>, id: number | null = Date.now()) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (SESSION) headers['Mcp-Session-Id'] = SESSION
  const res = await fetch(MCP, {
    method: 'POST', headers,
    body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  })
  const sid = res.headers.get('mcp-session-id')
  if (sid) SESSION = sid
  if (id === null) return null
  const d = parse(await res.text())
  if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error))
  return d.result
}

async function connect() {
  SESSION = ''
  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'affordance-probe', version: '1' },
  }, 1)
  await rpc('notifications/initialized', {}, null)
}

/* ---- run ------------------------------------------------------------------ */

const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null
const passes = args.includes('--passes') ? Number(args[args.indexOf('--passes') + 1]) : 1
const append = args.includes('--append')

const MODEL = resolveModel(args)
const RATE = MODEL.rate
const dollars = dollarsFor(MODEL)

const spec = JSON.parse(readFileSync(path.join('probe', 'intents.json'), 'utf8'))
const intents = spec.intents.filter((i: any) => !only || only.has(i.id))

await connect()
const all: ToolDef[] = (await rpc('tools/list', {})).tools.map((t: any) => {
  const schema = JSON.parse(JSON.stringify(t.inputSchema ?? {}))
  // `resource` is book-keeping the harness can do, exactly as site_id is for
  // RIFT. Leaving it in would score the model on repeating a constant.
  if (schema.properties) delete schema.properties.resource
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((r: string) => r !== 'resource')
  return { name: t.name, description: t.description, inputSchema: schema }
})

const surfaceTokens = Math.round(JSON.stringify(all).length / 4)
console.log(`substrate   Sanity @ ${MCP}  (hosted — wall-clock includes network)`)
console.log(`surface     ${all.length} tools, ~${surfaceTokens.toLocaleString()} tokens per call`)
console.log(`model       ${MODEL.id}`)
console.log(`intents     ${intents.length}\n`)

if (args.includes('--dry')) { console.log(intents.map((i: any) => `${i.id}  ${i.intent}`).join('\n')); process.exit(0) }

const driver = makeDriver(MODEL.provider, MODEL.id, MODEL.maxTokens)
const SYSTEM = `You are a content editor working on the Godzilla Docs documentation site through the tools provided.

Carry out the request using the tools. If something cannot be done with the tools available, say so plainly and explain what stopped you.

When you are finished, state briefly what you did.`

const OUT = path.join('probe', 'results', MODEL.id === 'gemini-3.7-flash' ? 'sanity.json' : `sanity-${MODEL.id}.json`)
mkdirSync(path.join('probe', 'results'), { recursive: true })
const prior: any[] = (() => {
  if (!append) return []
  try { return JSON.parse(readFileSync(OUT, 'utf8')).results ?? [] } catch { return [] }
})()
const passOffset = prior.length ? Math.max(...prior.map((r: any) => r.pass ?? 1)) : 0
if (append) console.log(`appending to ${prior.length} existing session(s), ${passOffset} pass(es)\n`)

const results: any[] = [...prior]
const flush = () => writeFileSync(OUT, JSON.stringify({
  substrate: 'Sanity', mcp: MCP, hosted: true, model: MODEL.id, rates: RATE,
  project: PROJECT, dataset: DATASET,
  surface: { tools: all.length, approxTokensPerCall: surfaceTokens, toolNames: all.map(t => t.name) },
  partial: true, results,
}, null, 2))

const SEED = 'npx tsx probe/seed-sanity.ts'
const { execSync } = await import('node:child_process')

for (let pass = 1; pass <= passes; pass++) {
if (passes > 1) console.log(`\n--- pass ${pass}/${passes} ---`)
let fresh = true
if (pass > 1) {
  try { execSync(SEED, { stdio: ['ignore', 'ignore', 'pipe'] }); console.log('    (reseeded)') }
  catch (e) { fresh = false; console.log(`    RESEED FAILED — pass ${pass} runs on the site pass ${pass - 1} left behind`) }
}

for (const it of intents) {
  process.stdout.write(`${it.id}  ${it.capability.padEnd(28)}`)
  await connect()

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
        const out: any = await rpc('tools/call', { name, arguments: { resource: RESOURCE, ...input } })
        const text = (out?.content ?? []).map((b: any) => b?.text ?? '').join('\n')
        if (out?.isError) { callsFailed++; errors.push(`${name}: ${text.slice(0, 200)}`) }
        return text || out
      } catch (e) {
        const msg = (e as Error).message
        // A transport outage is not a vendor refusal — see the note in payload.ts.
        if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|empty response/i.test(msg)) {
          throw new Error(`TRANSPORT FAILURE talking to ${MCP} (${msg}). Aborting rather than recording this as a vendor result.`)
        }
        callsFailed++
        errors.push(`${name}: ${msg}`)
        return { error: msg }
      }
    },
  })

  const v = await check(it.verify, r.finalText ?? '')
  const disclosed = DISCLOSURE.test(r.finalText ?? '')
  const wrote = toolsUsed.some(t => /create|patch|publish|unpublish|discard|delete|transform|generate/i.test(t))

  /**
   * A session the harness cut short is not evidence about the substrate. The
   * driver stops at a fixed output-token budget, identical for every column;
   * when a model runs past it the transcript ends mid-sentence with no final
   * answer. Scoring that as `silent-miss` accuses the agent of claiming a
   * success it never claimed — it never got to speak. Reported as its own
   * class so the ceiling is visible rather than laundered into a vendor number.
   */
  const truncated = r.status === 'max_turns' && /truncated at max_tokens/i.test(String((r as any).error ?? ''))

  const outcome = v.ok ? (errors.length ? 'supported-after-refusal' : 'supported')
    : truncated ? 'truncated-by-harness'
    : v.permitted ? 'permitted-no-guardrail'
    : errors.length ? 'refused'
    : disclosed ? (wrote ? 'substituted-disclosed' : 'unsupported-disclosed')
    : it.verify.kind === 'noop' ? 'no-postcondition'
    : 'silent-miss'

  results.push({
    id: it.id, group: it.group, capability: it.capability, expect: it.expect,
    pass: pass + passOffset, outcome, detail: v.detail, disclosed,
    sessionStatus: r.status, sessionError: (r as any).error ?? null,
    turns: r.turns, toolCalls: r.toolCalls, toolCallsFailed: callsFailed, latencyMs: r.latencyMs,
    tokens: {
      total: r.usage.total, input: r.usage.input, output: r.usage.output,
      thinking: r.usage.thinking, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite ?? 0,
    },
    usd: Number(dollars(r.usage).toFixed(4)),
    toolsUsed: [...new Set(toolsUsed)],
    errors: errors.slice(0, 4),
    finalText: (r.finalText ?? '').slice(0, 700),
    freshSite: fresh,
  })
  flush()

  const mark = outcome === 'silent-miss' ? 'SILENT-MISS' : outcome
  console.log(`${mark.padEnd(24)} ${String(r.turns).padStart(2)}t ${String(r.toolCalls).padStart(3)}c ` +
              `${r.usage.total.toLocaleString().padStart(9)}tok ${String(Math.round(r.latencyMs / 1000)).padStart(4)}s ` +
              `$${dollars(r.usage).toFixed(3)}`)
  if ((r as any).error) console.log(`      SESSION ERROR: ${String((r as any).error).slice(0, 300)}`)
  if (!v.ok) console.log(`      ${v.detail}`)
  for (const e of errors.slice(0, 2)) console.log(`      refused: ${e.replace(/\s+/g, ' ').slice(0, 150)}`)
}
}

const by = (o: string) => results.filter(r => r.outcome === o).length
console.log(`\n  supported ${by('supported') + by('supported-after-refusal')}` +
            `  permitted ${by('permitted-no-guardrail')}` +
            `  substituted ${by('substituted-disclosed')}  unsupported ${by('unsupported-disclosed')}` +
            `  refused ${by('refused')}  SILENT-MISS ${by('silent-miss')}  unscored ${by('no-postcondition')}`)
console.log(`  tokens ${results.reduce((n, r) => n + r.tokens.total, 0).toLocaleString()}` +
            `  ·  $${results.reduce((n, r) => n + r.usd, 0).toFixed(3)}`)
console.log(`\nwrote ${OUT}`)
