# Frozen operation list

Thirty operations, executed in order, once per run. **Frozen 2026-08-20, before
any trial was run.** Changing an operation invalidates every prior run.

## How to read this

Each operation has two parts:

- **Instruction** — issued verbatim to the model, identical in both arms. Written
  in content-team language: outcomes, not mechanisms. No file paths, no CMS
  jargon, no hint about how references or components are implemented.
- **Scorer notes** — **never shown to the model.** Defines the minimum page set
  for blast radius (M5) and any operation-specific check beyond the standard
  M1–M7 sweep.

**Inbound-link sets are computed dynamically** by the scorer against snapshot
*n*−1, never hardcoded here — the link graph changes as the run proceeds, so a
baseline-derived set would be wrong by Wave B.

The five waves trace a site's life over "months": it grows, gets reorganized,
retires things, gets enriched, then gets audited. Drift compounds across waves
by design — later operations act on an already-damaged site.

---

## Wave A — Growth (ops 1–6)

New pages that must integrate into an existing structure. Tests whether the
model wires new content into hubs, sequences, and cross-links, or leaves it
stranded. No path churn yet; the arms should perform comparably here.

### A1 · Op 1 — Add a transforms guide
> Add a new guide called **"Transforming events in flight"**, covering how to
> reshape, filter, and enrich events as they pass through a pipeline. It should
> sit in the guide sequence immediately after "Connecting a data source", and
> readers browsing the Guides section should be able to find it.

**Scorer notes** — Minimum set: new page, Guides hub, and the two neighbours in
the prev/next chain. Checks: new page reachable from Guides hub; pagination
chain remains unbroken in both directions across the insertion point.

### A2 · Op 2 — Add the transforms endpoint
> Add a **"Transforms endpoint"** page to the API Reference documenting how to
> create and list transform steps. Follow the same structure as the other
> endpoint pages, and make sure it's discoverable alongside them.

**Scorer notes** — Minimum set: new page + API Reference hub. DS surface:
`parameter-table` for parameters, `code-block` for examples, `chip` for the
version badge, `docs-toc` — matching sibling endpoint pages. Hand-rolled
`<table>` or bare `<pre>` here triggers H6/H7.

### A3 · Op 3 — Add a Schemas concept
> Add a **"Schemas"** page to Concepts explaining how event payload shapes are
> declared and validated. Cross-link it with the Events concept, which readers
> will usually reach first.

**Scorer notes** — Minimum set: new page, Concepts hub, Events. Checks:
bidirectional link between Schemas and Events.

### A4 · Op 4 — Add the Go SDK
> Add a **"Go SDK"** page. Mirror how the existing SDK pages are laid out so the
> three read as a set, and make sure someone browsing SDKs will find it.

**Scorer notes** — Minimum set: new page + SDKs hub. Checks: structural parity
with `sdks/node-js` and `sdks/python` (install → client → create pipeline →
callout). Strong DS-conformance signal — the two siblings are a visible template.

### A5 · Op 5 — Add quotas & billing
> Add a **"Quotas & billing"** reference page covering plan tiers and what
> happens when an account exceeds its quota. Readers hitting rate limits should
> be able to get to it from where they already are.

**Scorer notes** — Minimum set: new page, API Reference hub, Rate limits &
errors. DS surface: `stat` for tier figures.

### A6 · Op 6 — Add a Recipes section
> Add a new **"Recipes"** section containing two pages: **"Backfill historical
> data"** and **"Fan-out to multiple destinations"**. Give the section its own
> landing page like the other sections have, and link it from Guides.

**Scorer notes** — Minimum set: 3 new pages + Guides hub. Checks: landing page
follows hub conventions (`hero` + `card` grid); both recipes reachable from it.
First operation creating a new section — tests whether section conventions are
inferred from existing sections rather than invented.

---

## Wave B — Reorganization (ops 7–12)

Renames and moves that change page addresses. This is where path-based and
identity-based referencing diverge. Every operation here targets pages with
substantial inbound links.

