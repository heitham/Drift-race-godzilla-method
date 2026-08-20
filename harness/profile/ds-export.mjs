/**
 * Design-system export — RIFT adapter.
 *
 * Emits DESIGN-SYSTEM.md, the raw arm's knowledge-parity equivalent of the
 * governed arm's `get_design_system_summary` (methodology §5.3). Generated
 * from the same records that back the MCP tool, so the two arms are provably
 * told the same thing and any drift we measure is a failure to *follow* the
 * design system rather than a failure to know it.
 *
 * This is the one deliberately RIFT-specific piece of the profiler; a
 * non-RIFT benchmark supplies its own exporter.
 *
 * Usage: node harness/profile/ds-export.mjs <site-id> <out-dir>
 */

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const DB = 'postgres://heithamghariani@localhost:5432/cms_dev'
const [, , siteId, outDir] = process.argv
if (!siteId || !outDir) {
  console.error('usage: node harness/profile/ds-export.mjs <site-id> <out-dir>')
  process.exit(1)
}

const q = sql => {
  // Collapse to one line: JSON.stringify would otherwise emit literal "\n"
  // sequences into the shell argument, which psql parses as a stray backslash.
  const flat = `SELECT coalesce(json_agg(t), '[]') FROM (${sql}) t`.replace(/\s+/g, ' ').trim()
  return JSON.parse(
    execSync(`psql "${DB}" -tAc ${JSON.stringify(flat)}`, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }).trim(),
  )
}

const [version] = q(`
  SELECT dsv.id, dsv.version_label, dsv.manifest
  FROM design_system_versions dsv
  JOIN sites s ON s.design_system_id = dsv.design_system_id
  WHERE s.id = '${siteId}'
  ORDER BY dsv.created_at DESC LIMIT 1
`)
if (!version) { console.error(`no design system found for site ${siteId}`); process.exit(1) }

const tokens = q(`
  SELECT category, name, value, description
  FROM design_tokens WHERE design_system_version_id = '${version.id}'
  ORDER BY category, position, name
`)
const components = q(`
  SELECT name, description, parameters, usage_notes, is_chrome_component
  FROM design_components WHERE design_system_version_id = '${version.id}'
  ORDER BY name
`)

const m = version.manifest ?? {}
const out = [
  `# Design system: ${m.name ?? 'Unknown'} ${version.version_label}`,
  '',
  m.description ?? '',
  '',
  'Every page on this site is built from these components and tokens. Use them',
  'rather than writing custom markup or styling — hand-rolled equivalents break',
  'visual consistency and will not pick up future design-system changes.',
  '',
  '## Components',
  '',
]

const content = components.filter(c => !c.is_chrome_component)
const chrome = components.filter(c => c.is_chrome_component)

for (const c of content) {
  out.push(`### ${c.name}`, '', c.description ?? '', '')
  const params = Array.isArray(c.parameters) ? c.parameters : []
  if (params.length) {
    out.push('| Parameter | Type | Default | Description |', '|---|---|---|---|')
    for (const p of params) {
      out.push(`| \`${p.name}\` | ${p.type ?? ''} | ${p.default != null ? `\`${String(p.default).slice(0, 40)}\`` : ''} | ${(p.description ?? '').replace(/\|/g, '\\|')} |`)
    }
    out.push('')
  }
  if (c.usage_notes) out.push(`**Usage:** ${c.usage_notes}`, '')
}

if (chrome.length) {
  out.push(
    '## Site chrome',
    '',
    'These render automatically on every page — header, footer, and navigation.',
    'They are managed centrally and should not be hand-edited on individual pages:',
    '',
    ...chrome.map(c => `- **${c.name}** — ${c.description ?? ''}`),
    '',
  )
}

out.push('## Tokens', '')
let cat = ''
for (const t of tokens) {
  if (t.category !== cat) {
    cat = t.category
    out.push('', `### ${cat}`, '', '| Token | Value | Purpose |', '|---|---|---|')
  }
  out.push(`| \`${t.name}\` | \`${t.value}\` | ${(t.description ?? '').replace(/\|/g, '\\|')} |`)
}
out.push('')

const file = path.join(outDir, 'DESIGN-SYSTEM.md')
writeFileSync(file, out.join('\n'))
console.log(`${m.name} ${version.version_label}: ${content.length} components, ${chrome.length} chrome, ${tokens.length} tokens`)
console.log(`wrote ${file}`)
