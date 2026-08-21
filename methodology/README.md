# Methodology

Full protocol for the RIFT Drift Race Benchmark. The frozen operation list lives
in [`operations.md`](operations.md); this document defines the experiment, the
metrics, the scoring procedure, and the data contract the dashboard reads.

**Status:** v1 protocol frozen 2026-08-20. No trials run yet.

---

## 1. Hypothesis

Structure is a property of the content substrate, not the agent.

The same model, given an identical sequence of content operations, accumulates
less structural drift when working through a governed layer (UUID-based link
graph, design-system contract, single-source chrome, change-set review) than
when editing raw HTML files directly.

**Drift** is operationalized as three measurable end-states: references that no
longer resolve, styling that escapes the design system, and chrome that
diverges page-to-page.

## 2. What this benchmark does and does not claim

This section exists to preempt the obvious critique, because the critique is
partly correct and should be stated by us first.

**Claimed:** a governed substrate reduces accumulated drift under repeated,
memoryless editing by the same model.

**Not claimed:** that any model is better than another; that RIFT is better than
every alternative substrate; that these numbers generalize beyond documentation
sites.

**The asymmetry is the treatment, not a confound.** The governed arm has
affordances the raw arm does not — UUID references that survive renames, chrome
injected from one source, a design system the substrate can enumerate. That
*is* the independent variable. A reader who objects "but the CMS arm had help"
has restated the hypothesis, not refuted it.

**The asymmetry we do control for is knowledge.** Both arms are told the same
rules and given the same reference material (§5.3). We are testing whether the
substrate *enforces* structure, not whether the model *knew about* it.

**The comparison is against raw HTML files, not against a static-site
generator.** An SSG with shared layouts would eliminate chrome divergence (M4)
by construction and would partially mitigate path fragility. We test raw files
because that is the honest floor case and because it isolates the mechanism.
Extending the raw arm to an SSG is the most valuable follow-up study and is
named here as a known boundary, not discovered later as a flaw.

## 3. Design

- **Paired same-model runs.** Each model executes the same 30 operations twice —
  once against raw files, once through RIFT's MCP. Substrate is the only
  variable that changes between a model's two runs.
- **Roster (v1):** Claude Haiku 4.5, Claude Sonnet 4.6, Claude Sonnet 5,
  Gemini 3.5 Flash, Gemini 3.7 Flash. Exact model IDs and the reasoning
  configuration are pinned in `benchmarks/godzilla-docs/benchmark.config.json`.
- **Roster substitution (recorded, not silently dropped):** Gemini 3.1 Pro was
  in the planned roster. The available API key returns 429 for *every* Pro-tier
  model, including `gemini-pro-latest`, so this is a plan-tier limitation and no
  Gemini Pro run is possible. Gemini 3.5 Flash was substituted. The honest
  consequence: capability range is tested only on the Claude side (Haiku 4.5 →
  Sonnet 5), and the Gemini pair now tests cross-vendor generalization rather
  than cross-capability. If Pro access is obtained later it should be added as a
  sixth model, not swapped in.
- **Reasoning effort:** enabled and held constant across both arms of every
  model, so effort is not confounded with the token-cost metric. See M3 for why
  cross-provider effort equivalence is neither achievable nor required.
- **Trials:** 1 run per (model × arm) = 10 runs, 300 model sessions total.
- **Memorylessness:** every operation runs in a fresh session with no history of
  prior operations, in both arms. This simulates "months of changing hands"
  rather than one continuous engagement, and it is the condition under which
  substrate matters most.

## 4. The substrate under test

Both arms start from byte-identical published output: the 30-page **Godzilla
Docs** site (fictional data-pipeline platform), built in RIFT and published to
`github.com/heitham/godzilladocs`.

- **Baseline commit:** `main` branch at the initial production publish.
- **Structure:** 15 root pages, plus `guides/` (6), `apis/` (6), `sdks/` (3).
- **Design system:** "Godzilla" v1.0.0 — 33 tokens, 14 components, of which
  `header`, `footer`, `left_nav`, `main_nav`, `breadcrumb` are chrome
  (injected at publish) and the rest are content components.