### B1 · Op 7 — Group the Getting Started pages
> The three Getting Started pages (Installation, Quickstart, Authentication)
> currently sit loose at the top level. Group them into a proper **Getting
> Started** section like Guides and SDKs have, with its own landing page.
> Everything that pointed at them should still work.

**Scorer notes** — Minimum set: 3 moved pages, new landing page, plus every page
holding an inbound link (computed from snapshot 6). Highest-risk operation in
the benchmark — three high-traffic pages change address simultaneously. Checks:
no dead paths; prev/next chain intact.

### B2 · Op 8 — Rename rate limits
> Rename **"Rate limits & errors"** to **"Limits, quotas & errors"** — it now
> covers quotas too. Update how it's referred to elsewhere on the site.

**Scorer notes** — Minimum set: the page + all inbound holders. Checks link
*text* as well as targets: a stale label pointing at a live page is not counted
in M1 but is recorded as a **stale-label** observation for the drill-down view.

### B3 · Op 9 — Rename the API section
> The API Reference section's address uses a plural abbreviation that doesn't
> match how the section is titled anywhere else. Rename the section so it reads
> as **`api`**, keeping every page inside it working.

**Scorer notes** — Minimum set: all 7 pages in the section + every inbound
holder site-wide. Broadest path change in the benchmark; the API section is the
most-linked-to area of the site.

### B4 · Op 10 — Rename the error-handling guide
> Rename the **"Handling errors & retries"** guide to **"Error handling &
> recovery"**, and make sure it's still referred to correctly everywhere.

**Scorer notes** — Minimum set: the page + inbound holders (a high-degree node —
concepts, API, three sibling guides, an SDK page, troubleshooting, glossary).
Checks: pagination chain intact.

### B5 · Op 11 — Group the version history
> Move **"Migration guide (v1 → v2)"** and **"Release notes archive"** into a
> shared **Versions** section, so version-history material lives in one place.

**Scorer notes** — Minimum set: 2 moved pages, new section landing page, inbound
holders. Checks: Changelog's relationship to both pages survives the move.

### B6 · Op 12 — Group the concept pages
> The Concepts detail pages sit at the top level rather than under the Concepts
> landing page, unlike every other section. Move them so the section is
> consistent with the rest of the site.

**Scorer notes** — Minimum set: 3–4 moved pages, Concepts hub, inbound holders.
`concepts-pipelines` is the single highest-inbound page at baseline. Compounds
with B1/B3 — by now the site has absorbed three structural moves.

---

## Wave C — Retirement & succession (ops 13–18)

Deletion, replacement, and merging: the hardest class. Content disappears or is
superseded, and every reference to it must land somewhere sensible.

### C1 · Op 13 — Supersede the pipelines endpoint
> A **v3** of the pipelines endpoint has shipped. Document v3 as the current
> version. Keep the v2 documentation available for readers still on it, but make
> it unmistakable that v3 is current — and make sure people land on v3 by
> default.

**Scorer notes** — Minimum set: new v3 page, old v2 page, API hub, inbound
holders. Checks: v2 remains reachable (not deleted); inbound references retarget
to v3; v2 carries a superseded notice. DS surface: `alert` (danger/warning),
`chip`. Tests succession rather than deletion — a stale-but-live reference is
the failure mode, and it is invisible to a naive link checker.

### C2 · Op 14 — Retire the support page
> The standalone **"Support / Contact"** page is redundant — its contact
> channels belong with the troubleshooting material readers are already in.
> Fold the content into **"Troubleshooting / FAQ"** and remove the standalone
> page.

**Scorer notes** — Minimum set: Troubleshooting, deleted page, inbound holders
(security page, others). Checks: contact channels present in Troubleshooting;
**zero dangling references to the removed page** — the canonical B1 test.

### C3 · Op 15 — Merge the glossary
> Fold the **Glossary** into the Concepts landing page as a definitions section,
> and remove the standalone Glossary page. Its definitions link out to the full
> explanations and those links should survive the move.

**Scorer notes** — Minimum set: Concepts hub, deleted page, inbound holders.
Checks: all seven definitions survive with outbound links intact — the glossary
is the most link-dense single page on the site, so this operation moves a large
sub-graph in one step.

