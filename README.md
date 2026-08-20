# RIFT Drift Race Benchmark

Standalone benchmark comparing content-management drift on a governed substrate
(RIFT CMS, via its MCP) against the same models operating on raw/unmanaged site
infrastructure. **Not part of the RIFT CMS codebase** — this project talks to a
local RIFT CMS instance over its MCP interface and to a plain-file clone of the
same published site. It does not import or depend on RIFT CMS source.

## Hypothesis

Structure is a property of the content substrate, not the agent. The same AI
model, given identical content operations, drifts less when working through a
governed layer (link graph, design-system contract, change-set human approval)
than when editing raw files directly.

## Design

- **Paired same-model runs.** Each tested model executes the same frozen
  operation list twice — once as unmanaged raw file edits, once through RIFT's
  MCP against a snapshot of the same site. Substrate is the only variable that
  changes between a model's two runs.
- **Roster (v1):** Claude Haiku 4.5, Claude Sonnet 4.6, Claude Sonnet 5,
  Gemini 3.5 Flash, Gemini 3.7 Flash. Reasoning is enabled for all, held
  constant across both arms of every model so effort isn't a confound with the
  token-cost metric. (Effort is *not* numerically comparable across providers —
  see methodology M3 for why that's sound rather than sloppy.)
- **Roster substitution:** Gemini 3.1 Pro was planned but is unreachable — the
  available key returns 429 for every Pro-tier model, so no Gemini Pro run is
  possible. Gemini 3.5 Flash replaces it. Consequence: capability range is
  tested only on the Claude side (Haiku → Sonnet); the Gemini pair tests
  cross-vendor generalization instead.
- **Trials:** 1 run per (model × arm) for v1 — 10 runs total. Repeat-trial
  averaging is deferred until the harness supports running this benchmark
  repeatably over time.
- **Metrics:** cumulative broken references, design-system deviations
  ("style forks"), tokens consumed per operation.
- **Out of scope for v1:** cross-lab models (Grok, Llama) — no automated
  agentic execution path to those providers yet. Tracked as a follow-up, not
  silently dropped from the roster.

## Fairness constraints

- Scoring scripts are substrate-blind: they run against final published
  HTML/CSS output only, with no awareness of which arm produced it. Both arms
  emit plain HTML rendered by the same renderer, so nothing in the scorer's
  input identifies the substrate.
- **Knowledge parity:** the raw arm's working copy is seeded with a
  `DESIGN-SYSTEM.md` and `SITEMAP.md` generated from the same data the governed
  arm queries natively. Both arms are told the same rules; only enforcement
  differs. Without this control the benchmark would measure information
  asymmetry rather than substrate.
- Each operation runs in a fresh session with no memory of prior operations,
  in both arms — "months of changing hands," not one continuous chat.
- The operation list was frozen and published before any trial was run.
- Full methodology, the frozen operation list, per-operation snapshots, and the
  scoring code are published alongside results.

## Status

**Baseline complete.** The sample site — "Godzilla Docs," 30 pages — is built in
RIFT, published, and live at `github.com/heitham/godzilladocs`. Methodology and
the frozen 30-operation list are written (`methodology/`). No trials have been
run yet; the harness and scoring code are the remaining build.

## Layout

- `methodology/` — protocol + metric definitions (`README.md`), frozen
  operation list (`operations.md`)
- `harness/` — per-model-family driver code (raw-file arm + RIFT-MCP arm)
- `scoring/` — link crawler, style-fork detector, chrome-divergence detector,
  token counter
- `results/` — per-run snapshots, `timeline.json` metric feeds, chart data
- `site-spec/` — sample site content plan (built; see Status)
- `clones/` — local git clones of the published site, served for inspection
