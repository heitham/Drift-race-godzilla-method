# Design system: Godzilla 1.0.0

Godzilla is the design system for RIFT CMS documentation sites — born from the rift where molten content rises to the surface. Warm volcanic neutrals, magma-orange accents, and a dense, link-heavy, code-heavy layout language built for technical docs (Astro-style hub/detail pages, left navigation, API reference tables, and syntax-styled code blocks).

Every page on this site is built from these components and tokens. Use them
rather than writing custom markup or styling — hand-rolled equivalents break
visual consistency and will not pick up future design-system changes.

## Components

### alert

Callout box for notes, warnings, and danger/breaking-change notices inside docs content.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `variant` | string | `info` | One of info, success, warning, danger. |
| `title` | string | `Note` | Callout heading. |
| `body_html` | html | `This endpoint is deprecated in favor of ` | Callout body content, may include inline links. |

**Usage:** variant must match one of the fixed CSS suffixes: info, success, warning, danger. Any other value falls back to the default neutral alert border.

### card

Link tile used on hub pages to point at guides, API endpoints, SDKs, or concepts.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `href` | string | `/guides/building-your-first-pipeline` | Destination URL. |
| `tag` | string | `Guide` | Short category label shown above the title. |
| `title` | string | `Building your first pipeline` | Card title. |
| `description` | string | `Learn how to assemble your first data pi` | One or two sentence summary. |

**Usage:** Use one card component call per tile on hub/index pages such as Guides hub, API Reference hub, and SDKs hub.

### chip

Small inline badge used for version tags and status labels (e.g. v2, Beta, Deprecated).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `label` | string | `v2` | Chip text. |
| `variant` | string | `primary` | One of primary, success, warning, danger, info, or omit for neutral. |

**Usage:** variant maps directly to a fixed CSS class suffix; unknown values render as the neutral default chip style.

### code-block

Syntax-styled code block with filename/language header and copy affordance, used throughout guides and API reference pages.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `filename` | string | `pipeline.config.json` | Optional filename or example label shown in the header. |
| `language` | string | `json` | Language label shown top-right. |
| `code` | html | `{
  "pipeline": "ingest-orders"
}` | The pre-formatted code content (already escaped/highlighted markup if needed). |

**Usage:** code is inserted verbatim inside a pre/code block; author it as plain text or pre-escaped markup, since there is no runtime syntax highlighter in this template.

### docs-pagination

Prev/next page navigation shown at the bottom of docs content.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `prev_href` | string | `/getting-started/installation` | URL of previous page. |
| `prev_label` | string | `Installation` | Title of previous page. |
| `next_href` | string | `/getting-started/authentication` | URL of next page. |
| `next_label` | string | `Authentication` | Title of next page. |

**Usage:** Place once at the bottom of any sequential docs page (Getting Started, Guides, API Reference, SDKs).

### docs-toc

On-this-page table of contents rendered alongside long docs content.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `items_html` | html | `<li><a href='#overview'>Overview</a></li` | Pre-built li/a elements linking to in-page anchors. |

**Usage:** Typically placed in a right-hand rail on long API reference and guide pages.

### hero

Page-top hero banner used on the home page and section hubs.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `title` | string | `Godzilla Docs` | Main hero heading. |
| `subtitle` | string | `Everything you need to build on the RIFT` | Supporting subheading. |
| `cta_html` | html | `<a href='/getting-started/quickstart'>Ge` | Pre-built call-to-action anchor markup. |

**Usage:** One hero per page, typically at the top of hub pages.

### parameter-table

Name/type/required/description table for documenting API request and response parameters.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `rows_html` | html | `<tr><td><code>pipeline_id</code></td><td` | Pre-built tr elements, one per parameter, with td cells for name, type, required, and description. |

**Usage:** rows_html must contain the full set of tr elements for every parameter row; there is no loop, so build the full row set before insertion.

### stat

Compact data/stat tile for surfacing a metric, e.g. rate limits, SLA numbers, or release counts.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `value` | string | `1000` | The headline stat value. |
| `label` | string | `requests / minute` | Short label describing the stat. |
| `description` | string | `Default rate limit for standard API keys` | Additional context sentence. |

**Usage:** Use for single metrics on API reference pages such as rate limits, or on the changelog/release notes for counts.

## Site chrome

These render automatically on every page — header, footer, and navigation.
They are managed centrally and should not be hand-edited on individual pages:

- **breadcrumb** — Breadcrumb trail showing the current page's position in the hierarchy.
- **footer** — Site footer with brand and copyright line.
- **header** — Site header with Godzilla wordmark and primary navigation slot.
- **left_nav** — Left-hand section navigation for docs pages, folders, and root.
- **main_nav** — Top-level primary navigation list (used inside header or standalone).

## Tokens


### color

| Token | Value | Purpose |
|---|---|---|
| `primary-500` | `#ff5a1f` | Magma orange — primary accent, links, active states. |
| `primary-700` | `#b3390f` | Deep rust — hover/pressed states, emphasis text on light backgrounds. |
| `neutral-900` | `#1c1512` | Basalt charcoal — primary text color. |
| `neutral-500` | `#6b625c` | Warm ash gray — secondary text, muted labels. |
| `neutral-100` | `#f4efe9` | Warm sand — subtle surfaces, hover backgrounds, table stripes. |
| `background` | `#fffaf6` | Page background — warm off-white. |
| `accent-teal-500` | `#1f9d8a` | Rift-pool teal — secondary accent for links inside dark surfaces and info states. |
| `success-500` | `#2f9e44` | Success / stable status color. |
| `warning-500` | `#d98c1f` | Warning / caution status color. |
| `danger-500` | `#d1341f` | Danger / breaking-change status color. |
| `border-color` | `#e4dcd3` | Default hairline border on warm background. |
| `code-bg` | `#241a16` | Code block background — charred basalt. |
| `code-text` | `#f4efe9` | Code block foreground text. |

### dimension

| Token | Value | Purpose |
|---|---|---|
| `space-xs` | `0.25rem` | Extra-small spacing unit. |
| `space-sm` | `0.5rem` | Small spacing unit. |
| `space-md` | `1rem` | Medium/base spacing unit. |
| `space-lg` | `1.5rem` | Large spacing unit. |
| `space-xl` | `2.5rem` | Extra-large spacing unit. |
| `space-2xl` | `4rem` | Section-level spacing unit. |
| `font-size-h1` | `2.75rem` | H1 heading size. |
| `font-size-h2` | `2rem` | H2 heading size. |
| `font-size-h3` | `1.375rem` | H3 heading size. |
| `font-size-body` | `1rem` | Body text size. |
| `font-size-small` | `0.875rem` | Small/caption text size. |
| `font-size-code` | `0.9rem` | Code and monospace text size. |
| `radius-sm` | `4px` | Small border radius — chips, badges. |
| `radius-md` | `8px` | Medium border radius — cards, alerts, inputs. |
| `radius-lg` | `16px` | Large border radius — hero panels. |

### fontFamily

| Token | Value | Purpose |
|---|---|---|
| `font-heading` | `'Space Grotesk', sans-serif` | Heading typeface — angular, technical. |
| `font-body` | `'Inter', sans-serif` | Body typeface. |
| `font-mono` | `'JetBrains Mono', monospace` | Monospace typeface for code blocks and inline code. |

### shadow

| Token | Value | Purpose |
|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(28, 21, 18, 0.08)` | Subtle elevation — cards, chips. |
| `shadow-md` | `0 4px 12px rgba(28, 21, 18, 0.14)` | Medium elevation — hero panels, popovers. |
