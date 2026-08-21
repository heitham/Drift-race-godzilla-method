/**
 * Protocol runner.
 *
 * Executes one (model × arm) run: thirty operations, each in a fresh session
 * with no memory of the ones before it — "months of changing hands" rather
 * than a single continuous engagement (methodology §3).
 *
 * Usage:
 *   tsx harness/run/index.ts --model <id> --arm raw|governed [--ops 1-3] [--dry]
 *                             [--tag r2]   distinguishes a re-run's branch and results
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, loadEnv, checkPin, resolveModel } from './config.js'
import { parseOperations } from './operations.js'
import { makeDriver } from './drivers.js'
import { RawArm } from './arms/raw.js'
import { GovernedArm } from './arms/governed.js'
import type { Arm } from './arms/types.js'

/**
 * Standing system prompt — methodology §5.2.
 *
 * Identical in both arms except the tool inventory the driver supplies.
 * Stating the expectations explicitly in BOTH arms is deliberate: any drift
 * we then observe is a failure to maintain structure, never a failure to know
 * it was expected.
 */
const SYSTEM_PROMPT = `You are a content editor maintaining the Godzilla Docs documentation site.

Complete the requested change. Keep the site internally consistent: every page that should link to another should still link to it, and every page should follow the site's design system.

A reference to the design system and a site map are available to you. Read what you need before making changes — you have no memory of any previous work on this site.

When you have finished the change, briefly state what you did.`

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) args[key] = true
    else { args[key] = next; i++ }
  }
  return args
}

