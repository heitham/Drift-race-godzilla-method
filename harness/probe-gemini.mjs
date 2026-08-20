/**
 * Probe which Gemini models this key can actually call.
 *
 * Distinguishes three outcomes that look alike from the outside:
 *   OK    — usable
 *   QUOTA — model exists but the key has no quota (429)
 *   ERR   — anything else (not found, no access, bad request)
 *
 * Calls are serialized with a delay so the probe itself doesn't trip limits
 * and mislabel a usable model as quota-exhausted.
 */

import { readFileSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2]
}
const KEY = process.env.GEMINI_API_KEY

const CANDIDATES = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-pro-latest',
  'gemini-flash-latest',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

for (const model of CANDIDATES) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
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
    if (d.error) {
      const tag = d.error.code === 429 ? 'QUOTA' : 'ERR  '
      console.log(`${tag}  ${model.padEnd(26)} ${d.error.status ?? d.error.code}: ${String(d.error.message).slice(0, 80)}`)
    } else {
      const text = d.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? ''
      const u = d.usageMetadata ?? {}
      console.log(`OK     ${model.padEnd(26)} → ${JSON.stringify(text.slice(0, 8))}  visible=${u.candidatesTokenCount} thinking=${u.thoughtsTokenCount ?? 0}`)
    }
  } catch (e) {
    console.log(`ERR    ${model.padEnd(26)} ${String(e).slice(0, 80)}`)
  }
  await sleep(1500)
}
