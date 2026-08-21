/**
 * Benchmark configuration loading and pin enforcement.
 *
 * The renderer that produces every snapshot lives in the RIFT CMS. If it
 * changes between runs, snapshots stop being comparable and the failure is
 * SILENT — both versions emit valid-looking HTML. So the pin is enforced
 * actively: a run refuses to start against an unexpected CMS commit.
 */

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

export interface RosterEntry {
  id: string
  provider: 'anthropic' | 'google'
  label: string
  tier: string
}

export interface BenchmarkConfig {
  id: string
  frozenAt: string
  baseline: {
    repo: string
    mainSha: string
    dbDump: string
    dbDumpSha256: string
    pageCount: number
    linkEdges: number
  }
  cms: {
    repo: string
    cmsSha: string
    enforce: string
    allowDirtyPaths: string[]
  }
  roster: RosterEntry[]
  arms: string[]
  operations: string
  operationCount: number
  reasoning: {
    anthropic: { type: string; budget_tokens: number }
    google: { thinkingBudget: number }
  }
  site: { id: string; displayName: string; designSystem: string; mcpUrl: string }
  runBranchPrefix: string
  protectedBranches: string[]
}

export function loadConfig(benchmarkDir: string): BenchmarkConfig {
  const file = path.join(benchmarkDir, 'benchmark.config.json')
  if (!existsSync(file)) throw new Error(`benchmark config not found: ${file}`)
  return JSON.parse(readFileSync(file, 'utf8')) as BenchmarkConfig
}

/** Load .env.local into process.env without adding a dependency. */
export function loadEnv(root = process.cwd()): void {
  const file = path.join(root, '.env.local')
  if (!existsSync(file)) throw new Error('.env.local not found — API keys required')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
    if (m) process.env[m[1]] ??= m[2]
  }
}

export interface PinStatus {
  ok: boolean
  actualSha: string
  expectedSha: string
  dirtyFiles: string[]
  reason?: string
}

/**
 * Verify the CMS is at the pinned commit with no relevant local modifications.
 *
 * Files under `allowDirtyPaths` (documentation) are ignored: they cannot affect
 * rendered output. Anything else dirty means the renderer may not match the
 * one that produced earlier runs.
 */
/**
 * Expand ${VAR} in a config value. Paths differ per machine, and hard-coding
 * one author's home directory into a published benchmark makes it unrunnable
 * by anyone else — which would make "inspect it yourself" an empty invitation.
 */
function expand(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is not set — it is required by benchmark.config.json (see .env.example)`)
    return v
  })
}

export function checkPin(config: BenchmarkConfig): PinStatus {
  const repo = expand(config.cms.repo)
  let actualSha = ''
  let dirtyFiles: string[] = []

  try {
    actualSha = execSync(`git -C "${repo}" rev-parse HEAD`, { encoding: 'utf8' }).trim()
    dirtyFiles = execSync(`git -C "${repo}" status --porcelain`, { encoding: 'utf8' })
      .split('\n')
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .filter(f => !config.cms.allowDirtyPaths.some(p => f.startsWith(p)))
  } catch (e) {
    return { ok: false, actualSha: '', expectedSha: config.cms.cmsSha, dirtyFiles: [], reason: `cannot read CMS repo: ${e}` }
  }

  if (actualSha !== config.cms.cmsSha) {
    // A commit that touches only documentation cannot change rendered output,
    // and the CMS is under active development — blocking every run on a README
    // would train the operator to bypass the pin, which is the one failure the
    // pin exists to prevent. Anything outside allowDirtyPaths is still a hard
    // stop; the moved sha is reported either way so it is never invisible.
    let onlyIgnorable = false
    let movedFiles: string[] = []
    try {
      movedFiles = execSync(`git -C "${repo}" diff --name-only ${config.cms.cmsSha} ${actualSha}`, { encoding: 'utf8' })
        .split('\n').map(f => f.trim()).filter(Boolean)
      onlyIgnorable = movedFiles.length > 0 &&
        movedFiles.every(f => config.cms.allowDirtyPaths.some(pfx => f.startsWith(pfx)))
    } catch { /* unreachable commit — fall through to the hard stop */ }

    if (!onlyIgnorable) {
      return {
        ok: false, actualSha, expectedSha: config.cms.cmsSha, dirtyFiles,
        reason:
          `CMS is at ${actualSha.slice(0, 8)} but the benchmark is pinned to ${config.cms.cmsSha.slice(0, 8)}.\n` +
          (movedFiles.length
            ? `  Changed since the pin:\n` + movedFiles.slice(0, 12).map(f => `    ${f}`).join('\n') +
              (movedFiles.length > 12 ? `\n    …and ${movedFiles.length - 12} more` : '') + '\n'
            : '') +
          `  The renderer may differ from the one that produced existing runs, which would\n` +
          `  silently break comparability. Either check out the pinned commit, or — if the\n` +
          `  move is intentional — update cmsSha and pinHistory in benchmark.config.json.`,
      }
    }
    console.warn(
      `pin NOTE          CMS at ${actualSha.slice(0, 8)}, pinned to ${config.cms.cmsSha.slice(0, 8)} — ` +
      `${movedFiles.length} file(s) changed, all under ${config.cms.allowDirtyPaths.join(', ')}; accepting.`,
    )
  }

  if (dirtyFiles.length) {
    return {
      ok: false, actualSha, expectedSha: config.cms.cmsSha, dirtyFiles,
      reason:
        `CMS working tree has uncommitted changes outside ${config.cms.allowDirtyPaths.join(', ')}:\n` +
        dirtyFiles.map(f => `    ${f}`).join('\n') +
        `\n  Rendered output may not match the pinned commit.`,
    }
  }

  return { ok: true, actualSha, expectedSha: config.cms.cmsSha, dirtyFiles: [] }
}

export function resolveModel(config: BenchmarkConfig, id: string): RosterEntry {
  const entry = config.roster.find(r => r.id === id || r.label === id)
  if (!entry) {
    throw new Error(
      `model "${id}" is not in the frozen roster.\n` +
      `  Available: ${config.roster.map(r => r.id).join(', ')}\n` +
      `  Substituting a model mid-benchmark invalidates comparability with completed runs.`,
    )
  }
  return entry
}