- **Link graph at baseline:** dense and intentional. High-inbound-degree pages
  (`concepts-pipelines`, `apis/webhooks`, `guides/handling-errors-and-retries`,
  each ~9–11 inbound) are deliberately targeted by the rename and retirement
  operations in Waves B and C.

### 4.0 What the substrate enforces, and the pin that holds it still

RIFT is pinned by commit sha and the runner refuses to start on a mismatch,
because a changed renderer breaks comparability **silently** — both versions
emit valid-looking HTML. The pin moved once, deliberately, before any valid run
existed: `40b1b708` → `01207e8c`, RIFT's Phase 43 link governance. The Haiku
pilot had traced the governed arm's loss on M1 to a gap in the CMS rather than
to the model, the content or the scorer, and freezing a defect in place would
have measured the wrong thing on purpose.

Since that commit, `create_item` / `update_item` **reject** three classes of
body that previously stored and published in silence:

| Code | Trigger |
|---|---|
| `UNMANAGED_INTERNAL_LINK` | a raw path where a managed reference exists — the error names the exact `{{cms:item/<uuid>}}` |
| `MALFORMED_HREF` | an href carrying an extra layer of quoting (`href=\"#list\"`) |
| `DEAD_MANAGED_REF` | a reference to an item that does not exist |

Rejection, not normalization. The model sees the error and has to respond to
it, so what the benchmark measures is a substrate *enforcing* — not one quietly
repairing behind the model's back, which would flatter the governed arm without
telling us anything about how structure is actually maintained.

**The rule that keeps future CMS work safe:** write-path changes (validation,
tool behavior, link-graph maintenance, API routes) may land at any time — they
change what content enters the CMS, which is the treatment under study.
**Render-path changes** (`renderer.ts`, `publish.ts`, `discoveryFiles.ts`,
`gitPublisher.ts`, `succession.ts`, `navResolver.ts`, design-system CSS or
component templates) invalidate every completed run and must be coordinated.
The test is: *does identical stored content produce different published HTML?*
Phase 43 was verified against that test by static reachability over the publish
path — `renderer.ts` imports only `node:crypto`, and the one render-adjacent
file that changed, `linkParser.ts`, is imported by no module the publisher
touches.

### 4.1 A tool that would have invalidated the benchmark

RIFT exposes **two** agentic surfaces over MCP, and only one of them is a
substrate. The distinction is not cosmetic — using the wrong one would have
produced a result that looked valid and measured nothing.

| Surface | Who authors the content |
|---|---|
| **Granular tools** — `get_item`, `create_item`, `update_item`, `open_change_set`, `propose_change_set`, … | **The MCP caller** — the model under test. Verified: the tool module imports no AI service; these are CRUD operations. |
| **`request_content_change`** | **RIFT's own internal agent**, which reaches `invokeAi` and runs on the CMS's separately-configured model. |

**`request_content_change` is excluded from the governed arm's tool set.** Had
it been available, the governed arm's content would have been written by RIFT's
internal agent rather than by the model under test: all five models would have
produced near-identical governed output, the model under test would appear
nowhere in its own governed run, and the paired comparison — the entire
experiment — would collapse while still yielding plausible-looking numbers.

**This exclusion is capability parity, not handicapping.** The raw arm's tools
are primitives (read, write, move, delete); the governed arm's granular tools
are the same primitives through a governed interface. `request_content_change`
is not a primitive — it is *delegate the whole task to a different model*, and
it has no raw-arm equivalent. Offering it on one side only is exactly the
confound §5.3 exists to control.

The publisher invoked by `propose_change_set` contains no AI, so snapshots are
unaffected either way.

**A legitimate future third arm.** "Does RIFT's purpose-built agent beat a
general model driving granular tools?" is a real question — just a different
one. It fits the N-arm adapter interface directly, and would need its own cost
accounting, since it spends the CMS's AI budget rather than the benchmark's.

### 4.2 Arm definitions

