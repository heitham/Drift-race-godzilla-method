/**
 * Export the RIFT benchmark site to a vendor-neutral fixture.
 *
 * The affordance probe compares substrates, so the SITE must not vary between
 * columns. It did: RIFT's Changelog already linked to "Release notes archive",
 * which intent E2 asks an agent to create — RIFT scored `supported` for work it
 * never had to do, while Payload earned the same mark the hard way. And RIFT's
 * "Concepts" is a childless root page where Payload's was a populated section,
 * so R2 asked RIFT to build a section and Payload merely to reparent a page.
 *
 * Neither is a property of the substrate. Both are properties of two sites that
 * happened to differ. So the fixture is derived from RIFT's site once, and every
 * other column is seeded FROM it — the sites are then identical by construction
 * rather than by inspection.
 *
 * Bodies are exported as plain-text paragraphs plus a resolved link list.
 * Nothing of RIFT's markup travels: a fixture carrying {{cms:item/…}} would be
 * a RIFT artefact, and rendering it anywhere else would measure translation.
 */
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { loadEnv } from '../harness/run/config.js'

loadEnv()
const DB = process.env.DATABASE_URL!
const SITE = '32114acb-ccbe-44e4-96d4-64fa594284e2'

/**
 * Rows come back as JSON, not delimited text. Page bodies contain newlines and
 * tabs, which silently corrupted a TSV export and produced pages with no title.
 */
const q = <T>(sql: string): T[] => {
  const raw = execSync(
    `psql "${DB}" -tAc ${JSON.stringify(`SELECT coalesce(json_agg(t), '[]') FROM (${sql.replace(/\s+/g, ' ').trim()}) t`)}`,
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
  return JSON.parse(raw)
}

interface PageRow { id: string; title: string; section: string; slug: string; body: string }
const pages = q<PageRow>(`
  SELECT ci.id, ci.page_title AS title, coalesce(f.path,'') AS section,
         cp.file_name AS slug, ci.body
  FROM content_placements cp
  JOIN content_items ci ON ci.id = cp.item_id
  LEFT JOIN folders f ON f.id = cp.folder_id
  WHERE cp.site_id='${SITE}' AND ci.workflow_state IN ('public','staging')
  ORDER BY coalesce(f.path,''), ci.page_title
`)

interface EdgeRow { src: string; dst: string }
const edges = q<EdgeRow>(`
  SELECT src.id AS src, dst.id AS dst
  FROM link_edges le
  JOIN content_items src ON src.id = le.from_item_id
  JOIN content_items dst ON dst.id = le.to_item_id
  JOIN content_placements cp ON cp.item_id = src.id
  WHERE cp.site_id='${SITE}'
    AND src.workflow_state IN ('public','staging')
    AND dst.workflow_state IN ('public','staging')
`)

const titleById = new Map(pages.map(p => [p.id, p.title]))

/** HTML to paragraphs. Reference syntax is stripped to its link text; the edge
 *  it encoded is carried separately in `links`, where it is substrate-neutral. */
const toParas = (html: string): string[] =>
  (html ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\{\{ds:[^}]*\}\}/g, '')
    .replace(/\{\{cms:item\/[0-9a-f-]+\|?([^}]*)\}\}/gi, '$1')
    .split(/<\/(?:p|h[1-6]|li)>/i)
    .map(s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
               .replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 2)

const out = {
  _: 'Derived from the RIFT benchmark site. Every affordance-probe column seeds from this, so the site is identical across substrates by construction.',
  source: { site: SITE, exportedFrom: 'rift' },
  pages: pages.map(p => ({
    title: p.title,
    section: p.section,
    slug: p.slug || p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    paragraphs: toParas(p.body).slice(0, 12),
    links: [...new Set(edges.filter(e => e.src === p.id).map(e => titleById.get(e.dst)!).filter(Boolean))],
  })),
}

writeFileSync('probe/fixtures/site.json', JSON.stringify(out, null, 2))
const linkCount = out.pages.reduce((n, p) => n + p.links.length, 0)
console.log(`pages ${out.pages.length}  ·  links ${linkCount}  ·  sections ${new Set(out.pages.map(p => p.section)).size}`)
console.log(`paragraphs: min ${Math.min(...out.pages.map(p => p.paragraphs.length))}, max ${Math.max(...out.pages.map(p => p.paragraphs.length))}`)
