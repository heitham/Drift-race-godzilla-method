/**
 * Governed arm — the model edits content through RIFT's MCP interface.
 *
 * References survive renames because they are UUIDs resolved at publish time;
 * chrome is injected from one source; the design system is queryable. Those
 * affordances ARE the treatment (methodology §2), not a confound.
 *
 * Snapshots come from RIFT's own publisher: `propose_change_set` promotes the
 * change-set to staging and publishes, and the resulting commit on the run
 * branch is the snapshot. So the governed arm's output is plain rendered HTML,
 * produced by the same renderer that produced the raw arm's baseline.
 */

import { execSync } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Arm, SnapshotResult } from './types.js'
import type { ToolDef } from '../drivers.js'
import type { BenchmarkConfig } from '../config.js'

/**
 * Tools withheld from the model, and why (methodology §4.1).
 *
 * `request_content_change` hands the work to RIFT's OWN internal agent, which
 * runs on the CMS's separately-configured model. Exposing it would mean the
 * governed arm's content was written by that agent rather than by the model
 * under test — every model would produce near-identical governed output and
 * the paired comparison would be measuring the wrong thing entirely, while
 * still producing numbers that look valid.
 *
 * `list_sites` is withheld for a different reason: the site is fixed for the
 * run and is bound automatically below, so discovering it would be a step the
 * raw arm has no equivalent of.
 */
const WITHHELD = new Set(['request_content_change', 'list_sites'])

interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }

export class GovernedArm implements Arm {
  readonly name = 'governed'
  private branch = ''
  private cache: McpTool[] | null = null
  /** Last sha published by this run; the comparison point for snapshots. */
  private lastSha = ''
  private db = 'postgres://heithamghariani@localhost:5432/cms_dev'

  constructor(private config: BenchmarkConfig, private workRoot: string) {}

