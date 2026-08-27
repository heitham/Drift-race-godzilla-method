/**
 * Re-derive outcomes from stored sessions, without re-running anything.
 *
 * Outcome is a pure function of what was recorded — whether the postcondition
 * held, whether any tool call errored, whether the agent disclosed, and whether
 * it wrote anything — so a refinement to the disclosure detector can be applied
 * to completed columns instead of re-buying them. Every column is rescored by
 * the same code, so a refinement cannot be applied to one substrate and not
 * another.
 *
 * Usage: tsx probe/rescore.ts [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import path from 'node:path'
import { DISCLOSURE } from './disclosure.js'

const WRITE = process.argv.includes('--write')
const files = globSync('probe/results/*.json')
  .filter(f => !/comparison|x2-before/.test(f))

/** Postcondition truth, recovered from the outcome that was recorded. */
const heldFor = (o: string) => o.startsWith('supported')

/**
 * Which intents carry no postcondition. This must come from the intent spec,
 * not be inferred from the recorded outcome: a governance intent that was
 * classified `unsupported-disclosed` still has verify.kind 'noop', and losing
 * that fact demoted one to `silent-miss` on the first attempt at this.
 */
const NOOP = new Set(
  (JSON.parse(readFileSync(path.join('probe', 'intents.json'), 'utf8')).intents as any[])
    .filter(i => i.verify?.kind === 'noop').map(i => i.id),
)

for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8'))
  let changed = 0
  for (const r of d.results as any[]) {
    const held = heldFor(r.outcome)
    const errored = (r.errors?.length ?? 0) > 0
    const permitted = r.outcome === 'permitted-no-guardrail'
    const noPost = NOOP.has(r.id)
    // finalText is stored truncated, so the pattern can no longer see everything
    // the original classifier saw. The detector has only ever WIDENED, so a row
    // that disclosed before still discloses: this is a union, never a re-test.
    // Without it, truncation silently manufactures silent misses.
    const disclosed = r.disclosed === true || DISCLOSURE.test(r.finalText ?? '')
    const wrote = (r.toolsUsed ?? []).some((t: string) =>
      /^(create|update|delete)|create|update|patch|move|retire|delete|propose|open_change/.test(t))

    const next = held ? (errored ? 'supported-after-refusal' : 'supported')
      : permitted ? 'permitted-no-guardrail'
      : errored ? 'refused'
      : disclosed ? (wrote ? 'substituted-disclosed' : 'unsupported-disclosed')
      : noPost ? 'no-postcondition'
      : 'silent-miss'

    if (next !== r.outcome || disclosed !== r.disclosed) {
      if (next !== r.outcome) {
        console.log(`  ${path.basename(f)} ${r.id} p${r.pass}: ${r.outcome} -> ${next}`)
        changed++
      }
      r.outcome = next
      r.disclosed = disclosed
    }
  }
  if (changed && WRITE) {
    d.rescored = 'disclosure detector widened; see probe/disclosure.ts'
    writeFileSync(f, JSON.stringify(d, null, 2))
  }
  if (!changed) console.log(`  ${path.basename(f)}: no change`)
}
console.log(WRITE ? '\nwritten' : '\ndry run — pass --write to apply')
