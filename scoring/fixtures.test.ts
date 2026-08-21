/**
 * Scorer fixture tests.
 *
 * Answers "how do we know the scorer is right?" systematically rather than by
 * running pilots and hoping a defect happens to appear.
 *
 * Method: copy the pristine baseline, inject exactly one known defect, and
 * assert the scorer reports exactly that defect and nothing else. Free, fast,
 * and repeatable — no model calls, so this can run on every change to the
 * scoring rules.
 *
 * Usage: tsx scoring/fixtures.test.ts <baseline-dir>
 */

import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scoreSnapshot, blastRadius, type Scores } from './score.js'
import { crawlSite, type SiteCrawl } from './crawl.js'

const baselineDir = process.argv[2] ?? 'clones/godzilladocs-main'
if (!existsSync(baselineDir)) { console.error(`baseline not found: ${baselineDir}`); process.exit(1) }

let passed = 0
let failed = 0

/** Copy the baseline, mutate it, score it. */
function withFixture(mutate: (dir: string) => void): Scores {
  const dir = mkdtempSync(path.join(tmpdir(), 'driftfix-'))
  try {
    cpSync(baselineDir, dir, { recursive: true })
    rmSync(path.join(dir, '.git'), { recursive: true, force: true })
    mutate(dir)
    return scoreSnapshot(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Same fixture mechanism, but returns the crawl — M5 compares two of them. */
function withFixtureCrawl(mutate: (dir: string) => void): SiteCrawl {
  const dir = mkdtempSync(path.join(tmpdir(), 'driftfix-'))
  try {
    cpSync(baselineDir, dir, { recursive: true })
    rmSync(path.join(dir, '.git'), { recursive: true, force: true })
    mutate(dir)
    return crawlSite(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
}

/** Inject markup immediately after a page's <main> opening tag. */
const injectIntoContent = (dir: string, page: string, html: string) => {
  const file = path.join(dir, page)
  const src = readFileSync(file, 'utf8')
  writeFileSync(file, src.replace(/(<main class="cms-main-content">)/, `$1${html}`))
}

const base = scoreSnapshot(baselineDir)
console.log(`baseline: M1=${base.m1_brokenRefs.total} M2=${base.m2_styleForks.hard} ` +
            `M4=${base.m4_chromeDivergence.excess} orphans=${base.m6_orphansAndReach.orphans.length}\n`)

// --- M2: one rule at a time ------------------------------------------------

check('H1 inline style detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<p style="color:red">x</p>')).m2_styleForks.byRule.H1,
  base.m2_styleForks.byRule.H1 + 1)

check('H2 style block detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<style>.x{color:red}</style>')).m2_styleForks.byRule.H2,
  base.m2_styleForks.byRule.H2 + 1)

// The silent case: base class is real, modifier is not, so the design system
// falls back to a neutral style and the page looks fine to a human reviewer.
check('H3 dangling modifier detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<div class="alert alert--bogus">x</div>')).m2_styleForks.byRule.H3,
  base.m2_styleForks.byRule.H3 + 1)

check('H4 unknown class detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<div class="totally-invented-class">x</div>')).m2_styleForks.byRule.H4,
  base.m2_styleForks.byRule.H4 + 1)

check('H5 hardcoded color detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<p>use #ff0000 here</p>')).m2_styleForks.byRule.H5,
  base.m2_styleForks.byRule.H5 + 1)

// Regression guard for a real bug: &#123; is an escaped "{", ubiquitous in code
// samples, and was previously matched as a three-digit hex colour.
check('H5 ignores numeric HTML entities (regression)',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<p>&#123;&#125;&#123;&#125;</p>')).m2_styleForks.byRule.H5,
  base.m2_styleForks.byRule.H5)

check('H6 raw table detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<table><tr><td>x</td></tr></table>')).m2_styleForks.byRule.H6,
  base.m2_styleForks.byRule.H6 + 1)

check('H6 ignores design-system table',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<table class="param-table"><tr><td>x</td></tr></table>')).m2_styleForks.byRule.H6,
  base.m2_styleForks.byRule.H6)

check('H7 bare pre detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<pre>code</pre>')).m2_styleForks.byRule.H7,
  base.m2_styleForks.byRule.H7 + 1)

check('H7 ignores pre inside a code block',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<div class="code-block"><pre>code</pre></div>')).m2_styleForks.byRule.H7,
  base.m2_styleForks.byRule.H7)

