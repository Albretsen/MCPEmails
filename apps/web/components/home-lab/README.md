# Homepage Lab (staging only)

Ten experimental English home pages (`v01` to `v10`) plus today's page (`v00`), flipped with a picker on `staging.mcpemails.com`. Production never builds any of it.

## How it is wired

- `app/[locale]/home-render.tsx` holds the home page's metadata, data loading and JSON-LD (FAQPage included). `app/[locale]/page.tsx` renders it with today's `HomeClient`, exactly as before.
- Each variant has its own route, `app/[locale]/home-lab/vNN/page.tsx`, which renders the same `renderHome` with that variant as the body. Separate routes mean each page ships only its own CSS.
- On staging, `proxy.ts` rewrites `/?home=vNN` (or the `home_lab` cookie) to that route at the same URL. `?home=v00` goes back to today's page. The decision is `homeLabRewritePath` in `src/lib/home-lab/select.mjs`.
- `next.config.js` aliases `home-lab-entry` (the picker) and `home-lab-v01` to `home-lab-v10` (the variants) to the real files only on staging builds (`NEXT_PUBLIC_APP_ENV=staging`) and to null stubs everywhere else, so production compiles none of it; the lab routes also 404 outside English staging.
- The picker shell (`components/home-lab-shell/`: `HomeLab.tsx`, `Picker.jsx`, `registry.mjs`) lives outside this folder on purpose. When it sat here, Turbopack grouped it with the variants and every variant's CSS loaded on every page.
- `registry.mjs` is generated from each `vNN/meta.mjs` by `node scripts/home-lab/sync_registry.mjs` (`--check` in tests).
- The picker sits bottom right, is `aria-hidden` with buttons out of the tab order (left and right arrow keys flip variants), and has no headings, so it never changes a variant's outline.
- `npm run test:home-lab` pins all of the above.

## Variant contract

Each `vNN/` folder is owned by one builder and holds:

- `Home.jsx`: default export, the whole page body below the root layout, including its own `header`, `nav`, `main` and `footer`. It receives `{ stripePrices, eurEnabled, businessSeat, faqItems, locale }`.
- `meta.mjs`: `export const meta = { id, name, concept }` for the picker (then run the sync script).
- `README.md`: concept, pitch, where each brief item is used, Lighthouse numbers, screenshots.
- Copy lives in a module inside the folder (English only; a staging experiment, not shipped copy).

Briefs, rules and assets: `home-lab/` at the repo root.