| | **Raw arm** | **Governed arm** |
|---|---|---|
| Working copy | Git clone of `main`, one directory per run | RIFT site clone, one per run |
| Read | `list_files`, `read_file`, `grep` | `list_folders`, `search_content`, `get_item` |
| Write | `write_file` | `create_item`, `update_item` |
| Commit | `git commit` after each op | `open_change_set` → `propose_change_set` |
| Who commits | The harness, on the model's behalf | The harness, on the model's behalf (§4.3) |
| Chrome | Literal HTML duplicated in all 30 files | Injected at publish from site settings |
| Links | Literal `href="/path"` | `{{cms:item/<uuid>}}`, resolved at publish |
| Snapshot | The working directory | Publish to staging → git branch |

### 4.3 Publication parity

The raw model calls `write_file` and stops; the harness commits and pushes for
it. The governed model, left alone, would additionally have to call
`propose_change_set` before anything existed to score. That is not a property
of the substrate — it is an asymmetric burden in the harness, and the Haiku
pilot paid for it: 8 of 10 governed `partial` operations had written correct
content that was never proposed, and scored as drift.

**The harness therefore closes any change-set the model leaves open, exactly as
it commits any file the raw model leaves written**, and records `autoClosed` on
the operation. M7 reports completion and *unaided* completion separately, so
nothing is hidden by the fix.

This is parity of harness support, not a weakened approval gate. `propose`
promotes to staging on the run's own branch — the governed equivalent of a
commit. Reaching the live site still requires a named human, and no run ever
asks for one.

### 4.4 Substrate prerequisite: the link graph

RIFT's rename repointing and broken-link reporting are driven by the
`link_edges` table. Until FR-LK-002 that table was maintained only by the CMS's
own UI, so a site built through MCP — as this one was — restored from its dump
with effectively **zero** edges. Running against that state would have measured
a CMS with its central guarantee switched off and reported the result as the
substrate's ceiling.

`scripts/reset-baseline.sh` therefore rebuilds the graph on every reset and
refuses to proceed if it comes back empty. The frozen baseline carries **126
edges, all `cms_reference`** — no page starts outside the managed-link
guarantee.
### 4.5 Review between operations

RIFT guards a page against carrying two *unreviewed agent bundles* at once: a
second change-set touching a page an `open` or `proposed` one already holds is
refused — *"ask a human to approve or reject that change-set first."* The guard
is explicitly agent-only, and it exists so that approving one bundle cannot
ship another's edits.

The protocol originally never reviewed anything. Change-sets accumulated in
`proposed`, and the governed arm progressively walled itself out of every page
it had already touched — in the v2 trial, operations 8 and 9, **both renames**,
failed for that reason alone. That was a defect in this protocol, not in the
CMS and not model drift. The benchmark claims to model *months of changing
hands*; what it actually modelled was a content team that files thirty
proposals and reads none of them.

**The harness therefore reviews between operations**, through RIFT's own
admin-key approval endpoint rather than an imitation of it, so the run
exercises the same code path a real reviewer does — item transitions, audit
trail and publish included.

Two keys, two roles, and the separation is load-bearing:

| Key | Held by | Can |
|---|---|---|
| agent | the model under test | propose; never approve, publish or archive |
| admin | the harness, as reviewer | approve a proposed change-set |

The model can never sign off its own work. That ceiling is the governance model
the benchmark exists to measure, and collapsing the two keys would silently
delete it.

Approved content publishes to `git_main_branch`, so a governed run points
**both** branch settings at its own run branch and restores them in teardown. A
run cannot write to the site's real `main`.


## 5. Protocol

### 5.1 Per-operation loop

For each operation *n* in 1..30, for each run:

1. Start a fresh session. No memory of ops 1..*n*−1.
2. Provide the standing system prompt (§5.2) and the verbatim operation text
   from `operations.md`. Nothing else — the model must discover current site
   state by reading.
3. Let the model work to completion using only its arm's tool set.
4. Produce a snapshot (§6).
5. Record usage, latency, and completion status.
6. Score the snapshot (§7).

