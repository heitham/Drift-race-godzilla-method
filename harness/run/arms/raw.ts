/**
 * Raw arm — the model edits published HTML files directly.
 *
 * This is the honest floor case: no link indirection, no design-system
 * enforcement, chrome duplicated into every file. See methodology §2 for why
 * we compare against raw HTML rather than a static-site generator, and why
 * that boundary is stated up front rather than discovered later.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'
import type { Arm, SnapshotResult } from './types.js'
import type { ToolDef } from '../drivers.js'
import type { BenchmarkConfig } from '../config.js'

const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8' })

export class RawArm implements Arm {
  readonly name = 'raw'
  private dir: string
  private branch = ''

  constructor(private config: BenchmarkConfig, workRoot: string, private push = true) {
    this.dir = path.join(workRoot, 'raw')
  }

  /** Reject any path that escapes the working copy or touches git internals. */
  private safe(rel: string): string {
    const clean = String(rel).replace(/^\/+/, '')
    const full = path.resolve(this.dir, clean)
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error(`path escapes the site directory: ${rel}`)
    }
    if (clean.split('/')[0] === '.git') throw new Error('refusing to touch .git')
    return full
  }

  private list(): string[] {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        if (e === '.git') continue
        const f = path.join(d, e)
        statSync(f).isDirectory() ? walk(f) : out.push(path.relative(this.dir, f).split(path.sep).join('/'))
      }
    }
    walk(this.dir)
    return out.sort()
  }

  async setup(runId: string): Promise<void> {
    this.branch = `${this.config.runBranchPrefix}${runId}`
    if (this.config.protectedBranches.includes(this.branch)) {
      throw new Error(`refusing to run against protected branch ${this.branch}`)
    }

    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(path.dirname(this.dir), { recursive: true })

    // Always start from the pinned baseline commit, never from branch tips —
    // both arms of every model must begin byte-identical.
    git(path.dirname(this.dir), `clone --quiet "${this.config.baseline.repo}" raw`)
    git(this.dir, `checkout --quiet ${this.config.baseline.mainSha}`)
    git(this.dir, `checkout --quiet -B ${this.branch}`)
    git(this.dir, 'config user.email "benchmark@local"')
    git(this.dir, 'config user.name "Drift Race Harness"')

    // Knowledge parity (methodology §5.3): the raw arm must be *told* the same
    // rules the governed arm can query, or we would be measuring information
    // asymmetry rather than substrate.
    const benchDir = path.join(process.cwd(), 'benchmarks', this.config.id)
    for (const f of ['SITEMAP.md', 'DESIGN-SYSTEM.md']) {
      const src = path.join(benchDir, f)
      if (existsSync(src)) writeFileSync(path.join(this.dir, f), readFileSync(src, 'utf8'))
    }
    git(this.dir, 'add -A')
    git(this.dir, 'commit --quiet -m "[baseline] knowledge-parity reference files" --allow-empty')
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'list_files',
        description: 'List every file on the site, as paths relative to the site root.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'read_file',
        description: 'Read a file\'s full contents.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path relative to the site root.' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a file with the given contents.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the site root.' },
            content: { type: 'string', description: 'Full file contents.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'move_file',
        description: 'Move or rename a file, creating parent directories as needed.',
        inputSchema: {
          type: 'object',
          properties: { from: { type: 'string' }, to: { type: 'string' } },
          required: ['from', 'to'],
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'search',
        description: 'Search all files for a literal string. Returns matching paths with line numbers.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'list_files':
        return { files: this.list() }

      case 'read_file': {
        const p = this.safe(input.path as string)
        if (!existsSync(p)) return { error: `no such file: ${input.path}` }
        return { path: input.path, content: readFileSync(p, 'utf8') }
      }

      case 'write_file': {
        const p = this.safe(input.path as string)
        mkdirSync(path.dirname(p), { recursive: true })
        writeFileSync(p, String(input.content ?? ''), 'utf8')
        return { ok: true, path: input.path, bytes: String(input.content ?? '').length }
      }

      case 'move_file': {
        const from = this.safe(input.from as string)
        const to = this.safe(input.to as string)
        if (!existsSync(from)) return { error: `no such file: ${input.from}` }
        mkdirSync(path.dirname(to), { recursive: true })
        renameSync(from, to)
        return { ok: true, from: input.from, to: input.to }
      }

      case 'delete_file': {
        const p = this.safe(input.path as string)
        if (!existsSync(p)) return { error: `no such file: ${input.path}` }
        rmSync(p)
        return { ok: true, deleted: input.path }
      }

      case 'search': {
        const q = String(input.query ?? '')
        if (!q) return { error: 'query required' }
        const hits: Array<{ path: string; line: number; text: string }> = []
        for (const rel of this.list()) {
          const full = path.join(this.dir, rel)
          let content: string
          try { content = readFileSync(full, 'utf8') } catch { continue }
          content.split('\n').forEach((text, i) => {
            if (text.includes(q)) hits.push({ path: rel, line: i + 1, text: text.trim().slice(0, 200) })
          })
        }
        return { matches: hits.slice(0, 200), truncated: hits.length > 200 }
      }

      default:
        return { error: `unknown tool: ${name}` }
    }
  }

  async snapshot(opId: string, message: string): Promise<SnapshotResult> {
    git(this.dir, 'add -A')
    const status = git(this.dir, 'status --porcelain').trim()
    if (!status) {
      // No change at all. Record the existing head rather than fabricating a
      // commit — the runner marks the operation failed/partial per M7.
      return { sha: git(this.dir, 'rev-parse HEAD').trim(), noChange: true, filesChanged: 0 }
    }
    const filesChanged = status.split('\n').filter(Boolean).length
    git(this.dir, `commit --quiet -m "[${opId}] ${message.replace(/"/g, "'")}"`)
    return { sha: git(this.dir, 'rev-parse HEAD').trim(), noChange: false, filesChanged }
  }

  async teardown(): Promise<void> {
    // Push the completed run branch so snapshots are durable and auditable.
    // Suppressed for smoke tests so throwaway branches never reach the remote.
    if (!this.push) return
    try { git(this.dir, `push --quiet -u origin ${this.branch} --force`) } catch { /* offline is survivable; local history is intact */ }
  }

  /** Directory the scorer reads. */
  get siteDir(): string { return this.dir }
}