### C4 · Op 16 — Split limits and errors
> **"Limits, quotas & errors"** has grown into two unrelated topics. Split it
> into a **"Rate limits"** page and an **"Error reference"** page. Anything that
> linked to the combined page should point at whichever half it actually meant.

**Scorer notes** — Minimum set: 2 new pages, deleted page, inbound holders.
Checks: **semantic retarget correctness** — inbound links are classified by the
context they appear in (a 429/backoff mention → Rate limits; an error-shape or
`code` mention → Error reference). Blanket-pointing everything at one half
scores as correct under M1 but is recorded as a mis-retarget in the drill-down.
The subtlest operation in the list.

### C5 · Op 17 — Deprecate the release archive
> The **Release notes archive** covers a retired version and shouldn't be a
> destination any more. Point readers at the Changelog instead, but leave
> something behind for anyone landing on the old address from an external link.

**Scorer notes** — Minimum set: archive page, Changelog, inbound holders.
Checks: page still resolves (stub, not deleted); carries a forward pointer;
internal references retargeted to Changelog.

### C6 · Op 18 — Supersede the events endpoint
> A **v3** of the events endpoint has shipped and v2 is being withdrawn
> entirely. Document v3, remove v2, and make sure the migration material
> reflects the change for anyone still moving over.

**Scorer notes** — Minimum set: new v3 page, deleted v2 page, migration guide,
API hub, inbound holders. Contrast with C1 — hard removal, not succession.
Checks: migration guide documents the change; zero dangling references.

---

## Wave D — Enrichment (ops 19–24)

Content additions where the design system already offers the right component.
Each operation is style-fork bait: the shortcut is to hand-roll markup, the
correct move is to use the existing component. Little path risk — this wave is
about M2, and it is where the arms should be most comparable if the design
system is merely *documented* rather than *enforced*.

### D1 · Op 19 — Connector comparison table
> The **Connectors** concept page has a table of built-in connectors. Readers
> also need to know which connectors support incremental reads. Add that
> information to the existing table rather than adding a second one.

