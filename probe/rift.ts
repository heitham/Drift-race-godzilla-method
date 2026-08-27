/**
 * Affordance probe — RIFT adapter.
 *
 * Runs each intent from intents.json as one fresh agent session against RIFT's
 * MCP surface, then checks the postcondition against the CMS's own state.
 *
 * Nothing is published. The probe measures the INTERFACE, not rendered output,
 * so there is no publish pipeline, no HTML scoring and no parity gate — which
 * is what makes it portable to another vendor in hours instead of weeks.
 *
 * Mutations still travel RIFT's real path: the agent proposes into a change-set
 * and the harness approves with its reviewer key, exactly as in the drift race.
 * `publish_after` is false — the probe reads the database, not a branch.
 *
 * Usage: tsx probe/rift.ts [--only D1,R2] [--dry]
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../harness/run/config.js'
import { makeDriver, type ToolDef } from '../harness/run/drivers.js'
import { resolveModel, dollarsFor, resultFile } from './models.js'
import { DISCLOSURE } from './disclosure.js'

loadEnv()

const SITE = '32114acb-ccbe-44e4-96d4-64fa594284e2'
const MCP = process.env.RIFT_MCP_URL ?? 'http://localhost:3001/api/mcp'
const ORIGIN = new URL(MCP).origin
const DB = process.env.DATABASE_URL ?? 'postgres://localhost:5432/cms_dev'
const AGENT_KEY = process.env.RIFT_API_KEY!
const ADMIN_KEY = process.env.RIFT_ADMIN_KEY!

/** Withheld for the same reason as the drift race: this hands the work to the
 *  CMS's own internal agent, so the surface under test would not be the one
 *  being measured. */
const WITHHELD = new Set(['request_content_change', 'list_sites'])

const sql = (q: string) =>
  execSync(`psql "${DB}" -tAc ${JSON.stringify(q.replace(/\s+/g, ' ').trim())}`, { encoding: 'utf8' }).trim()

const esc = (s: string) => s.replace(/'/g, "''")

async function rpc(method: string, params: Record<string, unknown>, key = AGENT_KEY) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const d = await res.json() as any
  if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error))
  return d.result
}

// --- postconditions, checked against the CMS's own state --------------------
// Ported to another vendor these become reads through that vendor's MCP; the
// shapes below are deliberately generic (title, section, body) rather than
// RIFT-specific so the port is mechanical.

const livePage = (title: string) => sql(`
  SELECT coalesce(f.path,''), ci.workflow_state
  FROM content_placements cp
  JOIN content_items ci ON ci.id = cp.item_id
  LEFT JOIN folders f ON f.id = cp.folder_id
  WHERE cp.site_id = '${SITE}' AND ci.page_title = '${esc(title)}'
    AND ci.workflow_state IN ('public','staging')
  ORDER BY ci.workflow_state LIMIT 1
`)

const bodyOf = (title: string) => sql(`
  SELECT ci.body FROM content_placements cp
  JOIN content_items ci ON ci.id = cp.item_id
  WHERE cp.site_id = '${SITE}' AND ci.page_title = '${esc(title)}'
    AND ci.workflow_state IN ('public','staging')
  ORDER BY ci.workflow_state LIMIT 1
`)

interface Verify { kind: string; [k: string]: unknown }

/**
 * `permitted` marks a shortfall that is a POLICY difference rather than a
 * defect: the intent expected a refusal, the surface allowed it, and the agent
 * reported accurately. Folding that into `silent-miss` scores one vendor's
 * governance model as the definition of correct and brands an honest surface
 * dishonest. Kept identical to the Payload column so the classes mean the same
 * thing in both.
 */