  private get key(): string {
    const k = process.env.RIFT_API_KEY
    if (!k) throw new Error('RIFT_API_KEY not set — the governed arm needs an agent-role CMS key')
    return k
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.config.site.mcpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    })
    const d = await res.json() as any
    if (d.error) throw new Error(`MCP ${method}: ${d.error.message ?? JSON.stringify(d.error)}`)
    return d.result
  }

  private sql(q: string): string {
    return execSync(`psql "${this.db}" -tAc ${JSON.stringify(q.replace(/\s+/g, ' ').trim())}`, {
      encoding: 'utf8',
    }).trim()
  }

  async setup(runId: string): Promise<void> {
    this.branch = `${this.config.runBranchPrefix}${runId}`
    if (this.config.protectedBranches.includes(this.branch)) {
      throw new Error(`refusing to run against protected branch ${this.branch}`)
    }

    // The DB must be at the pristine baseline. Restoring it requires stopping
    // the CMS (Postgres refuses to drop a database with live connections), so
    // that stays an explicit operator step; here we verify rather than assume,
    // because a contaminated baseline invalidates the run silently.
    const pages = Number(this.sql(`
      SELECT count(*) FROM content_placements cp
      JOIN content_items ci ON ci.id = cp.item_id
      WHERE cp.site_id = '${this.config.site.id}' AND ci.workflow_state = 'public'
    `))
    if (pages !== this.config.baseline.pageCount) {
      throw new Error(
        `site has ${pages} public pages, baseline expects ${this.config.baseline.pageCount}.\n` +
        `  Restore the baseline before this run:\n` +
        `    stop the CMS dev server and worker, then: npm run baseline:restore`,
      )
    }

    // Point this run's publishes at its own branch. main/staging are never touched.
    this.sql(`UPDATE sites SET git_staging_branch = '${this.branch}' WHERE id = '${this.config.site.id}'`)

    // Local checkout the scorer reads, and the baseline sha every snapshot
    // compares against. Captured now, before any operation runs.
    rmSync(this.siteDir, { recursive: true, force: true })
    mkdirSync(path.dirname(this.siteDir), { recursive: true })
    execSync(`git clone --quiet "${this.config.baseline.repo}" "${this.siteDir}"`, { encoding: 'utf8' })
    this.lastSha = this.remoteSha()
  }

  tools(): ToolDef[] {
    if (!this.cache) throw new Error('call loadTools() before tools()')
    return this.cache.map(t => {
      // site_id is bound automatically, so strip it from the schema the model
      // sees — the raw arm has no equivalent parameter to supply.
      const schema = JSON.parse(JSON.stringify(t.inputSchema ?? {}))
      if (schema.properties) delete schema.properties.site_id
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((r: string) => r !== 'site_id')
      return { name: t.name, description: t.description, inputSchema: schema }
    })
  }

  /** Fetch the live tool list so the arm reflects RIFT's actual surface. */
  async loadTools(): Promise<void> {
    const result = await this.rpc('tools/list', {})
    const all: McpTool[] = result.tools
    this.cache = all.filter(t => !WITHHELD.has(t.name))
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (WITHHELD.has(name)) return { error: `tool ${name} is not available` }
    const result = await this.rpc('tools/call', {
      name,
      arguments: { site_id: this.config.site.id, ...input },
    })
    // MCP returns content blocks; hand the model the text payload.
    const blocks = result?.content ?? []
    const text = blocks.map((b: any) => b?.text ?? '').join('\n')
    return text || result
  }

  /**
   * Snapshot = the commit RIFT's publisher wrote to the run branch.
   *
   * The baseline sha must be captured BEFORE the operation runs, not here.
   * `propose_change_set` is typically the model's last tool call and the
   * publish lands within seconds, so a sha read at snapshot time already
   * reflects the new commit — comparing against it would report "no change"
   * for a perfectly successful operation. The known-good sha is therefore
   * carried as arm state across operations.
   *
   * PUBLICATION PARITY. In the raw arm the model calls write_file and the
   * harness commits and pushes on its behalf — the model never publishes. The
   * governed arm must therefore not charge the model for a publication step
   * its counterpart is spared: the Haiku pilot lost 8 of 10 partials to
   * content that was written correctly but never proposed, which scored as
   * drift when it was really an asymmetric burden in the harness.
   *
   * So the harness closes any change-set the model left open, exactly as it
   * commits any file the raw model left written, and records `autoClosed` so
   * M7 can still separate a model that finished unaided from one that did not.
   * This is parity of harness support, not a relaxed approval gate: propose
   * promotes to staging on THIS RUN'S branch, which is the governed arm's
   * equivalent of a commit. Going live still needs a human, and no run ever
   * asks for one.
   */
  async snapshot(_opId: string, _message: string): Promise<SnapshotResult> {
    const autoClosed = await this.flushOpenChangeSets()

    for (let i = 0; i < 45; i++) {
      const sha = this.remoteSha()
      if (sha && sha !== this.lastSha) {
        const changed = this.countChanged(this.lastSha, sha)
        this.lastSha = sha
        return { sha, noChange: false, filesChanged: changed, autoClosed }
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    return { sha: this.lastSha || 'no-publish', noChange: true, filesChanged: 0, autoClosed }
  }

  /**
   * Propose every change-set this site still has open that actually contains
   * work. Empty change-sets are left alone — proposing one publishes nothing
   * and would only add noise to the run branch.
   *
   * Returns true if the harness had to close anything.
   */
  private async flushOpenChangeSets(): Promise<boolean> {
    const ids = this.sql(`
      SELECT DISTINCT cs.id FROM change_sets cs
      JOIN change_set_items csi ON csi.change_set_id = cs.id
      WHERE cs.site_id = '${this.config.site.id}' AND cs.status = 'open'
    `).split('\n').map(x => x.trim()).filter(Boolean)

    if (ids.length === 0) return false
    for (const id of ids) {
      try {
        await this.rpc('tools/call', {
          name: 'propose_change_set',
          arguments: { site_id: this.config.site.id, change_set_id: id, comment: 'closed by harness (publication parity)' },
        })
      } catch (e) {
        // A change-set that cannot be proposed is a genuine failure of the
        // model's work, not of the harness — let the operation record no
        // change rather than masking it.
        console.warn(`\n    auto-propose failed for ${id.slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`)
      }
    }
    return true
  }

  /** Files touched between two published commits — M5 blast radius. */
  private countChanged(from: string, to: string): number {
    if (!from) return -1
    try {
      execSync(`git -C "${this.siteDir}" fetch --quiet origin ${this.branch}`, { encoding: 'utf8' })
      const out = execSync(`git -C "${this.siteDir}" diff --name-only ${from} ${to}`, { encoding: 'utf8' })
      return out.split('\n').filter(Boolean).length
    } catch { return -1 }
  }

  private remoteSha(): string {
    try {
      const out = execSync(`git ls-remote "${this.config.baseline.repo}" "refs/heads/${this.branch}"`, {
        encoding: 'utf8',
      }).trim()
      return out.split(/\s+/)[0] ?? ''
    } catch { return '' }
  }

  async teardown(): Promise<void> {
    // Leave the branch pointing at the run so snapshots stay reachable; reset
    // the site's config so a later manual publish can't land on a run branch.
    try { this.sql(`UPDATE sites SET git_staging_branch = 'staging' WHERE id = '${this.config.site.id}'`) } catch { /* best effort */ }
  }

  /** Local checkout of the run branch, for the scorer. */
  get siteDir(): string { return path.join(this.workRoot, 'governed') }
}
