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

  /**
   * The reviewer's key, held by the HARNESS and never exposed to the model.
   *
   * Two keys, two roles, deliberately: the agent key the model uses cannot
   * approve or publish (FR-MCP-002), so the model can never sign off its own
   * work. That ceiling is the governance model this benchmark measures, and
   * collapsing the two keys into one would quietly delete it.
   */
  private get adminKey(): string {
    const k = process.env.RIFT_ADMIN_KEY
    if (!k) {
      throw new Error(
        'RIFT_ADMIN_KEY not set — the governed arm needs an admin-role key to review\n' +
        '  between operations. Without review, RIFT\'s collision guard locks the arm out\n' +
        '  of every page it has already touched (see resolveReview).',
      )
    }
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

    // Point this run's publishes at its own branch — BOTH of them. Approval
    // publishes public content to git_main_branch, so leaving that at 'main'
    // would let a benchmark run rewrite the real baseline. Teardown restores
    // both; the run branch is the only thing a run can ever write.
    this.sql(`
      UPDATE sites SET git_staging_branch = '${this.branch}', git_main_branch = '${this.branch}'
      WHERE id = '${this.config.site.id}'
    `)

    // Fail here, loudly, rather than at operation 8 when the collision guard
    // bites: verify the reviewer's key and the approval endpoint both work
    // before a single token is spent.
    await this.checkReviewer()

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
    const before = this.lastSha

    // Two publishes can land per operation: the one `propose` triggers, and
    // the one approval triggers. Wait for the first, review, then wait for
    // everything to go quiet — recording a sha between the two would attribute
    // the approval's commit to the NEXT operation and shift every snapshot in
    // the run by one, silently.
    await this.waitForChange(before)
    await this.review()
    await this.publishFullChecked()
    // Belt and braces: the run is terminal, but the git push happens inside it
    // and the remote ref can lag the status flip by a beat.
    const sha = await this.waitForQuiet()

    if (!sha || sha === before) {
      return { sha: before || 'no-publish', noChange: true, filesChanged: 0, autoClosed }
    }
    const changed = this.countChanged(before, sha)
    this.lastSha = sha
    return { sha, noChange: false, filesChanged: changed, autoClosed }
  }

  /**
   * Republish the whole site, so the snapshot is the site rather than a
   * patch of it.
   *
   * Approval publishes with scope `site_changed`, and only `site_full` /
   * `site_staging` clean the branch first (`cleanFirst` in publish.ts). An
   * incremental publish therefore writes a moved page's NEW path and leaves
   * the old file sitting on the branch — so a relocated page keeps answering
   * at its old URL with stale content, and the scorer, which reads the branch,
   * would see a site that does not exist.
   *
   * That would corrupt the measurement in the direction that flatters the
   * governed arm: ghost files at old paths keep stale links resolving, hiding
   * exactly the breakage M1 exists to count.
   *
   * This is representational parity, not help. The raw arm's snapshot is its
   * real file tree; this makes the governed arm's snapshot its real site. It
   * cannot improve the model's score — a full publish reveals duplicates the
   * model failed to clean up rather than concealing them, and it republishes
   * whatever is in the CMS, unchanged.
   */
  private async publishFull(): Promise<string> {
    const res = await fetch(`${this.origin}/api/v1/sites/${this.config.site.id}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'site_full' }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(
        `full publish failed (HTTP ${res.status}): ${detail.slice(0, 200)}\n` +
        `  Without it the snapshot keeps stale files at the paths of moved pages,\n` +
        `  which would hide broken references rather than count them.`,
      )
    }
    const body = await res.json().catch(() => null) as any
    return body?.run?.id ?? body?.data?.run?.id ?? ''
  }

  /**
   * Publish, retrying once if the push lost a race for the branch ref.
   *
   * With `publish_after: false` on approval there should be no competitor, but
   * a run queued by an earlier operation can still be draining. A ref-lock
   * rejection is transient by nature — the loser only needs to push again from
   * the newer tip — so it earns one retry before the run is failed.
   */
  private async publishFullChecked(): Promise<void> {
    try {
      await this.awaitPublishRun(await this.publishFull())
    } catch (e) {
      if (!/cannot lock ref|remote rejected|non-fast-forward/i.test((e as Error).message)) throw e
      console.warn('\n    publish lost the branch ref; retrying once')
      await new Promise(r => setTimeout(r, 5000))
      await this.awaitPublishRun(await this.publishFull())
    }
  }

  /**
   * Block until a publish run reaches a terminal state.
   *
   * Replaces waiting for the git sha to "look settled", which was a guess and
   * a wrong one: publishing is queued, and the enqueue-to-pickup gap routinely
   * exceeded the quiet window. Each snapshot was therefore taken BEFORE its own
   * full publish, which then landed during the next operation — every snapshot
   * in the run shifted by one, and the drift curve alternated between two
   * trees (0, 28, 0, 28 ...) in a way no real site behaves.
   *
   * The publish run's own status is the authoritative completion signal, so
   * this asks for it rather than inferring it.
   */
  private async awaitPublishRun(runId: string): Promise<void> {
    if (!runId) return
    for (let i = 0; i < 180; i++) {
      const res = await fetch(
        `${this.origin}/api/v1/sites/${this.config.site.id}/publish-runs/${runId}`,
        { headers: { Authorization: `Bearer ${this.adminKey}` } },
      )
      if (res.ok) {
        const body = await res.json().catch(() => null) as any
        const status = body?.run?.status ?? body?.data?.run?.status
        if (status && !['queued', 'running', 'pending', 'in_progress'].includes(status)) {
          if (status !== 'completed' && status !== 'success') {
            const why = body?.run?.error_message ?? body?.data?.run?.error_message ?? ''
            throw new Error(
              `publish run ${runId.slice(0, 8)} ended '${status}' — snapshot would not reflect the site` +
              (why ? `\n  ${String(why).split('\n')[0].slice(0, 200)}` : ''),
            )
          }
          return
        }
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error(`publish run ${runId.slice(0, 8)} did not finish within 6 minutes`)
  }

  /** Wait for the run branch to move off `from`. Returns '' if it never does. */
  private async waitForChange(from: string, tries = 45): Promise<string> {
    for (let i = 0; i < tries; i++) {
      const sha = this.remoteSha()
      if (sha && sha !== from) return sha
      await new Promise(r => setTimeout(r, 2000))
    }
    return ''
  }

  /**
   * Wait until the branch stops moving.
   *
   * Publishing is queued, so "the sha changed" does not mean "publishing
   * finished" — the approval's publish is still in flight behind it. Quiet is
   * defined as the same sha across several consecutive polls; anything less
   * races the worker.
   */
  private async waitForQuiet(stableFor = 5, tries = 90): Promise<string> {
    let last = ''
    let stable = 0
    for (let i = 0; i < tries; i++) {
      const sha = this.remoteSha()
      if (sha && sha === last) {
        if (++stable >= stableFor) return sha
      } else {
        stable = 0
        last = sha
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    return last
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

  /**
   * Review what this operation produced, playing the part a content team plays
   * between one month's work and the next.
   *
   * RIFT guards a page against carrying two *unreviewed agent bundles* at
   * once: a second change-set touching a page an `open` or `proposed` one
   * already holds is refused with "ask a human to approve or reject that
   * change-set first". The guard is explicitly agent-only and exists so that
   * approving one bundle cannot ship another's edits. It is correct, and it
   * assumes review happens.
   *
   * Our protocol did not review, so change-sets accumulated in `proposed` and
   * the governed arm progressively walled itself out of every page it had
   * already touched. In the v2 trial ops 8 and 9 — both RENAMES, where the
   * governed substrate should be strongest — failed for that reason alone.
   * That was a defect in our protocol, not in the CMS and not model drift;
   * scoring it as drift would have been the benchmark lying about its subject.
   *
   * Approval goes through RIFT's own admin-key endpoint rather than being
   * imitated here, so the benchmark exercises the same code path a real
   * reviewer does — item transitions, audit trail and publish included.
   */
  private async review(): Promise<void> {
    const ids = this.sql(`
      SELECT id FROM change_sets
      WHERE site_id = '${this.config.site.id}' AND status = 'proposed'
      ORDER BY proposed_at
    `).split('\n').map(x => x.trim()).filter(Boolean)

    for (const id of ids) {
      const res = await fetch(
        `${this.origin}/api/v1/sites/${this.config.site.id}/change-sets/${id}/approve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.adminKey}`, 'content-type': 'application/json' },
          // publish_after: false — deliberately. Approval's job here is the
        // workflow transition, including the staged move's placement swap; the
        // single site_full publish below writes the files. Letting both publish
        // put two runs on one branch at once and git rejected the loser:
        // "cannot lock ref ... is at <sha> but expected <other>". One publish
        // per operation removes the race rather than retrying it.
        body: JSON.stringify({ comment: 'Reviewed between benchmark operations.', publish_after: false }),
        },
      )
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(
          `review failed for change-set ${id.slice(0, 8)} (HTTP ${res.status}).\n` +
          `  ${detail.slice(0, 300)}\n` +
          `  Without review the next operation is locked out of every page this one\n` +
          `  touched, so the run stops rather than recording that as drift.`,
        )
      }
    }
  }

  /** CMS origin, derived from the configured MCP URL. */
  private get origin(): string { return new URL(this.config.site.mcpUrl).origin }

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
    try {
      this.sql(`
        UPDATE sites SET git_staging_branch = 'staging', git_main_branch = 'main'
        WHERE id = '${this.config.site.id}'
      `)
    } catch { /* best effort */ }
  }

  /**
   * Preflight for the review step.
   *
   * Probes the approval endpoint with an id that cannot exist. A JSON error
   * body means the route is present and the key authenticated; an HTML 404
   * means the endpoint has not shipped yet; 401/403 means the key is missing
   * or is not admin-role.
   */
  private async checkReviewer(): Promise<void> {
    const missing = '00000000-0000-4000-8000-000000000000'
    const res = await fetch(
      `${this.origin}/api/v1/sites/${this.config.site.id}/change-sets/${missing}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.adminKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ comment: 'preflight' }),
      },
    )
    const body = await res.text().catch(() => '')
    const isJson = body.trimStart().startsWith('{')

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `the reviewer key was rejected (HTTP ${res.status}). RIFT_ADMIN_KEY must be an\n` +
        `  ADMIN-role key — an agent key cannot approve, by design. Re-seed it with\n` +
        `  npm run reset.`,
      )
    }
    if (!isJson) {
      throw new Error(
        `no approval endpoint at POST /api/v1/sites/:siteId/change-sets/:id/approve\n` +
        `  (HTTP ${res.status}, non-JSON response). The governed arm cannot review between\n` +
        `  operations without it, and without review RIFT's collision guard locks the arm\n` +
        `  out of every page it has already touched. See docs/CMS-REQUEST-approve-endpoint.md.`,
      )
    }
  }

  /** Local checkout of the run branch, for the scorer. */
  get siteDir(): string { return path.join(this.workRoot, 'governed') }
}