function check(v: Verify, finalText: string): { ok: boolean; detail: string; permitted?: boolean } {
  switch (v.kind) {
    case 'noop':
      return { ok: false, detail: 'no postcondition — classified from the transcript' }

    case 'answerNames': {
      const must = v.mustInclude as string[]
      const hay = finalText.toLowerCase()
      const missing = must.filter(m => !hay.includes(m.toLowerCase()))
      return { ok: missing.length === 0, detail: missing.length ? `answer omitted: ${missing.join(', ')}` : 'answer named the expected pages' }
    }

    case 'pageExists': {
      const row = livePage(v.title as string)
      return { ok: !!row, detail: row ? `present (${row})` : `no page titled "${v.title}"` }
    }

    case 'allPagesExist': {
      const missing = (v.titles as string[]).filter(t => !livePage(t))
      return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'both halves exist' }
    }

    case 'pageInSection': {
      const row = livePage(v.title as string)
      if (!row) return { ok: false, detail: `no page titled "${v.title}"` }
      const section = row.split('|')[0]
      return { ok: section === v.section, detail: `section is "${section || '(root)'}", wanted "${v.section}"` }
    }

    case 'sectionExists': {
      const n = sql(`SELECT count(*) FROM folders WHERE site_id='${SITE}' AND path='${esc(v.section as string)}'`)
      return { ok: n !== '0', detail: n !== '0' ? 'section created' : `no section "${v.section}"` }
    }

    case 'bodyContains': {
      const body = bodyOf(v.title as string)
      if (!body) return { ok: false, detail: `no page titled "${v.title}"` }
      const hay = v.caseInsensitive ? body.toLowerCase() : body
      const needle = v.caseInsensitive ? (v.text as string).toLowerCase() : (v.text as string)
      const ok = hay.includes(needle)
      return { ok, detail: ok ? 'body carries the text' : `body does not contain "${v.text}"` }
    }

    case 'linksTo': {
      const n = sql(`
        SELECT count(*) FROM link_edges le
        JOIN content_items src ON src.id = le.from_item_id
        JOIN content_items dst ON dst.id = le.to_item_id
        WHERE src.page_title = '${esc(v.from as string)}' AND dst.page_title = '${esc(v.to as string)}'
      `)
      return { ok: n !== '0', detail: n !== '0' ? `${n} managed edge(s)` : 'no managed link edge between them' }
    }

    case 'allBodiesContain': {
      const total = sql(`
        SELECT count(*) FROM content_placements cp
        JOIN content_items ci ON ci.id = cp.item_id
        JOIN folders f ON f.id = cp.folder_id
        WHERE cp.site_id='${SITE}' AND f.path='${esc(v.section as string)}'
          AND ci.workflow_state IN ('public','staging')
      `)
      const hit = sql(`
        SELECT count(*) FROM content_placements cp
        JOIN content_items ci ON ci.id = cp.item_id
        JOIN folders f ON f.id = cp.folder_id
        WHERE cp.site_id='${SITE}' AND f.path='${esc(v.section as string)}'
          AND ci.workflow_state IN ('public','staging')
          AND ci.body ILIKE '%${esc(v.text as string)}%'
      `)
      const ok = Number(hit) >= Number(v.minPages ?? 1) && hit === total
      return { ok, detail: `${hit}/${total} pages in "${v.section}" carry it` }
    }

    // Three very different outcomes hide behind "does the page still exist":
    // the surface refused (still live), the agent substituted a weaker
    // operation (archived), or a hard delete really happened (gone). A boolean
    // collapses them, and collapsed them wrongly on the first run.
    case 'pageState': {
      const row = livePage(v.title as string)
      if (row) return { ok: true, detail: `still live (${row.split('|')[1]}) — surface refused, correct` }
      const arch = sql(`
        SELECT count(*) FROM content_placements cp
        JOIN content_items ci ON ci.id = cp.item_id
        WHERE cp.site_id='${SITE}' AND ci.page_title='${esc(v.title as string)}'
          AND ci.workflow_state='archived'
      `)
      return arch !== '0'
        ? { ok: false, detail: 'archived — a weaker operation was substituted for deletion' }
        : { ok: false, permitted: true, detail: 'gone from the CMS entirely — hard delete was allowed' }
    }

    case 'pageRetired': {
      const n = sql(`
        SELECT count(*) FROM content_placements cp
        JOIN content_items ci ON ci.id = cp.item_id
        WHERE cp.site_id='${SITE}' AND ci.page_title='${esc(v.title as string)}'
          AND ci.workflow_state = 'archived'
      `)
      return { ok: n !== '0', detail: n !== '0' ? 'archived' : 'still live' }
    }

    default:
      return { ok: false, detail: `unknown verify kind ${v.kind}` }
  }
}