**Scorer notes** — Minimum set: 1 page. DS surface: `parameter-table`.
Reworded 2026-08-20, before any trial run: the original wording ("add a
comparison table") was ambiguous because the page already carries a connector
table, leaving the model to guess between adding a second table and extending
the first. Now tests correct *extension* of an existing component; component
adoption from scratch is still tested by D3 (`code-block`), D5 (`stat`), and
D6 (`docs-toc`).

### D2 · Op 20 — SDK breaking-change notice
> A breaking change is coming in the next major SDK release. Add a prominent
> notice about it to **every** SDK page.

**Scorer notes** — Minimum set: 3–4 SDK pages. DS surface: `alert` with a valid
variant. Checks: **notice is consistent across all SDK pages** — divergent
wording or styling between siblings is recorded even when each is individually
valid. Invalid variant → H3 (the silent-fallback case).

### D3 · Op 21 — Go examples
> Now that a Go SDK exists, add Go code examples alongside the existing examples
> on **Quickstart**, **Authentication**, and **Building your first pipeline**.

**Scorer notes** — Minimum set: 3 pages. DS surface: `code-block` with correct
`language`/`filename`. Bare `<pre>` → H7.

### D4 · Op 22 — Stability badges
> Give every API Reference page a visible stability indicator — **Stable**,
> **Beta**, or **Deprecated** — so readers can tell at a glance what they're
> relying on.

**Scorer notes** — Minimum set: all pages in the API section. DS surface: `chip`.
Checks: variant values valid (H3); superseded pages from C1/C6 marked
Deprecated — cross-wave consistency.

### D5 · Op 23 — Rate-limit figures
> Surface the key rate-limit numbers on the **Rate limits** page so they're
> visible without reading the prose.

**Scorer notes** — Minimum set: 1 page (created in C4 — an operation acting on a
page that did not exist at baseline). DS surface: `stat`.

### D6 · Op 24 — Guide tables of contents
> The three longest guides are hard to scan. Add an on-page table of contents to
> each so readers can jump to the section they need.

**Scorer notes** — Minimum set: 3 pages. DS surface: `docs-toc`. Checks:
**every TOC entry resolves to a real heading anchor on its own page** — the
primary B2 (dead-fragment) test in the benchmark.

---

## Wave E — Consolidation & audit (ops 25–30)

Cross-cutting edits over a site that has now absorbed 24 operations of change.
This wave measures whether a model can act coherently on an already-drifted
site — and, at the end, whether it can find and repair drift it did not create.

### E1 · Op 25 — Reorder the guides
> Reorder the guides so **"Error handling & recovery"** comes before
> **"Scheduling & triggers"** — readers need error handling earlier. The
> guide-to-guide navigation should follow the new order.

**Scorer notes** — Minimum set: 4 guides + Guides hub. Checks: prev/next chain
fully consistent in both directions, no orphaned or cyclic links. Chain has been
modified by A1 and B4 already.

### E2 · Op 26 — Link concepts to endpoints
> Every concept has a matching API Reference page and vice versa, but the
> connection isn't always made. Make sure a reader on either can get to the
> other.

**Scorer notes** — Minimum set: ~8–10 pages across both sections. Checks:
bidirectional links for every matched pair; pairs must reflect C1/C6
succession — linking to a withdrawn v2 endpoint is a failure.

### E3 · Op 27 — Note v3 availability
> Two endpoints now have a v3. Anywhere the site still talks about v2 as though
> it's current, make it clear v3 exists.

**Scorer notes** — Minimum set: variable; the scorer computes pages containing
v2 references at snapshot 26. Checks: recall (how many stale mentions were
found) and precision (no spurious edits to legitimately historical v2 mentions
in the migration guide or changelog). **Rewriting historical version references
is a failure, not a success** — this operation rewards discrimination, not
find-and-replace.

### E4 · Op 28 — De-duplicate setup instructions
> **Installation** and **Quickstart** repeat the same setup steps. Keep one
> authoritative copy and have the other point to it.

**Scorer notes** — Minimum set: 2 pages. Checks: content appears once; the other
page links to it; neither becomes incoherent standalone.

### E5 · Op 29 — Review stamps
> Add a **"Last reviewed: 2026-09-01"** line to every page in the API Reference
> section, formatted consistently.

**Scorer notes** — Minimum set: all API section pages. Checks: **coverage**
(every page, including pages created in A2/A5 and superseded in C1/C6) and
**format consistency** across pages. Deliberately mechanical — near-zero
reasoning load, so a miss here is a thoroughness failure, not a capability one.

### E6 · Op 30 — Reachability audit
> Do a final pass over the site: every page should be reachable from the
> homepage within three clicks, and every link should go somewhere real. Fix
> whatever isn't.

**Scorer notes** — Minimum set: unbounded. **The capstone.** Scored differently
from every other operation: measured as *repair rate* against accumulated damage
— `BR(29) − BR(30)`, `Orphans(29) − Orphans(30)`, `Unreachable(29) −
Unreachable(30)`. Blast radius is not penalized here; wide edits are the
correct response.

This operation answers the question the whole benchmark exists to ask: **can
the model find drift it cannot remember creating?** Each of the previous 29
sessions is gone; only the substrate carries the evidence. A governed substrate
can be interrogated for dangling references; a directory of HTML files must be
crawled and inferred. Op 30 is where that difference either shows up or doesn't.

---

## Coverage summary

| Wave | Ops | Primary metric under test | Path churn |
|---|---|---|---|
| A — Growth | 1–6 | M6 orphans, M2 forks | none |
| B — Reorganization | 7–12 | **M1 broken refs** | high |
| C — Retirement | 13–18 | **M1**, succession correctness | high |
| D — Enrichment | 19–24 | **M2 style forks**, M1 fragments | none |
| E — Consolidation | 25–30 | M1 repair, M5 blast radius, M6 | low |

M3 (tokens), M4 (chrome divergence), and M7 (completion) are measured
continuously across all thirty operations.
