# MCPEmails

Instructions for every coding agent working in this repository. Nested files add rules when you work in their folder: `apps/web/CLAUDE.md` and `supabase/functions/mcp-server/CLAUDE.md`.

This repo is public. Never commit customer email addresses, customer or company names, revenue figures or credentials, and never paste them into PR text.

@~/.claude/mcpemails-private.md

## Layout

- `apps/web`: Next.js 16 site, dashboard and API routes (mcpemails.com), deployed by Vercel.
- `apps/client`: Vite + React web mail client (app.mcpemails.com).
- `apps/mcp-app`: the in-chat draft card. Its build is generated into `supabase/functions/mcp-server/ui/review-card.html.ts`.
- `supabase/functions`: Deno edge functions. `mcp-server` is the product; also `client-api`, `system-notify`, `synthetic-monitor`, `outlook-token-refresh`.
- `supabase/migrations`, `supabase/tests`: schema, RLS and pgTAP tests.
- `self-host/`: Docker self-host stack. `self-host/db/00-schema.sql` must keep up with what mcp-server queries (a test enforces it).
- `packages/mcpemails`: the npm package. `tools/video-studio`: video pipeline (read its `AGENTS.md`).

## Shipping

IMPORTANT: a push to `main` is a production deploy of the web app. Vercel promotes only after the `CI passed` check in `.github/workflows/ci.yml` is green, and there are no preview deploys. When you add a CI job, add it to that job's `needs:` list, and never rename `CI passed`.

- Other sessions work in this repo at the same time. Never switch branches or `git checkout -b` in the main checkout; work in a git worktree. Stage explicit paths only, and never commit or deploy files you did not change.
- Before redoing work, check git and open PRs: another session may already have done it.
- `gh auth switch --user Albretsen` is always available. When a `gh` command (merging, auto-merge, workflow dispatch) is refused for permissions, switch to that account and retry rather than stopping.
- Decide whether something shipped by grepping the content of `origin/main`, never by commit ancestry.
- "Done" means merged, deployed to every surface the change touches (web, edge functions, migrations), and checked in production. Say which surfaces you deployed.
- Never run `vercel --prod` from a worktree: the CLI walks up to the main checkout's `.vercel` link and uploads that tree, including other sessions' uncommitted files. Pushing to `main` is the web deploy.
- Edge functions: apply migrations first, then deploy the function. Use the `deploy-edge-function.yml` workflow from `main` with `-f target=production` (its default target is staging), or `npx supabase functions deploy <fn> --project-ref swvaxorwumispmjaaszb --no-verify-jwt --use-api`. If that returns 413 "exceeds the maximum deployment size (5 MB)" (client-api does since 2026-10-24), drop `--use-api` so the CLI bundles with Docker; the workflow does this on its own. `node scripts/edge-function-size.mjs <fn>` shows how close a function is. Never use the Supabase MCP deploy tool, and never omit `--no-verify-jwt`.
- `functions deploy` uploads the working tree, not a commit. Deploy from a clean worktree at the pushed SHA, after checking `git rev-list --left-right --count HEAD...origin/main` is `0 0`.
- After a web deploy, verify a route with `curl -sI <url> | grep -i x-matched-path`, not the status code: an unmatched route can still answer 200.
- After any change in `apps/mcp-app/src`, or in `supabase/functions/mcp-server/html-text-merge.ts` or `quoted-reply.ts` (the card imports both), run `cd apps/mcp-app && npm run build` and commit the regenerated `review-card.html.ts`, or CI fails.

## Staging

A full copy of the stack for end-to-end checks: `staging.mcpemails.com` (web) and `app-staging.mcpemails.com` (client) on the Vercel projects `mcp-emails-web-staging` and `mcp-emails-client-staging`, a separate Supabase project and a Stripe sandbox. Both Vercel projects build the long-lived `staging` branch as their production branch.

- A change that needs an end-to-end check (billing, auth, OAuth, mail, cron, the web client) goes to `staging` first, then to `main`. Everything else goes straight to `main` as before.
- `sync-staging.yml` fast-forwards `staging` to `main` every Monday and fails if staging has commits main lacks. Get those into `main` or drop them before the sync.
- Name the staging Supabase project only through `vars.SUPABASE_REF_STAGING`; never hardcode its ref.
- Migrations reach staging through `migrate-staging.yml` (push to `staging`), the only place `db push` is allowed. It refuses the prod ref. Production keeps the manual apply under Database.
- Edge functions: `gh workflow run deploy-edge-function.yml --ref staging -f function=<fn>` (staging is the default target). If it fails 403, the repo token lacks staging access: deploy with the CLI from a clean worktree at `origin/staging`, passing the staging ref.
- Never put a production key, secret or webhook in staging. Staging secrets live in `~/.config/mcpemails-staging/staging.env`, outside the repo.
- Seed test users with `node scripts/seed-staging.mjs` (dry run, then `--apply`). Set up the Stripe sandbox catalog and webhook with `node scripts/stripe-staging-setup.mjs`. Both read `staging.env`, never `apps/web/.env.local`.

## Sessions and hand-off

