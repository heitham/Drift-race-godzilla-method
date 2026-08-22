/**
 * Run scorer — walks a completed run's snapshots and emits the dashboard feed.
 *
 * For each operation: check out that operation's commit, audit it absolutely
 * (M1/M2/M4/M6), and compute blast radius (M5) against the previous
 * operation's snapshot. The result is written back into the run's
 * `timeline.json`, joined to the token and latency figures the runner already
 * recorded (M3, M7).
 *
 * Substrate-blind: this reads checked-out HTML and the run's own timeline. It
 * never contacts a model and never learns which arm produced the snapshots, so
 * it costs nothing and can be re-run freely whenever a metric definition
 * changes — which is why scorer bugs are cheap and harness bugs are not.
 *
 * Usage: tsx scoring/score-run.ts <results/run-id> [--repo <url-or-path>]
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crawlSite, type SiteCrawl } from './crawl.js'
import { scoreSnapshot, blastRadius, vocabularyFor } from './score.js'
import { checkOperation, type Assertion } from './assertions.js'

interface TimelineEntry {
  op: number
  opId: string
  wave: string
  status: string
  snapshotSha: string
  filesChanged?: number
  turns?: number
  toolCalls?: number
  tokens?: Record<string, number>
  latencyMs?: number
  [k: string]: unknown
}

const [, , runDir, ...rest] = process.argv
if (!runDir) {
  console.error('usage: tsx scoring/score-run.ts <results/run-id> [--repo <url-or-path>]')
  process.exit(1)
}

const repoFlag = rest.indexOf('--repo')
const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
const config = JSON.parse(
  readFileSync(path.join('benchmarks', manifest.benchmark ?? 'godzilla-docs', 'benchmark.config.json'), 'utf8'),
)
const repo = repoFlag >= 0 ? rest[repoFlag + 1] : config.baseline.repo

// Structural assertions: did the operation do what was asked, as opposed to
// merely publishing something? Optional — a benchmark without them still
// scores, it just cannot tell a skipped operation from a completed one.
const assertionsPath = path.join('benchmarks', manifest.benchmark ?? 'godzilla-docs', 'assertions.json')
const assertions: Record<string, Assertion[]> = existsSync(assertionsPath)
  ? JSON.parse(readFileSync(assertionsPath, 'utf8'))
  : {}

const timeline: TimelineEntry[] = JSON.parse(readFileSync(path.join(runDir, 'timeline.json'), 'utf8'))
if (timeline.length === 0) { console.error('empty timeline — nothing to score'); process.exit(1) }

// Score in a scratch clone. The run's own working copy may still be in use,
// and checking out historical commits underneath a live run would corrupt it.
const scratch = mkdtempSync(path.join(tmpdir(), 'driftscore-'))
console.log(`run       ${manifest.runId}`)
console.log(`model     ${manifest.model}  (${manifest.arm} arm)`)
console.log(`cloning   ${repo}`)
execSync(`git clone --quiet "${repo}" "${scratch}"`, { stdio: 'pipe' })

const checkout = (sha: string) => {
  execSync(`git -C "${scratch}" fetch --quiet origin "${sha}" 2>/dev/null || true`, { stdio: 'pipe' })
  execSync(`git -C "${scratch}" checkout --quiet --detach ${sha}`, { stdio: 'pipe' })
  execSync(`git -C "${scratch}" clean -qfd`, { stdio: 'pipe' })
}

// The design system's class vocabulary is fixed for the benchmark, so it is
// resolved once from the baseline rather than re-derived per snapshot — a
// snapshot that broke its own stylesheet link would otherwise appear to have
// an empty vocabulary and report every class as an unknown-class fork.
checkout(config.baseline.mainSha)
const vocabulary = vocabularyFor(scratch, crawlSite(scratch))
console.log(`vocab     ${vocabulary.size} design-system classes (pinned from baseline)\n`)

console.log('  op  wave  status      M1    M2    M4   orph  M5(blast)  asserts')
console.log('  ──  ────  ─────────  ────  ────  ────  ────  ─────────  ───────')

let prev: SiteCrawl | null = null
let prevSha = ''
/** Broken-ref detail strings from the previous snapshot — the basis for the
 *  NewBreaks/Repairs split the methodology promises (M1): broken now but sound
 *  before is damage CAUSED this operation; the inverse is damage REPAIRED. */
