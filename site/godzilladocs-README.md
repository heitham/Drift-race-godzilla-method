# Godzilla Docs

**This is not a real product.** It is a fictional 30-page documentation site, built as the
subject of an experiment: *[The Drift Race](https://www.riftcms.com/drift-race)*, which
measures what happens to a website when an AI agent edits it thirty times in a row.

Everything here is published output. You are looking at the evidence behind the results,
so that you do not have to take our word for any of it.

---

## The experiment, in one paragraph

The same site was handed to the same model — Claude Haiku 4.5 — twice. In one run the model
edited **raw HTML files** with a filesystem. In the other it worked through **RIFT**, a
governed CMS, over MCP. Both runs received the same thirty instructions, written and frozen
before any trial, in fresh sessions with no memory of previous operations. Then both
published sites were crawled and audited after every operation.

The only variable was the substrate the model wrote into.

---

## What is in this repository

Each run is a **branch**, and every operation in that run left a commit. Check out any point
in a run's history and you get the site exactly as it stood at that moment — broken links
and all.

### The two branches behind the published results

| Branch | Arm |
|---|---|
| `run/claude-haiku-4-5-20251001-raw-v2` | Raw HTML files |
| `run/claude-haiku-4-5-20251001-governed-v8` | RIFT |

### The baseline both runs started from

```bash
git checkout baseline-v1
```

30 pages, 129 internal links, one pre-existing broken reference that both arms inherited.

> **Note on `main`:** the tip of `main` is not the baseline. It carries later publishes and
> test output, including a leftover folder from a CMS fix verified against this repo. The
> `baseline-v1` tag is the pristine starting state.

### The other branches

Everything else prefixed `run/` is a superseded or aborted attempt — earlier governed runs
that were discarded when we found defects in our own harness, plus a few short smoke tests.
They are left in place rather than deleted, because a benchmark that quietly removes its
failed attempts is asking to be doubted. They are **not** the published result; the two
branches named above are.

---

## Reading a run

**The raw arm** commits once per operation, tagged with the operation's ID:

```
566aca0 [E6] Reachability audit
859defd [E4] De-duplicate setup instructions
d231345 [E3] Note v3 availability
```

**The governed arm** does not commit directly — RIFT's publisher does, so its messages are
publisher-generated and an operation may produce more than one commit:

```
1dddf1e [publish] user=… scope=site_changed items=14 ids=…
```

For that arm, use `timeline.json` in the published results, which records the exact commit
sha for each of the thirty operations. That mapping — not the commit log — is what the
scorer reads, in both arms.

---

## Checking the findings yourself

The headline claim is that the raw site ended with 19 broken internal references and the
RIFT site with none. You can check that without running a model or trusting our scorer:

```bash
# every internal href in the final raw site
git checkout run/claude-haiku-4-5-20251001-raw-v2
grep -rho 'href="/[^"]*"' --include='*.html' . | sort -u
```

Then confirm which of those paths have no corresponding file. Or run our scorer, which is
published alongside the harness and does exactly this, deterministically, with no model
involved.

**The most concrete failure is visible by eye.** Eight pages in the raw run were published
with a backslash-escaped stylesheet link, so the browser never loads the design system:

```bash
git checkout run/claude-haiku-4-5-20251001-raw-v2
grep -rl '\\"/assets/ds' --include='*.html' .
```

Open any of those files in a browser. The page renders unstyled and still returns 200.

---

## What we got wrong

The published hypothesis predicted RIFT would reduce **style forks** — hand-written styling
that escapes the design system. It did not. RIFT tripled them, in both governed runs,
because the design system had no component for a "last reviewed" line and the model invented
one in place with inline rules and literal colour values.

That result is on the findings page for the same reason these branches are still here.

---

## Caveats worth stating plainly

- **One model, one site.** Directional. No statistical significance is claimed.
- **RIFT changed during the experiment.** The benchmark exposed gaps in it — unvalidated
  links, no way to create a section, no way to move a published page — and those were fixed
  mid-study. Part of the zero above is a write-time validator that did not exist when we
  started. The pin history in the harness records every such change and when it happened.
- **The governed arm could not retire a page** during these runs, so it left behind content
  it was asked to remove. That is counted against it in the results.

---

## Links

- **Findings:** [riftcms.com/drift-race](https://www.riftcms.com/drift-race)
- **Harness, frozen operation list, scoring code and full results:** published alongside this
  repository. If you find a flaw in the method, that is the point of publishing it — we found
  five ourselves while running it.