The operation text is identical across both arms and all five models. It is
written in content-team language, naming outcomes rather than mechanisms — no
file paths, no RIFT jargon — so neither substrate is cued.

### 5.2 Standing system prompt

Identical in both arms except for the tool-inventory paragraph:

> You are a content editor maintaining the Godzilla Docs documentation site.
> Complete the requested change. Keep the site internally consistent: every
> page that should link to another should still link to it, and every page
> should follow the site's design system. A reference to `DESIGN-SYSTEM.md`
> and a site map are available to you.

Stating the expectations explicitly, in both arms, is deliberate. Any drift
observed is then a failure to *maintain* structure, never a failure to know it
was expected.

### 5.3 Knowledge parity (fairness control)

The raw arm's working copy is seeded with two files that mirror what the
governed arm can query natively:

- **`DESIGN-SYSTEM.md`** — every token (name, value, purpose) and every
  component (name, parameters, intended use, example markup), generated from
  `get_design_system_summary` so the content is provably identical.
- **`SITEMAP.md`** — every page with its path, title, and description,
  generated from the same data backing `list_folders` / `search_content`.

Both files are regenerated from the baseline and committed before op 1. Without
this control the benchmark would be measuring information asymmetry, and the
result would be uninteresting.

## 6. Snapshot mechanism

**Both arms produce a git branch of rendered HTML, one commit per operation.**
This section is deliberately concrete, because the relationship between git and
the measurement is easy to misread.

### 6.1 The critical distinction: we audit snapshots, we do not diff them

**Drift is not measured by comparing versions to each other.** Every metric
except blast radius (M5) is an **absolute audit of a single snapshot in
isolation**: crawl that version of the site, count how many links are dead,
count how many style violations exist. The number for operation 9 is computed
without reference to operation 8.

Git is **storage and time-travel**, not the measuring instrument. It exists so
that (a) all 300 snapshots are durably kept, (b) any snapshot can be restored
exactly with `git checkout`, and (c) a reader can inspect what actually
happened. The "drift curve" is those independent absolute scores plotted in
sequence — it rises because each snapshot genuinely contains more broken
references than the last, not because we diffed anything.

M5 (blast radius) is the sole exception: it needs the diff between consecutive
commits to count which pages changed.

### 6.2 Repository layout

One repository — `github.com/heitham/godzilladocs` — with one branch per run:

```
main                          ← baseline: the canonical published site
staging                       ← baseline staging
run/haiku-45-raw              ┐
run/haiku-45-governed         │
run/sonnet-46-raw             │
run/sonnet-46-governed        │  10 run branches,
run/sonnet-5-raw              ├─ each: baseline commit
run/sonnet-5-governed         │  + up to 30 operation commits
run/gemini-37-flash-raw       │
run/gemini-37-flash-governed  │
run/gemini-31-pro-raw         │
run/gemini-31-pro-governed    ┘
```

Every run branch is cut from the **same baseline commit** before its run
begins, so both arms of every model start from byte-identical HTML.

### 6.3 What happens during one operation

Taking op 9 (rename the `apis/` section to `api/`) as the worked example.

**Raw arm** — the working copy is the deliverable:

1. Fresh session; model receives the op text and its file tools.
2. Model reads files, renames them, rewrites `href` attributes it finds.
3. Harness commits the working tree: `[op-09] Rename the API section`.
4. Push to `run/sonnet-5-raw`.

**Governed arm** — RIFT's own publisher produces the deliverable:

1. Fresh session; model receives the *same* op text and its MCP tools.
2. Model moves items via the CMS; proposes the change-set.
3. Harness triggers a staging publish. RIFT re-renders **every page** from the
   database, resolving `{{cms:item/<uuid>}}` references to current paths.
4. RIFT's publisher commits and pushes to `run/sonnet-5-governed`.

Both branches now hold a complete, self-contained tree of rendered HTML at op 9.

### 6.4 What the scorer does, later

The scorer runs offline, after all trials, over the finished branches:

