/**
 * Paired comparison — one model, two substrates.
 *
 * The benchmark's unit of evidence is a PAIR: the same model, the same thirty
 * operations, the same starting site, differing only in what it writes through.
 * Comparing across models is a secondary question and a much weaker one, since
 * n = 1 per cell (methodology §10.1). So this reads two scored runs, refuses to
 * compare them unless they are genuinely paired, and prints what changed.
 *
 * Reports FINAL STATE, not a sum. Drift is a property of the site you are left
 * with: an operation that breaks a link and a later one that repairs it should
 * net to zero, and summing per-op counts would score the repair as more damage.
 *
 * Usage:
 *   tsx scoring/compare.ts <results/run-a> <results/run-b> [--json]
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

interface Row {
  op: number
  opId: string
  wave: string
  status: string
  autoClosed?: boolean
  satisfied?: boolean | null
  tokens?: Record<string, number>
  m1_brokenRefs: number
  m2_styleForks: number
  m4_chromeDivergence: number
  m5_blastRadius: number
  m6_orphans: number
  m6_unreachable: number
  pages: number
}

interface Run {
  dir: string
  arm: string
  model: string
  rows: Row[]
}

function load(dir: string): Run {
  const manifestPath = path.join(dir, 'manifest.json')
  const timelinePath = path.join(dir, 'timeline.json')
  for (const f of [manifestPath, timelinePath]) {
    if (!existsSync(f)) throw new Error(`missing ${f} — has this run been scored? (npm run score:run ${dir})`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const rows: Row[] = JSON.parse(readFileSync(timelinePath, 'utf8'))
  if (rows.length && rows[0].m1_brokenRefs === undefined) {
    throw new Error(`${dir} has an unscored timeline — run: npm run score:run ${dir}`)
  }
  return { dir, arm: manifest.arm, model: manifest.model, rows }
}

const [, , dirA, dirB, ...rest] = process.argv
if (!dirA || !dirB) {
  console.error('usage: tsx scoring/compare.ts <results/run-a> <results/run-b> [--json]')
  process.exit(1)
}

const a = load(dirA)
const b = load(dirB)

// Pairing is the whole design. A mismatched pair would still produce a
// plausible-looking table, which is exactly why this is a hard stop.
if (a.model !== b.model) {
  console.error(`REFUSING — these are different models (${a.model} vs ${b.model}).\n` +
                `  Every comparison this benchmark makes is paired WITHIN a model; across\n` +
                `  models, with n = 1 per cell, the difference is not interpretable.`)
  process.exit(1)
}
if (a.arm === b.arm) {
  console.error(`REFUSING — both runs are the ${a.arm} arm. A pair is raw vs governed.`)
  process.exit(1)
}

const raw = a.arm === 'raw' ? a : b
const gov = a.arm === 'raw' ? b : a

if (raw.rows.length !== gov.rows.length) {
  console.warn(`NOTE: unequal operation counts (raw ${raw.rows.length}, governed ${gov.rows.length}).\n` +
               `      Final-state metrics are still comparable only if both reached the same\n` +
               `      operation. Read this table with that in mind.\n`)
}

const finalOf = (r: Run) => r.rows[r.rows.length - 1]
const sumTokens = (r: Run) => r.rows.reduce((n, x) => n + Number(x.tokens?.total ?? 0), 0)
const completed = (r: Run) => r.rows.filter(x => x.status === 'completed').length
const unaided = (r: Run) => r.rows.filter(x => x.status === 'completed' && !x.autoClosed).length
/** Operations whose requested structure was verified present (M7 assertions). */
const satisfied = (r: Run) => r.rows.filter(x => x.satisfied === true).length
const checked = (r: Run) => r.rows.filter(x => x.satisfied !== null && x.satisfied !== undefined).length
/** Churn is the one metric that IS a sum: total pages rewritten over the run. */
const churn = (r: Run) => r.rows.reduce((n, x) => n + (x.m5_blastRadius ?? 0), 0)

const rf = finalOf(raw), gf = finalOf(gov)

