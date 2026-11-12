# v01: Catalogue

**Pitch:** the product as a reference catalogue. Five lines tell the whole story before any reading (Connect, Ask, Approve, Teams, Plans), a sample mailbox shows the outcome, and every claim carries a footnote that links to the page proving it.

Files: `Home.jsx` (server component), `copy.mjs` (all copy and footnotes), `Home.module.css`, `seed.mjs` (seeded choices), client islands `LoopClip.jsx`, `HoverClip.jsx`, `Money.jsx` (EUR for EU visitors), `Poster.jsx` (lazy AVIF clip stills), `fonts/` (3 self-hosted latin woff2, about 58 KB).

## Brief map

| Brief item | Idea | Where on the page |
|---|---|---|
| layout-06 | Catalogue index of five titles | Hero, right column ("Contents"): 01 Connect, 02 Ask, 03 Approve, 04 Teams, 05 Plans, each linking to `#connect`, `#ask`, `#approve`, `#teams`, `#plans`; the same numbers head those sections |
| hero-02 | Before and after on one sample mailbox | Hero, "Sample mailbox": Before pane (7 unread) and After pane (3 drafts waiting, rest filed), labelled as a sample with example names |
| visual_style-16 | Semantic colour only | Cobalt only on actions and drafts waiting; amber on the held send; mint and red only in the Approve states; colour key in the spec sheet. Brand colours unchanged, nothing decorative |
| typography-02 | Newsreader 500 italic H1 72 px, Newsreader 400 body 19 px, Martian Mono 400 12 px labels | Exactly that; H3s also Newsreader 500 italic and buttons Martian Mono, so only three files load. Self-hosted from Google Fonts (latin subsets) |
| narrative-09 | Numbered beliefs, each with a link | "Six things we hold to" (tinted band), each ends in a link to how it works |
| proof-01 | Works-with wall, labelled compatibility | "Works with": 10 providers to `/connect/<slug>`, 10 AI clients to `/docs/<slug>`, labelled "A compatibility list, not a customer list" |
| asset_use-16 | Clips play only on hover or focus | Fig. 2b (approval card clip) and Fig. 2c (Approvals page clip): poster by default, play on hover or keyboard focus, nothing preloaded |
| motion-03 | One looping hero clip, pauses off screen, visible pause | "Then" column of the sample mailbox: the real draft-send clip, IntersectionObserver pause, Pause/Play button, phone-width cut on phones |
| section_order-13 | Hero, Spec sheet, Fig. 1 dashboard, Fig. 2 draft card, Fig. 3 connect screens, Pricing table, Footnotes | Hero, Spec sheet (`#features`), Principles, 01 Connect with Fig. 1, 02 Ask with Fig. 2, 03 Approve (2b, 2c), Security, Works with (Fig. 3), Reviews, 04 Teams, 05 Plans (table), FAQ, Footnotes |
| voice-01 | Plain manual voice | Throughout: "Connect an inbox. Paste one URL. Ask." |
| wildcard-10 | Footnotes for every claim | 16 superscripts link straight to the proving page (security, docs, changelog, DPA, privacy, pricing); listed again in the Footnotes section |

Must-haves: providers (Works with), pricing incl. Business per person (Teams and Plans, from `stripePrices` / `businessSeat`, names via `planDisplayName`, EUR via `useDisplayCurrency`), security and Stockholm (Security and storage, Diagram B), reviews (the one review in `reviews.mjs`, verbatim), FAQ (`faqItems`, all answers visible), how it works (01 Connect, `#how`, Diagram A).

## Seeded choices (`variant_seed` 198879164, mulberry32)

Tinted band: Principles. Numbers: padded (01 to 05). Held draft in the sample: the second (the supplier invoice). Section rule: double. Captions: below the plate. Hero clip: card-draft-send.

## Performance pass (2026-11-12)

- The H1 font (Newsreader italic) is preloaded with a real `<link rel="preload">` ahead of the H1; Newsreader 600 dropped.
- Metric-matched fallbacks (Georgia, Georgia Italic, Menlo with size-adjust and ascent/descent overrides, widths measured in Chrome). CLS measured locally on a phone viewport: 0.008.
- Clip stills are lazy `<picture>` elements (AVIF, then WebP, phone-width under 768 px) instead of eager `poster` attributes; nothing below the first screen loads up front.
- Held-state text in the sample mailbox darkened to #7A4A08 (6.6:1 on amber-100).

## Screens

`screens/desktop-full.webp` (1440 px) and `screens/mobile-full.webp` (390 px), full page, light.

SEO script: 16/16 passed, 3,827 words. Lighthouse: added by the orchestrator.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.3 s | 0.002 | 10 ms | 355 KB | 97 | 100 |
| Mobile 2 | 92 | 3.3 s | 0.002 | 10 ms | 355 KB | 97 | 100 |
| Desktop | 100 | 0.7 s | 0 | 0 ms | 361 KB | 97 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
