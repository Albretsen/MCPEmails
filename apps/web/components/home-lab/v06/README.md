# v06: By hand, or connected

**Pitch:** a calm blueprint page that answers the privacy question first, then shows five everyday email jobs twice, once copied by hand between inbox and chat and once done through MCPEmails, with the real product screenshot bleeding off the right edge.

Server component (`Home.jsx`) with two client islands: `CopyUrl.jsx` (connector URL copy feedback) and `Currency.jsx` (EUR for EU visitors, same rule as `Sections.jsx`). Copy in `copy.mjs`, seeded choices in `rng.mjs`, styles in `Home.module.css`, fonts self-hosted in `fonts/` (3 files, 57 KB).

## Brief items and where they are used

| Brief item | Idea | Where on the page |
|---|---|---|
| layout-13 | Alternating rows with bleed, text 5 cols, screenshot 7 cols bleeding off the right edge, five rows | `#features` "The same five jobs": five rows, text in 5 columns, shot from column 6 to the viewport edge. Dashboard shots render at 1120 px and are cut by the edge; card shots sit at their natural size inside the 7 columns. Rows alternate between the cobalt-50 band and plain grid. |
| hero-10 | 3D envelope, draft pulled halfway out, strong long shadow, H1 beside it | Hero: `b/envelopes-hero` (closest real asset, no new render) right of the H1, with a long cast shadow made from the same image flattened to a silhouette and sheared along the floor (CSS only, no extra download). |
| visual_style-05 | Blueprint grid, 8 px faint cobalt grid, cobalt line diagrams, unframed screenshots | Page background: 8 px minor grid plus a major line every 64 px in cobalt tints. Postbox leader lines, rules, step markers and list bullets are 1 px cobalt lines. `c/diagram-stored.svg` in Security. Screenshots have no frame or shadow. |
| typography-01 | Fraunces 600 opsz 144 SOFT 0 for H1/H2, Instrument Sans 400/500 body 18 px, IBM Plex Mono for addresses and the connector URL | Fraunces is a static 600 / opsz 144 / SOFT 0 instance; every H1, H2 and price. Instrument Sans 400/500 at 18 px for body. Plex Mono for every email address (info@, sales@, support@...) and the connector URL, set automatically by the `T` helper (the hero uses the system mono stack so the first view loads only two font files). |
| narrative-04 | By hand versus connected | Each of the five rows: a "By hand" list of copy-paste steps, then "Connected" with the real result. The demo intro frames it ("you are the connector"). |
| proof-10 | Install screenshots inside each client's connector settings | No real Claude or ChatGPT screenshots exist, so `#how` shows the real connector URL (with copy button), the exact menu steps from `/docs/claude` and `/docs/chatgpt`, and the real MCPEmails receipt card beside them, with a note that this is not a mock-up of either client. |
| asset_use-02 | 3D postbox once, anchoring "Connect your inbox", slots labelled with provider names | `#providers`: `b/postbox-*` with 1 px cobalt leader lines from its slot to ten provider labels (each a link to its `/connect/` page). Sticky beside the provider answers on desktop; a labelled list beside it on phones. |
| motion-11 | "Copied" replaces the button label for two seconds | `CopyUrl.jsx` beside the connector URL in `#how` and in the footer. |
| section_order-09 | Hero > Security > Demo > Providers > Pricing > FAQ | That order, with How it works and Reviews between Providers and Pricing, and "What is an email MCP server?" after the FAQ. |
| voice-11 | FAQ plainness | Every H2 is a reader's question with a short answer ("Does it store my email? No. It fetches it when asked."); Security and Providers are Q/A lists. |
| wildcard-06 | Only three font sizes | 14 px, 18 px and 48 px (34 px on phones) on the whole page, footer and FAQ included. Checked in headless Chrome: rendered text uses exactly those three. |
| must-haves | providers, pricing, Stockholm security, reviews, FAQ, how it works, Business per person | `#providers`, `#pricing` (four plans from `stripePrices`, names via `planDisplayName`, Business per person card from `businessSeat` plus a "Is Business really per person?" block), `#security`, `#reviews` (the one review in `reviews.mjs`, verbatim), `#faq` (all `faqItems`, always visible), `#how`. |

## Performance

- Fraunces and Instrument Sans are preloaded with real `<link>` elements (before the H1), plus the envelope AVIF for desktop (`min-width: 960px`). Both fonts have metric-matched local fallbacks (Georgia Bold, Arial).
- The envelope uses only `b/envelopes-hero` (1600x1154): `envelopes-small` is a different crop, which failed `image-aspect-ratio`.

## Seeded choices (`variant_seed` 609717239)

- Hero long shadow falls to the right (0.17).
- Demo rows 1, 3 and 5 sit on the cobalt-50 band (0.02).
- Postbox in the left column, labels to its right (0.03).
- Major blueprint line every 64 px (0.46).
- Mono text in cobalt-700 (0.49).

## Screenshots

- `screens/desktop-full.webp` (1440 px, full page)
- `screens/mobile-full.webp` (390 px, full page)

## Lighthouse

Added by the orchestrator.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 91 | 3.4 s | 0 | 10 ms | 362 KB | 96 | 100 |
| Mobile 2 | 91 | 3.4 s | 0 | 10 ms | 362 KB | 96 | 100 |
| Desktop | 100 | 0.7 s | 0 | 0 ms | 410 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