```
for branch in run/*:
    for each operation commit 1..30:
        git checkout <sha>
        crawl the working tree
        emit scores.json
```

Continuing the example — with the *actual* mechanism that produces the
difference:

- On `run/sonnet-5-raw`, hrefs are literal strings the model had to find and
  rewrite by hand. Whatever it missed still says `/apis/…`, which now resolves
  to nothing. Suppose 14 such references remain → **BR = 14**.
- On `run/sonnet-5-governed`, hrefs were never literal. RIFT regenerated every
  page from UUID references at publish time, so all of them emit `/api/…`
  → **BR = 0**.

Neither number was obtained by comparing the two branches, or by comparing
either branch to its own history. Each is an independent count of dead links in
one directory of HTML.

### 6.5 Why this design

1. **The scorer is genuinely substrate-blind.** It receives a directory of HTML
   and nothing else. No `{{cms:item}}` or `{{ds:component}}` syntax survives
   publication, so the governed arm's output is plain HTML indistinguishable in
   kind from the raw arm's. Branch names are stripped before scoring.
2. **Rendering is identical by construction.** Both arms' HTML comes from
   RIFT's renderer — the raw arm's baseline *is* RIFT's output. We never
   reimplement reference resolution, so the arms cannot diverge for rendering
   reasons.
3. **Everything is reproducible and inspectable.** A third party can clone the
   repo, check out any operation of any run, and re-derive every number.

### 6.6 Mechanical notes

Verified against RIFT's publisher implementation:

- **History accumulates.** Publishes are ordinary non-fast-forward-checked
  pushes; `--force` is used only when first creating a branch.
- **Renames and deletions are reflected.** Each full-site publish clears the
  tracked tree and rewrites it, so stale files cannot linger.
- **A no-op operation produces no commit.** If a model changes nothing, the
  publisher returns the existing HEAD. The harness records the previous sha
  again and marks the operation `partial`/`failed` per M7 — a run must never
  earn a clean drift score by doing nothing.
- **Commit messages carry the operation ID**, so history is self-describing.

## 7. Metrics

Three headline metrics (M1–M3) as specified in the project README, plus four
supporting metrics that make the headline numbers interpretable.

### Path resolution rules (applies to M1, M6)

Identical for both arms. For an internal href *p*:

1. try `p` exactly, 2. try `p.html`, 3. try `p/index.html`.
   Trailing slashes are stripped first. Unresolvable by all three = dead.

Internal means: starts with `/`, or is relative, or matches the site's own
configured domain. External links are out of scope (not scored, not crawled).

### M1 — Broken references *(headline)*

Crawl every page in the snapshot; classify every internal reference.

| Code | Condition |
|---|---|
| B1 | **Dead path** — target resolves to no file |
| B2 | **Dead fragment** — path resolves but `#id` is absent on the target |
| B3 | **Dead asset** — `<link href>`, `<img src>`, `<script src>` target missing |

`BR(n) = |B1| + |B2| + |B3|` at snapshot *n*, reported with subcategories.

This is a **snapshot count, not an accumulator** — it falls when a model repairs
something. Also report `NewBreaks(n)` (broken at *n*, sound at *n*−1) and
`Repairs(n)` (the inverse), which separate "caused damage" from "left damage."

### M2 — Style forks *(headline)*

Scored on the **content region only** — chrome is scored separately as M4.

**Hard forks** — deterministic, no judgment:

| Code | Condition |
|---|---|
| H1 | Inline `style="…"` attribute |
| H2 | `<style>` element inside content |
| H3 | **Dangling modifier** — class matches a DS pattern (`alert--*`, `chip--*`, …) with no corresponding rule in the DS stylesheet |
| H4 | **Unknown class** — class token appears nowhere in the DS stylesheet |
| H5 | Hardcoded color literal (`#rgb`, `#rrggbb`, `rgb(`, `hsl(`) |
| H6 | Raw `<table>` without `class="param-table"` |
| H7 | Raw `<pre>` not inside `.code-block` |

**Soft forks** — heuristic, reported separately and never folded into the
headline number:

