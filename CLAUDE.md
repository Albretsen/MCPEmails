# MCPEmails

Instructions for every coding agent working in this repository. Nested files add rules when you work in their folder: `apps/web/CLAUDE.md` and `supabase/functions/mcp-server/CLAUDE.md`.

This repo is public. Never commit customer email addresses, customer or company names, revenue figures or credentials, and never paste them into PR text.

@~/.claude/mcpemails-private.md

## Layout

- `apps/web`: Next.js 16 site, dashboard and API routes (mcpemails.com), deployed by Vercel.
- `apps/client`: Vite + React web mail client (app.mcpemails.com).
- `apps/mcp-app`: the in-chat draft card. Its build is generated into `supabase/functions/mcp-server/ui/review-card.html.ts`.
- `supabase/functions`: Deno edge functions. `mcp-server` is the product; also `client-api`, `system-notify`, `synthetic-monitor`, `gmail-token-refresh`, `outlook-token-refresh`.
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
- Edge functions: apply migrations first, then deploy the function. Use the `deploy-edge-function.yml` workflow, or `npx supabase functions deploy <fn> --project-ref swvaxorwumispmjaaszb --no-verify-jwt --use-api`. Never use the Supabase MCP deploy tool, and never omit `--no-verify-jwt`.
- `functions deploy` uploads the working tree, not a commit. Deploy from a clean worktree at the pushed SHA, after checking `git rev-list --left-right --count HEAD...origin/main` is `0 0`.
- After a web deploy, verify a route with `curl -sI <url> | grep -i x-matched-path`, not the status code: an unmatched route can still answer 200.
- After any change in `apps/mcp-app/src`, run `cd apps/mcp-app && npm run build` and commit the regenerated `review-card.html.ts`, or CI fails.

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
- The product is "MCP Emails", with a space, in anything a customer reads.
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
