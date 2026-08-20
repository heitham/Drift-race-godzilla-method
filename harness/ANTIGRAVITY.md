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

- [ ] `harness/run/` built and `npm run bench` working *(not yet built — this
      prompt is staged for when it is)*
- [ ] Antigravity running **on this same Mac** — the governed arm talks to the
      local RIFT CMS at `localhost:3001`, which is not reachable from elsewhere
- [ ] RIFT CMS running on port 3001, plus its BullMQ worker (publishes are
      queued; without the worker nothing reaches git)
- [ ] `.env.local` present with `GOOGLE_AI_API_KEY`
- [ ] Baseline database dump at `baseline/cms_dev.baseline.dump`

**Credential check:** the harness calls the Gemini API directly with an API key.
If your Gemini access is only through an Antigravity subscription rather than a
key, stop and say so — we'd need a different transport, and hand-driving the
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
> 3. `.env.local` contains a non-empty `GOOGLE_AI_API_KEY`
>
> If any check fails, stop and report — do not try to start these services
> yourself.
>
> **Then run these four commands, one at a time, in order.** Each takes a long
> time (30 operations, each a fresh model session). Let each finish completely
> before starting the next. Do not run them in parallel — they share the RIFT
> instance and would corrupt each other's state.
>
> ```
> npm run bench -- run --model gemini-3.5-flash --arm raw
> npm run bench -- run --model gemini-3.5-flash --arm governed
> npm run bench -- run --model gemini-3.7-flash --arm raw
> npm run bench -- run --model gemini-3.7-flash --arm governed
> ```
>
> Use these model IDs exactly. Do not substitute `gemini-3.1-pro-preview` or any
> Pro-tier model — they return 429 on this key, and swapping a model would break
> comparability with the Claude runs already completed.
>
> **Guardrails:**
> - Never push to, or modify, the `main` or `staging` branches of the
>   godzilladocs repo. The harness writes only to `run/*` branches.
> - Never edit `methodology/operations.md`. The operation list is frozen;
>   changing it invalidates every run, including the Claude runs already done.
> - Never edit anything under `baseline/`.
> - If a run fails partway, do **not** restart it from the middle. Report the
>   failure and stop — resuming mid-run breaks the fresh-session protocol.
>
> **Report back:** for each of the four runs — whether it completed, the run ID,
> how many of the 30 operations reported `completed` vs `partial`/`failed`, and
> any errors. Then paste the last 20 lines of each run's log.
>
> Do not score the runs. Scoring happens separately, after all runs finish.

## 4. After the runs

Scoring is deliberately a separate step, run once across all ten runs so every
snapshot is scored by identical code:

```
npm run bench -- score --all
```

The scorer reads only checked-out HTML snapshots. It never contacts a model, so
it costs nothing and can be re-run freely as metric definitions are refined.
