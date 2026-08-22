/**
 * Scorer — M1..M6 over a published-HTML snapshot.
 *
 * Substrate-blind: the input is a directory of HTML plus the design system's
 * own stylesheet. Nothing here knows which arm produced the snapshot, and no
 * `{{cms:item}}` or `{{ds:component}}` syntax survives publication, so the
 * governed arm's output is indistinguishable in kind from the raw arm's.
 *
 * Every metric except blast radius is an ABSOLUTE audit of one snapshot in
 * isolation — the drift curve is these independent counts plotted in sequence,
 * not a diff between versions (methodology §6.1).
 *
 * Usage: tsx scoring/score.ts <site-dir> [--vocab <site-profile.json>] [--json]
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { crawlSite, resolve, type SiteCrawl } from './crawl.js'

export interface Scores {
  pages: number
  m1_brokenRefs: { total: number; deadPath: number; deadFragment: number; deadAsset: number; detail: string[] }
  m2_styleForks: { hard: number; byRule: Record<string, number>; detail: string[] }
  m4_chromeDivergence: { excess: number; sections: Record<string, number> }
  m6_orphansAndReach: { orphans: string[]; unreachable: string[]; unreachableWithNav: string[] }
  linkEdges: number
}

/** M1 — every internal reference that fails to resolve. */
function scoreBrokenRefs(crawl: SiteCrawl) {
  let deadPath = 0, deadFragment = 0, deadAsset = 0
  const detail: string[] = []

  for (const page of crawl.pages) {
    // Chrome links count too: an auto-generated nav pointing at a deleted page
    // is just as broken for a reader as a body link.
    for (const link of [...page.links, ...page.chromeLinks]) {
      if (link.external) continue
      const r = resolve(link, crawl, page.path)
      if (r.ok) continue
      r.reason === 'dead_fragment' ? deadFragment++ : deadPath++
      detail.push(`${page.path} -> ${link.href} (${r.reason})`)
    }
    for (const a of page.assets) {
      if (a.external) continue
      const target = a.url.split('#')[0].split('?')[0]
      const rel = target.startsWith('/') ? target : path.posix.resolve(path.posix.dirname(page.path), target)
      if (!crawl.assetFiles.has(rel) && !crawl.aliases.has(rel)) {
        deadAsset++
        detail.push(`${page.path} -> ${a.url} (dead_asset)`)
      }
    }
  }
  return { total: deadPath + deadFragment + deadAsset, deadPath, deadFragment, deadAsset, detail }
}

/**
 * M2 — styling that escapes the design system.
 *
 * Hard rules only; the heuristic "soft" rules are deliberately excluded from
 * the headline number (methodology M2).
 */
function scoreStyleForks(crawl: SiteCrawl, vocabulary: Set<string>) {
  const byRule: Record<string, number> = { H1: 0, H2: 0, H3: 0, H4: 0, H5: 0, H6: 0, H7: 0 }
  const detail: string[] = []
  const note = (rule: string, page: string, what: string) => {
    byRule[rule]++
    if (detail.length < 200) detail.push(`${rule} ${page}: ${what}`)
  }

  for (const p of crawl.pages) {
    const c = p.content
    for (let i = 0; i < c.inlineStyleCount; i++) note('H1', p.path, 'inline style attribute')
    for (let i = 0; i < c.styleBlockCount; i++) note('H2', p.path, '<style> block in content')
    for (const lit of c.colorLiterals) note('H5', p.path, `hardcoded color ${lit}`)
    for (let i = 0; i < c.rawTableCount; i++) note('H6', p.path, '<table> without param-table')
    for (let i = 0; i < c.rawPreCount; i++) note('H7', p.path, '<pre> outside code-block')

    for (const cls of c.classes) {
      if (vocabulary.has(cls)) continue
      // A dangling BEM-style modifier whose base IS known is the silent case:
      // the design system falls back to a neutral style, so the page renders
      // as if nothing is wrong.
      const base = cls.split('--')[0]
      if (cls.includes('--') && vocabulary.has(base)) note('H3', p.path, `dangling modifier .${cls}`)
      else note('H4', p.path, `unknown class .${cls}`)
    }
  }
  const hard = Object.values(byRule).reduce((a, b) => a + b, 0)
  return { hard, byRule, detail }
}

