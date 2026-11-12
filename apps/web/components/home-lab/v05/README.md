# v05 · Setup sheet

**Pitch:** the headline and Start free stay pinned on the left while the setup plays out on the right, step by step, as a quiet lowercase Q and A on grey hardware panels.

Brief: `home-lab/briefs/v05.json` (variant_seed 384930780, tone light, not bold).

## Brief items and where they are used

| Brief item | Idea | Where on the page |
|---|---|---|
| layout-03 | Sticky split, left 5 columns pinned, right 7 scroll four screenshots (connect, paste URL, ask, approve) | `.split`: left `.pin` holds the H1, lead, Start free, meta labels and a step index, `position: sticky` from 1024 px wide and 760 px tall. Right `.rail` scrolls: connect (dashboard Connect an inbox dialog), paste URL (dashboard overview with the endpoint), ask (draft card), approve (Approve email send dialog), then sent (receipt card). Below 1024 px it stacks. |
| hero-09 | Install hero: two equal columns Add to Claude / Add to ChatGPT, three numbered steps and a screenshot each, Start free above both | Step 02 "paste the URL": endpoint panel, Start free row, then two equal `.installCol` panels, each with three numbered steps from the real client setup pages, a card screenshot and a link to the full guide. |
| visual_style-13 | Hardware labels: light grey panels, tiny uppercase labels in ink, cobalt status dots | `.label` (11 px, 700, uppercase, ink-700) with a static cobalt `.dot` on every section, figure frames, meta chips, endpoint plate, price cards, footer headings. No pulsing, no pills. |
| typography-14 | Source Serif 4 600 at opsz 60 for a 72 px display, Public Sans 400 body, 700 labels | Self-hosted from Google Fonts: `fonts/source-serif-4-600-opsz60-latin.woff2` (H1 at 72 px, H2s, prices, prompts) and `fonts/public-sans-latin.woff2` (variable 400 to 700, body and labels). Two font files. |
| narrative-16 | Interview: Q and A with the maker, questions in bold, short answers | Every section opens on a bold question (H2) with a short answer; storage, team and maker sections are bold H3 questions with answers. "who is behind it?" answers from /about facts in the third person; the one first-person line is quoted verbatim from /about and linked there. No invented quotes. |
| proof-05 | Real customer quotes only, name and link to where published; hidden when none | `#reviews` renders `REVIEWS` from `components/marketing/reviews.mjs` verbatim with name, role, company link and a "published on Google" permalink; the section is not rendered when the array is empty. |
| asset_use-12 | Small line diagrams in the right margin next to the paragraph they explain | Storage Q and A (`#features`): `diagram-stored.svg` beside "is my email stored anywhere?", `diagram-flow-mobile.svg` beside "how does a request travel?", line icons (data location, encrypted credentials, revoke) beside their answers. Business per person sits in the margin of the team answer. |
| motion-07 | Hovering a provider logo reveals how it connects | Step 01 provider grid: `.providerHow` fades in on hover and keyboard focus (app password, OAuth: sign in with Microsoft, IMAP login); always shown on touch screens; no transition under reduced motion. Text is in the HTML for crawlers. |
| section_order-05 | Hero clip > Connect > Paste URL > Ask > Approve > Sent > Pricing > FAQ | Rail order 00 clip, 01 connect, 02 paste, 03 ask, 04 approve, 05 sent; then storage, team, maker and reviews (the other must-haves), then pricing, FAQ and a short closing. |
| voice-02 | Calm Scandinavian understatement | All copy in `copy.mjs`; the brief's sample line is in the lead. |
| wildcard-16 | Lowercase everywhere except product and provider names | All of our copy is lowercase except product, provider, client and proper names (MCPEmails, Gmail, Claude, Asgeir Albretsen, Stockholm) and protocol acronyms (MCP, IMAP, OAuth). The FAQ (`faqItems`) and the review are shown verbatim, so they keep their casing. Hardware labels are uppercased with CSS, which the visual style asks for. |

Must-haves: providers (01), pricing with Business per person (`#pricing`, plus the margin note in `#business`), security and Stockholm (`#features`), reviews (`#reviews`), FAQ (`#faq`), how it works (the whole `#how` split).

## Seeded choices (`seed.mjs`, mulberry32(384930780))

- Panel grey: `#F1F2F7` (second of three ink tints).
- Accent step: 02 "paste the URL" gets the one cobalt-50 surface instead of grey.
- Section rhythm: 120 px.
- Step numbering: `00` to `05`.
- Screenshot frame radius: 2 px.

## Assets used

Clip `a/card-draft-send-light-desktop` (webm + mp4, AVIF poster preloaded), `a/dashboard-connect-providers`, `a/dashboard-overview`, `a/card-draft-sent-light-mobile`, `a/card-approval-light-mobile`, `a/card-draft-light` (desktop + mobile), `a/dashboard-approve-modal-light` (desktop + mobile), `a/card-sent-light` (desktop + mobile), `c/diagram-stored.svg`, `c/diagram-flow-mobile.svg`, three `c/icon-*.svg`, mono provider logos (Zoho as a letter tile, per the asset notes).

Missing: no real Claude or ChatGPT connector screenshots exist, so the install columns show the real in-chat cards instead.

## Screens

- `screens/desktop-full.webp` (1440 px, full page)
- `screens/mobile-full.webp` (390 px CSS width, full page, saved at 0.7 scale to stay under Chrome's 16384 px capture limit)

## Lighthouse

Added by the orchestrator.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.3 s | 0 | 10 ms | 380 KB | 96 | 100 |
| Mobile 2 | 92 | 3.2 s | 0 | 10 ms | 380 KB | 96 | 100 |
| Desktop | 100 | 0.8 s | 0 | 0 ms | 730 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
