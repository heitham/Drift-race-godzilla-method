/**
 * The full matrix — substrate × model, and one substrate across two CMS pins.
 *
 * The paired comparison answers "does the substrate matter". It cannot answer
 * the first objection anyone raises to it: that a fast cheap model is simply
 * flaky, and a stronger one would close the gap. That is settled by running the
 * same intents on a second model, not by argument — so the unit here is a CELL
 * (substrate, model, pin) and the interesting reads are across its edges.
 *
 * Usage: tsx probe/matrix.ts [--json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface Row {
  id: string; pass: number; outcome: string; disclosed: boolean
  turns: number; toolCalls: number; toolCallsFailed?: number
  latencyMs: number; tokens: { total: number }; usd: number; freshSite?: boolean
}

const CELLS = [
  { key: 'RIFT · gemini · b8461b8',  file: 'rift-b8461b8-gemini.json',    note: 'before get_inbound_links' },
  { key: 'RIFT · gemini · 0adc095',  file: 'rift.json',                   note: 'after' },
  { key: 'RIFT · sonnet5 · 0adc095', file: 'rift-claude-sonnet-5.json',   note: '' },
  { key: 'Payload · gemini',         file: 'payload.json',                note: '' },
  { key: 'Payload · sonnet5',        file: 'payload-claude-sonnet-5.json', note: '' },
  { key: 'Sanity · sonnet5',         file: 'sanity-claude-sonnet-5.json',  note: 'hosted' },
]

/** Tool-schema tokens sent on every call, measured per column. */
const SCHEMA: Record<string, number> = {
  'RIFT · gemini · b8461b8': 2285, 'RIFT · gemini · 0adc095': 2889,
  'RIFT · sonnet5 · 0adc095': 2889, 'Payload · gemini': 12583,
  'Payload · sonnet5': 12583, 'Sanity · sonnet5': 12581,
}

const load = (f: string): Row[] =>
  (JSON.parse(readFileSync(path.join('probe', 'results', f), 'utf8')).results as Row[])
    .filter(r => r.freshSite !== false)   // a pass that did not start clean is not evidence

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const intents = JSON.parse(readFileSync(path.join('probe', 'intents.json'), 'utf8')).intents as any[]
const ids = intents.map(i => i.id)
const good = (o: string) => o.startsWith('supported')

const cells = CELLS.map(c => {
  const rows = load(c.file)
  const per = (id: string) => rows.filter(r => r.id === id)
  return {
    ...c, rows,
    sessions: rows.length,
    passes: new Set(rows.map(r => r.pass)).size,
    /** Supported on EVERY pass — one lucky pass is not a capability. */
    supported: ids.filter(id => per(id).length && per(id).every(r => good(r.outcome))).length,
    /** The number that matters most: did it do the same thing twice? */
    stable: ids.filter(id => per(id).length > 1 && new Set(per(id).map(r => r.outcome)).size === 1).length,
    silentMiss: rows.filter(r => r.outcome === 'silent-miss').length,
    disclosed: (() => {
      const s = rows.filter(r => !good(r.outcome) && r.outcome !== 'no-postcondition')
      return s.length ? `${s.filter(r => r.disclosed).length}/${s.length}` : '—'
    })(),
    medTokens: med(rows.map(r => r.tokens.total)),
    totTokens: rows.reduce((n, r) => n + r.tokens.total, 0),
    medSeconds: Math.round(med(rows.map(r => r.latencyMs)) / 1000),
    medTurns: med(rows.map(r => r.turns)),
    usd: rows.reduce((n, r) => n + r.usd, 0),
    /**
     * Total splits into SURFACE cost (turns x schema, paid before any thinking)
     * and WORK cost (everything else). Reported because a column carrying a big
     * tool list is penalised on total in a way that says nothing about how well
     * it edits — and separating them removes any need to guess which tools
     * "count" as content and filter the rest away.
     */
    surface: med(rows.map(r => r.turns)) * (SCHEMA[c.key] ?? 0),
    work: Math.max(0, med(rows.map(r => r.tokens.total)) - med(rows.map(r => r.turns)) * (SCHEMA[c.key] ?? 0)),
    truncated: rows.filter(r => r.outcome === 'truncated-by-harness').length,
  }
})