| Code | Condition |
|---|---|
| S1 | Callout-shaped `<div>` (bordered/filled, heading-like first child) not using `.alert` |
| S2 | Hand-inlined copy of a DS component's template markup |

`SF(n) = Σ hard fork occurrences`. H3 deserves emphasis: the Godzilla DS
documents that an unrecognized `variant` "falls back to the default neutral
alert border" — so an invalid variant is a *silent* visual regression, exactly
the kind of drift that survives human review.

### M3 — Token cost *(headline)*

`TokIn(n)`, `TokOut(n)`, `TokTotal(n)` summed across every model call in
operation *n*, **including tool-result tokens** — MCP JSON responses and file
reads both consume context and both must count.

**Reasoning tokens count.** Both families reason before answering and bill for
it, and the volume is not marginal: in preflight, Gemini 3.7 Flash spent 62
reasoning tokens to emit a one-token reply. Reasoning tokens are recorded as a
separate `thinking` field and included in `total`. Excluding them would
understate the true cost of an operation by a wide margin.

**On effort parity.** The two providers expose reasoning through different
mechanisms with incompatible units, so "high effort" cannot be made numerically
equivalent *across* providers. This is not a defect in the design: the
protocol requires effort held constant **across both arms of a single model**,
which is exactly achievable, and the benchmark makes no cross-model claim
(§2). Each run's manifest records the exact reasoning configuration used.

Reported as cumulative curve, per-op mean, and cost-per-clean-operation.

We expect this metric may favor the raw arm. That is a real tradeoff and the
dashboard surfaces it rather than burying it (§9, cost/correctness scatter).

### M4 — Chrome divergence *(supporting)*

Count of **distinct** header / footer / left-nav variants across all pages in
the snapshot. Baseline = 1. Any value > 1 means the site no longer has one
voice in its furniture.

This metric is structurally asymmetric and that is precisely why it is
informative: the governed arm cannot exceed 1 (chrome is injected from a single
source at publish), while the raw arm's chrome is duplicated across every file
and any partial edit fractures it. It isolates the single-source-of-truth
property more cleanly than any other measure here — and it is also the metric an
SSG-based raw arm would neutralize (§2).

### M5 — Blast radius *(supporting)*

`PagesChanged(n)` = pages whose rendered content differs from snapshot *n*−1,
ignoring whitespace. Compared against the minimum page set the operation
actually required (recorded per-op in `operations.md`).

High blast radius signals collateral churn — a model rewriting twelve pages to
accomplish a two-page task is drifting even when nothing breaks.

### M6 — Orphans and reachability *(supporting)*

- `Orphans(n)` — pages with zero inbound content links (chrome nav excluded).
- `Unreachable(n)` — pages not reachable from `/` by BFS over content links.

Content can decay without a single link breaking: a page nothing points to is
functionally lost. Op 30 tests repair of exactly this condition.

### M7 — Operation completion *(supporting)*

Per-op status: `completed` / `partial` / `failed` / `refused`. A run that
silently does nothing must not be rewarded with a clean drift score, so this
metric gates interpretation of all others.

Reported alongside it: **unaided completion** — operations the model closed
itself, without the harness publishing on its behalf (§4.3). Completion is the
fair cross-arm comparison; unaided completion is the more interesting number,
and only the latter is sensitive to how much ceremony a substrate demands.

## 8. Data capture

Written during the run, not reconstructed afterward.

```
results/<run-id>/                 # run-id = <model>-<arm>, e.g. sonnet-5-governed
  manifest.json                   # model, arm, effort, baseline sha, timestamps
  ops/
    op-01/
      request.json                # verbatim operation text as issued
      transcript.jsonl            # full message trace incl. tool calls/results
      usage.json                  # tokens in/out, latency, completion status
      snapshot.sha                # git sha of the resulting commit
      scores.json                 # full M1–M7 detail for this op
    op-02/ …
  timeline.json                   # flattened per-op records — the dashboard feed
results/index.json                # all runs, for cross-run charts
```