/**
 * M4 — chrome divergence.
 *
 * Naively counting distinct chrome variants site-wide is wrong: the design
 * system renders per-folder left navigation, so a four-section site legitimately
 * has four variants and a "must equal 1" rule would report divergence on a
 * perfectly consistent site.
 *
 * What actually constitutes divergence is *within* a navigation scope — two
 * pages in the same section whose chrome differs. Baseline excess is therefore
 * 0 regardless of how many sections the site has, and stays 0 as sections are
 * added or removed by the operations.
 */
function scoreChrome(crawl: SiteCrawl) {
  const bySection = new Map<string, Set<string>>()
  for (const p of crawl.pages) {
    const parts = p.path.replace(/^\//, '').split('/')
    const section = parts.length > 1 ? parts[0] : '(root)'
    ;(bySection.get(section) ?? bySection.set(section, new Set()).get(section)!).add(p.chromeHash)
  }
  let excess = 0
  const detail: Record<string, number> = {}
  for (const [section, variants] of bySection) {
    detail[section] = variants.size
    excess += variants.size - 1
  }
  return { excess, sections: detail }
}

/**
 * M6 — pages nothing links to, and pages unreachable from the site root.
 *
 * Two reachability walks, deliberately. The content-only walk excludes
 * generated navigation so a nav that lists every page cannot mask a genuinely
 * unreferenced one — that is the anti-masking property the metric was built
 * for. But read as "can a reader get there?", it is unfair in exactly one
 * direction: a hub page reachable from every page via the substrate's own nav
 * was scored an orphan BECAUSE the substrate generates navigation centrally,
 * which is the feature. The nav-inclusive walk answers the reader's question;
 * the content-only walk answers the author's. Both are reported.
 */
function scoreOrphans(crawl: SiteCrawl) {
  const inbound = new Map<string, number>(crawl.pages.map(p => [p.path, 0]))
  const adjacency = new Map<string, Set<string>>()
  const adjacencyNav = new Map<string, Set<string>>()

  for (const page of crawl.pages) {
    const targets = new Set<string>()
    for (const link of page.links) {
      if (link.external) continue
      const r = resolve(link, crawl, page.path)
      if (r.ok && r.page !== page.path) {
        targets.add(r.page)
        inbound.set(r.page, (inbound.get(r.page) ?? 0) + 1)
      }
    }
    adjacency.set(page.path, targets)

    const navTargets = new Set<string>(targets)
    for (const link of page.chromeLinks) {
      if (link.external) continue
      const r = resolve(link, crawl, page.path)
      if (r.ok && r.page !== page.path) navTargets.add(r.page)
    }
    adjacencyNav.set(page.path, navTargets)
  }

  const root = crawl.aliases.get('/') ?? crawl.aliases.get('/index') ?? crawl.pages[0]?.path
  const walk = (adj: Map<string, Set<string>>) => {
    const seen = new Set<string>()
    const queue = root ? [root] : []
    while (queue.length) {
      const cur = queue.shift()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const t of adj.get(cur) ?? []) if (!seen.has(t)) queue.push(t)
    }
    return seen
  }
  const seen = walk(adjacency)
  const seenNav = walk(adjacencyNav)

  return {
    orphans: crawl.pages.filter(p => (inbound.get(p.path) ?? 0) === 0 && p.path !== root).map(p => p.path),
    unreachable: crawl.pages.filter(p => !seen.has(p.path)).map(p => p.path),
    unreachableWithNav: crawl.pages.filter(p => !seenNav.has(p.path)).map(p => p.path),
  }
}

