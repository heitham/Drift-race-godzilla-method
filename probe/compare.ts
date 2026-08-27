/**
 * Paired affordance comparison — one model, one site, two substrates.
 *
 * Both columns run the same intents against a site seeded from the same
 * fixture, so a difference here is a property of the MCP surface and not of the
 * content. That was NOT true earlier and it mattered: one substrate's site
 * already carried a link an intent asks an agent to add, and would have scored
 * `supported` for work it never performed.
 *
 * Every figure is a MEDIAN over passes, never a sum. One expensive pass should
 * not decide a cell, and with n = 2 a median is the honest summary — the spread
 * is reported separately rather than averaged away.
 *
 * Usage: tsx probe/compare.ts [--json]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

interface Row {
  id: string; group: string; capability: string; pass: number
  outcome: string; disclosed: boolean; detail: string
  turns: number; toolCalls: number; latencyMs: number
  tokens: { total: number }; usd: number
  freshSite?: boolean
}
interface Col { substrate: string; surface: { tools: number; approxTokensPerCall: number }; results: Row[] }

const load = (f: string): Col => {
  const d = JSON.parse(readFileSync(path.join('probe', 'results', f), 'utf8'))
  // A pass that did not start from a restored site measures whatever the
  // previous pass left behind; it is excluded rather than flagged in a footnote.
  d.results = d.results.filter((r: Row) => r.freshSite !== false)
  return d
}

const cols = [load('rift.json'), load('payload.json')]
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const intents = JSON.parse(readFileSync(path.join('probe', 'intents.json'), 'utf8')).intents as any[]
const rowsFor = (c: Col, id: string) => c.results.filter(r => r.id === id)

/** Did every pass reach the same outcome? A coin flip is worse than a known gap. */
const stable = (rs: Row[]) => rs.length > 1 && new Set(rs.map(r => r.outcome)).size === 1
const good = (o: string) => o.startsWith('supported')

