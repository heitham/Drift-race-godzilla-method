/**
 * Shared crawler primitive.
 *
 * Reads a directory of published HTML and produces a structural record of the
 * site. Used by BOTH the profiler (harness/profile) and the scorer, so the
 * link graph the benchmark measures is definitionally the same one the
 * operation binder reasoned about.
 *
 * Substrate-blind by construction: the input is a directory of HTML and
 * nothing else. Nothing here knows or can know which arm produced it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { parse, type HTMLElement } from 'node-html-parser'

/** Chrome containers, derived from the design system's chrome components. */
const CHROME_SELECTORS = ['header.site-header', 'aside.cms-left-nav', 'footer.site-footer']

/**
 * Design-system navigation that the publisher injects INSIDE the content
 * region. It is chrome by origin — no author writes it — but it does not sit
 * in a chrome element, so it has to be removed by hand.
 *
 * This matters more than it looks. RIFT emits a breadcrumb only for pages
 * nested two or more levels deep, and the frozen baseline has none. So the
 * markup appears for the first time when a model successfully creates
 * sections — and before this exclusion it was scored as 110 hand-written
 * "unknown class" style forks in the governed arm's v4 run, penalising the
 * arm precisely for doing the reorganisation correctly. The raw arm, which
 * hand-copies pages and never injects a breadcrumb, was untouched by it.
 *
 * Removed before BOTH content facts and the chrome hash. It cannot count as a
 * style fork (the model did not write it), and it cannot join the chrome hash
 * either, since a breadcrumb legitimately differs per page and would make
 * every page its own chrome variant (M4).
 */
const INJECTED_NAV_SELECTORS = ['nav.usa-breadcrumb', '.usa-breadcrumb']
/** The single content container. Everything scored as M2 lives inside this. */
const CONTENT_SELECTOR = 'main.cms-main-content'

/**
 * Hardcoded colour literals.
 *
 * The negative lookbehind is load-bearing: numeric HTML entities such as
 * `&#123;` (an escaped `{`, ubiquitous inside code samples) would otherwise
 * match as three-digit hex colours and swamp the metric with false positives.
 */
const COLOR_LITERAL = /(?<![&\w])#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g

/**
 * Markers of "this nav entry is the current page".
 *
 * Chrome legitimately differs page to page by exactly this much, so it is
 * normalized away before hashing. Without this, M4 would report one variant
 * per page on a perfectly consistent site and measure nothing.
 */
const ACTIVE_TOKENS = new Set(['usa-current', 'is-current', 'is-active', 'active', 'selected', 'current'])

function normalizeChrome(html: string): string {
  return html
    .replace(/\s+aria-current="[^"]*"/g, '')
    // Strip active-state tokens, then drop the attribute entirely when nothing
    // remains — an empty class="" would still differ from a page that carries
    // no class attribute at all, which is precisely the case being normalized.
    .replace(/\s+class="([^"]*)"/g, (_, value: string) => {
      const kept = value.split(/\s+/).filter(Boolean).filter(c => !ACTIVE_TOKENS.has(c))
      return kept.length ? ` class="${kept.join(' ')}"` : ''
    })
}

export interface LinkRef {
  /** Raw href exactly as authored in the HTML. */
  href: string
  /** Path portion, no fragment. */
  target: string
  /** Fragment without '#', if any. */
  fragment: string | null
  /** Visible link text, whitespace-collapsed. */
  text: string
  external: boolean
}

export interface AssetRef {
  url: string
  kind: 'stylesheet' | 'image' | 'script'
  external: boolean
}

export interface ContentFacts {
  hash: string
  classes: string[]
  inlineStyleCount: number
  styleBlockCount: number
  colorLiterals: string[]
  /** <table> elements not carrying the design system's table class. */
  rawTableCount: number
  /** <pre> elements not inside a design-system code block. */
  rawPreCount: number
}

