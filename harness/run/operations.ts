/**
 * Operation-list parser.
 *
 * `methodology/operations.md` is the single source of truth for the frozen
 * operations — the harness reads it directly rather than keeping a parallel
 * machine-readable copy that could silently drift out of sync with the
 * published document.
 *
 * Format contract:
 *   ### <opId> · Op <n> — <title>
 *   > instruction line
 *   > instruction line
 *   **Scorer notes** — never shown to the model
 */

import { readFileSync } from 'node:fs'

export interface Operation {
  n: number
  id: string
  wave: string
  title: string
  /** Verbatim text issued to the model. Identical across arms and models. */
  instruction: string
}

export function parseOperations(file: string): Operation[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const ops: Operation[] = []
  let current: Operation | null = null
  let buffer: string[] = []

  const flush = () => {
    if (current) {
      current.instruction = buffer.join('\n').trim()
      if (!current.instruction) throw new Error(`operation ${current.id} has no instruction blockquote`)
      ops.push(current)
    }
    current = null
    buffer = []
  }

  for (const line of lines) {
    const head = line.match(/^###\s+(\S+)\s+·\s+Op\s+(\d+)\s+—\s+(.+?)\s*$/)
    if (head) {
      flush()
      current = {
        n: Number(head[2]),
        id: head[1],
        wave: head[1][0],
        title: head[3],
        instruction: '',
      }
      continue
    }
    if (!current) continue
    // Scorer notes end the instruction and are never issued to the model.
    if (/^\*\*Scorer notes\*\*/.test(line)) { flush(); continue }
    if (line.startsWith('> ')) buffer.push(line.slice(2))
    else if (line.trim() === '>') buffer.push('')
  }
  flush()

  ops.sort((a, b) => a.n - b.n)
  const expected = ops.map((_, i) => i + 1)
  const actual = ops.map(o => o.n)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`operation numbering is not contiguous 1..${ops.length}: got ${actual.join(',')}`)
  }
  return ops
}