function parseRange(spec: string | undefined, max: number): number[] {
  if (!spec) return Array.from({ length: max }, (_, i) => i + 1)
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`bad --ops range: ${part}`)
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1])
    for (let i = lo; i <= hi; i++) if (i >= 1 && i <= max) out.add(i)
  }
  return [...out].sort((a, b) => a - b)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const benchmarkId = String(args.benchmark ?? 'godzilla-docs')
  const benchDir = path.join(process.cwd(), 'benchmarks', benchmarkId)

  loadEnv()
  const config = loadConfig(benchDir)

  // --- pin enforcement -------------------------------------------------
  // A changed renderer breaks comparability silently, so this is a hard stop
  // rather than a warning.
  const pin = checkPin(config)
  if (!pin.ok) {
    console.error(`\nREFUSING TO RUN — CMS pin check failed\n\n  ${pin.reason}\n`)
    process.exit(1)
  }
  console.log(`pin OK            CMS @ ${pin.actualSha.slice(0, 8)}`)

  const armName = String(args.arm ?? '')
  if (!config.arms.includes(armName)) {
    console.error(`--arm must be one of: ${config.arms.join(', ')}`)
    process.exit(1)
  }

  const model = resolveModel(config, String(args.model ?? ''))
  const budget = model.provider === 'anthropic'
    ? config.reasoning.anthropic.budget_tokens
    : config.reasoning.google.thinkingBudget

  const operations = parseOperations(path.join(process.cwd(), config.operations))
  const selected = parseRange(args.ops as string | undefined, operations.length)

  // Run tag. A re-run must not land on a previous run's branch: the governed
  // arm reads that branch's head as its "before" sha, so op 1 would be scored
  // against the earlier run's END state. Tagging is preferred over deleting
  // the old branch — the superseded run stays inspectable.
  const tag = args.tag ? `-${String(args.tag)}` : ''
  const runId = `${model.id}-${armName}${tag}`
  const outDir = path.join(process.cwd(), 'results', runId)

  console.log(`model             ${model.id}  (${model.provider}, reasoning budget ${budget})`)
  console.log(`arm               ${armName}`)
  console.log(`operations        ${selected.length} of ${operations.length}`)
  console.log(`results           results/${runId}`)

  if (args.dry) {
    console.log('\n--dry: printing operation 1 as it would be issued, then exiting.\n')
    const op = operations.find(o => o.n === selected[0])!
    console.log(`--- ${op.id} · Op ${op.n} — ${op.title} ---\n${op.instruction}\n`)
    return
  }

  // --- set up ----------------------------------------------------------
  const workRoot = path.join(process.cwd(), 'work', runId)
  let arm: Arm
  if (armName === 'raw') {
    arm = new RawArm(config, workRoot, !args['no-push'])
  } else {
    const g = new GovernedArm(config, workRoot)
    // The tool surface is fetched live so the arm reflects RIFT's actual
    // capabilities rather than a hand-copied list that can drift out of date.
    await g.loadTools()
    arm = g
  }

  mkdirSync(outDir, { recursive: true })
  const driver = makeDriver(model.provider, model.id, budget)
  await arm.setup(runId)
  console.log(`\nbaseline ready    ${runId}\n`)

  const manifest = {
    runId,
    benchmark: benchmarkId,
    model: model.id,
    provider: model.provider,
    label: model.label,
    arm: armName,
    reasoningBudget: budget,
    cmsSha: pin.actualSha,
    baselineSha: config.baseline.mainSha,
    startedAt: new Date().toISOString(),
    operations: selected,
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const timeline: unknown[] = []

  for (const n of selected) {
    const op = operations.find(o => o.n === n)!
    const opDir = path.join(outDir, 'ops', `op-${String(n).padStart(2, '0')}`)
    mkdirSync(opDir, { recursive: true })

    process.stdout.write(`op ${String(n).padStart(2)}  ${op.id.padEnd(4)} ${op.title.slice(0, 44).padEnd(46)}`)

    // Fresh session: a new driver invocation with no prior messages.
    const result = await driver.runSession({
      system: SYSTEM_PROMPT,
      userMessage: op.instruction,
      tools: arm.tools(),
      onToolCall: (name, input) => arm.callTool(name, input),
    })

    const snap = await arm.snapshot(op.id, op.title)

    // A run must never earn a clean drift score by doing nothing (M7).
    const status = result.status === 'error' ? 'failed'
      : snap.noChange ? 'partial'
      : result.status === 'max_turns' ? 'partial'
      : 'completed'

    writeFileSync(path.join(opDir, 'request.json'), JSON.stringify({ op, system: SYSTEM_PROMPT }, null, 2))
    writeFileSync(path.join(opDir, 'transcript.jsonl'), result.transcript.map(t => JSON.stringify(t)).join('\n'))
    writeFileSync(path.join(opDir, 'usage.json'), JSON.stringify({
      status, turns: result.turns, toolCalls: result.toolCalls,
      usage: result.usage, latencyMs: result.latencyMs, error: result.error,
      snapshotSha: snap.sha, noChange: snap.noChange, filesChanged: snap.filesChanged,
      autoClosed: snap.autoClosed ?? false,
    }, null, 2))

    timeline.push({
      op: n, opId: op.id, wave: op.wave, status,
      // The harness publishes on the model's behalf in both arms; this flags
      // the operations where it had to, so M7 can report unaided completion
      // separately from completion (see GovernedArm.snapshot).
      autoClosed: snap.autoClosed ?? false,
      snapshotSha: snap.sha, filesChanged: snap.filesChanged,
      turns: result.turns, toolCalls: result.toolCalls,
      tokens: result.usage, latencyMs: result.latencyMs,
    })
    writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2))

    const tag = status === 'completed' ? (snap.autoClosed ? 'ok*' : 'ok') : status
    console.log(
      `${tag.padEnd(10)} ${String(result.turns).padStart(2)}t ` +
      `${String(result.toolCalls).padStart(3)}c ` +
      `${String(result.usage.total).padStart(7)}tok ` +
      `cr:${String(Math.round(result.usage.cacheRead / 1000)).padStart(5)}k ` +
      `${String(Math.round(result.latencyMs / 1000)).padStart(4)}s` +
      (result.error ? `  ${result.error.slice(0, 60)}` : ''),
    )
  }

  await arm.teardown()
  writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ ...manifest, finishedAt: new Date().toISOString() }, null, 2),
  )
  console.log(`\ndone — results/${runId}`)
}

main().catch(e => { console.error(e); process.exit(1) })