// Regression guard for a defect that cost a whole governed run. RIFT injects a
// breadcrumb INSIDE the content region, but only for pages nested two or more
// levels deep — so it is absent from the baseline and appears for the first
// time when a model successfully creates sections. Scored as authored markup it
// read as 110 "unknown class" style forks, penalising the arm precisely for
// doing the reorganisation right, and leaving the arm that skipped the work
// untouched.
check('H4 ignores publisher-injected breadcrumbs (regression)',
  withFixture(d => injectIntoContent(d, 'glossary.html',
    '<nav class="usa-breadcrumb"><ol class="usa-breadcrumb__list">' +
    '<li class="usa-breadcrumb__list-item"><a class="usa-breadcrumb__link" href="/index">Home</a></li>' +
    '</ol></nav>')).m2_styleForks.byRule.H4,
  base.m2_styleForks.byRule.H4)

// The same breadcrumb must not rescue a page from orphanhood: injected
// navigation is chrome by origin, and counting its links as content links is
// the exact masking the chromeLinks split exists to prevent.
check('M6 breadcrumb links do not count as content links (regression)',
  withFixture(d => injectIntoContent(d, 'glossary.html',
    '<nav class="usa-breadcrumb"><a class="usa-breadcrumb__link" href="/changelog">Changelog</a></nav>'))
    .m6_orphansAndReach.orphans.length,
  base.m6_orphansAndReach.orphans.length)

// --- M1: reference integrity ----------------------------------------------

check('M1 dead fragment detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<a href="/index#no-such-anchor">x</a>')).m1_brokenRefs.deadFragment,
  base.m1_brokenRefs.deadFragment + 1)

check('M1 dead path detected',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<a href="/no-such-page">x</a>')).m1_brokenRefs.deadPath,
  base.m1_brokenRefs.deadPath + 1)

// Deleting a linked-to page must surface every reference that pointed at it,
// which is the core Wave-B/C failure mode the benchmark exists to measure.
check('M1 deleting a linked page breaks its inbound refs',
  withFixture(d => rmSync(path.join(d, 'concepts-events.html'))).m1_brokenRefs.deadPath > base.m1_brokenRefs.deadPath,
  true)

check('M1 external links are ignored',
  withFixture(d => injectIntoContent(d, 'glossary.html', '<a href="https://example.com/nope">x</a>')).m1_brokenRefs.total,
  base.m1_brokenRefs.total)

// --- M4: chrome divergence -------------------------------------------------

check('M4 detects chrome edited on one page in a section',
  withFixture(d => {
    const f = path.join(d, 'apis/pipelines.html')
    writeFileSync(f, readFileSync(f, 'utf8').replace('</footer>', '<p>rogue footer text</p></footer>'))
  }).m4_chromeDivergence.excess,
  base.m4_chromeDivergence.excess + 1)

// Regression guard: the active-page marker legitimately differs per page and
// must not be counted as divergence.
check('M4 ignores active-page nav marker (regression)',
  base.m4_chromeDivergence.excess, 0)

// --- M6: orphans -----------------------------------------------------------

check('M6 orphan detected when content links are removed',
  withFixture(d => {
    // Strip every content link to the changelog; nav links must not rescue it.
    for (const f of ['index.html', 'migration-guide-v1-to-v2.html', 'release-notes-archive.html', 'troubleshooting.html']) {
      const p = path.join(d, f)
      if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replace(/href="\/changelog"/g, 'href="#"'))
    }
  }).m6_orphansAndReach.orphans.includes('/changelog'),
  true)

// --- M5: blast radius (the one metric that compares two snapshots) ---------

{
  const base = crawlSite(baselineDir)

  check('M5 identical snapshots report no churn',
    blastRadius(base, crawlSite(baselineDir)).changed, 0)

  const oneEdit = withFixtureCrawl(d => injectIntoContent(d, 'glossary.html', '<p>edited</p>'))
  check('M5 single edited page counts as 1',
    blastRadius(base, oneEdit).modified, ['/glossary'])

  const deleted = withFixtureCrawl(d => rmSync(path.join(d, 'changelog.html')))
  check('M5 deleted page is counted as removed',
    blastRadius(base, deleted).removed, ['/changelog'])

  // Guards the chrome exclusion: a new page makes the left nav gain an entry
  // on EVERY page. Counting that would make every additive operation look like
  // a site-wide rewrite — and would penalize the governed arm hardest, since
  // its navigation is generated centrally.
  const chromeOnly = withFixtureCrawl(d => {
    for (const f of ['glossary.html', 'changelog.html', 'support.html']) {
      const p = path.join(d, f)
      writeFileSync(p, readFileSync(p, 'utf8').replace('</aside>', '<a href="/new-page">New</a></aside>'))
    }
  })
  check('M5 ignores chrome-only changes (regression)',
    blastRadius(base, chromeOnly).changed, 0)
}

// --- determinism -----------------------------------------------------------

check('scoring is deterministic',
  JSON.stringify(scoreSnapshot(baselineDir)) === JSON.stringify(base), true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