// --- review, so mutations actually land -------------------------------------
async function review(): Promise<number> {
  const ids = sql(`SELECT id FROM change_sets WHERE site_id='${SITE}' AND status='proposed' ORDER BY proposed_at`)
    .split('\n').map(s => s.trim()).filter(Boolean)
  for (const id of ids) {
    const res = await fetch(`${ORIGIN}/api/v1/sites/${SITE}/change-sets/${id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      // No publish: the probe reads CMS state, not a git branch.
      body: JSON.stringify({ comment: 'approved by affordance probe', publish_after: false }),
    })
    if (!res.ok) console.warn(`    approve failed for ${id.slice(0, 8)}: HTTP ${res.status}`)
  }
  return ids.length
}

async function flushOpen(): Promise<number> {
  const ids = sql(`
    SELECT DISTINCT cs.id FROM change_sets cs
    JOIN change_set_items csi ON csi.change_set_id = cs.id
    WHERE cs.site_id='${SITE}' AND cs.status='open'
  `).split('\n').map(s => s.trim()).filter(Boolean)
  for (const id of ids) {
    try { await rpc('tools/call', { name: 'propose_change_set', arguments: { site_id: SITE, change_set_id: id, comment: 'closed by probe' } }) }
    catch { /* an unproposable change-set is the model's failure, not the probe's */ }
  }
  return ids.length
}

// --- run --------------------------------------------------------------------
const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null
/**
 * Passes per intent. One pass cannot see determinism, and determinism is a
 * buyer question, not an academic one: X2 disclosed its substitution on one run
 * and called archival "removal" on the next. "Happened once" and "happens a
 * third of the time" are different products.
 */
const passes = args.includes('--passes') ? Number(args[args.indexOf('--passes') + 1]) : 1

const MODEL = resolveModel(args)

/**
 * The CMS pin this column ran against. RIFT changed during the study — a
 * get_inbound_links tool landed after the first columns were measured — so a
 * result that does not name its pin cannot be told apart from a result measured
 * on a different product.
 */
const CMS_PIN = (() => {
  try {
    return execSync(`git -C ${JSON.stringify(process.env.CMS_REPO ?? '.')} rev-parse --short HEAD`, { encoding: 'utf8' }).trim()
  } catch { return 'unknown' }
})()
const RATE = MODEL.rate
const dollars = dollarsFor(MODEL)

const spec = JSON.parse(readFileSync(path.join('probe', 'intents.json'), 'utf8'))
const intents = spec.intents.filter((i: any) => !only || only.has(i.id))

const all: ToolDef[] = (await rpc('tools/list', {})).tools
  .filter((t: any) => !WITHHELD.has(t.name))
  .map((t: any) => {
    const schema = JSON.parse(JSON.stringify(t.inputSchema ?? {}))
    if (schema.properties) delete schema.properties.site_id
    if (Array.isArray(schema.required)) schema.required = schema.required.filter((r: string) => r !== 'site_id')
    return { name: t.name, description: t.description, inputSchema: schema }
  })

const surfaceTokens = Math.round(JSON.stringify(all).length / 4)
console.log(`substrate   RIFT @ ${MCP}`)
console.log(`surface     ${all.length} tools, ~${surfaceTokens.toLocaleString()} tokens per call`)
console.log(`intents     ${intents.length}\n`)

if (args.includes('--dry')) { console.log(intents.map((i: any) => `${i.id}  ${i.intent}`).join('\n')); process.exit(0) }

const driver = makeDriver(MODEL.provider, MODEL.id, MODEL.maxTokens)
const SYSTEM = `You are a content editor working on the Godzilla Docs documentation site through the tools provided.

Carry out the request using the tools. If something cannot be done with the tools available, say so plainly and explain what stopped you.

When you are finished, state briefly what you did.`

const append = args.includes('--append')
const OUT = path.join('probe', 'results', resultFile('rift', MODEL))
mkdirSync(path.join('probe', 'results'), { recursive: true })
const prior: any[] = (() => {
  if (!append) return []
  try { return JSON.parse(readFileSync(OUT, 'utf8')).results ?? [] } catch { return [] }
})()
const passOffset = prior.length ? Math.max(...prior.map((r: any) => r.pass ?? 1)) : 0
if (append) console.log(`appending to ${prior.length} existing session(s), ${passOffset} pass(es)\n`)

const results: any[] = [...prior]

/**
 * Flushed after EVERY session. A crash between the last intent and the write
 * discarded a completed pass once, on the Payload column; a run this expensive
 * must not be able to lose finished work.
 */
const flush = () => writeFileSync(OUT, JSON.stringify({
  substrate: 'RIFT', mcp: MCP, model: MODEL.id, rates: RATE, cmsPin: CMS_PIN,
  surface: { tools: all.length, approxTokensPerCall: surfaceTokens, toolNames: all.map(t => t.name) },
  partial: true, results,
}, null, 2))

for (let pass = 1; pass <= passes; pass++) {
if (passes > 1) console.log(`\n--- pass ${pass}/${passes} ---`)
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
        const out = await rpc('tools/call', { name, arguments: { site_id: SITE, ...input } })
        const text = (out?.content ?? []).map((b: any) => b?.text ?? '').join('\n')
        return text || out
      } catch (e) {
        const msg = (e as Error).message
        // A dead server is not a vendor refusal — see the note in payload.ts.
        if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|empty response/i.test(msg)) {
          throw new Error(
            `TRANSPORT FAILURE talking to ${MCP} (${msg}). ` +
            `Aborting rather than recording this as a vendor result. Is the server up?`,
          )
        }
        callsFailed++
        errors.push(`${name}: ${msg}`)
        return { error: msg }
      }
    },
  })

  await flushOpen()
  const approved = await review()

  const v = check(it.verify, r.finalText ?? '')

  // Disclosure is the axis that matters, and a boolean postcondition cannot see
  // it. An agent that cannot do a thing, does something weaker, and SAYS SO has
  // behaved well; one that does the same thing and reports success has not. The
  // detector is a heuristic over the agent's own words and every finalText is
  // recorded, so any classification here can be audited or overridden.
  const disclosed = DISCLOSURE.test(r.finalText ?? '')
  const didSomething = toolsUsed.some(t => /create|update|patch|move|retire|delete|propose|open_change/.test(t))

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

    // Effort — what it costs a team to get this done.
    turns: r.turns,
    toolCalls: r.toolCalls,
    toolCallsFailed: callsFailed,
    latencyMs: r.latencyMs,

    // Cost — split, because "what does it cost to UNDERSTAND my site" and
    // "what does it cost to CHANGE it" are different purchasing questions.
    tokens: {
      total: tok,
      input: r.usage.input,
      output: r.usage.output,
      thinking: r.usage.thinking,
      cacheRead: r.usage.cacheRead,
      cacheWrite: r.usage.cacheWrite ?? 0,
    },
    usd: Number(dollars(r.usage).toFixed(4)),

    toolsUsed: [...new Set(toolsUsed)],
    errors: errors.slice(0, 4),
    changeSetsApproved: approved,
    finalText: (r.finalText ?? '').slice(0, 700),
    // Passes are reset from the shell between invocations; a run that reaches
    // here started from a restored baseline.
    freshSite: true,
  })
  flush()

  const mark = outcome === 'silent-miss' ? 'SILENT-MISS' : outcome
  console.log(`${mark.padEnd(24)} ${String(r.turns).padStart(2)}t ${String(r.toolCalls).padStart(3)}c ` +
              `${tok.toLocaleString().padStart(9)}tok ${String(Math.round(r.latencyMs / 1000)).padStart(4)}s ` +
              `$${dollars(r.usage).toFixed(3)}`)
  if (!v.ok) console.log(`      ${v.detail}`)
  for (const e of errors.slice(0, 2)) console.log(`      refused: ${e.replace(/\s+/g, ' ').slice(0, 150)}`)
}
}

const out = OUT

// --- roll-ups: the numbers a buyer actually decides on ----------------------
// Per-intent rows are evidence; these are the reading of it. Computed here
// rather than in a notebook so every substrate is summarised by identical code
// and the comparison cannot drift between columns.
const outcomes = (rs: any[]) => rs.reduce((m: any, r) => (m[r.outcome] = (m[r.outcome] ?? 0) + 1, m), {})
const byIntent = new Map<string, any[]>()
for (const r of results) byIntent.set(r.id, [...(byIntent.get(r.id) ?? []), r])

const summary = {
  passes: passes + passOffset,
  intents: byIntent.size,
  sessions: results.length,

  // Coverage and the failure that matters most.
  supportedRate: results.filter(r => r.outcome.startsWith('supported')).length / results.length,
  silentMissRate: results.filter(r => r.outcome === 'silent-miss').length / results.length,
  disclosureRate: (() => {
    const shortfalls = results.filter(r => !r.outcome.startsWith('supported'))
    return shortfalls.length ? shortfalls.filter(r => r.disclosed).length / shortfalls.length : null
  })(),

  // Effort and cost, per intent-attempt.
  usdTotal: Number(results.reduce((n, r) => n + r.usd, 0).toFixed(3)),
  usdMedian: Number([...results.map(r => r.usd)].sort((a, b) => a - b)[Math.floor(results.length / 2)].toFixed(4)),
  secondsMedian: Math.round([...results.map(r => r.latencyMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)] / 1000),
  turnsMedian: [...results.map(r => r.turns)].sort((a, b) => a - b)[Math.floor(results.length / 2)],
  toolCallFailureRate: results.reduce((n, r) => n + r.toolCallsFailed, 0) /
                       Math.max(1, results.reduce((n, r) => n + r.toolCalls, 0)),

  // Read vs write economics — different purchasing questions.
  tokensByGroup: [...new Set(results.map(r => r.group))].reduce((m: any, g) => {
    const rs = results.filter(r => r.group === g)
    m[g] = { sessions: rs.length, tokens: rs.reduce((n, r) => n + r.tokens.total, 0),
             usd: Number(rs.reduce((n, r) => n + r.usd, 0).toFixed(3)) }
    return m
  }, {}),

  // Attribution: which KIND of task fails, and how.
  outcomeByGroup: [...new Set(results.map(r => r.group))].reduce((m: any, g) => {
    m[g] = outcomes(results.filter(r => r.group === g)); return m
  }, {}),

  // Determinism. Only meaningful with passes > 1; recorded either way so the
  // absence is visible rather than assumed.
  nonDeterministicIntents: [...byIntent.entries()]
    .filter(([, rs]) => new Set(rs.map(r => r.outcome)).size > 1)
    .map(([id, rs]) => ({ id, outcomes: rs.map(r => r.outcome) })),

  // Where the money goes.
  costConcentration: [...byIntent.entries()]
    .map(([id, rs]) => ({ id, capability: rs[0].capability, usd: Number(rs.reduce((n, r) => n + r.usd, 0).toFixed(3)) }))
    .sort((a, b) => b.usd - a.usd).slice(0, 5),
}

writeFileSync(out, JSON.stringify({
  substrate: 'RIFT', mcp: MCP, model: MODEL.id, rates: RATE, cmsPin: CMS_PIN,
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