export interface PageRecord {
  /** Canonical site path, e.g. "/apis/pipelines". */
  path: string
  /** File path relative to the site root, e.g. "apis/pipelines.html". */
  file: string
  title: string
  /** Every id in the document — the resolution set for '#fragment' links. */
  ids: string[]
  /** Links inside the content region. These form the scored link graph. */
  links: LinkRef[]
  /** Links inside chrome. Excluded from orphan/reachability analysis so that
   *  auto-generated navigation cannot mask a genuinely unreferenced page. */
  chromeLinks: LinkRef[]
  assets: AssetRef[]
  content: ContentFacts
  /** Hash of the chrome regions — the basis for chrome-divergence (M4). */
  chromeHash: string
}

export interface SiteCrawl {
  root: string
  pages: PageRecord[]
  /** Every resolvable alias → canonical page path. */
  aliases: Map<string, string>
  /** Non-HTML files present (assets), as site paths. */
  assetFiles: Set<string>
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, root, out)
    else out.push(path.relative(root, full))
  }
  return out
}

function isExternal(href: string): boolean {
  return /^(https?:)?\/\//i.test(href) || /^(mailto|tel|data):/i.test(href)
}

function extractLinks(scope: HTMLElement | null): LinkRef[] {
  if (!scope) return []
  const out: LinkRef[] = []
  for (const a of scope.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') === false && href.trim() === '') continue
    const external = isExternal(href)
    const [target, fragment = null] = href.split('#') as [string, string?]
    out.push({
      href,
      target,
      fragment: fragment ?? null,
      text: collapse(a.text),
      external,
    })
  }
  return out
}

/** Convert a file path to its canonical site path and any aliases it answers to. */
function pathsForFile(file: string): { canonical: string; aliases: string[] } {
  const noExt = file.replace(/\.html$/i, '')
  const posix = '/' + noExt.split(path.sep).join('/')
  const aliases = new Set<string>([posix, posix + '/', posix + '.html'])

  if (posix.endsWith('/index')) {
    const dir = posix.slice(0, -'/index'.length)
    // "apis/index.html" also answers to "/apis" and "/apis/"
    aliases.add(dir === '' ? '/' : dir)
    aliases.add(dir === '' ? '/' : dir + '/')
  }
  return { canonical: posix, aliases: [...aliases] }
}

