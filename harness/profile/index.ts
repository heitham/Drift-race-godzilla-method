/**
 * Site profiler.
 *
 * Input:  a directory of published HTML (any arm, any substrate).
 * Output: site-profile.json  — link graph, sections, design-system class
 *                              vocabulary, and suggested archetype bindings
 *         SITEMAP.md         — knowledge-parity file for the raw arm
 *
 * Deliberately substrate-agnostic: it reads only published output, including
 * the design system's own stylesheet for the class vocabulary. Nothing here
 * talks to RIFT, so the same profiler runs against a future SSG arm or a
 * non-RIFT benchmark unchanged.
 *
 * Usage: tsx harness/profile/index.ts <site-dir> <out-dir>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { crawlSite, inboundDegree, resolve, type SiteCrawl } from '../../scoring/crawl.js'

export interface SiteProfile {
  generatedAt: string
  root: string
  pageCount: number
  sections: Record<string, string[]>
  /** Every class name defined by the design system's stylesheet. */
  dsClassVocabulary: string[]
  dsStylesheets: string[]
  pages: Array<{
    path: string
    title: string
    section: string
    inbound: number
    outbound: number
  }>
  linkGraph: Array<{ from: string; to: string }>
  /** Suggested targets for operation archetypes — proposals for human review. */
  suggestedBindings: Record<string, unknown>
}

/** Extract every class selector defined in the design system's stylesheets. */
function extractClassVocabulary(root: string, crawl: SiteCrawl): { classes: string[]; sheets: string[] } {
  const sheets = [...new Set(
    crawl.pages.flatMap(p =>
      p.assets.filter(a => a.kind === 'stylesheet' && !a.external).map(a => a.url.split('#')[0]),
    ),
  )]
  const classes = new Set<string>()
  for (const sheet of sheets) {
    try {
      const css = readFileSync(path.join(root, sheet.replace(/^\//, '')), 'utf8')
      // Strip strings/comments first so content: "..." can't inject false classes.
      const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')
      for (const m of cleaned.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(m[1])
    } catch { /* stylesheet absent from this snapshot — recorded as empty */ }
  }
  return { classes: [...classes].sort(), sheets }
}

const sectionOf = (p: string) => {
  const parts = p.replace(/^\//, '').split('/')
  return parts.length > 1 ? parts[0] : '(root)'
}

export function profileSite(root: string): SiteProfile {
  const crawl = crawlSite(root)
  const inbound = inboundDegree(crawl)
  const { classes, sheets } = extractClassVocabulary(root, crawl)

  const sections: Record<string, string[]> = {}
  const linkGraph: Array<{ from: string; to: string }> = []

  for (const page of crawl.pages) {
    ;(sections[sectionOf(page.path)] ??= []).push(page.path)
    for (const link of page.links) {
      if (link.external) continue
      const r = resolve(link, crawl, page.path)
      if (r.ok && r.page !== page.path) linkGraph.push({ from: page.path, to: r.page })
    }
  }

  const pages = crawl.pages
    .map(p => ({
      path: p.path,
      title: p.title.split('|')[0].trim(),
      section: sectionOf(p.path),
      inbound: inbound.get(p.path) ?? 0,
      outbound: new Set(
        p.links.filter(l => !l.external)
          .map(l => resolve(l, crawl, p.path))
          .filter((r): r is { ok: true; page: string } => r.ok)
          .map(r => r.page),
      ).size,
    }))
    .sort((a, b) => b.inbound - a.inbound)

  // --- archetype binding proposals ----------------------------------------
  // Structural suggestions only. Which retirement is *realistic* is an
  // editorial judgment and is deliberately left to human confirmation.
  const nonRootSections = Object.entries(sections).filter(([s]) => s !== '(root)')
  const looseRootPages = (sections['(root)'] ?? []).filter(p => p !== '/index')

  const suggestedBindings = {
    R1_RENAME_PAGE: pages.filter(p => p.inbound > 0).slice(0, 3).map(p => ({
      target: p.path, inbound: p.inbound, rationale: 'highest inbound degree — maximum reference blast radius',
    })),
    R2_RENAME_SECTION: nonRootSections
      .sort((a, b) => b[1].length - a[1].length).slice(0, 2)
      .map(([name, ps]) => ({ target: name, pageCount: ps.length, rationale: 'largest section' })),
    R3_NEST_LOOSE_PAGES: {
      candidates: looseRootPages,
      rationale: 'top-level pages with no section — candidates for grouping',
    },
    T_RETIREMENT_CANDIDATES: pages.filter(p => p.inbound >= 2).slice(0, 6).map(p => ({
      target: p.path, inbound: p.inbound, rationale: 'enough inbound links that removal is measurable',
    })),
    E_SIBLING_SETS: nonRootSections
      .filter(([, ps]) => ps.length >= 3)
      .map(([name, ps]) => ({ section: name, members: ps, rationale: 'sibling set for cross-page consistency checks' })),
  }

  return {
    generatedAt: new Date().toISOString(),
    root,
    pageCount: crawl.pages.length,
    sections,
    dsClassVocabulary: classes,
    dsStylesheets: sheets,
    pages,
    linkGraph,
    suggestedBindings,
  }
}

/** Knowledge-parity artifact: the raw arm's equivalent of `list_folders`. */
export function renderSitemapMd(profile: SiteProfile): string {
  const lines = [
    '# Site map',
    '',
    'Every page on this site, with its address and purpose.',
    `Generated from published output — ${profile.pageCount} pages.`,
    '',
  ]
  for (const [section, paths] of Object.entries(profile.sections).sort()) {
    lines.push(`## ${section}`, '')
    lines.push('| Path | Title |', '|---|---|')
    for (const p of paths.sort()) {
      const page = profile.pages.find(x => x.path === p)!
      lines.push(`| \`${p}\` | ${page.title} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

const [, , siteDir, outDir] = process.argv
if (!siteDir || !outDir) {
  console.error('usage: tsx harness/profile/index.ts <site-dir> <out-dir>')
  process.exit(1)
}

const profile = profileSite(path.resolve(siteDir))
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'site-profile.json'), JSON.stringify(profile, null, 2))
writeFileSync(path.join(outDir, 'SITEMAP.md'), renderSitemapMd(profile))

console.log(`pages            ${profile.pageCount}`)
console.log(`sections         ${Object.keys(profile.sections).join(', ')}`)
console.log(`link edges       ${profile.linkGraph.length}`)
console.log(`DS classes       ${profile.dsClassVocabulary.length}`)
console.log(`\ntop inbound:`)
for (const p of profile.pages.slice(0, 8)) {
  console.log(`  ${String(p.inbound).padStart(3)}  ${p.path}`)
}
console.log(`\nwrote ${outDir}/site-profile.json, ${outDir}/SITEMAP.md`)
