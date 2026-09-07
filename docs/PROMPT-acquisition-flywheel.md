# Keep the acquisition flywheel compounding

You are working on top-of-funnel growth for MCP Emails (`apps/web`, Next.js 16 App
Router, Supabase backend, deployed on Vercel). Today is 2026-09-07.

Signups are accelerating with zero paid spend: **118 in the last 7 days against 86 the
week before, 423 workspaces all time.** Nothing is on fire. Your job is to keep a
working thing working and to widen it, which means resisting the urge to rebuild
anything. Most of the obvious work here is already done, and a plan that treats it as
undone will waste weeks.

**Read the "already done" section before you propose anything.** Several previous
passes have re-discovered the same finished work and re-recommended it.

Style rule for anything you write into this repo: never use em dashes (`—`). Use
commas, periods, colons or parentheses.

## Blocker zero: acquisition attribution is still broken, and it gates everything else

You cannot rank channels while half the data is dark, so fix this first or explicitly
argue why not.

A fix landed in commit `5c740a2` ("fix(analytics): attribute the signups that start on
the login page"). `appendAcquisitionParams` is now called in `buildOAuthUrl` in
`apps/web/components/auth/LoginApp.jsx`, and `isNewAccountSignup` exists in
`apps/web/src/lib/acquisition-context.mjs:147` to stop the callback stamping a false
first touch on old accounts. That work is real and it is committed.

**It did not move the number.** Verified against prod today, `acquisition_source` NULL
rate by signup week:

| week of | signups | null | % null |
|---|---|---|---|
| 2026-08-03 | 26 | 15 | 57.7 |
| 2026-08-10 | 46 | 21 | 45.7 |
| 2026-08-17 | 62 | 34 | 54.8 |
| 2026-08-24 | 83 | 51 | 61.4 |
| 2026-08-31 | 107 | 54 | 50.5 |
| 2026-09-07 (partial) | 22 | 13 | 59.1 |

Attributed sources all time: direct 76, organic_google 48, other 25, reddit 9,
smithery 1, **NULL 264**.

So roughly 55% of signups are still unattributed after the fix shipped. Find out why
before anything else. Candidate explanations to test, not assume:

- Is `5c740a2` actually deployed to production, or only merged? Check the deployed
  bundle, not the repo.
- `AcquisitionCapture` is mounted in `apps/web/app/layout.js` and writes sessionStorage
  key `mcpe-acquisition`. Does sessionStorage survive the OAuth round trip through
  Google and back? A cross-origin redirect can land the user on a fresh tab or a
  different storage partition.
- Are there signup entry points other than `/signup` and `/login` (an invite link, a
  deep link from a connect page, a `?redirect=` flow) that never mount the capture?
- Is the callback's `.is('acquisition_source', null)` guard combined with
  `isNewAccountSignup` accidentally rejecting real new accounts? The window is 2
  minutes for clock skew; check whether OAuth account creation actually completes
  inside it.

Deliverable for this part: the root cause with evidence, and a fix. Instrument the
failure so it cannot silently regress again. Note that historical NULLs stay NULL
forever, so every channel percentage in this repo is a ratio between attributed
channels, never a level.

## What is ALREADY DONE. Do not re-propose any of this.

**Directory and registry distribution is essentially complete.** Verified live:
official MCP registry (`com.mcpemails/emails`, published 2026-06-10), npm
(`mcpemails`), Glama (grade A, maintenance B), Smithery (namespace is `bjellanda`, not
`Albretsen`), PulseMCP, mcp.so. Two awesome-lists merged: TensorBlock (2026-08-30) and
**punkpeye/awesome-mcp-servers, 94.5k stars, merged 2026-09-07**, which is the highest
authority list in the category and the one most aggregators scrape.

**The 106 provider pages are built, merged and deploying.** `/connect` hub plus
`/connect/<slug>`, 133k words, mean 1254 words per page, every IMAP host verified by a
live TLS probe and CAPABILITY banner. Architecture: `src/lib/connect/providers.mjs` is
the generated registry (the only source of hosts and ports),
`src/lib/connect/content/<locale>/<slug>.json` is the prose, and
`src/lib/connect/release.mjs` gates a 10-wave weekly rollout. Status today:

```
public today : 22 of 106
next wave    : 11 pages on 2026-09-14
wave 10      : 2026-11-02
```

`npm run connect:release-status` prints this. Unreleased slugs return 404 by design (a
404 costs no crawl budget, a noindex page still gets fetched). Every route is dynamic,
so a wave opens on its date with no deploy.

**`/connect/imap` already exists** and shipped in wave 1. Older notes in the memory
store claim "generic_imap has no landing page". That is stale. Verify before repeating
it.

**SEO is technically clean.** All 42 sitemap URLs audited 2026-08-31: 200s,
self-canonical, one H1, no stray noindex, fully server rendered, correct structured
data, 0.31 to 0.59s TTFB. Two false alarms that must never be re-raised: hreflang
renders as camelCase `hrefLang=` in Next 16 output and is correct (HTML attributes are
case-insensitive, verified in a real DOM), and measuring visible text with a greedy
`sed 's/<script.*<\/script>//g'` deletes the whole body and makes SSR pages look
client-rendered (use a non-greedy Python regex).

## What is genuinely open, roughly in order of expected value

Treat this as a starting list, not a work order. Re-rank it with evidence and say why.

1. **The ChatGPT apps directory has never been attempted.** `onboarding_client` shows
   chatgpt (11) tied with claude (11), so this is not a Claude-only audience. OpenAI
   runs submissions through the Developer Platform (the app directory folded into the
   Plugin directory 2026-07-09), six steps, one to two weeks review, and it accepts
   MCP-backed apps. Unlike the Claude directory it does **not** require buying a Team
   seat, so it is the cheaper of the two remaining big surfaces. Requires verified
   identity rather than just a form.

2. **The Claude connector directory is blocked, not undone.** Blockers are a Claude
   Team Owner seat (a real cost) and an unresolved Policy 3.F question. Resolve the
   policy question first; do not buy the seat before you know the answer.

3. **`/docs/<client>` pages do not exist and are uncontested.** Competitor mailmcp.io
   has 13 of them and anymailmcp has zero. Today this repo has only
   `apps/web/app/[locale]/docs/page.js` and `docs/providers/page.js`. Pages for Claude
   Desktop, Claude Code, Cursor, ChatGPT, Continue, Cline and so on are the highest
   intent queries in the category and nobody owns them.

4. **`/for/<persona>` is a template with exactly one member.**
   `apps/web/app/[locale]/for/founders/page.js` is the only one. The highest-value
   customer segment discovered so far is a one-operator business connecting
   departmental mailboxes (finanzas@, ventas@, photo@). A separate plan covers that
   segment; coordinate rather than duplicate, see
   `docs/PLAN-multi-mailbox-business-segment.md`.

5. **Backlinks are the actual ceiling.** 38 referring domains against funded
   competitors carrying hundreds. Average SERP position is 13, which is page two, and
   that caps everything downstream. CTR at that position is 3.1% against an expected
   1.5 to 2.5%, so the titles are already outperforming the rank. More pages will not
   fix a link problem.

6. **`tolkonepiu/best-of-mcp-servers` PR #386** is open, unreviewed, no bot gate, no
   comments. Just needs a nudge.

7. **The README carries no Glama or registry badges.** Free trust signal, five minutes.

8. **The registry DNS TXT is stale**: `mcpemails.com` publishes `p=UhenYTXN...` while
   the working HTTP auth key is `p=GkPwbyqC...`.

## Hard constraints on strategy

- **Gmail is the worst keyword territory available.** Google ships an official
  first-party remote Gmail MCP server, Anthropic shipped native Gmail send/reply/forward
  on 2026-08-18, and Fastmail shipped its own MCP in April 2026. Defensible ground is
  what the platforms will never build first-party: Yahoo, iCloud, Zoho, Yandex, GMX
  Mail, regional ISPs, cPanel hosts. This also matches retention: generic IMAP is the
  best-retaining provider cohort (65% active at 7 days, 566 average calls) and Gmail is
  the worst real provider (39%).
- **Page count is not the win.** anymailmcp has 101 provider pages and across seven
  exact-match test queries one surfaced exactly once, and it was their generic cPanel
  page. mailmcp's 8 guides out-rank anymailmcp's 101. Do not read a competitor's page
  count as evidence that thin pages work.
- **Ads are uneconomical**: break-even CPC is $0.06 at $5 ARPU. Revisit only if the
  paid mix shifts materially toward Pro.
- **Show HN is a spent lever.** It ran 2026-08-29 and got zero traction. Do not
  re-propose it.
- **Do not deploy or push without confirming with the founder.** The project is live
  with paying customers. A push to `main` IS a production deploy on this repo.

## Repo mechanics you will trip over

- `@/` maps to `src/` only. `@/components/...` does not resolve; components live at
  `apps/web/components/`. Use relative imports from `app/`.
- `RichText` renders React text children, so HTML entities are never decoded. Write a
  bare `&`, never `&amp;`. Only `<code>` and `<b>` are supported, and only in fields
  passed through RichText (not `hero.answer`, `*.h`, `faq.q`, `meta.*`).
- Per-page marketing copy must NOT live in `messages/` next-intl namespaces, because a
  namespace ships to every page. That is why connect content is per-slug JSON.
- next-intl ICU escaping is dev-only: `'<'` unescapes in dev but renders literally in
  prod. Reword rather than escape, and verify with a production build.
- Every connect slug must match `/connect/[a-z0-9-]+` or acquisition attribution
  silently drops the landing path (`safeLandingPath` in `src/lib/acquisition-context.mjs`
  and the CHECK constraint on `workspaces.acquisition_landing_path` that mirrors it).
- Use `npm run build`, not bare `npx next build`: `npx` resolves the ancestor repo's
  Next version in a worktree.
- Tests: `npm run test:seo`, `npm run test:connect-release` (8 tests, includes "no page
  links to a 404").
- Querying prod: `npx supabase db query --linked -f file.sql` from the repo root. You
  MUST pass `--linked` or it silently runs against an empty local database and returns
  wrong answers. Read-only. PostgREST caps row-returning selects at 1000 rows silently,
  so aggregate in SQL.

## Deliverables

1. Root cause and fix for the 55% attribution gap, with a regression guard.
2. A re-ranked plan for the open items above, with your reasoning and rough cost per
   item, explicitly marking what you are NOT doing and why.
3. A recommendation on the wave schedule: wave 2 went live today, so by the time you
   read this there is real wave-1-versus-wave-2 data. Measure whether the released
   pages are producing signups before committing the remaining 84 pages to the format.
   Accelerating, holding or pausing the schedule are all acceptable answers if the data
   supports them.
4. Whatever you actually ship, with the founder's confirmation before any deploy.

Where you are guessing, say so. Where the facts above turn out to be stale, correct
them and say which ones.
