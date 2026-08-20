# Sample site spec — "Godzilla Docs"

Domain: fictional documentation/knowledge-base site for an invented API/data
platform ("Godzilla Docs"). Docs sites are
link-dense (heavy cross-referencing between guides, reference pages, and
concepts) and exercise RIFT's existing docs-oriented DS components directly
(`docs-toc`, `docs-pagination`, `left_nav`, `breadcrumb`), so this domain
stress-tests both the link graph and design-system conformance without
inventing new component categories from scratch.

## Blocked on: a real site + folder to build into

**The MCP has no `create_site` or `create_folder` tool** (read-only
`list_sites`/`list_folders`; `create_item` requires an existing `folder_id`
in an existing site). This is a real capability gap, logged in the RIFT CMS
build plan as backlog Phase 42. Until it's built, provisioning a new site is
a manual step:

1. In the RIFT admin UI, create a new site ("Godzilla Docs").
2. Optionally run the in-app AI Design System Generator to give it a base DS,
   or leave it to inherit/derive from an existing one — your call.
3. Optionally create a few top-level folders (`guides/`, `api/`, `sdks/`) if
   you want nested URL paths — not required; flat root-level pages work fine
   for the benchmark's purposes (link-graph and DS-conformance scoring don't
   depend on folder depth).
4. Hand back the new `site_id` (and folder IDs if created) — content
   population from here runs entirely over MCP. :HG says: i dont have these but they are in the RIFT CMS under the Godzilla Docs site. Please note i have enabled the left navigation on each folder and the root. if you need that turned off let me know. I have created and assigned the Godzilla Design System to the site so you should be able to use the design system components.

## Planned page list (30)

1. Home / product overview
2. Getting Started → Installation
3. Getting Started → Quickstart
4. Getting Started → Authentication
5. Concepts hub
6. Concepts → Pipelines
7. Concepts → Connectors
8. Concepts → Events
9. Guides hub
10. Guide → Building your first pipeline
11. Guide → Connecting a data source
12. Guide → Handling errors & retries
13. Guide → Scheduling & triggers
14. Guide → Monitoring & alerts
15. API Reference hub
16. API → Pipelines endpoint
17. API → Connectors endpoint
18. API → Events endpoint
19. API → Webhooks endpoint
20. API → Rate limits & errors
21. SDKs hub
22. SDK → Node.js
23. SDK → Python
24. Troubleshooting / FAQ
25. Changelog
26. Migration guide (v1 → v2)
27. Security & compliance overview
28. Support / Contact
29. Glossary
30. Release notes archive

Cross-linking is intentional and dense: guides link into specific API
reference pages and concepts; API reference pages link back to concepts and
SDKs; troubleshooting links across guides, API, and the changelog; the
migration guide links the v1 and v2 versions of whichever endpoint page gets
retired/replaced (this is the page used for the "succession" and "remove
with N inbound links" operations in the frozen op list).

## Design-system needs

Reuse existing components as-is: `docs-toc`, `docs-pagination`, `left_nav`,
`breadcrumb`, `chip` (version/status badges), `alert` (callouts), `card`
(guide/API index tiles). Likely need a small number of new docs-specific
components once the site's DS is set up: a code-block component (syntax
styling, copy affordance) and a parameter-table component (name/type/
required/description rows) for API reference pages. Whether these get built
via the DS generator or hand-authored depends on what the operator sets up
in step 2 above.