if (process.argv.includes('--json')) {
  const out = {
    site: 'probe/fixtures/site.json (30 pages, 119 links, 3 sections)',
    cells: cells.map(({ rows, ...c }) => c),
    perIntent: ids.map(id => ({
      id, capability: intents.find(i => i.id === id).capability,
      cells: cells.map(c => {
        const rs = c.rows.filter(r => r.id === id)
        return {
          cell: c.key, outcomes: rs.map(r => r.outcome),
          medianTokens: rs.length ? med(rs.map(r => r.tokens.total)) : null,
          medianSeconds: rs.length ? Math.round(med(rs.map(r => r.latencyMs)) / 1000) : null,
        }
      }),
    })),
  }
  writeFileSync(path.join('probe', 'results', 'matrix.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log('\n  Affordance probe — full matrix. Same 18 intents, same site (30 pages, 119 links).\n')
  const H = ['cell', 'sess', 'supp', 'STABLE', 'silent', 'disclosed', 'med tok', 'surface', 'work', 'med s', 'turns', '$']
  const W = [26, 5, 6, 7, 7, 10, 10, 9, 9, 6, 6, 7]
  console.log('  ' + H.map((h, i) => h.padEnd(W[i])).join(''))
  console.log('  ' + '─'.repeat(W.reduce((a, b) => a + b, 0)))
  for (const c of cells) {
    const v = [c.key, String(c.sessions), `${c.supported}/18`, `${c.stable}/18`,
               `${c.silentMiss}/${c.sessions}`, c.disclosed,
               c.medTokens.toLocaleString(), c.surface.toLocaleString(), Math.round(c.work).toLocaleString(),
               String(c.medSeconds), String(c.medTurns), '$' + c.usd.toFixed(2)]
    console.log('  ' + v.map((x, i) => x.padEnd(W[i])).join(''))
  }

  const by = (k: string) => cells.find(c => c.key === k)!
  console.log('\n  ── reads across the edges ──\n')

  const pre = by('RIFT · gemini · b8461b8'), post = by('RIFT · gemini · 0adc095')
  const d3 = (c: typeof pre) => med(c.rows.filter(r => r.id === 'D3').map(r => r.tokens.total))
  console.log(`  product change, same model: get_inbound_links (FR-MCP-051)`)
  console.log(`    D3 inbound-link query   ${d3(pre).toLocaleString()} -> ${d3(post).toLocaleString()} tokens` +
              `   (${(d3(pre) / d3(post)).toFixed(0)}x cheaper)`)
  console.log(`    whole column            ${pre.totTokens.toLocaleString()} -> ${post.totTokens.toLocaleString()} tokens`)

  console.log(`\n  model change, same substrate:`)
  for (const [g, s] of [['RIFT · gemini · 0adc095', 'RIFT · sonnet5 · 0adc095'], ['Payload · gemini', 'Payload · sonnet5']] as const) {
    const a = by(g), b = by(s)
    console.log(`    ${g.split(' ·')[0].padEnd(8)} stable ${a.stable}/18 -> ${b.stable}/18` +
                `   tokens ${a.totTokens.toLocaleString()} -> ${b.totTokens.toLocaleString()}` +
                `   $${a.usd.toFixed(2)} -> $${b.usd.toFixed(2)}`)
  }

  console.log(`\n  three substrates on sonnet 5 (Sanity is HOSTED — its seconds include network, its tokens do not):`)
  for (const k of ['RIFT · sonnet5 · 0adc095', 'Payload · sonnet5', 'Sanity · sonnet5']) {
    const c = by(k)
    console.log(`    ${k.split(' ·')[0].padEnd(8)} supported ${c.supported}/18  stable ${c.stable}/18` +
                `  silent ${c.silentMiss}  truncated ${c.truncated}` +
                `  med tok ${c.medTokens.toLocaleString().padStart(8)}  turns ${String(c.medTurns).padStart(2)}`)
  }

  console.log(`\n  substrate change, same model:`)
  for (const [r, p] of [['RIFT · gemini · 0adc095', 'Payload · gemini'], ['RIFT · sonnet5 · 0adc095', 'Payload · sonnet5']] as const) {
    const a = by(r), b = by(p)
    console.log(`    ${r.includes('gemini') ? 'gemini ' : 'sonnet5'}  stable ${a.stable}/18 vs ${b.stable}/18` +
                `   silent-miss ${a.silentMiss} vs ${b.silentMiss}` +
                `   med tok ${a.medTokens.toLocaleString()} vs ${b.medTokens.toLocaleString()}` +
                `   (${(b.medTokens / a.medTokens).toFixed(1)}x)`)
  }
  console.log('\n  n = 2 passes per cell. Directional; no significance is claimed.\n')
}
