# v09 "Re: your questions"

**Pitch:** the home page is a stack of emails. A short hero, an index that reads like an inbox, then every FAQ question open as an H2, filed in four folders (Setup, Safety, Teams, Billing), with seven numbered messages from MCPEmails sitting between the folders. Each block opens with a From / To / Subject / Date header; the Subject row holds the heading.

Server component. Client islands: `Money.jsx` (USD to EUR swap, like `Sections.jsx`) and `Clip.jsx` (approval clip, plays only on screen, poster only under reduced motion). Fonts self-hosted in `fonts/`: Spectral 300 italic (13 KB) and Work Sans limited to wght 400 to 500 (25 KB), subset to latin with fontTools. Both are preloaded with real `<link rel="preload">` elements and have metric-matched fallbacks (Georgia Italic at 89.2%, Arial at 110.6%, ascent and descent overrides), so the swap does not shift layout.

## Performance pass (2026-11-12)

- Fonts: Work Sans 50 KB to 25 KB (instanced 400 to 500, latin subset); Spectral 16 KB to 13 KB; preload links plus fallbacks fixed the CLS on `.display`.
- Images: phone sources under `(max-width: 767px)`, hero cards lazy. The approval clip poster is now a lazy AVIF-first `<picture>` under the video, so it no longer loads on first view.
- Measured on the dev server with a throttled phone over CDP (not Lighthouse): CLS 0, LCP is the lead paragraph, non-script first-load bytes about 200 KB.

## Brief items and where they are used

| Brief item | Where on the page |
|---|---|
| layout-15: FAQ as the page, every question an H2, answers open, grouped Setup, Safety, Teams, Billing | Four `Folder` sections; each question is an `<article>` with an H2 and its answer open beside it, text exactly `faqItems` |
| hero-03: invoices@ business task | Hero: example request about invoice 2041 from invoices@, then the real held-send card (`a/card-approval-*`) and draft card (`a/card-draft-*`), captioned as the cards MCPEmails shows in the chat. No Claude UI is drawn |
| visual_style-14: ledger lines, tabular figures, cobalt totals | Pricing ledger (ruled feature lines at the seeded pitch, cobalt prices with a double underline), provider, client and storage spec tables on hairline rules; `tabular-nums` page-wide |
| typography-16: Spectral 300 italic display, Work Sans 400/500 body | H1, H2s, question H2s, plan names, review quote in Spectral; everything else Work Sans |
| narrative-12: built for the long haul | 04 Security: intro plus "Your mail never leaves your provider's storage", "Revoke in one click", "No lock-in"; hero fact "Revoke any connection in one click" |
| proof-11: full pricing table incl. Business per person, no gate | 06 Plans: all four plans from `stripePrices` with `planDisplayName`, Business card from `businessSeat` (per person, yearly, minimum) plus a "Business, per person" note; EUR via `Money` |
| asset_use-08: 3D envelopes as step markers | 01 "How it works, in three envelopes": `b/envelopes-small` cropped three ways in CSS with the step number |
| motion-12: cobalt-soft flash on anchored FAQ answers | `.q:target` animation (1.8 s, once); static tint under reduced motion. The 07 index links to every question |
| section_order-07: Index > 01 ... 07 Questions | Index, 01 What it is (+ how it works), Setup, 02 Providers, 03 Clients, Safety, 04 Security, 05 Approval, Teams (+ review), 06 Plans, Billing, 07 Questions |
| voice-08: business-plain for teams | H1 "Give the AI the invoices@ inbox. Keep the approve button for yourself."; 05 "The agent drafts. A person approves." |
| wildcard-04: every section is an email | `MailHead` on every section, folder and the review (the review's From is the reviewer). Addresses only info@, sales@, invoices@ at example.com |
| Must-haves | providers (02), pricing and Business per person (06), security and Stockholm (04), reviews (Teams folder), FAQ (folders), how it works (01) |

## Seeded choices (`rng.mjs`, variant_seed 1166650964)

- Header block tint: `cobalt` (faint cobalt rather than paper).
- Unread dot in the index: message `05` (Approval).
- Ledger line pitch: `40` px.
- Hero figures: `offset` (draft card narrower, right-aligned under the held send).
- Envelope crops for steps 1 to 3: a shuffle of three framings.

## Screens

`screens/desktop-full.webp` (1440 px) and `screens/mobile-full.webp` (390 px), full page, light.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 93 | 3.2 s | 0 | 10 ms | 351 KB | 96 | 100 |
| Mobile 2 | 93 | 3.2 s | 0 | 10 ms | 351 KB | 96 | 100 |
| Desktop | 100 | 0.7 s | 0 | 0 ms | 371 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