One `timeline.json` record per operation:

```json
{
  "op": 7,
  "op_id": "B1-move-getting-started",
  "wave": "B",
  "status": "completed",
  "snapshot_sha": "a1b2c3d",
  "broken_refs": { "total": 14, "dead_path": 12, "dead_fragment": 2, "dead_asset": 0 },
  "new_breaks": 14,
  "repairs": 0,
  "style_forks": { "hard": 3, "soft": 1, "by_rule": { "H1": 2, "H5": 1 } },
  "chrome_variants": 1,
  "pages_total": 36,
  "pages_changed": 5,
  "pages_required": 4,
  "orphans": 0,
  "unreachable": 0,
  "tokens": { "in": 42188, "out": 3910, "total": 46098 },
  "latency_ms": 51200
}
```

## 9. Dashboard

| Panel | Content |
|---|---|
| **Divergence** *(hero)* | Cumulative broken references, ops 1–30, 10 series. Paired by model: same hue, raw dashed, governed solid. The central chart. |
| **Style forks** | Same shape, M2 hard forks |
| **Chrome divergence** | Step chart — expected flat at 1 for governed, stair-stepping for raw |
| **Token cost** | Cumulative M3 — the governance premium, shown plainly |
| **Cost vs. correctness** | Scatter: x = total tokens, y = final broken refs. Ideal is bottom-left; makes the tradeoff legible in one view |
| **Per-model panels** | Five small multiples, each model's two arms side by side |
| **Scorecard** | Final-state table, all runs, all metrics |
| **Op drill-down** | Select an operation → per-run diff, deep-linked to the git commit |

The two chart families to design first are Divergence and Cost-vs-correctness:
together they state the whole finding — *what governance buys, and what it
costs.*

## 10. Threats to validity

Stated plainly rather than discovered by a reader.

1. **n = 1 per cell.** Ten runs give no variance estimate. Results are
   directional only. **No significance testing will be reported**, and any
   between-model difference smaller than the between-op noise should be read as
   noise. Repeat trials are the first upgrade once the harness supports them.
2. **Single domain, single design system.** Documentation sites are unusually
   link-dense; the effect size is likely domain-sensitive.
3. **Fixed operation order.** Order effects are unmeasured and confounded with
   wave structure — later ops act on an already-drifted site by design.
4. **Operations authored by us.** Waves B and C deliberately target path
   fragility, which is the governed arm's structural advantage. Mitigation: the
   op list is frozen and published *before* any trial runs, and Waves A/D/E
   contain operations with no path component where the arms should perform
   comparably. If the governed arm wins those too, that is a signal worth
   scrutinizing, not celebrating.
5. **Scorer authored by us.** Published in full alongside results; every metric
   above is deterministic and re-runnable against the published snapshots by a
   third party.
6. **Raw arm is raw HTML, not an SSG** — see §2.
7. **Publication timing differs between arms.** The governed arm publishes
   through a queue worker; the raw arm commits directly. Latency comparisons
   between arms are therefore not meaningful and are reported per-arm only.
8. **The governed arm's guardrails are stated in its tool descriptions**, and
   the raw arm has no surface on which an equivalent could be written. This is
   the treatment, not a confound — a rule that travels with the write API is
   precisely what "structure is a property of the substrate" means — but it
   does mean the governed arm's advantage is partly *instructional* and not
   only *mechanical*, and the two cannot be separated by this design. An arm
   given the same rules in its system prompt, with nothing enforcing them,
   would separate them; that is the most valuable single addition to this
   benchmark and is not currently run.

## 11. Reproducibility

Everything needed to re-run or re-score independently:

- Baseline site: `github.com/heitham/godzilladocs`, `main` at the baseline commit
- Frozen operations: [`operations.md`](operations.md)
- Per-run snapshots: one git commit per operation, published with results
- Scoring code: `scoring/`, deterministic, no model calls
- Run manifests: model IDs, effort settings, timestamps

Re-scoring a published run requires only the snapshot repository and `scoring/`.
No CMS instance, no API keys, no model access.
