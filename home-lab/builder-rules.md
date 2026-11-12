# Homepage Lab: rules for every builder

You build ONE experimental English home page for MCPEmails, shown only on staging. Read all of this before you start.

## Files you read
- Your brief: `home-lab/briefs/vNN.json` (dealt by a seeded script; use it literally).
- `home-lab/decisions.md` (Asgeir's answers), `home-lab/brand.md` (all light, logo and brand colours fixed), `home-lab/banned.md` (the generic look you must avoid), `home-lab/baseline.md` (today's SEO facts you must keep), `home-lab/assets.json` (the real assets you may use), `home-lab/ideas.json` (only to understand your brief's ideas).
- `CLAUDE.md` (root) and `apps/web/CLAUDE.md`: all rules apply. `apps/web/components/home-lab/README.md`: the variant contract.
- Today's page for facts and copy: `apps/web/components/marketing/HomeClient.jsx`, `Sections.jsx`, `apps/web/messages/en/home.json`, `apps/web/components/marketing/reviews.mjs` (real reviews, quote verbatim, never invent), `apps/web/src/lib/stripe/plans.ts` (`planDisplayName`, plan facts), `apps/web/src/lib/billing/business-seat-copy.ts` (Business per person).

## What you own
- Only `apps/web/components/home-lab/vNN/`. Do not edit any other file (not `page.tsx`, not the picker, not shared CSS, not `package.json`, not `assets.json`). If you need something outside your folder (a shared change, a missing asset, a new dependency), finish what you can and put the request in your final report.
- Never commit, push, switch branches, open PRs or start sessions. Never run `npm run build`, `next build` or `npm ci` (they would break the shared dev server). Never use the `mcp__Claude_Browser__*` tools (the orchestrator's pane).

## Deliverables in your folder
- `Home.jsx`: default export rendering the whole page body: `header` (logo + `nav`), `main`, `footer`. Props: `{ stripePrices, eurEnabled, businessSeat, faqItems, locale }`. Prefer a server component (no `'use client'`); put interaction in small client islands in separate files.
- `meta.mjs`: `export const meta = { id: 'vNN', name: '<concept name>', concept: '<one line>' }`.
- `copy.mjs` (or similar): all English copy for the page lives in your folder.
- Styles: a CSS Module (`Home.module.css`) or plain CSS imported by `Home.jsx`, scoped to your page. No Tailwind, no new runtime dependencies, no animation or 3D library.
- Fonts: self-host. Put latin-subset `.woff2` files in `vNN/fonts/` (download from the font's official source, e.g. the Google Fonts CSS API with a modern user agent, or the foundry's release) and declare `@font-face` with `font-display: swap` in your CSS. At most 4 font files on the first load. Use the fonts your brief names; if one cannot be self-hosted, pick the closest open-licence font and say so.
- `README.md`: concept name, one-line pitch, a table of every brief item and where on the page it is used, and screenshots (`vNN/screens/desktop.png` at 1440 px and `vNN/screens/mobile.png` at 390 px, full page, light). The orchestrator adds Lighthouse numbers.

## Content rules
- Lead with business teams on their own domain (info@, sales@, invoices@); solo Claude / ChatGPT users second. Primary CTA: Start free (`/signup`); secondary: install in Claude or ChatGPT (`/connect`, `/docs/clients`).
- Must-have sections: providers, pricing (all plans incl. Business per person, from `stripePrices`/`businessSeat`, names via `planDisplayName`, honour `eurEnabled` like `Sections.jsx` Pricing does, or reuse that `Pricing` component), security and where data is stored (Stockholm), reviews (from `reviews.mjs` only), FAQ, how it works.
- Copy: keep today's SEO terms and facts, rewrite the wording in your brief's voice. Name is "MCPEmails" (one word). No em dashes. No SOC 2. Never "30 days". No hard-coded tool count. No plan slugs. No Fastmail OAuth or JMAP (Fastmail uses an app password). Mail is fetched live and never stored; credentials encrypted at rest; data stored in Stockholm. Copy must match what the code does: check `messages/en/home.json`, `apps/web/src/i18n/seo.ts` (featureList) or the docs when unsure.
- Nothing from `banned.md`. No invented logos, quotes, numbers or user counts. Provider logos only to name providers.
- Marketing layout is left-aligned: never centre blocks of content.

## SEO rules (non-negotiable; `node scripts/home-lab/seo_check.mjs 'http://localhost:3220/?home=vNN'` checks them)
- Exactly one H1. The H1 and the first paragraph keep the main terms: email MCP server, MCPEmails, Claude, ChatGPT, connector, Gmail, Outlook, IMAP.
- All copy server-rendered and readable with JavaScript off. No client-only hero.
- At least the baseline's word count, in real sections with H2s.
- Every internal link listed in `baseline.md` stays on the page (a full footer is the usual home for most of them).
- The FAQ is visible and uses exactly `faqItems` (the same `home.faq.items` the FAQPage JSON-LD uses): every question and answer shown. Answers contain light markup from the messages file; render them like `Sections.jsx` `Faq` does.
- Images: width, height and descriptive alt; decorative ones `alt=""`. The LCP element is text or a preloaded AVIF. Use `<picture>` with AVIF + WebP from `assets.json`. Lazy-load below the fold. Video: `muted loop playsInline preload="none"` with a poster, and under `prefers-reduced-motion` show the poster only.
- Landmarks `header`, `main`, `nav`, `footer`; heading levels never skip.

## Performance budgets (mobile Lighthouse on staging)
Performance at least 95, LCP under 1.8 s, CLS under 0.05, TBT under 150 ms, first-load transfer at most 350 KB excluding lazy media. Reserve space for every image and video (no layout shift).

## Craft
- Use every brief item visibly; your README says where. The brief is literal, not a mood board.
- Use `variant_seed` from your brief for small choices you would otherwise make by taste (accent placement, section rhythm, which tint): `const rng = mulberry32(variant_seed)` in a tiny helper in your folder, and say in the README which choices it made.
- Real assets only from `assets.json`. Never a placeholder, stock or AI image. If something your brief needs is missing, use the closest real asset and list the missing one in your report.
- WCAG AA contrast, visible focus states, keyboard reachable, works with reduced motion.

## How to check your page
A shared staging dev server runs at `http://localhost:3220` from this worktree with hot reload. Your page: `http://localhost:3220/?home=vNN`. Check it with `curl` (HTML without JavaScript), the SEO script above, and screenshots from headless Chrome:
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir=home-lab/work/vNN/chrome --hide-scrollbars --window-size=1440,900 --screenshot=<file>.png 'http://localhost:3220/?home=vNN'` (use a tall window height for full-page shots). Look at your screenshots (Read the PNG) and fix what looks wrong. Run `cd apps/web && npx eslint components/home-lab/vNN --max-warnings 0` and `npx tsc --noEmit` and fix every issue in your folder. Scratch files go to `home-lab/work/vNN/` (not committed).

## Final report (under 300 words)
Concept name and pitch, the SEO script's pass line, word count, anything you could not do, missing assets, and any request for a change outside your folder.

## Asset notes from the orchestrator (2026-11-12)
- `a/` (agent A): real product shots and clips, light. There are NO Claude or ChatGPT screenshots or clips. Where a brief asks for a chat transcript, client tabs or a chat screenshot, use the real in-chat draft card shots and clips (`a/card-*`, they are the product's real card) and the diagrams; never build or draw a fake Claude or ChatGPT interface, and do not use their logos.
- The draft card's button says "Send email" / "Send"; a held send says "Approve in browser". Use the product's real words.
- `c/` (agent C): diagrams, provider logo wall, icons, OG candidates. Gmail connects with a Google app password over IMAP; only Outlook / Microsoft 365 uses Microsoft sign-in. Fastmail and Yandex are letter tiles. The Zoho mark is rough at small sizes: prefer the logo wall or a text label for Zoho.
- `b/` (agent B, 3D objects) is still in progress; briefs v01 to v05, v07 and v10 do not depend on it.
- Phone screenshots: headless Chrome's `--window-size` cannot go below about 500 px, so use the DevTools-protocol script `home-lab/work/v04/cdp/shot.mjs` (read it for usage) for anything at 390 px.
- `businessSeat` copy contains "150 email actions a month": leave that line out (no action caps in customer copy). The FAQ answer about tools says "Twenty-one action-based tools": render the FAQ unchanged (it must match the JSON-LD); that copy is fixed separately.
- `b/` (agent B): 3D stills are ready in `apps/web/public/home-lab/assets/b/`: `card-*` (the draft card as a physical slip with an approve stamp), `envelopes-*` (stack with a cobalt chevron lining), `postbox-*` (cobalt postbox on a round base), `rack-*` (pigeonhole rack with letters), each `-hero` (about 1600 px) and `-small`, AVIF + WebP, white/transparent background; plus `paper-grain.svg`, `ruled-letter.svg`, `lining-chevron-cobalt.svg`, `lining-chevron-light.svg` textures. Turntable clips may land later. If their `assets.json` entries are not there yet, read the width and height with `node -e "require('sharp')('<file>').metadata().then(m=>console.log(m.width,m.height))"` from `apps/web`, and write your own descriptive alt text.

## Performance pass (orchestrator, 2026-11-12 evening)
Measured with Lighthouse mobile on a local staging production build. Locally today's page (v00) scores 92 to 95 with LCP 2.8 to 3.3 s and 344 KB (production measures 99 to 100), so locally the bar is: perf at least v00's (95 in a good run), LCP at or under about 2.8 s, CLS under 0.05, first-load transfer at most 350 KB excluding lazy media.
- `preload()` from `react-dom` does NOT reach the HTML here: the head is flushed before the page renders, so the hint only arrives in the RSC payload. Instead render real elements as the FIRST children of your page body, e.g. `<link rel="preload" href={fontUrl} as="font" type="font/woff2" crossOrigin="anonymous" />` for the one font your H1/lead paints in, and `<link rel="preload" as="image" href=... type="image/avif" media="..." fetchPriority="high" />` only if your LCP is an image. Check with `curl -s 'http://localhost:3220/?home=vNN' | grep -o '<link rel="preload"[^>]*>'` that they are in the HTML before your `<h1>`.
- Text LCP is held back by font swap: preload the LCP font (above), keep at most 2 font files on the first view, and give each webfont a metric-matched fallback (`@font-face { font-family: 'X Fallback'; src: local('Georgia' or 'Arial'); size-adjust; ascent-override; descent-override; }`) so the swap does not shift layout.
- Images: every `<picture>` lists `type="image/avif"` before WebP, phone-width sources (`a/*-mobile*`) under `media="(max-width: 767px)"`, and everything below the first screen has `loading="lazy"`. Video posters below the fold must be lazy too (use an `<img loading="lazy">` poster, or `preload="none"` plus a lazy picture).
- Shared cost you cannot change: Geist latin (29 KB) is preloaded by the root layout on every page.
- The shared dev server runs again at http://localhost:3220. Never run a build.