Asgeir runs many sessions at once and reads a twice-daily brief built by `scripts/state-snapshot.mjs`. These rules keep that brief accurate.

- A session that starts more than 2 child sessions creates a sidebar group named after itself and moves its children into it.
- WIP cap: at most 3 PR-producing sessions in flight, plus up to 2 read-only ones. Before starting another, count the open ones; if at the cap, propose instead of starting.
- A large research fan-out ends in a ranked list for Asgeir to pick from. It does not auto-start the follow-up sessions.
- Every session ends with one line per open or finished item, in its final message and in the relevant memory file:
  - `OWED: <what> (due YYYY-MM-DD)` for anything still waiting on someone, including a read-out or a check in production.
  - `DONE: <what> (PR #n)` for anything that shipped.
- Use full dates (`2026-11-14`, not `11-14` or "next week") in those lines. The collector only picks up dated lines.

## Commands

npm only, one root `package-lock.json`, Node 24 from `.nvmrc`. Run `npm ci` at the root of a new worktree (a symlinked `node_modules` breaks Turbopack). If npm rewrites thousands of lockfile lines in an unrelated change, revert the lockfile.

- Web: `cd apps/web && npx tsc --noEmit`, `npm run lint` (zero warnings), `npm test`, `npm run build`. Targeted suites are the `test:<area>` scripts in `apps/web/package.json`.
- `npm test` in `apps/web` runs every suite and ends with an `N/N suites passed` line. Read that line and the exit code, not the scrollback.
- Build with `npm run build`, never bare `npx next build`, which can pick up a different Next version in a worktree.
- Draft card: `cd apps/mcp-app && npm run typecheck && npm test`.
- Web client: `cd apps/client && npm run typecheck && npm test && npm run build`.
- Edge functions: `deno check --node-modules-dir=none supabase/functions/<fn>/index.ts` and `HOST_GUARD_SKIP_NETWORK_TESTS=1 deno test --node-modules-dir=none --allow-read --allow-env --allow-run=git supabase/functions/<fn>/`. Run the `deno check` after touching `mcp-server/index.ts`: a syntax error there otherwise only shows up as a failed deploy.
- Database: `supabase db start && supabase test db` applies every migration and runs the RLS tests.

## Database

- Never run `supabase db push`. Apply one migration with `npx supabase db query --linked -f <file>`, then `npx supabase migration repair --status applied <version> --linked`.
- Always pass `--linked` to `db query`. Without it the query hits a local database and returns plausible but wrong rows.
- `apps/web/.env.local` points at the production project: local dev reads and writes live rows.
- PostgREST cuts any select off at 1000 rows without an error. Aggregate in SQL, or page with `.range()` and a total order. Call `rpc` as `supabase.rpc.bind(supabase)` when passing it around.
- RPCs gated on `auth.uid()` or `my_workspace_ids()` return zero rows under the service-role client. Never treat that empty result as a real answer (for example by falling back to `'free'`).
- Count signups with `public.signup_scoreboard()`, never `count(users)`.
- `apps/web/src/types/database.types.ts` is generated: run `npm run gen:types`, never hand-edit it, never cast around it with `as any`.
- Prefer the Supabase and Stripe CLIs and REST APIs over their MCP connectors, which fail often.

## Public copy and claims

- Never claim SOC 2, even as "in progress". Data is stored in one region, Stockholm.
- Customer-facing copy never mentions action caps, never says "30 days" (the refund window is 14 days), and never shows raw plan slugs (use `planDisplayName`).
- The product is "MCPEmails", one word, camel case, in anything a customer or an AI engine reads (page titles, JSON-LD, copy, emails, tool descriptions). Lowercase `mcpemails` appears only in the domain, the npm package and ids. "MCP Emails" survives only in the JSON-LD `alternateName` list.
- No em dashes. Avoid common signs of AI writing (filler, "the honest answer is", stacked adjectives).
- Copy must match the code. Do not hardcode a tool count, and do not claim Fastmail OAuth or JMAP (Fastmail connects with an app password only).
- The pre-commit hook in `.githooks/` blocks customer addresses under `docs/` and untracked working briefs. A fresh clone must run `git config core.hooksPath .githooks`.

## Changelog

When a PR ships something a customer would notice, add an entry to `apps/web/src/lib/changelog/entries.mjs` in the same PR. Read that file's header comment first; it is the full rulebook.

- One or two sentences on what changed for the customer. If the change is a fix, describe what was broken before. Date it the day it lands on `main`.
- Positive or neutral wording only. Describe what works now. Do not describe something that was removed, withheld or made worse.
- Never add an entry about pricing, plans, usage limits or billing, even when a price or limit moved.
- Leave out internal work: CI, tooling, admin and kiosk pages, analytics, internal email settings, refactors, dependency bumps, and perf work a customer cannot feel.
- Leave out anything still behind an internal rollout flag (for example the draft editor card) until it is on for customers.
- Style: straight apostrophes, no em dashes, no angle brackets (`<` breaks next-intl in production).
- Keep the `getEntries`, `getEntriesByMonth` and `getLatestDate` exports; the page imports them.