let prevBroken = new Set<string>()
const scored: TimelineEntry[] = []

for (let entry of timeline) {
  const sha = entry.snapshotSha
  // A no-change operation carries the previous sha; scoring it again would
  // duplicate the prior row rather than reveal anything.
  const unchanged = sha === prevSha || !sha || sha === 'no-publish'

  if (!unchanged) checkout(sha)
  const curr: SiteCrawl = unchanged && prev ? prev : crawlSite(scratch)
  const s = scoreSnapshot(scratch, vocabulary)
  const blast = prev ? blastRadius(prev, curr) : { changed: 0, added: [], removed: [], modified: [] }

  // Status is re-derived here, not trusted from the run. The governed arm
  // republishes the whole site every operation, so early runs recorded a new
  // sha — and therefore `completed` — for operations that changed no file at
  // all. The harness now catches this at snapshot time; re-deriving lets runs
  // recorded before that fix still be scored honestly, and costs nothing.
  if (entry.status === 'completed' && entry.filesChanged === 0) {
    entry = { ...entry, status: 'partial', statusCorrected: 'empty commit — no file changed' }
  }

  const opAssertions = assertions[entry.opId] ?? []
  const verdict = opAssertions.length ? checkOperation(curr, opAssertions) : null

  const nowBroken = new Set(s.m1_brokenRefs.detail)
  const newBreaks = [...nowBroken].filter(x => !prevBroken.has(x)).length
  const repairs = [...prevBroken].filter(x => !nowBroken.has(x)).length

  const row: TimelineEntry = {
    ...entry,
    // `status` records whether the session produced a publish; this records
    // whether the requested structure actually exists. They disagree exactly
    // where it matters.
    assertions: verdict ? { passed: verdict.passed, failed: verdict.failed, failures: verdict.failures } : null,
    satisfied: verdict ? verdict.failed === 0 : null,
    pages: s.pages,
    linkEdges: s.linkEdges,
    m1_brokenRefs: s.m1_brokenRefs.total,
    m1_detail: {
      deadPath: s.m1_brokenRefs.deadPath,
      deadFragment: s.m1_brokenRefs.deadFragment,
      deadAsset: s.m1_brokenRefs.deadAsset,
    },
    m1_newBreaks: newBreaks,
    m1_repairs: repairs,
    m2_styleForks: s.m2_styleForks.hard,
    m2_byRule: s.m2_styleForks.byRule,
    m4_chromeDivergence: s.m4_chromeDivergence.excess,
    m5_blastRadius: blast.changed,
    m5_detail: { added: blast.added.length, removed: blast.removed.length, modified: blast.modified.length },
    m6_orphans: s.m6_orphansAndReach.orphans.length,
    m6_unreachable: s.m6_orphansAndReach.unreachable.length,
    // The reader's question rather than the author's: unreachable even when
    // generated navigation counts. See scoreOrphans for why both exist.
    m6_unreachableNav: s.m6_orphansAndReach.unreachableWithNav.length,
    m7_capabilityGaps: verdict?.capabilityGaps ?? [],
  }
  scored.push(row)

  const asrt = verdict ? (verdict.failed === 0 ? `${verdict.passed}/${verdict.passed}` : `${verdict.passed}/${verdict.passed + verdict.failed} FAIL`) : '-'
  console.log(
    `  ${String(entry.op).padStart(2)}  ${entry.wave.padEnd(4)}  ${entry.status.padEnd(9)} ` +
    `${String(row.m1_brokenRefs).padStart(4)}  ${String(row.m2_styleForks).padStart(4)}  ` +
    `${String(row.m4_chromeDivergence).padStart(4)}  ${String(row.m6_orphans).padStart(4)}  ` +
    `${String(row.m5_blastRadius).padStart(9)}  ${asrt}`,
  )
  if (verdict && verdict.failed) for (const f of verdict.failures) console.log(`        ${f}`)

  prev = curr
  prevSha = sha
  prevBroken = nowBroken
}

