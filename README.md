# Substrate benchmarks — how much structure does the CMS supply?

Two instruments, one question: **is structure a property of the content substrate, or of the
agent writing into it?**

The same model, given the same work, should behave differently depending on what it writes
through — because in one substrate a link is a literal path and in another it is a reference,
and because one surface offers "move this page" while another offers only "replace this
document".

| | [The Drift Race](#instrument-1--the-drift-race) | [The Affordance Probe](#instrument-2--the-affordance-probe) |
|---|---|---|
| Asks | what happens to a site after thirty edits? | what can an agent actually *do* through this CMS? |
| Measures | published HTML | the MCP surface and the CMS's own state |
| Unit | a paired run, raw vs governed | one intent, one fresh session |
| Cost to add a vendor | weeks | hours |

- **Findings:** [riftcms.com/drift-race](https://www.riftcms.com/drift-race)
- **The site under test, with every drift-race run's output:** [github.com/heitham/godzilladocs](https://github.com/heitham/godzilladocs)

This repository is the instrument: the runners, the frozen operation list, the intents, the
scorers, and the full results.

---

# Instrument 1 — The Drift Race

Thirty content operations — written and frozen *before any trial* — are issued one at a time
to a model, in **fresh sessions with no memory of previous operations**. That is deliberate: a
real site changes hands over months, it is not maintained by one continuous mind that remembers
everything it did.

The operations trace a plausible year: pages added, sections reorganised and renamed, pages
retired and superseded, content enriched, then a consolidation pass.

Two arms receive identical instructions:

| | Raw arm | Governed arm |
|---|---|---|
| Reads | `list_files`, `read_file`, `search` | `list_folders`, `search_content`, `get_item` |
| Writes | `write_file`, `move_file`, `delete_file` | `create_item`, `update_item`, `move_item`, `create_folder` |
| Publishes | harness commits for it | harness reviews and the CMS publishes |
| Links are | literal paths | references resolved at publish |
| Chrome is | duplicated in every file | generated from one source |

After every operation the whole published site is crawled and audited from scratch — not
diffed against the previous version. A fault introduced at operation twelve and never fixed is
still counted at operation thirty.

### What is measured

| | |
|---|---|
| **M1** | Broken internal references — dead paths, dead fragments, missing assets |
| **M2** | Style forks — styling that escapes the design system (seven hard rules) |
| **M3** | Token cost, including reasoning tokens |
| **M4** | Chrome divergence — header/footer/nav variants within a section |
| **M5** | Blast radius — pages disturbed per operation |
| **M6** | Orphans and reachability |
| **M7** | Operation completion, **and whether the requested structure actually exists** |

That last clause matters more than it looks. An arm that quietly skips an operation damages
nothing and would otherwise score beautifully. Each operation therefore carries assertions
written from its own instruction — a page that was supposed to move is confirmed moved — so
an arm cannot look good by doing nothing. See `benchmarks/*/assertions.json`.

### What it found

The strong hypothesis did not survive. Claude Haiku 4.5 degraded the raw site badly and kept
the governed site intact. **Gemini 3.7 Flash kept both intact** — by spending 75M tokens to do
it. What replicated exactly across both models was cost: **the governed arm used 39% fewer
tokens in both pairs.** The revised claim is narrower and better supported — the substrate is a
capability equalizer that makes correctness cheap and model-independent, rather than a
prerequisite for correctness.

```bash
npm run reset                       # restore the CMS to the frozen baseline
npm run bench -- --model claude-haiku-4-5-20251001 --arm governed
npm run bench -- --model claude-haiku-4-5-20251001 --arm raw
npm run score:run results/<run-id>  # audit every snapshot
npm run compare results/<raw-run> results/<governed-run>
```

Scoring never contacts a model. It reads published HTML, so it is free and can be re-run
whenever a metric definition changes — which is why scorer bugs are cheap here and harness
bugs are not.

```bash
npm run test:scoring                # 24 fixture tests over the scorer
```

`results/<run-id>/timeline.json` holds one row per operation: the metrics, the token spend, the
assertion outcome, and the commit sha of the resulting snapshot. That sha is how you get from a
number back to the site it came from.

`npm run compare` refuses to compare two runs of the same arm, or two different models — with
n=1 per cell a cross-model table would look every bit as authoritative while meaning nothing.

---

# Instrument 2 — The Affordance Probe

The drift race is expensive: thirty operations, a publish pipeline, a rendered site to crawl.
Porting it to a fourth vendor is weeks of work. The affordance probe asks a cheaper and in some
ways more direct question — **what can an agent do through this CMS's MCP surface at all?** —
and answers it in hours per vendor.

Eighteen intents, each a fresh session, each followed by a postcondition **checked against the
CMS's own state** rather than against what the agent said it did. Nothing is published and no
HTML is scored, which is why it needs no port, no publish pipeline and no parity gate.

Every column seeds from `probe/fixtures/site.json` — exported once from the RIFT benchmark site
and vendor-neutral — so the site is identical across substrates **by construction**, not by
inspection. 30 pages, 119 links, 3 sections.

### The intents

| | asks the agent to | expects |
|---|---|---|
| **D1–D3** | find a page by topic · list every section · **name which pages link to a given page** | supported |
| **C1–C2** | create a page in a section · create a section with its own landing page | supported |
| **E1–E2** | add one sentence to a paragraph · add a link between two pages | supported |
| **R1–R4** | rename a page · move a page between sections · **split one page into two and repoint inbound links** · fold one page into another | supported |
| **X1–X2** | retire a page and send readers to its successor · **permanently delete a page** | supported · refused |
| **B1** | add a line to *every* page in a section | supported |
| **G1–G3** | publish to production without review · revert a page · show a page's edit history | refused · unknown |
| **F1** | create a page whose body must survive `<config>`, `{{braces}}`, `&` and quotes verbatim | supported |

### Outcome classes

The classes matter more than the pass rate. A refusal an agent can read is a much smaller
problem than a success it cannot verify.

| | |
|---|---|
| `supported` | postcondition met |
| `supported-after-refusal` | met, but only after at least one rejected tool call |
| `substituted-disclosed` | did something weaker **and said so** |
| `unsupported-disclosed` | could not, **and said so** |
| `permitted-no-guardrail` | the intent expected a refusal, the surface allowed it, the agent reported accurately |
| `refused` | the surface returned an error and the agent did not recover |
| `silent-miss` | **postcondition not met and the agent reported success** |

`permitted-no-guardrail` exists because an earlier version folded it into `silent-miss`. That
scored one vendor's governance policy as the definition of correct behaviour and branded an
honest surface dishonest. A hard delete offered and performed on request is a policy
difference, not a defect.

### How a result is verified

Two thirds of the intents are checked against the CMS's **own store**, read directly and never
through the surface under test: raw SQL for RIFT and Payload, GROQ over the HTTP API for Sanity.
An agent that says it moved a page and left `parent_id` unchanged scores `silent-miss`. The
remaining third is stated plainly rather than dressed up:

| checked against | intents | |
|---|---|---|
| CMS state | 12/18 | the store, independently |
| the agent's own answer | 3/18 — D1–D3 | the answer *is* the deliverable; there is no state change to verify |
| nothing | 3/18 — G1–G3 | no postcondition; classified from the transcript and reported as `no-postcondition` |

`probe/substance.ts` adds a word floor on pages an instruction asked the agent to write, so an
agent cannot pass by splitting a page into two headings. The floors are low and assert only
what each instruction implies.

### What it found — RIFT vs Payload 3.88 vs Sanity

Same 18 intents, same site, same model, 2 passes each. Sanity is **hosted**, so its seconds
include network round-trips and are not comparable; tokens and turns are.

| on `claude-sonnet-5` | RIFT | Payload | Sanity |
|---|---|---|---|
| tool schema sent on **every** call | **2,889** | 12,583 | 12,581 |
| supported in every pass | **14/18** | 12/18 | 12/18 |
| **same outcome in every pass** | **18/18** | 14/18 | 14/18 |
| silent misses | **0/36** | 1/36 | **0/36** |
| median tokens per intent | **29.9k** | 82.0k | 104.0k |
| of which tool surface | 11.6k | 37.7k | 62.9k |
| **of which actual work** | **18.3k** | 44.3k | 41.1k |
| whole column | $3.05 | $6.77 | $4.15 |

The headline is not the pass rate, it is the **reproducibility**. RIFT gave the same answer
twice on every intent. On `gemini-3.7-flash` the same comparison is 18/18 against Payload's
10/18 — so a stronger model closes about half the gap and does not remove it. A missing feature
can be planned around; a coin flip is discovered in production.

**Surface cost is reported separately from work cost**, because a column carrying a large tool
list is otherwise penalised for something that says nothing about how well it edits. Sanity
ships 38 tools of which nine are content operations, so most of its total is schema it never
uses. Its *work* cost is close to Payload's, and both are roughly 2.2× RIFT's. Filtering the
surface to a content subset would have measured a product nobody can buy; splitting the number
answers the same question without anyone guessing which tools "count".

**Sanity was chosen to test the mechanism, not to add a third demo.** It shares RIFT's
architecture — fragment-level patch mutations, first-class typed references — where Payload
round-trips a whole Lexical document. If the mechanism were the whole story Sanity should have
landed near RIFT. It did not, so fragment-level editing is necessary and not sufficient, and
this benchmark cannot yet say what the rest is.

**Where each one breaks is more useful than the totals.** Sanity has no retire or archive
concept, so its agent improvises: 10 turns to retire a page, 12 to fail at a rollback. RIFT
refuses a hard delete in **1 turn and 4.9k tokens** because the constraint is legible in the
tool description; Sanity spends 242k discovering it. A constraint an agent can read costs
around fifty times less than one it has to find out by trying.

**Payload wins one cell and it is worth knowing.** The inbound-link query was *cheaper on
Payload* than on pre-`get_inbound_links` RIFT, despite Payload having no link graph at all —
its agent fetched every page and scanned them, consistently, while RIFT's went hunting through
tools that looked like they should answer and once spent 1.45M tokens getting there.

**All three shared one gap.** Every product has version history in its database; none exposed
it to MCP, so every agent correctly reported it could not roll back. That is a category finding
about MCP-native CMSes rather than a mark against any of them.

### A change this benchmark prompted, and then measured

RIFT shipped `get_inbound_links` after the first column named the gap. Re-measured on the same
model, the inbound-link query fell from **739,252 tokens to 13,008** — 57× — and the column's
reproducibility went to 18/18. Both pins are kept (`rift-b8461b8-gemini.json` against
`rift.json`) so the before/after is checkable rather than asserted.

```bash
npm run reset                        # restore the CMS to the frozen baseline
npx tsx probe/export-site.ts         # fixture — only ever from a freshly reset site
npx tsx probe/rift.ts --model claude-sonnet-5
npm run reset && npx tsx probe/rift.ts --model claude-sonnet-5 --append
npx tsx probe/matrix.ts              # substrate x model, with the surface/work split
```

`--tag <name>` files a side experiment beside a column instead of over it, and `--max-tokens`
overrides the per-response output ceiling so that choice can be tested rather than assumed.
Every column records the model, the ceiling and — for RIFT — the CMS pin it ran against.

Passes are driven from the shell with a reset between them, and every session is flushed to
disk as it completes — a crash between the last intent and the write discarded a finished pass
once. A pass whose site was not reset is stamped `freshSite: false` and excluded from the
comparison rather than footnoted in it.

---

## Honesty notes

These are in the methodology in full; the short version belongs here too.

- **n is small.** One raw run, two governed runs and one model for the drift race; two passes
  per cell for the probe. Directional; no statistical significance is claimed anywhere.
- **RIFT changed during the study.** The benchmark exposed real gaps in it — unvalidated links,
  no way to create a section, no way to move a published page, ghost files left at vacated
  paths — and each was fixed mid-study. Every such move is recorded in `benchmark.config.json`
  under `pinHistory`, with the date, the reason, and whether the render path was affected. Part
  of the governed arm's result is a write-time validator that did not exist when the first run
  started.
- **The drift race's treatment is confounded by design.** The governed arm differs from the raw
  arm in several ways at once. It can say *substrate* matters; it cannot attribute the effect to
  any single mechanism. A third arm — raw files plus a static-site generator — would separate
  templating from governance, and is the most valuable experiment not yet run.
- **We got one prediction backwards.** The published hypothesis expected the governed arm to
  reduce style forks. It tripled them. That result is reported.
- **Payload was configured to its own best advantage.** Its website template ships Pages as a
  flat collection with no parent/child at all. The probe asks an agent to create a section and
  move a page between sections, so Pages were added to Payload's own first-party `nested-docs`
  plugin — one line of config, and Payload's documented answer to hierarchy. Running against
  flat pages would have measured a handicap we imposed. Every collection is likewise exposed at
  full CRUD.
- **The output ceiling is 8,000 tokens per response, and it was tested rather than assumed.**
  Sanity's split-page truncated against it. The worst single turn in any RIFT column used 1,229
  tokens, so RIFT cannot have been shaped by it; Payload's split-page re-run at 32,000 keeps the
  same outcome while costing two to six times MORE, because given more room the agent attempts
  larger single-shot writes and retries after validation failures. Only Sanity's split-page
  needs restating, at 522k tokens rather than the 358k a truncated run implied.
- **Sanity is hosted.** Its wall-clock includes network round-trips and is not comparable to the
  local columns; tokens and turns are. Its results carry `hosted: true`.
- **Two harness-side distortions affect the Payload column.** Gemini's function-declaration
  schema has no `anyOf`, so Payload's union schemas are merged into one permissive object; and
  Gemini rejects an empty-string enum member, which Lexical uses as its no-format sentinel, so
  that `enum` constraint is dropped rather than the member. Both are mechanical projections
  applied identically to every substrate, and both are lossy in the direction of permitting too
  much.
- **The measurement had bugs, and finding them is most of the work.** Ten defects in the
  harness and scorers were found and fixed while running this. The three worth naming, because
  each would have been published as a vendor result:
  - The scorer counted the CMS's own injected breadcrumbs as if a model had hand-written them —
    and because breadcrumbs only appear on pages two levels deep, the bias ran *against* the arm
    that had correctly built sections.
  - `toGeminiSchema` collapsed a union to its **first branch**, so Payload's agent was shown one
    block type and never saw the one holding page bodies. Three intents failed validation and
    the column read "Payload cannot edit page bodies over MCP", which is false. Fixing it
    flipped four cells to supported.
  - Two columns ran against **different sites**, and one difference was live: RIFT's Changelog
    already carried the link intent E2 asks an agent to add, so RIFT would have scored
    `supported` for work it never performed. Hence the shared fixture.

  - The substance gate stripped `{{…}}` reference syntax wholesale, which deletes the prose RIFT
    stores inside design-system component parameters. A page carrying a code block, an alert with
    real explanatory copy and a table of contents counted as **four words**; corrected, it counts
    54. That one cut against us, as two of the others did.

  Each is documented in the commit that fixed it. If you find a twelfth, that is the point of
  publishing this.

---

## Adding another substrate

**Drift race.** The arms are pluggable. `harness/run/arms/types.ts` defines the interface —
setup, tool surface, tool execution, snapshot, teardown — and `raw.ts` and `governed.ts` are the
two implementations. A third CMS needs one file and an entry in the benchmark config. The
operation list, the scorer and the assertions are substrate-blind: they read published HTML and
never learn which arm produced it.

**Affordance probe.** Copy `probe/payload.ts` (local) or `probe/sanity.ts` (hosted, session-based
transport). A column is roughly three things: an RPC call into that vendor's MCP, a seed that
builds `probe/fixtures/site.json` in it, and postcondition reads against its own store. The
intents, the outcome classes, the disclosure detector and the roll-ups are shared, so the
comparison cannot drift between columns. Sanity took about a day end to end, most of it setup
rather than measurement.

## What is NOT measured

Both instruments score an **agent**. Neither scores the hour a human spends setting the product
up, and that may matter more to a buyer than anything here. Recorded as a limitation rather than
left for a reader to notice.
