# v04: The Correspondence Catalogue

**Pitch:** The provider list is the headline. The page answers "does it work with my mailbox?" first, then reads like a typed letter bound into a catalogue: the FAQ is the body in four chapters, and the plans are printed plates.

One colour only: brand cobalt `#2547E5` and its tints on white. Screenshots and the provider wall are duotoned to cobalt and paper by an inline SVG filter (`#v04-duo`). Libre Caslon Text for headings and body, Courier Prime for To / From / Re lines.

## Brief items and where they are used

| Brief item | Idea | Where on the page |
|---|---|---|
| layout-17 | Catalogue plates with a large number, then one shared CTA | `#pricing`: four plates (Plate I to IV, huge numeral, name, spec table, includes list), then "One order form for all four" with the single Start free button. Each plate keeps a small "Order plate N" text link to its checkout (the baseline checkout links must stay). |
| hero-04 | Provider list as the headline, each word linking to its guide | H1 "Gmail. Outlook. iCloud. Fastmail. Yahoo. Zoho. Any IMAP." with every word linking to `/connect/<provider>` |
| visual_style-03 | One full-width ink band for security | Chapter II Safety is a cobalt-900 band; accents inside are cobalt-200/300 (mint dropped, see wildcard) |
| typography-06 | Libre Caslon Text 400/700, Courier Prime for To / From / Subject | Self-hosted in `fonts/` (latin woff2, 4 files incl. Caslon italic). Courier: hero letterhead (From / To / Re), team addresses (To: info@...), client tab metadata, spec tables, kickers |
| narrative-01 | Problem first, then fix, then proof | First paragraph opens "Your AI can write the email. It still can't send it."; fix = Setup chapter; proof = ledger, revoke demo, annotated dashboard, review |
| proof-13 | Revoke demo | Safety, "Pull the plug": cropped, duotoned Inboxes screenshot with a ring on the bin button and one line on what stops at once |
| asset_use-10 | Annotated dashboard, numbered pins, legend | Teams, "The control panel, annotated": dashboard overview with 7 pins and a numbered legend below |
| motion-13 | Client tabs where only the underline slides | Setup, "Paste the URL into your client": Claude, ChatGPT, Cursor, VS Code. CSS-only radio tabs (no JS); only the underline moves, `transition: none` under reduced motion |
| section_order-17 | Short hero, FAQ as main body (Setup, Safety, Teams, Billing), Pricing, Start free | Hero, contents strip, then chapters I to IV each ending in its share of `faqItems`, then the catalogue, then the closing letter "Start free. Keep your mail where it is." |
| voice-12 | Mission voice | "Your mail belongs in your mailbox, not in one more database." in What is and Safety; copy in `copy.mjs` |
| wildcard-01 | One colour only, duotoned screenshots | Everything cobalt on white; body text cobalt-900. Duotone filter in `Home.jsx` (`DuotoneFilter`) |

Must-haves: providers (hero H1, provider wall and list in Setup), pricing and Business per person (plates, from `stripePrices`/`businessSeat`, names via `planDisplayName`, EUR via `useDisplayCurrency`), security and Stockholm (ledger), reviews (Teams, verbatim from `reviews.mjs`), FAQ (all `faqItems`, grouped by chapter, every answer visible), how it works (Setup steps).

## Seeded choices (`variant_seed` 1373657159, `rng.mjs`)

- Word in the H1 with a permanent cobalt-200 rule under it: index 2, **iCloud**. (It was italic until the performance pass; the italic file is no longer needed on the first view.)
- Plate numerals: **roman** (I, II, III, IV).
- Alternate surface tint behind the annotated dashboard: **cobalt-50**.
- Duotone shadow tone: **cobalt-900** (`#0E1750`).
- Client tab open by default: **Claude**.

## Notes

- Performance: Caslon 400 (the H1 and lead font) is preloaded by a `<link rel="preload">` as the first child of the page body, resolved with `new URL('./fonts/...', import.meta.url)` to the same hashed URL the CSS uses. The first view needs only Caslon 400 and Courier 400 (buttons are set in 400). Both have metric-matched fallbacks (Georgia, Courier New) measured in Chrome.

- Client islands: `Plates.jsx` and `Money.jsx`, only for the EUR swap. Server render is complete in USD.
- No revoke-control screenshot exists; the Inboxes page bin button (which disconnects the inbox and wipes its credentials, `DELETE /api/inboxes/[id]`) stands in.
- Screenshots: `screens/desktop-full.webp` (1440) and `screens/mobile-full.webp` (390), full page, light. The lab picker is visible in them.

## Lighthouse

To be added by the orchestrator.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.2 s | 0 | 20 ms | 335 KB | 96 | 100 |
| Mobile 2 | 93 | 3.2 s | 0 | 20 ms | 335 KB | 96 | 100 |
| Desktop | 100 | 0.7 s | 0 | 0 ms | 362 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