writeFileSync(path.join(runDir, 'timeline.json'), JSON.stringify(scored, null, 2))
rmSync(scratch, { recursive: true, force: true })

// --- run summary -----------------------------------------------------------
const last = scored[scored.length - 1]
const tok = scored.reduce((n, r) => n + Number(r.tokens?.total ?? 0), 0)
const completed = scored.filter(r => r.status === 'completed').length
const checked = scored.filter(r => r.satisfied !== null)
const satisfied = checked.filter(r => r.satisfied === true).length
// Time-under-damage: the area under the M1 curve. An endpoint of zero can hide
// twenty operations spent serving broken links; this cannot.
const exposure = scored.reduce((n, r) => n + Number(r.m1_brokenRefs ?? 0), 0)
const capFails = checked.filter(r => r.satisfied === false && (r.m7_capabilityGaps as string[])?.length)
const modelFails = checked.filter(r => r.satisfied === false && !(r.m7_capabilityGaps as string[])?.length)

console.log(`\nfinal state after ${scored.length} operations`)
console.log(`  broken references   ${last.m1_brokenRefs}`)
console.log(`  style forks         ${last.m2_styleForks}`)
console.log(`  chrome divergence   ${last.m4_chromeDivergence}`)
console.log(`  orphaned pages      ${last.m6_orphans}`)
console.log(`  operations complete ${completed}/${scored.length}`)
console.log(`  requested structure ${satisfied}/${checked.length} operations verified` +
            (checked.length < scored.length ? `  (${scored.length - checked.length} carry no assertion)` : ''))
if (capFails.length || modelFails.length) {
  console.log(`    of the failures: ${modelFails.length} model, ${capFails.length} requiring a capability ` +
              `(${[...new Set(capFails.flatMap(r => r.m7_capabilityGaps as string[]))].join(', ')})`)
}
console.log(`  M1 exposure         ${exposure}  (sum of broken refs across all ${scored.length} snapshots)`)
console.log(`  unreachable w/ nav  ${scored[scored.length - 1].m6_unreachableNav}  (reader's view; content-only figure above)`)
console.log(`  tokens              ${tok.toLocaleString()}`)
// --- plausibility ----------------------------------------------------------
// Not a metric. A cheap smell test for the failure this run set kept producing:
// an operation that reports `completed`, damages nothing, and did nothing. That
// case is invisible to M1-M6 — work not done is also damage not done — and the
// tell was never in a metric. It was a row reading "2t 3c 9,905tok" against an
// instruction that said "every SDK page".
//
// Flags rather than fails: some operations are legitimately small. It says
// where to look.
{
  const calls = scored.map(r => Number(r.toolCalls ?? 0)).filter(n => n > 0).sort((a, b) => a - b)
  const median = calls.length ? calls[Math.floor(calls.length / 2)] : 0
  const thin = scored.filter(r =>
    r.status === 'completed' && Number(r.toolCalls ?? 0) > 0 && Number(r.toolCalls) * 3 < median)
  if (thin.length) {
    console.log(`\nthin operations — completed on unusually little work (median ${median} tool calls)`)
    for (const r of thin) {
      console.log(`  op ${String(r.op).padStart(2)}  ${r.opId}  ${r.toolCalls} tool calls, ` +
                  `${Number(r.tokens?.total ?? 0).toLocaleString()} tokens`)
    }
    console.log('  Worth reading the transcript: a completed operation that changed little')
    console.log('  scores as cleanly as one that changed the right things.')
  }
}

console.log(`\nwrote ${path.join(runDir, 'timeline.json')}`)
