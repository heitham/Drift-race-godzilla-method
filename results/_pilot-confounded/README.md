# Haiku pilot — confounded, retained as evidence

Not a valid result. Retained because it is the evidence trail for three defects
it exposed, all fixed before the re-run:

1. **CMS gap (primary).** `create_item` / `update_item` performed no body
   validation, so escaped markup and raw internal paths stored, rendered and
   published in silence. 45 of 108 governed broken targets carried a literal
   `\"`. Fixed in RIFT Phase 43 (`01207e8c`); the pin moved deliberately rather
   than freezing the defect in place.
2. **Empty link graph.** `link_edges` was maintained only by the CMS UI, so a
   site built through MCP restored with effectively zero edges — rename
   repointing and broken-link reporting were inert. The reset script now
   rebuilds the graph and refuses to proceed if it comes back empty.
3. **Harness parity gap.** 8 of 10 governed `partial` operations wrote correct
   content and never called `propose_change_set`, while the raw arm's commits
   were made for it by the harness. The harness now closes open change-sets in
   the governed arm too, and records `autoClosed` (methodology §4.3).

Headline pilot numbers, for the record — governed vs raw, final state:
M1 48 vs 15 · M2 5 vs 10 · M4 0 vs 7 · M6 orphans 13 vs 3 · M3 5.9M vs 17.4M tokens.
