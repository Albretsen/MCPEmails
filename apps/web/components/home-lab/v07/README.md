# v07 The Front Page

A newspaper front page for an email MCP server: the edition is dated today in Oslo and filed from Stockholm, the lead story is the draft card, and every product claim sits next to a framed print of the real product.

Staging only, English only. Server component; the one client island is `Currency.jsx` (USD, or EUR for an EU visitor while EUR prices are on).

## Brief items and where they are used

| Brief item | Idea | Where on the page |
|---|---|---|
| layout-05 | Newspaper front page, masthead with date and Stockholm, 8-column lead, 4-column rail "Also in this edition" | Masthead (`Edition of <today, Europe/Oslo, per request>`, `Stockholm, where your account data is kept`); lead story `article` spans 8 of 12 columns; `aside` rail spans 4 with a column rule, holding providers, plans, a reader's letter, Stockholm, business, wire and open source |
| hero-06 | Three stills, same size, captioned 1, 2, 3 (Connect, Ask, Approve) | Under the H1: three square framed prints (Connect an inbox dialog, draft card, approval card), captions "1 Connect", "2 Ask", "3 Approve"; a scroll-snap row on phones |
| visual_style-08 | Framed prints: cream mats, thin ink frames, small-caps captions | Every screenshot and diagram sits on a cream mat inside a 1 px ink frame with an inner bevel line; captions use `font-variant-caps: all-small-caps`; provider plates use the same mat |
| typography-13 | Plex Sans Condensed 600 headings, Plex Sans 400 body, Plex Mono 400 labels | Self-hosted text subsets in `fonts/` (condensed 600 14 KB, sans 400 17 KB, mono 400 8 KB; buttons use the condensed face so no Sans 600 file), metric-matched local fallbacks |
| narrative-17 | Install-led: you already use Claude or ChatGPT, the install, what to ask first | Lead story body: "You already use Claude or ChatGPT.", "The install. One URL." (steps plus the server URL), "What to ask first." (prompts), then "The draft card." |
| proof-07 | Open by default: GitHub repo, npm package, docs, "read the code" secondary | Colophon "Open by default." with GitHub repository, npm package and Docs as the main rows and "Read the code" (the mcp-server folder) as a secondary link; repeated in the rail |
| asset_use-15 | Chat and inbox side by side, joined by a hairline | How it works, "Live, not copied.": the draft card (A) and the dashboard Approvals queue (B), with a cobalt hairline joining the subject "Re: Moving Thursday's design review" in both; the right print is cropped so the two subjects sit on one horizontal line. Stacked without the line under 820 px |
| motion-09 | Before/after crossfade, 5-second loop, paused on hover | End of the lead story: draft card crossfades to the sent card on a 5 s CSS loop; hover or keyboard focus pauses it; `prefers-reduced-motion` shows the before frame only |
| section_order-04 | Masthead and lead > Providers > How it works > Changelog dispatches > Pricing > Colophon | That order; the FAQ ("Readers' questions") sits between Pricing and the Colophon, and security and Stockholm live inside How it works |
| voice-10 | Clipped fragments | All copy in `copy.mjs` ("Connected once. Fetched live. Never stored. Ask. Review. Send.") |
| wildcard-11 | Providers as numbered field-guide plates I to XII | Providers section: twelve plates, "Plate I" to "Plate XII", each with the specimen (provider mark or letter tile), "Connects with" and "Field notes", and a link to its connect guide |

Must-haves: providers (plates), pricing (classifieds, all four plans by `planDisplayName`, live `stripePrices`, Business per person from `businessSeat` with its minimum, `eurEnabled` honoured), security and Stockholm (How it works plus the stored diagram, and the rail), reviews (the one review in `reviews.mjs`, verbatim, with its Google link), FAQ (every `faqItems` question and answer, always visible), how it works, Business per person (pricing card and rail).

Changelog dispatches come from `getEntries()` in `src/lib/changelog/entries.mjs`, never typed in.

## Seeded choices (`rng.mjs`, variant_seed 637257314)

| Draw | Decided |
|---|---|
| 1 | Plate V (Fastmail) carries the cobalt double frame |
| 2 | Mat tone `#F8F5ED` of three creams |
| 3 | Section-head rule: double rule |
| 4 | Rail order: providers before plans |
| 5 | Six dispatches printed |

## Notes

- The cream mat (`#F8F5ED`) is the only colour outside the brand table; it is a surface tint for the "framed prints" brief, every text and accent colour is a brand token.
- Zoho, Google Workspace and "Your own domain" use letter tiles (the Zoho mark is rough at small sizes; the other two have no asset).
- Hero frames use the phone-width card shots so their text reads at frame size.

## Performance pass (2026-11-12)

- Fonts cut from 65 KB to 40 KB (Google Fonts `text=` subsets, static Sans 400 instead of the variable file). Sans (dek, the LCP) and Condensed (H1) are preloaded with real `<link rel="preload" as="font">` elements ahead of the H1; Plex Mono (8 KB, the brief's label face) loads unpreloaded.
- No image loads eagerly: the three hero frames are lazy (they sit below the first screen on a phone), and the `react-dom` preloads are gone.
- Links inside the review and other text blocks are underlined.

## Screenshots

- `screens/desktop-full.webp` (1440 px, full page)
- `screens/mobile-full.webp` (390 px, full page)

## Lighthouse (orchestrator)

Measured 2026-11-12 on a local staging production build (`next start`), Lighthouse 12.8.2, before the PR. Locally today's page (v00) scores 93 and 92 on mobile with LCP 3.2 s and 344 KB (on production mcpemails.com it scores 99 to 100 with LCP 1.4 to 1.9 s), so compare against v00, not the absolute budget. SEO 69 is the staging `noindex`; `scripts/home-lab/seo_check.mjs` passes 16/16.

| Run | Performance | LCP | CLS | TBT | Transfer | Accessibility | Best practices |
|---|---|---|---|---|---|---|---|
| Mobile 1 | 90 | 3.6 s | 0 | 10 ms | 432 KB | 97 | 100 |
| Mobile 2 | 90 | 3.6 s | 0 | 10 ms | 432 KB | 97 | 100 |
| Desktop | 100 | 0.8 s | 0 | 0 ms | 445 KB | 97 | 100 |
| v00 mobile (reference) | 93 | 3.2 s | 0 | 10 ms | 344 KB | 96 | 100 |
