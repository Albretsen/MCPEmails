# v03 The Letter

**Pitch:** the home page is a printed letter from MCPEmails. It opens with a letterhead, a date and a Re: line, then splits into two tracks (your team on its own domain, and you) that run side by side down to pricing. Every chapter is dated by a real changelog entry and stamped with a Stockholm postmark, and Start free is the P.S.

Server component (`Home.jsx`) with two small client islands: `HeroClip.jsx` plays the one clip only when the visitor asks, and `Money.jsx` switches USD to EUR the same way the live Pricing component does. Copy is in `copy.mjs`, seeded choices in `rng.mjs`, the postmark in `Postmark.jsx`, and styles in `Home.module.css`. Font: one Archivo variable file in `fonts/`, cut with fonttools to wght 400 to 800, wdth 62 to 100, basic Latin plus Latin-1, kerning only and no hinting (44.7 KB; the full latin file was 90 KB). It is declared with `@font-face` and `font-display: swap` and has metric-matched Arial fallbacks so the font swap does not move text. The font and the desktop hero poster (the desktop LCP) are preloaded with real `<link rel="preload">` elements, the first children of the page. The poster is not preloaded on phones: there it sits below the first screen and the LCP is the H1 text. The poster box keeps a fixed aspect ratio at every width. The signature is set at weight 400 because the subset starts at 400.

## Brief items and where they are used

| Brief item | Where on the page |
|---|---|
| layout-11: two tracks, "For you" and "For your team (info@, sales@)" | From chapter one to pricing, every chapter is split into two columns labelled "For your team (info@, sales@)" (first, since the page leads with teams) and "For you". The tracks meet at pricing, which is marked "Both tracks end here", and each plan card is labelled with its track. |
| hero-01: real draft card at 1:1 next to a left-aligned H1 | The hero shows the shipping draft card poster at actual size (714 x 420 CSS px on desktop, 392 x 360 on phones) next to the H1. Its caption uses the card's real words (Save, Send, undo). |
| visual_style-15: postmark separators | `Postmark.jsx`: circular cobalt postmarks reading STOCKHOLM / MCPEMAILS, each stamped with its chapter's changelog date. Their cancellation waves are the section rules, and they are the only ornament on the page. |
| typography-10: Archivo 800 wdth 62 headlines, 400 wdth 100 body | Every headline (H1 poster, H2, H3, prices, step numbers, signature) uses Archivo 800 at wdth 62, the review and FAQ questions use wdth 75, and body text uses Archivo 400 at wdth 100. No other family is used. |
| narrative-15: velocity story, dated changelog entries as chapters | Each chapter's margin shows "Last shipped for this" with the newest matching entry from `getEntries()`, and the postmark carries that date. The letter itself is dated with the newest entry. |
| proof-04: latest dated entries from the changelog, linking the full page | Chapter six, "Recently shipped": the newest six entries, read at render, with a "Read the full changelog" link. |
| asset_use-06: one clip, in the hero | The only video is `card-draft-send` in the hero. Everything else is a still: the approval card, the sent receipt, the provider dialog, the stored-data diagram and the logo wall. |
| motion-01: no motion | Nothing moves and there are no transitions. The page has designed hover underlines (thin cobalt-200, then 3 px cobalt-500) and 2 px cobalt focus rings. The clip plays only when the visitor clicks Play, and under `prefers-reduced-motion` the Play button is hidden so only the still shows. |
| section_order-16 | Hero, then Day in the life (08:00, 12:30, 18:00, which also serves as how it works), then Approval, then Teams, then Pricing, then FAQ, then Recently shipped. Security (Stockholm) is chapter three, between Approval and Teams. |
| voice-16: modest and concrete | All of the copy in `copy.mjs`. The brief's sample line is used as the security intro. |
| wildcard-03: printed letter | The letterhead (logo, Albretsen AS address, "Data stored in Stockholm"), the dateline "Bergen, <date>", the Re: line as the H1, "Dear reader,", a signature (Asgeir Albretsen, using the founder facts published on /about) and the P.S. with Start free. |
| Must-haves | Providers (chapter four, with logo wall and connect links), pricing (all four plans, with Business per person from `businessSeat`, names from `planDisplayName` and EUR through `Money`), security and Stockholm (chapter three), reviews (the one review in `reviews.mjs`, quoted verbatim, chapter four), FAQ (all `faqItems` shown in full), how it works (chapter one), Business per person (the pricing card and the team track in chapter four). |

## Seeded choices (`variant_seed` 306090038, mulberry32)

- Tinted track: **team** (the team column sits on cobalt-50).
- Waves per postmark: **3**. Inner ring: **solid**.
- Postmark tilts: -6.5, -1.8, -3.3, 3.2, -4.5, -5.5, -1.5 degrees.
- Signature: set in the **right** half of its row on desktop, with the P.S. below it.

## Screenshots

`screens/desktop-full.webp` (1440 px) and `screens/mobile-full.webp` (390 px), both full page and light, captured over the DevTools protocol (`home-lab/work/v03/shot.mjs`).

## Lighthouse

The orchestrator adds these. After the performance pass, local dev checks showed the LCP element as the preloaded hero AVIF on desktop and the H1 text on mobile, with CLS 0 on both.

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 92 | 3.3 s | 0 | 10 ms | 333 KB | 96 | 100 |
| Mobile 2 | 92 | 3.3 s | 0 | 10 ms | 333 KB | 96 | 100 |
| Desktop | 100 | 0.7 s | 0 | 0 ms | 339 KB | 96 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
