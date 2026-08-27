/**
 * Affordance-probe seed for Sanity — built from the shared site fixture.
 *
 * Setup goes through Sanity's own HTTP mutate API rather than its MCP, exactly
 * as the Payload column seeds through Payload's Local API. The probe measures
 * the MCP surface; using that same surface to build the fixture would fold setup
 * cost into the measurement and let a seeding bug read as a vendor limitation.
 *
 * Document ids are derived from the fixture slug, so the whole graph can be
 * written in ONE pass — a link can name its target's id before that target
 * exists. Payload needed two passes because its ids are database sequences.
 *
 * Links are `internalLink` annotations carrying a real reference, so an edge is
 * something the store knows about. That is what lets GROQ's references() answer
 * "what points at this page" — the capability RIFT shipped as get_inbound_links
 * and Payload does not have at all.
 *
 * Idempotent and destructive: every page document is deleted first.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../harness/run/config.js'

loadEnv()

const PROJECT = process.env.SANITY_PROJECT_ID!
const DATASET = process.env.SANITY_DATASET ?? 'production'
const TOKEN = process.env.SANITY_TOKEN!
const API = `https://${PROJECT}.api.sanity.io/v2024-01-01`

interface FixturePage {
  title: string; section: string; slug: string; paragraphs: string[]; links: string[]
}
const fixture = JSON.parse(
  readFileSync(path.join('probe', 'fixtures', 'site.json'), 'utf8'),
) as { pages: FixturePage[] }

const SECTION_LANDING = 'index'
const sections = [...new Set(fixture.pages.map(p => p.section).filter(Boolean))]
const landingOf = (s: string) =>
  fixture.pages.find(p => p.section === s && p.slug === SECTION_LANDING)!
const slugFor = (p: FixturePage) =>
  p.slug !== SECTION_LANDING ? p.slug : (p.section || 'home')

/** Stable, readable ids so the graph can be written in one pass. */
const idFor = (p: FixturePage) => `page-${slugFor(p)}`.replace(/[^a-zA-Z0-9._-]/g, '-')
const byTitle = new Map(fixture.pages.map(p => [p.title, p]))

async function mutate(mutations: unknown[], label: string) {
  const res = await fetch(`${API}/data/mutate/${DATASET}?returnIds=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mutations }),
  })
  const body = await res.json() as any
  if (!res.ok || body.error) {
    throw new Error(`${label} failed: ${JSON.stringify(body.error ?? body).slice(0, 400)}`)
  }
  return body
}

async function query(groq: string) {
  const res = await fetch(`${API}/data/query/${DATASET}?query=${encodeURIComponent(groq)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  return (await res.json() as any).result
}

/* ---------- wipe ---------------------------------------------------------- */

const existing: string[] = await query(`*[_type == "page"]._id`)
if (existing.length) {
  // Drafts are separate documents in Sanity and are NOT removed by deleting the
  // published id; leaving them behind would let a previous pass's edits reappear.
  const ids = [...new Set(existing.flatMap(id => [id, `drafts.${id.replace(/^drafts\./, '')}`]))]
  await mutate(ids.map(id => ({ delete: { id } })), 'wipe')
}
console.log(`wiped ${existing.length} page document(s)`)

/* ---------- build --------------------------------------------------------- */

const span = (key: string, text: string, marks: string[] = []) =>
  ({ _type: 'span', _key: key, text, marks })

let n = 0
const docs = fixture.pages.map(p => {
  const blocks: unknown[] = p.paragraphs.map((t, i) => ({
    _type: 'block', _key: `p${i}`, style: 'normal', markDefs: [],
    children: [span(`p${i}s0`, t)],
  }))

  const targets = p.links.map(t => byTitle.get(t)).filter(Boolean) as FixturePage[]
  if (targets.length) {
    // Links live in one closing paragraph. The fixture records WHICH edges exist,
    // not where in a sentence they sat, and inventing placements would differ per
    // column for no measured reason.
    const markDefs = targets.map((t, i) => ({
      _key: `l${i}`, _type: 'internalLink',
      reference: { _type: 'reference', _ref: idFor(t) },
    }))
    const children: unknown[] = [span('ls', 'See also: ')]
    targets.forEach((t, i) => {
      if (i) children.push(span(`sep${i}`, ' · '))
      children.push(span(`lk${i}`, t.title, [`l${i}`]))
    })
    blocks.push({ _type: 'block', _key: 'links', style: 'normal', markDefs, children })
    n += targets.length
  }

  const parent = p.section ? landingOf(p.section) : null
  return {
    createOrReplace: {
      _id: idFor(p),
      _type: 'page',
      title: p.title,
      slug: { _type: 'slug', current: slugFor(p) },
      ...(parent && parent.title !== p.title
        ? { parent: { _type: 'reference', _ref: idFor(parent) } }
        : {}),
      body: blocks,
    },
  }
})

// One transaction: references resolve against documents created in the same
// mutation, so the cyclic link graph needs no second pass.
await mutate(docs, 'create')

const pages = await query(`count(*[_type == "page"])`)
const edges = await query(`count(*[_type == "page"].body[].markDefs[_type == "internalLink"])`)
console.log(`created ${pages} pages · ${n} edges declared`)
console.log(`SEED OK — sections: ${sections.length}`)