export function crawlSite(root: string): SiteCrawl {
  const files = walk(root, root)
  const pages: PageRecord[] = []
  const aliases = new Map<string, string>()
  const assetFiles = new Set<string>()

  for (const file of files) {
    if (!/\.html$/i.test(file)) {
      assetFiles.add('/' + file.split(path.sep).join('/'))
      continue
    }

    const raw = readFileSync(path.join(root, file), 'utf8')
    const doc = parse(raw, { comment: false })

    const contentEl = doc.querySelector(CONTENT_SELECTOR)
    const chromeEls = CHROME_SELECTORS.map(s => doc.querySelector(s)).filter(Boolean) as HTMLElement[]

    // Publisher-injected navigation living inside the content region. Its
    // links are collected as chrome links — counting them as content links
    // would let a breadcrumb rescue a page from orphanhood (M6), which is the
    // same masking the chromeLinks split exists to prevent — and then the
    // element is detached so it reaches neither the style rules nor M4.
    const injectedNav: HTMLElement[] = []
    for (const sel of INJECTED_NAV_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        if (!injectedNav.includes(el)) injectedNav.push(el)
      }
    }
    for (const el of injectedNav) el.remove()

    const contentHtml = contentEl?.innerHTML ?? ''

    // --- style-fork raw material, content region only -----------------------
    const classes = new Set<string>()
    let inlineStyleCount = 0
    for (const el of contentEl?.querySelectorAll('*') ?? []) {
      const cls = el.getAttribute('class')
      if (cls) for (const c of cls.split(/\s+/).filter(Boolean)) classes.add(c)
      if (el.getAttribute('style')) inlineStyleCount++
    }

    const rawTableCount = (contentEl?.querySelectorAll('table') ?? []).filter(
      t => !(t.getAttribute('class') ?? '').split(/\s+/).includes('param-table'),
    ).length

    const rawPreCount = (contentEl?.querySelectorAll('pre') ?? []).filter(p => {
      // Walk ancestors looking for a design-system code block wrapper.
      let n: HTMLElement | null = p.parentNode as HTMLElement | null
      while (n) {
        if ((n.getAttribute?.('class') ?? '').split(/\s+/).some(c => c.startsWith('code-block'))) return false
        n = n.parentNode as HTMLElement | null
      }
      return true
    }).length

    const { canonical, aliases: fileAliases } = pathsForFile(file)
    for (const a of fileAliases) aliases.set(a, canonical)

    pages.push({
      path: canonical,
      file: file.split(path.sep).join('/'),
      title: collapse(doc.querySelector('title')?.text ?? ''),
      ids: doc.querySelectorAll('[id]').map(e => e.getAttribute('id')!).filter(Boolean),
      links: extractLinks(contentEl),
      chromeLinks: [...chromeEls, ...injectedNav].flatMap(el => extractLinks(el)),
      assets: [
        ...doc.querySelectorAll('link[href]').map(e => ({
          url: e.getAttribute('href')!, kind: 'stylesheet' as const, external: isExternal(e.getAttribute('href')!),
        })),
        ...doc.querySelectorAll('img[src]').map(e => ({
          url: e.getAttribute('src')!, kind: 'image' as const, external: isExternal(e.getAttribute('src')!),
        })),
        ...doc.querySelectorAll('script[src]').map(e => ({
          url: e.getAttribute('src')!, kind: 'script' as const, external: isExternal(e.getAttribute('src')!),
        })),
      ],
      content: {
        hash: sha(collapse(contentHtml)),
        classes: [...classes].sort(),
        inlineStyleCount,
        styleBlockCount: (contentEl?.querySelectorAll('style') ?? []).length,
        colorLiterals: contentHtml.match(COLOR_LITERAL) ?? [],
        rawTableCount,
        rawPreCount,
      },
      chromeHash: sha(normalizeChrome(chromeEls.map(e => collapse(e.innerHTML)).join('|'))),
    })
  }

  return { root, pages, aliases, assetFiles }
}

export type Resolution =
  | { ok: true; page: string }
  | { ok: false; reason: 'dead_path' | 'dead_fragment' }

/**
 * Resolve an internal reference against a crawl.
 *
 * Resolution order is fixed and identical for every arm: exact path, then
 * `.html`, then `/index.html`. Trailing slashes are normalized first.
 */
export function resolve(ref: LinkRef, crawl: SiteCrawl, fromPath: string): Resolution {
  // Pure fragment link — resolves against the page it appears on.
  if (ref.target === '' && ref.fragment) {
    const self = crawl.pages.find(p => p.path === fromPath)
    return self?.ids.includes(ref.fragment)
      ? { ok: true, page: fromPath }
      : { ok: false, reason: 'dead_fragment' }
  }

  let t = ref.target
  if (!t.startsWith('/')) t = path.posix.resolve(path.posix.dirname(fromPath), t)
  const candidates = [t, t.replace(/\/$/, ''), t + '.html', t.replace(/\/$/, '') + '/index']

  let hit: string | undefined
  for (const c of candidates) {
    const found = crawl.aliases.get(c)
    if (found) { hit = found; break }
  }
  if (!hit) return { ok: false, reason: 'dead_path' }

  if (ref.fragment) {
    const target = crawl.pages.find(p => p.path === hit)
    if (!target?.ids.includes(ref.fragment)) return { ok: false, reason: 'dead_fragment' }
  }
  return { ok: true, page: hit }
}

/** Inbound-link counts over the content link graph (chrome excluded). */
export function inboundDegree(crawl: SiteCrawl): Map<string, number> {
  const deg = new Map<string, number>(crawl.pages.map(p => [p.path, 0]))
  for (const page of crawl.pages) {
    const seen = new Set<string>()
    for (const link of page.links) {
      if (link.external) continue
      const r = resolve(link, crawl, page.path)
      if (r.ok && r.page !== page.path && !seen.has(r.page)) {
        seen.add(r.page)
        deg.set(r.page, (deg.get(r.page) ?? 0) + 1)
      }
    }
  }
  return deg
}
