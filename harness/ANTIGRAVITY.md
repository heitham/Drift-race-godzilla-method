# Running the Gemini arms from Antigravity

Copy the prompt in §3 into Antigravity when you're ready to run the Gemini
half of the benchmark.

---

## 1. The one rule that matters

**Antigravity's agent must not perform the content operations itself.** Its job
is to *invoke the harness*, which drives the model through a fixed protocol.

This is not a style preference. The benchmark holds everything constant except
substrate. If Claude's runs go through the harness's agent loop and Gemini's
runs go through Antigravity's IDE agent — different system prompts, different
tool implementations, different turn limits, different retry behavior — then the
Claude/Gemini comparison measures *scaffolding*, not models, and the paired
raw-vs-governed comparison inside each Gemini run is contaminated too.

The harness owns the agent loop. Antigravity is only an execution environment
that has Gemini credentials.

## 2. Prerequisites

- [x] `harness/run/` is built and working — the Claude arms have run through it
- [ ] Antigravity running **on this same Mac** — the governed arm talks to the
      local RIFT CMS at `localhost:3001`, which is not reachable from elsewhere
- [ ] RIFT CMS running on port 3001, plus its BullMQ worker (publishes are
      queued; without the worker nothing reaches git)
- [ ] `.env.local` present with a non-empty `GEMINI_API_KEY`
- [ ] Baseline database dump at `baseline/cms_dev.baseline.dump`

**Credential check:** the harness calls the Gemini API directly with an API key.
If your Gemini access is only through an Antigravity subscription rather than a
key, stop and say so — we would need a different transport, and hand-driving the
operations is not an acceptable substitute (see §1).

## 3. The prompt

> I'm running a benchmark that measures content drift. Your job is to **execute
> the harness**, not to do any content editing yourself.
>
> **Critical:** do not open, read, or edit any site content. Do not perform the
> content operations. Do not "help" the model by fixing its output. The harness
> drives the model through a fixed protocol; any manual intervention invalidates
> the run and wastes the whole benchmark.
>
> Working directory: `~/Documents/RIFT Drift Race Benchmark`
>
> **Before starting**, verify:
> 1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001` returns 307
> 2. `ps aux | grep "src/worker.ts" | grep -v grep` returns a process
> 3. `.env.local` contains a non-empty `GEMINI_API_KEY`
>
> If any check fails, stop and report — do not try to start these services
> yourself.
>
> **Then run these commands, one at a time, in order.** Each run is 30
> operations, each a fresh model session, and takes roughly two hours. Let each
> finish completely before starting the next.
>
> ```bash
> npm run reset
> npm run bench -- --model gemini-3.7-flash --arm governed
> npm run bench -- --model gemini-3.7-flash --arm raw
> ```
>
> `npm run reset` restores the CMS to the pristine baseline and rebuilds its
> link graph. It **must** come before the governed run — that arm refuses to
> start against a contaminated database, and a stale link graph would silently
> disable the very CMS behaviour the benchmark is measuring. The raw arm does
> not touch the CMS, so its position after the governed run is safe.
>
> Use that model ID exactly. Do not substitute `gemini-3.1-pro-preview` or any
> Pro-tier model — they return 429 on this key — and do not add
> `gemini-3.5-flash`, which was descoped from the roster. Swapping a model
> breaks comparability with the Claude runs already completed.
>
> If the harness prints `REFUSING TO RUN — CMS pin check failed`, **stop and
> report it verbatim.** It means the RIFT CMS moved to a commit that changes
> code, which would make these runs incomparable with the Claude ones. Do not
> edit `benchmark.config.json` to make the check pass.
>
> **Guardrails:**
> - Never push to, or modify, the `main` or `staging` branches of the
>   godzilladocs repo. The harness writes only to `run/*` branches.
> - Never edit `methodology/operations.md`. The operation list is frozen;
>   changing it invalidates every run, including the Claude runs already done.
> - Never edit anything under `baseline/`.
> - If a run fails partway, do **not** restart it from the middle. Report the
>   failure and stop — resuming mid-run breaks the fresh-session protocol. A
>   clean restart uses `npm run reset` and a new `--tag`, e.g.
>   `npm run bench -- --model gemini-3.7-flash --arm governed --tag b`.
>
> **Report back:** for each run — whether it completed, the run ID, how many of
> the 30 operations reported `completed` vs `partial`/`failed`, and any errors.
> Then paste the last 20 lines of each run's output.
>
> Do not score the runs. Scoring happens separately, after all runs finish.

## 4. After the runs

Scoring is deliberately a separate step so every snapshot is scored by identical
code:

```bash
npm run score:run results/gemini-3.7-flash-governed
npm run score:run results/gemini-3.7-flash-raw
```

The scorer reads only checked-out HTML snapshots. It never contacts a model, so
it costs nothing and can be re-run freely as metric definitions are refined.
