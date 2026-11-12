# v10 The Annotated Inbox

An editorial long read. The page shows the product working before it explains anything. Every product shot sits in the margin with a museum label that gives the date it shipped, taken from the changelog.

## Files

- `Home.jsx`: server component (header, nav, main, footer). Client islands: `Compare.jsx` (before/after divider), `DrawLine.jsx` (the how-it-works rule that draws itself), `Clip.jsx` (muted clip that plays only while on screen), `Money.jsx` (EUR swap through `useDisplayCurrency`).
- `MonoFont.jsx`: loads Space Mono with the FontFace API once section 01 nears the screen.
- `copy.mjs`: all copy. `rng.mjs`: seeded choices. `Home.module.css`: scoped styles. `fonts/`: 3 self-hosted latin woff2 files.

## Where each brief item is used

| Brief item | Where on the page |
|---|---|
| layout-01: 640px text column, wide margin with marginalia | Every section uses a `.row` grid: a 640px column plus a margin for shots, labels, "Asked of it" notes, the FAQ note and the margin note in the walkthrough. Below 1100px it becomes one column. |
| hero-17: client tabs | Hero: Claude / ChatGPT / Cursor / VS Code as a radio group that works without JavaScript (CSS `:has`). Each tab holds that client's real setup steps from `src/lib/clients/content/en/*.json`. All four panels are in the server HTML. The real draft card shot sits beside them in a sticky margin. There is no fake client UI. |
| visual_style-02: Swiss rules | A 2px ink rule on the header and every section head, plan table, FAQ and tabs. 1px rules inside sections. One solid cobalt block per section (see seed choices below). No cards and no shadows. |
| typography-04 | Space Grotesk 700 at -2% tracking for headings, IBM Plex Sans 400 (variable file, 600 for labels) for body, Space Mono 400 for info@ / sales@ / invoices@, prompts, code and footer addresses from section 01 down. The first screen uses Plex 600 for the hero addresses and the system monospace for the hero code, to keep the first view to two font files. |
| narrative-02: demo first | Section 01, "One task, from the first word to the receipt": request, draft, send with Undo (clip), receipt, held send with the approval card and its receipt. Explanation begins in 03. |
| proof-06: data location label | Section 04: "Data stored in Stockholm, Sweden" as a cobalt block that links to `/security#subprocessors`. |
| asset_use-09: before/after with a draggable divider | Section 05: the Inboxes page (connected, quiet) and the Approvals page (two prepared emails waiting), shown in one frame with a range-input divider that works by keyboard. |
| motion-05: line draws itself once | Section 03: an SVG rule down the left of Fig. 1 to Fig. 3, drawn with stroke-dashoffset when it enters view, then left in place. It is fully drawn in the server HTML and under reduced motion. |
| section_order-01 | Hero (draft card) > walkthrough > Providers > How it works (Fig. 1 to 3) > Security model > Use cases by mailbox > Reviews > Pricing > FAQ > Closing CTA. |
| voice-09: literary and spare | H1 "An inbox is a list of small promises. This helps you keep them." The same voice runs through every section intro. |
| wildcard-12: museum labels | Each visual has a `figcaption` with title, medium, note and "Shipped <date>", linked to the changelog entry. Dates come from `entries.mjs`: 27 Oct 2026 (draft card, receipts), 3 Aug 2026 (approval), 10 Aug 2026 (approval page), 26 May / 29 May / 26 Sep 2026 (providers, IMAP, Outlook), 23 Jun 2026 (encrypted scheduled sends). The review label uses its real date, 13 Sep 2026. |
| Must-haves | Providers (02), pricing with Business per person from `businessSeat` (07), security and Stockholm (04), review (06, verbatim from `reviews.mjs`), FAQ with every `faqItems` entry visible (08), how it works (03). |

## Seed choices (`variant_seed` 1065250005, `rng.mjs`)

- Default client tab: Claude.
- Figure and marginalia tint: cobalt-50 (the other option was ink-50).
- Section numbers: `01`-style (the other option was `§ 1`).
- Solid cobalt block per section: walkthrough number tab; Providers "Any IMAP inbox" row; Security Stockholm label; Use cases `info@` tag; Reviews 5/5 block; Pricing "Get Pro" button; FAQ number tab. In How it works, the seed picked the number tab, but the flow diagram already has its own cobalt node, so that node is the section's block and the tab stays plain.
- Divider start position: 51%.

## Performance pass (2026-11-12)

- First view loads two webfonts: Plex (preloaded with a real `<link>` before the H1, because the lead paragraph is the LCP text) and Space Grotesk. Space Mono loads later through `MonoFont.jsx`.
- Metric-matched Arial fallbacks for Plex and Space Grotesk, computed from the woff2 files with next's fontkit, cut the font-swap shift.
- The clip poster is a lazy `<picture>`: AVIF first, with the phone poster under 768px. The video keeps `preload="none"`. All phone crops switch at `max-width: 767px`. The hero card is lazy, with no preload.
- Every section below the hero, plus the footer, uses `content-visibility: auto`.
- Phone first load without JS chunks or CSS (headless Chrome, 390px): HTML 54 KB, Geist 30 KB (shared), Plex 41 KB, Grotesk 13.5 KB, hero card AVIF 26.5 KB.

## Screens

`screens/desktop-full.webp` (1440 px), `screens/mobile-full.webp` (390 px), full page, light.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.3 s | 0 | 10 ms | 348 KB | 96 | 100 |
| Mobile 2 | 92 | 3.3 s | 0 | 10 ms | 348 KB | 96 | 100 |
| Desktop | 100 | 0.8 s | 0.011 | 0 ms | 424 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