const SHORT: Record<string, string> = {
  'supported': 'yes',
  'supported-after-refusal': 'yes*',
  'substituted-disclosed': 'substituted',
  'unsupported-disclosed': 'no, said so',
  'permitted-no-guardrail': 'allowed',
  'refused': 'REFUSED',
  'silent-miss': 'SILENT MISS',
  'no-postcondition': 'unscored',
}
const label = (rs: Row[]) => {
  if (!rs.length) return '—'
  const os = [...new Set(rs.map(r => r.outcome))]
  return os.length === 1 ? SHORT[os[0]] ?? os[0] : os.map(o => SHORT[o] ?? o).join(' / ')
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    site: 'probe/fixtures/site.json',
    columns: cols.map(c => ({
      substrate: c.substrate, surface: c.surface, sessions: c.results.length,
      passes: new Set(c.results.map(r => r.pass)).size,
    })),
    intents: intents.map(i => ({
      id: i.id, capability: i.capability, group: i.group,
      columns: cols.map(c => {
        const rs = rowsFor(c, i.id)
        return {
          substrate: c.substrate, outcomes: rs.map(r => r.outcome), stable: stable(rs),
          medianTokens: rs.length ? med(rs.map(r => r.tokens.total)) : null,
          medianUsd: rs.length ? Number(med(rs.map(r => r.usd)).toFixed(4)) : null,
          medianSeconds: rs.length ? Math.round(med(rs.map(r => r.latencyMs)) / 1000) : null,
        }
      }),
    })),
  }, null, 2))
} else {
  const [a, b] = cols
  console.log(`\n  ${a.substrate} vs ${b.substrate} — same 18 intents, same site, gemini-3.7-flash`)
  console.log(`  ${a.substrate}: ${a.results.length} sessions   ${b.substrate}: ${b.results.length} sessions   (fresh-site passes only)\n`)
  console.log(`  tool surface, sent on EVERY call:`)
  for (const c of cols) console.log(`    ${c.substrate.padEnd(8)} ${String(c.surface.tools).padStart(3)} tools  ${c.surface.approxTokensPerCall.toLocaleString().padStart(8)} tokens`)

  console.log(`\n  ${''.padEnd(3)} ${'capability'.padEnd(26)} ${a.substrate.padEnd(15)} ${b.substrate.padEnd(15)} ${'tok ' + a.substrate}`.padEnd(100))
  console.log('  ' + '─'.repeat(96))
  for (const i of intents) {
    const ra = rowsFor(a, i.id), rb = rowsFor(b, i.id)
    const ta = ra.length ? med(ra.map(r => r.tokens.total)) : 0
    const tb = rb.length ? med(rb.map(r => r.tokens.total)) : 0
    const ratio = ta && tb ? (tb / ta) : 0
    const flag = (rs: Row[]) => (rs.length > 1 && !stable(rs)) ? '~' : ' '
    console.log(
      `  ${i.id.padEnd(3)} ${i.capability.padEnd(26)} ` +
      `${(label(ra) + flag(ra)).padEnd(15)} ${(label(rb) + flag(rb)).padEnd(15)} ` +
      `${ta.toLocaleString().padStart(10)} ${tb.toLocaleString().padStart(11)} ` +
      `${ratio ? (ratio >= 1 ? `${ratio.toFixed(1)}x` : `${(1 / ratio).toFixed(1)}x cheaper`) : ''}`,
    )
  }

  console.log('\n  ~ = the two passes disagreed on the outcome\n')
  console.log('  ' + 'summary'.padEnd(34) + cols.map(c => c.substrate.padEnd(14)).join(''))
  console.log('  ' + '─'.repeat(64))
  const line = (name: string, f: (c: Col) => string) =>
    console.log('  ' + name.padEnd(34) + cols.map(c => f(c).padEnd(14)).join(''))

  const ids = intents.map(i => i.id)
  line('intents supported in every pass', c =>
    `${ids.filter(id => { const rs = rowsFor(c, id); return rs.length && rs.every(r => good(r.outcome)) }).length}/${ids.length}`)
  line('same outcome in every pass', c =>
    `${ids.filter(id => stable(rowsFor(c, id))).length}/${ids.length}`)
  line('silent misses', c => `${c.results.filter(r => r.outcome === 'silent-miss').length}/${c.results.length}`)
  line('shortfalls disclosed', c => {
    const s = c.results.filter(r => !good(r.outcome) && r.outcome !== 'no-postcondition')
    return s.length ? `${s.filter(r => r.disclosed).length}/${s.length}` : '—'
  })
  line('tool calls that errored', c =>
    `${(100 * c.results.reduce((n, r) => n + ((r as any).toolCallsFailed ?? 0), 0) /
        Math.max(1, c.results.reduce((n, r) => n + r.toolCalls, 0))).toFixed(1)}%`)
  line('median tokens per intent', c => med(c.results.map(r => r.tokens.total)).toLocaleString())
  line('median $ per intent', c => '$' + med(c.results.map(r => r.usd)).toFixed(3))
  line('median seconds per intent', c => String(Math.round(med(c.results.map(r => r.latencyMs)) / 1000)))
  line('total $ for the column', c => '$' + c.results.reduce((n, r) => n + r.usd, 0).toFixed(2))

  console.log('\n  by task kind (median tokens per session)')
  console.log('  ' + 'group'.padEnd(34) + cols.map(c => c.substrate.padEnd(14)).join('') + 'ratio')
  console.log('  ' + '─'.repeat(72))
  for (const g of [...new Set(intents.map(i => i.group))]) {
    const t = cols.map(c => { const rs = c.results.filter(r => r.group === g); return rs.length ? med(rs.map(r => r.tokens.total)) : 0 })
    console.log('  ' + g.padEnd(34) + t.map(x => x.toLocaleString().padEnd(14)).join('') +
                (t[0] && t[1] ? `${(t[1] / t[0]).toFixed(1)}x` : ''))
  }
  console.log('\n  n = 2 passes per cell. Directional; no significance is claimed.\n')
}
