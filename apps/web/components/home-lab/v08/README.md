# v08 The Spec Sheet

Museum white for an email MCP server: one collected object (the draft card in 3D) and the real send clip at the top, then a long key/value spec sheet you read with a cobalt progress line in the left index, a founder letter, and a short note to the agent at the end of each section.

Staging only, English only. Server component; client islands are `Currency.jsx` (USD, or EUR for an EU visitor while EUR prices are on) and `LoopClip.jsx` (the hero clip).

## Brief items and where they are used

| Brief item | Idea | Where on the page |
|---|---|---|
| layout-14 | Spec sheet: one long two-column key/value table (Providers, Clients, Data location, Storage, Approval, Revoke, Plans), screenshots between groups | Section 02 "The spec sheet" (`#features`): seven groups (What it is, Providers, Clients, Data, Sending, How it works, Plans), each a `<table>` with `th scope="row"` keys. All seven named keys are rows (Providers, Clients, Data location, Storage, Approval, Revoke, Plans). Real screenshots and the flow diagram hang between groups |
| hero-15 | One muted looping clip: question, draft card, approve, Sent | Fig. 2 under the hero: the real `a/card-draft-send-light` clip (draft card, Send, five-second Undo, Sent receipt). There is no clip of a question typed in Claude, so none is drawn. Muted, looping, `playsInline`, `preload="none"`, loaded only when in view; a visible Pause button; poster only under `prefers-reduced-motion` and without JavaScript |
| visual_style-12 | Museum white: pure white, objects with soft contact shadows, grey captions, very wide spacing | `#FFFFFF` page, no panels; every shot and the clip sit on a soft contact shadow; numbered grey museum labels ("Fig. N") beside or under each figure; 144 to 176 px gaps between sections |
| typography-09 | Familjen Grotesk 600 headings, Literata 400 body at 18 px, Familjen Grotesk 500 buttons | Self-hosted latin subsets in `fonts/` (2 files, 39 KB: Familjen Grotesk 500 to 600 variable, Literata 400). Literata is preloaded with a real `link` element (the lead paints in it), and both have metric-matched local fallbacks (Georgia, Arial) so the swap does not shift text. Body is 18 px Literata |
| narrative-08 | Founder letter, signed, features as a short P.S. list | Section 04 "A letter from the founder": built only from what `/about` publishes (`messages/en/about.json`), mostly in its own first-person sentences, signed Asgeir Albretsen, with a six-line P.S. of features. No invented quotes |
| proof-02 | Four plain security statements | Section 03 "Security model": 1 mail fetched live and never stored, 2 credentials encrypted at rest, 3 OAuth access revocable in one click, 4 data stored in Stockholm; plus the `c/diagram-stored` diagram |
| asset_use-17 | A single 3D object in the hero, then real screenshots only | Fig. 1 is `b/card-hero` / `b/card-small` (the draft card as a slip with a stamp). After it: only `a/` screenshots and `c/` diagrams |
| motion-16 | Thin cobalt reading-progress line in the left index | The sticky "On this page" index beside the long read has a 2 px track; a cobalt fill grows with a CSS scroll-driven animation (`view-timeline` on the long read, `animation-range: contain`). No JavaScript, no scroll hijack. Under 1024 px the index collapses to the same line pinned to the left gutter. Browsers without scroll timelines show the plain track |
| section_order-14 | Hero > Real quotes > Feature rows (alternating) > Letter > Pricing > Closing CTA | That order. Feature rows are the spec sheet (alternating row tint, screenshots alternating right and left) followed by the security model; the FAQ sits between Pricing and the closing call to action |
| voice-15 | Two readers: sections for people, a short aside to the agent | Every section ends with "Note to the agent:", a grey aside with a hairline rule. The notes only state facts and point at docs (`/docs#tools`, `/docs/providers`, `/security`, `/about`, `/pricing`, `/docs/clients`); none asks an agent to do anything |
| wildcard-15 | Each section header shows the date it was last updated, from git | Every H2 header, every spec group and the hero show "Last updated D Mon YYYY, from git". Dates are constants in `dates.mjs`, computed on 2026-11-12 with `git log -1 --format=%cs -- <paths>` over the files each section describes (the paths are recorded next to each date). They are not computed at request time; re-run the command to refresh them |

Must-haves: providers (spec group "Providers", every `/connect/*` link), pricing (all four plans by `planDisplayName`, live `stripePrices`, `eurEnabled` honoured), Business per person (from `businessSeat.card` with its minimum; "email actions" lines are filtered out), security and Stockholm (spec group "Data" and section 03), reviews (the one review in `reviews.mjs`, verbatim, with its Google link), FAQ (every `faqItems` question and answer, always visible), how it works (spec group `#how` with the flow diagram).

## Seeded choices (`rng.mjs`, variant_seed 1964509051)

| Draw | Decided |
|---|---|
| 1 | First screenshot between spec groups hangs on the right; the next ones alternate |
| 2 | Alternating row tint is ink-50 (`#F5F6FA`) |
| 3 | Museum label prefix is "Fig." |
| 4 | The cobalt-marked spec key is "Storage" |
| 5 | Index numerals are decimal (01 to 07) |

## Notes

- No colour outside the brand table.
- The founder letter's facts and most sentences come from `messages/en/about.json`; nothing in it is new.
- The security diagram is small at 390 px (it is a 960-wide SVG); a mobile twin of `diagram-stored` would read better.

## Screenshots

- `screens/desktop-full.webp` (1440 px, full page)
- `screens/mobile-full.webp` (390 px, full page)

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.2 s | 0 | 10 ms | 345 KB | 96 | 100 |
| Mobile 2 | 92 | 3.2 s | 0 | 10 ms | 345 KB | 96 | 100 |
| Desktop | 100 | 0.7 s | 0.01 | 0 ms | 633 KB | 97 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
