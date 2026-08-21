/**
 * Structural assertions — did the operation actually do what was asked?
 *
 * M7 originally recorded an operation `completed` when content published. That
 * is not the same question. In the first Haiku pair the governed arm was
 * scored `completed` on three reorganisation operations while its published
 * tree showed no new sections and no moved pages: it had written root-level hub
 * pages and stopped. The metric could not see it, and the miss flattered
 * whichever arm did less work — because work not done is also damage not done.
 *
 * These assertions close that hole. Each is written from the frozen instruction
 * text, and deliberately BEFORE looking at what either arm produced.
 *
 * Arm-neutral by construction. Pages are matched by TITLE, never by path,
 * because the two arms legitimately choose different paths for the same page —
 * raw picked `api/`, governed kept `apis/`; raw named a file `authentication`,
 * governed `getting-started-authentication`. Asserting on paths would score a
 * naming preference as a failure. What the instructions actually specify is
 * titles and relationships, so that is what is checked.
 *
 * Usage: imported by score-run.ts; no separate CLI.
 */

import type { SiteCrawl, PageRecord } from './crawl.js'
import { resolve } from './crawl.js'

/** A page's parent directory, '' for the site root. */
const parentOf = (p: PageRecord) => p.path.replace(/\/[^/]*$/, '')

/**
 * Titles are compared loosely on purpose. The instruction says
 * "Migration guide (v1 → v2)"; a model may publish "Migration Guide (v1 -> v2)"
 * or escape the ampersand in "Limits, quotas &amp; errors". None of that is
 * drift, and penalising it would measure typography rather than structure.
 */
function norm(s: string): string {
  return s
    // Both arms render "<page title> | <site name>". Compare the page's own
    // title, or every assertion fails on the site name and reports the arm
    // broken when the matcher is.
    .split('|')[0]
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[→–—]/g, '-')   // → – — all read as "-"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const find = (crawl: SiteCrawl, title: string): PageRecord | undefined =>
  crawl.pages.find(p => norm(p.title) === norm(title))

export type Assertion =
  /** A page with this title exists. */
  | { kind: 'exists'; title: string }
  /** No page with this title exists — it was removed, folded in, or renamed. */
  | { kind: 'absent'; title: string }
  /** These pages all sit in one section together, and not at the site root. */
  | { kind: 'grouped'; titles: string[] }
  /** The section holding this page has its own landing page. */
  | { kind: 'sectionLanding'; title: string }
  /** A content link from one page resolves to another. Chrome does not count:
   *  auto-generated navigation would let every arm pass every link assertion. */
  | { kind: 'links'; from: string; to: string }


export interface AssertionResult {
  ok: boolean
  detail: string
}

export function checkAssertion(crawl: SiteCrawl, a: Assertion): AssertionResult {
  switch (a.kind) {
    case 'exists': {
      const p = find(crawl, a.title)
      return { ok: !!p, detail: p ? `"${a.title}" at ${p.path}` : `no page titled "${a.title}"` }
    }

    case 'absent': {
      const p = find(crawl, a.title)
      return { ok: !p, detail: p ? `"${a.title}" still present at ${p.path}` : `"${a.title}" gone` }
    }

    case 'grouped': {
      const found = a.titles.map(t => ({ t, p: find(crawl, t) }))
      const missing = found.filter(f => !f.p).map(f => f.t)
      if (missing.length) return { ok: false, detail: `missing: ${missing.join(', ')}` }
      const dirs = [...new Set(found.map(f => parentOf(f.p!)))]
      if (dirs.length > 1) return { ok: false, detail: `split across ${dirs.join(', ')}` }
      if (dirs[0] === '') return { ok: false, detail: 'still at the site root — no section was created' }
      return { ok: true, detail: `grouped under ${dirs[0]}` }
    }

    case 'sectionLanding': {
      const p = find(crawl, a.title)
      if (!p) return { ok: false, detail: `no page titled "${a.title}"` }
      const dir = parentOf(p)
      if (dir === '') return { ok: false, detail: 'page is at the site root, so it has no section' }
      const landing = crawl.pages.some(q => q.path === dir || q.path === `${dir}/index`)
      return { ok: landing, detail: landing ? `${dir} has a landing page` : `${dir} has no landing page` }
    }

    case 'links': {
      const from = find(crawl, a.from)
      const to = find(crawl, a.to)
      if (!from) return { ok: false, detail: `no page titled "${a.from}"` }
      if (!to) return { ok: false, detail: `no page titled "${a.to}"` }
      const hit = from.links.some(l => {
        if (l.external) return false
        const r = resolve(l, crawl, from.path)
        return r.ok && r.page === to.path
      })
      return { ok: hit, detail: hit ? `${from.path} -> ${to.path}` : `${from.path} has no content link to ${to.path}` }
    }

  }
}

export interface OpAssertionOutcome {
  passed: number
  failed: number
  failures: string[]
}

export function checkOperation(crawl: SiteCrawl, assertions: Assertion[]): OpAssertionOutcome {
  const failures: string[] = []
  let passed = 0
  for (const a of assertions) {
    const r = checkAssertion(crawl, a)
    if (r.ok) passed++
    else failures.push(`${a.kind}: ${r.detail}`)
  }
  return { passed, failed: failures.length, failures }
}
