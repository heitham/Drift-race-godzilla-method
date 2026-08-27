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

### What it found — RIFT vs Payload 3.88

Same 18 intents, same site, `gemini-3.7-flash`, 2 passes each, 72 sessions.

| | RIFT | Payload |
|---|---|---|
| tool schema sent on **every** call | 15 tools, **2,364 tok** | 20 tools, **12,583 tok** |
| supported in every pass | **14/18** | 11/18 |
| **same outcome in every pass** | **17/18** | **9/18** |
| silent misses | **0/36** | 2/36 |
| shortfalls disclosed | **7/7** | 6/11 |
| tool calls that errored | **0.0%** | 2.5% |
| median tokens per intent | **48.5k** | 356k |
| median seconds per intent | **11** | 25 |
| whole column | 12.5 min · $2.92 | 25.8 min · $6.66 |

The headline is not the pass rate, it is the **reproducibility**. RIFT gave the same answer
twice on 17 of 18 intents; Payload on 9. Payload sometimes moved a page and sometimes reported
moving a page without doing it. A missing feature can be planned around; a coin flip is
discovered in production.

The mechanism is visible in the token column. Payload's `updatePages` inlines the entire
Lexical document shape into its tool signature, so every semantic operation becomes fetch the
whole document, reason over it, rebuild it, resubmit it. Renaming a page took RIFT 6 turns and
Payload 18; moving one took 8 turns against 30. The gap is widest exactly where a fragment-level
tool should win — **editing a sentence is 14× cheaper on RIFT** — and narrowest on whole-page
creation, where both must send a whole document anyway.

**Where Payload wins, and it is worth knowing.** The inbound-link query (D3) is *cheaper on
Payload* despite Payload having no link graph at all — inline links are ids buried inside a
JSON blob. Its agent simply fetched every page and scanned them, consistently. RIFT's agent has
tools that look like they should answer the question, goes hunting, and on one pass spent 24
turns and 1.45M tokens getting there. A richer surface made things worse.

**Both products share one gap.** Both have full version history in the database; neither
exposes it to MCP, so both agents correctly reported they could not roll back or show an edit
history. That is a category finding about MCP-native CMSes rather than a mark against either.

```bash
npm run reset                        # restore the CMS to the frozen baseline
npx tsx probe/export-site.ts         # fixture — only ever from a freshly reset site
npx tsx probe/rift.ts                # one pass
npm run reset && npx tsx probe/rift.ts --append   # second pass
npx tsx probe/compare.ts             # the paired table
```

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

  Each is documented in the commit that fixed it. If you find an eleventh, that is the point of
  publishing this.

---

## Adding another substrate

**Drift race.** The arms are pluggable. `harness/run/arms/types.ts` defines the interface —
setup, tool surface, tool execution, snapshot, teardown — and `raw.ts` and `governed.ts` are the
two implementations. A third CMS needs one file and an entry in the benchmark config. The
operation list, the scorer and the assertions are substrate-blind: they read published HTML and
never learn which arm produced it.

**Affordance probe.** Copy `probe/payload.ts`. A column is roughly three things: an RPC call
into that vendor's MCP, a seed that builds `probe/fixtures/site.json` in it, and the
postcondition reads against its own store. The intents, the outcome classes and the roll-ups are
shared, so the comparison cannot drift between columns.