interface Metric { key: string; label: string; raw: number; gov: number; lowerIsBetter: boolean }
const metrics: Metric[] = [
  { key: 'M1', label: 'broken references', raw: rf.m1_brokenRefs, gov: gf.m1_brokenRefs, lowerIsBetter: true },
  { key: 'M2', label: 'style forks', raw: rf.m2_styleForks, gov: gf.m2_styleForks, lowerIsBetter: true },
  { key: 'M3', label: 'tokens (total)', raw: sumTokens(raw), gov: sumTokens(gov), lowerIsBetter: true },
  { key: 'M4', label: 'chrome divergence', raw: rf.m4_chromeDivergence, gov: gf.m4_chromeDivergence, lowerIsBetter: true },
  { key: 'M5', label: 'pages rewritten (sum)', raw: churn(raw), gov: churn(gov), lowerIsBetter: true },
  { key: 'M6', label: 'orphaned pages', raw: rf.m6_orphans, gov: gf.m6_orphans, lowerIsBetter: true },
  { key: 'M6', label: 'unreachable pages', raw: rf.m6_unreachable, gov: gf.m6_unreachable, lowerIsBetter: true },
  { key: 'M7', label: 'operations completed', raw: completed(raw), gov: completed(gov), lowerIsBetter: false },
  { key: 'M7', label: 'completed unaided', raw: unaided(raw), gov: unaided(gov), lowerIsBetter: false },
  { key: 'M7', label: 'structure verified', raw: satisfied(raw), gov: satisfied(gov), lowerIsBetter: false },
]

if (rest.includes('--json')) {
  console.log(JSON.stringify({ model: raw.model, raw: raw.dir, governed: gov.dir, metrics }, null, 2))
} else {
  const n = (v: number) => v.toLocaleString()
  console.log(`\n  ${raw.model}\n  raw ${raw.dir}\n  gov ${gov.dir}\n`)
  console.log('  metric                            raw     governed        delta   better')
  console.log('  ────────────────────────  ───────────  ───────────  ───────────  ──────')
  for (const m of metrics) {
    // Signed toward "governed is better", whichever direction that means for
    // this metric, so the column reads consistently rather than needing the
    // reader to remember which way each row points.
    const better = m.lowerIsBetter ? m.raw - m.gov : m.gov - m.raw
    const mark = better > 0 ? 'governed' : better < 0 ? 'raw' : '—'
    const delta = (better > 0 ? '+' : '') + n(better)
    console.log(
      `  ${(m.key + ' ' + m.label).padEnd(24)}  ${n(m.raw).padStart(11)}  ${n(m.gov).padStart(11)}  ` +
      `${delta.padStart(11)}  ${mark}`,
    )
  }

  // Printed before the wave table, because it gates how the wave table should
  // be read: an arm that skipped the reorganisation operations will show low
  // drift for the wrong reason, and this is the line that says so.
  const cr = checked(raw), cg = checked(gov)
  const gap = (r: Run, c: number) => c - satisfied(r)
  console.log(`\n  structural verification: raw ${satisfied(raw)}/${cr}, governed ${satisfied(gov)}/${cg}` +
              ` — ${raw.rows.length - cr} operation(s) carry no assertion`)
  if (gap(raw, cr) || gap(gov, cg)) {
    console.log('  UNVERIFIED WORK: an arm that did not perform an operation also did not damage')
    console.log('  the site doing it. Read every metric below against this line, not on its own.')
  }

  console.log('\n  drift by wave (broken references at the end of each wave)')
  console.log('  wave   raw   governed')
  console.log('  ────  ────  ─────────')
  for (const wave of ['A', 'B', 'C', 'D', 'E']) {
    const last = (r: Run) => [...r.rows].reverse().find(x => x.wave === wave)
    const lr = last(raw), lg = last(gov)
    if (!lr && !lg) continue
    console.log(`  ${wave.padEnd(4)}  ${String(lr?.m1_brokenRefs ?? '-').padStart(4)}  ${String(lg?.m1_brokenRefs ?? '-').padStart(9)}`)
  }
  console.log('\n  n = 1 per cell. Directional only — no significance is claimed (§10.1).\n')
}