/**
 * M5 — blast radius.
 *
 * The one metric that genuinely needs two snapshots: everything else is an
 * absolute audit of a single one (methodology §6.1). Compares rendered content
 * per page, so a republish that rewrites bytes without changing what a reader
 * sees does not register as churn.
 *
 * Chrome is deliberately excluded. A page whose only change is the left-nav
 * gaining an entry for some *other* new page has not itself been touched, and
 * counting it would make every additive operation look like a site-wide edit —
 * inflating the governed arm's blast radius precisely because its navigation
 * is generated centrally.
 */
export interface BlastRadius {
  changed: number
  added: string[]
  removed: string[]
  modified: string[]
}

export function blastRadius(prev: SiteCrawl, curr: SiteCrawl): BlastRadius {
  const before = new Map(prev.pages.map(p => [p.path, p.content.hash]))
  const after = new Map(curr.pages.map(p => [p.path, p.content.hash]))

  const added = [...after.keys()].filter(p => !before.has(p)).sort()
  const removed = [...before.keys()].filter(p => !after.has(p)).sort()
  const modified = [...after.entries()]
    .filter(([p, h]) => before.has(p) && before.get(p) !== h)
    .map(([p]) => p)
    .sort()

  return { changed: added.length + removed.length + modified.length, added, removed, modified }
}

/** Class vocabulary from the design system's own published stylesheet. */
export function vocabularyFor(root: string, crawl: SiteCrawl): Set<string> {
  const sheets = [...new Set(
    crawl.pages.flatMap(p => p.assets.filter(a => a.kind === 'stylesheet' && !a.external).map(a => a.url.split('#')[0])),
  )]
  const out = new Set<string>()
  for (const sheet of sheets) {
    const file = path.join(root, sheet.replace(/^\//, ''))
    if (!existsSync(file)) continue
    const cleaned = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')
    for (const m of cleaned.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1])
  }
  return out
}

export function scoreSnapshot(root: string, vocabulary?: Set<string>): Scores {
  const crawl = crawlSite(root)
  const vocab = vocabulary ?? vocabularyFor(root, crawl)
  return {
    pages: crawl.pages.length,
    m1_brokenRefs: scoreBrokenRefs(crawl),
    m2_styleForks: scoreStyleForks(crawl, vocab),
    m4_chromeDivergence: scoreChrome(crawl),
    m6_orphansAndReach: scoreOrphans(crawl),
    linkEdges: crawl.pages.reduce((n, p) => n + p.links.filter(l => !l.external).length, 0),
  }
}

// CLI entry point. Guarded so that importing this module — as the fixture
// tests and the per-op scorer both do — does not execute it as a side effect.
const invokedDirectly = process.argv[1]?.endsWith('score.ts')
const [, , siteDir, ...rest] = process.argv
if (invokedDirectly && siteDir) {
  const s = scoreSnapshot(path.resolve(siteDir))
  if (rest.includes('--json')) {
    console.log(JSON.stringify(s, null, 2))
  } else {
    console.log(`pages                ${s.pages}`)
    console.log(`link edges           ${s.linkEdges}`)
    console.log(`M1 broken refs       ${s.m1_brokenRefs.total}  (path ${s.m1_brokenRefs.deadPath}, fragment ${s.m1_brokenRefs.deadFragment}, asset ${s.m1_brokenRefs.deadAsset})`)
    console.log(`M2 style forks       ${s.m2_styleForks.hard}  ${JSON.stringify(s.m2_styleForks.byRule)}`)
    console.log(`M4 chrome divergence ${s.m4_chromeDivergence.excess}  ${JSON.stringify(s.m4_chromeDivergence.sections)}`)
    console.log(`M6 orphans           ${s.m6_orphansAndReach.orphans.length}`)
    console.log(`M6 unreachable       ${s.m6_orphansAndReach.unreachable.length}`)
    for (const d of s.m1_brokenRefs.detail.slice(0, 10)) console.log(`   broken: ${d}`)
    for (const d of s.m2_styleForks.detail.slice(0, 10)) console.log(`   fork:   ${d}`)
  }
}
