/**
 * Arm adapter interface.
 *
 * Deliberately N-arm rather than a raw/governed pair: the SSG arm named as a
 * limitation in methodology §2 should plug in here as a third implementation,
 * not fork the harness. A three-way comparison (raw / SSG / governed) is a
 * materially stronger result than the current two-way.
 */

import type { ToolDef } from '../drivers.js'

export interface SnapshotResult {
  /** Commit sha of the resulting snapshot. */
  sha: string
  /** True when the operation produced no change at all — recorded so a run
   *  can never earn a clean drift score by doing nothing (methodology M7). */
  noChange: boolean
  filesChanged: number
}

export interface Arm {
  readonly name: string

  /** Restore to the pristine baseline and prepare the run branch. */
  setup(runId: string): Promise<void>

  /** Tool schema exposed to the model. Equivalent capability across arms. */
  tools(): ToolDef[]

  /** Execute one tool call on this arm's substrate. */
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>

  /** Publish/commit current state and return the snapshot identity. */
  snapshot(opId: string, message: string): Promise<SnapshotResult>

  /** Release resources (stop services, close connections). */
  teardown(): Promise<void>
}
