# Runbook: Pro $19 flip on 2026-12-08

Executed by scheduled Claude routines on 2026-12-07 (prepare only) and 2026-12-08 (flip, plus a later fallback). Owner approval: 2026-10-24. Safe to run more than once: step 0 stops a second run.

You are flipping the MCPEmails Pro price on its approved date. The owner (Asgeir) approved this on 2026-10-24: from 2026-12-08 (Oslo), new Pro subscriptions cost $19/month and $182.40/year; existing subscribers keep $15/$144. Act without asking anyone; nobody is watching. The repo is PUBLIC: never put customer emails, names, revenue or MRR figures in commits, PR text or comments. Read CLAUDE.md and apps/web/CLAUDE.md first.

STEP 0. Already done? Run `git fetch origin` and `git show origin/main:apps/web/src/lib/stripe/pro-price-change.ts | grep -n "priceLive:"`. If it says `priceLive: true`, the flip already shipped: do step 5 (verify) only, then stop.

STEP 1. Date guard. Run `date -u`. If it is earlier than 2026-12-07T23:00:00Z (2026-12-08 00:00 Oslo), do NOT merge. Only do step 2 and 3 (rebase and get CI green), then stop and report "prepared, not merged".

STEP 2. Rebase the flip PR. The PR is https://github.com/Albretsen/MCPEmails/pull/246, branch `claude/pro-price-19-flip`. Check out that branch and rebase it onto origin/main. In conflicts, keep main's new content and re-apply the price change on top of it. The rule: every Pro (internal id `solo`) price in copy moves $15 -> $19, $144 -> $182.40, $12 (yearly per month) -> $15.20, in each locale's existing number format (en/de "$182.40", es/nb "$182,40", fr "182,40 $"). Personal ($9/$86.40) and Business ($39/$374.40) never change. `apps/web/src/lib/stripe/pro-price-change.ts` must have `priceLive: true`. Then run `npm ci` at the repo root and, in apps/web: `npm run test:allowance` (personal-price-copy.test.ts lists EVERY stale price by file and line, including new copy that landed on main since the PR was written; fix each one), `npm run test:plans`, `npx tsc --noEmit`, `npm run lint`, `npm test` (read the final "N/N suites passed" line and the exit code), and `CI=1 NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key NEXT_PUBLIC_APP_URL=https://mcpemails.com NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_placeholder STRIPE_SECRET_KEY=sk_test_placeholder npm run build`. Never run bare `npx next build`. Grep for leftovers: `rg -n '\$15\b|15 \$|\$144\b|144 \$' apps/web README.md -g '!node_modules' -g '!**/.next/**'` and check each hit is not a Pro price (history comments in plans.ts are fine). Commit with explicit paths only and force-push the branch (`git push --force-with-lease`).

STEP 3. CI. Wait for the PR's checks to finish (gh pr checks 246 --watch, or poll the GitHub API every few minutes). The required check is "CI passed". If a check fails, read the log, fix, push, and wait again. Up to 3 fix rounds.

STEP 4. Merge (only past the date guard, with every check green). Mark the PR ready (`gh pr ready 246`) and merge with a merge commit (`gh pr merge 246 --merge`). If `gh` is unavailable or refuses for permissions, try `gh auth switch --user Albretsen` first. A push to main is the production web deploy: Vercel promotes only after "CI passed" on main is green. No migration and no edge function deploy are part of this change.

STEP 5. Verify production (wait for main's CI and the Vercel deploy, up to about 40 minutes, checking every few minutes):
- `curl -s https://mcpemails.com/pricing` contains "$19" and "$182.40" and the serialized price data for plan solo shows monthlyCents 1900 and yearlyCents 18240 with monthlyPriceConfigured and yearlyPriceConfigured true.
- `curl -sI https://mcpemails.com/pricing | grep -i x-matched-path` shows a matched route.
- `curl -s https://mcpemails.com/llms.txt` quotes $19 for Pro.
- The dated notice line ("Pro goes to $19") is gone from /pricing.

ROLLBACK RULE. If after the deploy /pricing shows Pro amounts other than 1900/18240, or a "*Configured" flag is false (that means the STRIPE_PRICE_SOLO_*_V2 env vars are missing in Vercel), revert the merge commit on main with a PR titled "Revert Pro $19 flip: <reason>", get CI green and merge it, so the site goes back to $15 consistently. Never leave $19 copy live with a checkout that cannot sell it.

REPORT. End with: what you did, the PR/merge commit, check results (the exact N/N line), and the production checks, and the line `DONE: Pro $19 flip (PR #246)` or `OWED: Pro $19 flip blocked: <reason> (due 2026-12-08)`.
