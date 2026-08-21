# The Drift Race — benchmark harness

Measures what happens to a website when an AI agent edits it thirty times in a row, and
whether the substrate the agent writes into changes the outcome.

The hypothesis: **structure is a property of the content substrate, not the agent.** The same
model, given the same instructions, should degrade a folder of HTML files and leave a governed
CMS intact — because in one case a link is a literal path and in the other it is a reference.

- **Findings:** [riftcms.com/drift-race](https://www.riftcms.com/drift-race)
- **The site under test, with every run's output:** [github.com/heitham/godzilladocs](https://github.com/heitham/godzilladocs)

This repository is the instrument: the runner, the frozen operation list, the scorer, and the
full results.

---

## What it does

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

---

## Running it

```bash
npm install
cp .env.example .env.local          # then fill it in

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

---

## Reading the results

`results/<run-id>/timeline.json` holds one row per operation: the metrics, the token spend,
the assertion outcome, and the commit sha of the resulting snapshot. That sha is how you get
from a number back to the site it came from.

`npm run compare` refuses to compare two runs of the same arm, or two different models —
with n=1 per cell a cross-model table would look every bit as authoritative while meaning
nothing.

---

## Honesty notes

These are in the methodology in full; the short version belongs here too.

- **n is small.** One raw run, two governed runs, one model, one site. Directional; no
  statistical significance is claimed anywhere.
- **RIFT changed during the study.** The benchmark exposed real gaps in it — unvalidated
  links, no way to create a section, no way to move a published page, ghost files left at
  vacated paths — and each was fixed mid-study. Every such move is recorded in
  `benchmark.config.json` under `pinHistory`, with the date, the reason, and whether the
  render path was affected. Part of the governed arm's result is a write-time validator that
  did not exist when the first run started.
- **The treatment is confounded by design.** The governed arm differs from the raw arm in
  several ways at once. The benchmark can say *substrate* matters; it cannot attribute the
  effect to any single mechanism. A third arm — raw files plus a static-site generator —
  would separate templating from governance, and is the most valuable experiment not yet run.
- **We got one prediction backwards.** The published hypothesis expected the governed arm to
  reduce style forks. It tripled them. That result is reported.
- **The measurement had bugs, and finding them is most of the work.** Five defects in the
  harness and scorer were found and fixed while running this — a scorer counting the CMS's own
  breadcrumbs as if a model had hand-written them, snapshots landing one operation out of
  step, an empty commit scoring as completed work. Each is documented in the commit that fixed
  it. If you find a sixth, that is the point of publishing this.

---

## Adding another substrate

The arms are pluggable. `harness/run/arms/types.ts` defines the interface — setup, tool
surface, tool execution, snapshot, teardown — and `raw.ts` and `governed.ts` are the two
implementations. A third CMS needs one file and an entry in the benchmark config.

The operation list, the scorer, and the assertions are substrate-blind: they read published
HTML and never learn which arm produced it.
