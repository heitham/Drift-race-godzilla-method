# Harness design

How this benchmark stays runnable against *other* sites — a framework/SSG site,
an image-heavy marketing site, a different design system — without rewriting the
protocol each time.

**Status:** design agreed 2026-08-20, not yet built.

---

## 1. The separation that makes it reusable

Split everything into **engine** (stable across all benchmarks) and **instance**
(everything specific to one site).

| Engine — write once | Instance — one per site |
|---|---|
| Protocol runner (fresh session per op, snapshot, record) | The site itself, in the CMS |
| Metrics M1–M7 and the scorer | Operation bindings (which pages each op targets) |
| `timeline.json` schema | Design-system class vocabulary *(auto-derived)* |
| Dashboard | Chrome/content boundary *(auto-derived)* |
| Arm adapters | Which arms apply |

```
harness/
  profile/      # CMS site → site-profile.json (link graph, sections, DS vocab)
  bind/         # archetypes + profile → operations.json
  run/          # execute one run: per-op session, snapshot, record
  adapters/     # arm implementations (see §4)
scoring/        # crawl, forks, chrome divergence → timeline.json
dashboard/
benchmarks/
  godzilla-docs/    # instance: profile, bindings, operations.md, results
  <next-site>/      # instance: same shape, different site
```

Everything above `benchmarks/` is written once. Each new benchmark is a
directory.

## 2. Operation archetypes

The thirty operations in `methodology/operations.md` are not thirty unique
things — they are instances of ~25 reusable patterns. Naming the patterns is
what makes a second benchmark a *binding* rather than a rewrite.

**Growth**
| ID | Pattern |
|---|---|
| G1 | `ADD_LEAF_TO_SECTION` — new page joins an existing section, hub, and sequence |
| G2 | `ADD_NEW_SECTION` — new section with landing page + children |
| G3 | `ADD_CROSS_LINKED_PEER` — new page requiring bidirectional links |
| G4 | `ADD_SIBLING_MATCHING_TEMPLATE` — new page mirroring a visible sibling set |

**Reorganization**
| ID | Pattern |
|---|---|
| R1 | `RENAME_PAGE` — single high-inbound page changes address |
| R2 | `RENAME_SECTION` — all children change address |
| R3 | `NEST_LOOSE_PAGES` — flat pages gathered into a new section |
| R4 | `RELOCATE_TO_NEW_SECTION` — existing pages regrouped |

**Retirement**
| ID | Pattern |
|---|---|
| T1 | `SUPERSEDE_KEEP_OLD` — new version current, old retained and marked |
| T2 | `SUPERSEDE_DELETE_OLD` — new version current, old removed |
| T3 | `MERGE_INTO` — fold A into B, delete A |
| T4 | `SPLIT_PAGE` — A becomes B + C; inbound links retarget *by context* |
| T5 | `DEPRECATE_TO_STUB` — address survives, readers forwarded |

**Enrichment** — each baits a specific design-system component
| ID | Pattern | Component under test |
|---|---|---|
| E1 | `ADD_TABULAR_DATA` | table |
| E2 | `ADD_CODE_SAMPLE` | code block |
| E3 | `ADD_CALLOUT_ACROSS_SIBLINGS` | alert + cross-page consistency |
| E4 | `ADD_BADGE_ACROSS_SECTION` | chip + variant validity |
| E5 | `ADD_METRIC_DISPLAY` | stat |
| E6 | `ADD_IN_PAGE_NAV` | toc + fragment integrity |

**Consolidation**
| ID | Pattern |
|---|---|
| C1 | `REORDER_SEQUENCE` — prev/next chain integrity |
| C2 | `CROSS_LINK_SECTIONS` — bidirectional pairing at scale |
| C3 | `GLOBAL_UPDATE_WITH_DISCRIMINATION` — update stale refs, preserve historical ones |
| C4 | `DEDUPLICATE` — one canonical copy, the other points to it |
| C5 | `STAMP_ALL_IN_SECTION` — coverage + format consistency |
| C6 | `AUDIT_AND_REPAIR` — capstone, scored as repair rate |

A new benchmark selects archetypes and binds each to real pages. The archetype
supplies the instruction template and the scorer's checks; the binding supplies
the nouns.

## 3. What a new site gets for free

Derived automatically by `profile/` from the CMS:

- **Link graph** — inbound/outbound degree per page. Drives target selection:
  highest-inbound page → R1, largest section → R2, loose pages → R3.
- **Section structure** — hubs, sequences, sibling sets → G1/G4/E3/E4 targets.
- **Design-system vocabulary** — token and component names, valid parameter
  values, and the published CSS class list. This configures the M2 scorer
  entirely: "unknown class" and "dangling modifier" need no hand-authoring.
- **Chrome/content boundary** — from the DS's own chrome flags, so M2 (content)
  and M4 (chrome) split correctly without per-site rules.
- **Knowledge-parity files** — `DESIGN-SYSTEM.md` and `SITEMAP.md` for the raw
  arm (methodology §5.3), generated from the same data the governed arm queries.

**What still needs a human:** which retirement is *realistic*, what a page
should split into, and which references are historical versus stale. Those are
editorial judgments, and a generator that guesses them produces operations that
look plausible and measure nothing. The binder proposes; a person confirms.

So "hand me a site and go" is close to true — with one review step that should
not be automated away.

## 4. Extension points

**Arms are plural, not paired.** The adapter interface takes *N* arms, not
exactly two. Each implements: `setup(baseline)`, `execute(op) → session`,
`snapshot() → commit sha`. Today: `raw-html`, `rift-mcp`. The SSG arm named as
a limitation in methodology §2 becomes a third adapter, not a fork of the
harness — and once it exists, the three-way comparison (raw / SSG / governed) is
a materially stronger result than the current two-way.

**Metrics are plugins.** M1–M7 suit link-dense text sites. An image-heavy
marketing site needs metrics we have not written: broken `img src`, missing or
degraded alt text, orphaned assets, oversized/unoptimized media, responsive
`srcset` integrity. Rather than bolt those on later, the scorer takes a metric
set per instance, with M1/M3/M4/M5/M7 as the substrate-agnostic core and M2/M6
extended per content type.

This matters more than it looks: **the current metric set would make an
image-heavy site look artificially clean**, because nothing we measure today
would notice a broken image. Naming the gap now prevents a misleading second
benchmark.

## 5. Build order

Deliberately partial. We have not run this benchmark once, so we do not yet know
which metrics discriminate, which operations are duds, or where the harness
chafes. Building full generalization now is abstraction against unknowns.

**Build now** — structural, cheap now and expensive to retrofit:
- engine/instance directory split
- arm adapter interface (N arms)
- metric plugin interface
- `profile/` — needed for run 1 regardless, since knowledge-parity files depend on it
- DS-vocabulary-driven scorer — needed for run 1, and site-agnostic for free
- `timeline.json` schema

**Write now** — a document, not code:
- the archetype taxonomy above, so the current 30 operations are legible as
  instances of a general pattern and coverage gaps are visible

**Defer until after run 1:**
- `bind/` auto-binder — speculative now, cheap once we know what run 1 taught us
- SSG adapter
- dashboard beyond the two charts that carry the finding

The seams are what make this reusable. The automation on top of them is a
convenience, and it will be better-informed in a month.
