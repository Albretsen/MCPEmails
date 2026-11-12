# v02 The Postal Manual

**Pitch:** the home page is a manual's table of contents. Every line opens into its chapter in place (native `<details>`), the hero asks "Which inbox do you use?" and the route in chapter 02 follows the answer. Voice: "We carry the letter. We don't keep a copy."

## Brief items and where they are used

| Brief item | Where on the page |
|---|---|
| layout-16 filled magazine grid | Chapter 03 "Plates": asymmetric 6-column grid, every tile a real asset (approvals, approve dialog, inboxes, draft-send clip, receipt) with a caption |
| hero-14 dashboard hero + "see the draft card" | Hero figure: tight crop of the real dashboard's Recent activity, with insets of "Inboxes connected" and the MCP endpoint; "See the draft card" link opens chapter 01 |
| visual_style-09 marker highlight | Black-and-white body; cobalt-100 marker only on "never stored" and "you approve" |
| typography-17 | Atkinson Hyperlegible 400/700 + DM Mono 400 (addresses, URLs, numbers, captions), self-hosted in `fonts/` (3 files) |
| narrative-14 provider-first picker | Hero radio "stamps" (CSS `:has`, no JS): note under the picker and step 1 of chapter 02 (text + real connect-form screenshot) change per provider |
| proof-09 directory listings | Appendix A: Official MCP Registry, Glama, mcp.so, mcpservers.org, linked to the real listings |
| asset_use-07 200% detail crops | Chapter 01: To field, Approve in browser, inbox picker, numbered callouts 1 to 3 |
| motion-02 fade up 8px 200ms once | `Manual.jsx`; also when a chapter opens; off under reduced motion |
| section_order-08 | Hero question > 01 The answer card > 02 How it got there (diagram) > 03 What it can do > 04 What it won't do > 05 Pricing > 06 Start free; Appendix A reviews + directories, Appendix B FAQ |
| voice-14 postal | All copy in `copy.mjs` |
| wildcard-13 manual contents | The whole `main` below the hero; "Open every chapter / Close them all" buttons; #hash links open their chapter |
| Must-haves | Providers (hero + ch 02 logo wall), pricing incl. Business per person (ch 05, from `stripePrices` / `businessSeat`, EUR via `Currency.jsx`), security + Stockholm (ch 04), review (App. A, verbatim), FAQ (App. B, open, every answer visible), how it works (ch 02) |

## Seeded choices (`rng.mjs`, variant_seed 2027062686)
Open chapter: 02 How it got there (FAQ always open). Grid rhythm: b (tall tile left). Leaders: dashes. Page numbers 3, 5, 9, 13, 17, 23, 26, 32. Default provider in the picker: Outlook.

## Screens
`screens/desktop-full.webp` (1440) and `screens/mobile-full.webp` (390, DevTools mobile emulation), default state.

## Performance pass (2026-11-12)
- Under 768 px the hero shows a crop of `dashboard-overview-light-mobile` instead of the desktop crops and insets. Every hero image is lazy, so the hidden variant is never fetched. Connect-form and card shots carry `-mobile` sources too.
- `atkinson-400.woff2` (the face of the lead paragraph, which is the LCP) is preloaded with a real `<link rel="preload">` placed before the `<h1>`. Metric-matched Arial fallbacks are measured in Chrome. The first screen paints in Atkinson 400/700 only; DM Mono starts below the hero.
- Measured with mobile emulation on the dev server: hero media is about 94 KB in total, including the shared Geist font (30 KB), and no desktop shots load.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.3 s | 0 | 10 ms | 378 KB | 96 | 100 |
| Mobile 2 | 92 | 3.3 s | 0 | 10 ms | 378 KB | 96 | 100 |
| Desktop | 100 | 0.7 s | 0 | 0 ms | 450 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
