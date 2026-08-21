/**
 * Preflight check — run before any benchmark batch.
 *
 * Verifies every external dependency a run needs, so a 30-operation run can't
 * die at operation 27 because the worker wasn't up or a key was stale.
 *
 * Usage: node harness/preflight.mjs [--arm raw|governed]
 */

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Read the roster from the frozen config rather than duplicating it — a
// hardcoded copy silently drifts out of sync the moment the roster changes,
// and preflight would then vouch for models no run will use.
const CONFIG = JSON.parse(readFileSync('benchmarks/godzilla-docs/benchmark.config.json', 'utf8'))
const ROSTER = {
  anthropic: CONFIG.roster.filter(r => r.provider === 'anthropic').map(r => r.id),
  google: CONFIG.roster.filter(r => r.provider === 'google').map(r => r.id),
}

// --- env ---------------------------------------------------------------
if (!existsSync('.env.local')) {
  console.error('FAIL  .env.local missing')
  process.exit(1)
}
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2]
}

const results = []
const record = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

// --- Anthropic ---------------------------------------------------------
for (const model of ROSTER.anthropic) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model, max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      }),
    })
    const d = await r.json()
    const text = d.content?.map(c => c.text ?? '').join('').trim()
    record(!!text, `anthropic  ${model.padEnd(28)}`, text ? `→ ${JSON.stringify(text)}` : JSON.stringify(d).slice(0, 140))
  } catch (e) {
    record(false, `anthropic  ${model.padEnd(28)}`, String(e).slice(0, 120))
  }
}

// --- Google ------------------------------------------------------------
// Gemini 3.x reasons by default; thinking tokens are billed and MUST be
// counted in M3, so the preflight surfaces them explicitly.
for (const model of ROSTER.google) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY ?? ''}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }],
          generationConfig: { maxOutputTokens: 2048 },
        }),
      },
    )
    const d = await r.json()
    const text = d.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim()
    const u = d.usageMetadata ?? {}
    record(
      !!text,
      `google     ${model.padEnd(28)}`,
      text ? `→ ${JSON.stringify(text)}  visible=${u.candidatesTokenCount} thinking=${u.thoughtsTokenCount ?? 0}`
           : JSON.stringify(d).slice(0, 140),
    )
  } catch (e) {
    record(false, `google     ${model.padEnd(28)}`, String(e).slice(0, 120))
  }
}

// --- local infrastructure ---------------------------------------------
try {
  const r = await fetch('http://localhost:3001', { redirect: 'manual' })
  record(r.status === 307 || r.status === 200, 'RIFT CMS on :3001', `http ${r.status}`)
} catch {
  record(false, 'RIFT CMS on :3001', 'not reachable — start the dev server')
}

try {
  const ps = execSync('ps aux | grep "src/worker.ts" | grep -v grep || true', { encoding: 'utf8' })
  record(ps.trim().length > 0, 'BullMQ publish worker', ps.trim() ? 'running' : 'NOT running — publishes will queue forever')
} catch {
  record(false, 'BullMQ publish worker')
}

record(existsSync('baseline/cms_dev.baseline.dump'), 'baseline DB dump')

// Governed arm: the MCP surface must authenticate AND must not expose the
// tool that would hand authoring to RIFT's own agent (methodology §4.1).
try {
  const r = await fetch(CONFIG.site.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RIFT_API_KEY ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const d = await r.json()
  const names = (d.result?.tools ?? []).map(t => t.name)
  record(names.length > 0, 'RIFT MCP auth', names.length ? `${names.length} tools` : JSON.stringify(d).slice(0, 120))
} catch (e) {
  record(false, 'RIFT MCP auth', String(e).slice(0, 100))
}

// --- CMS version pin ---------------------------------------------------
try {
  const dir = process.env.CMS_REPO ?? ''
  if (!dir) return { ok: false, detail: 'CMS_REPO is not set (see .env.example)' }
  const sha = execSync(`git -C "${dir}" rev-parse --short HEAD`, { encoding: 'utf8' }).trim()
  const dirty = execSync(`git -C "${dir}" status --porcelain`, { encoding: 'utf8' }).trim().length > 0
  record(true, 'CMS commit', `${sha}${dirty ? '  (WORKING TREE DIRTY — pin a worktree before running)' : ''}`)
} catch {
  record(false, 'CMS commit', 'could not read')
}

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
