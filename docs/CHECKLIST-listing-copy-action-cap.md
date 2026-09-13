# Checklist: external listing copy vs the Free action allowance

Written 2026-09-12 for Phase 4 of `docs/PLAN-free-action-cap-150.md`. To be
worked through by a human, by hand, before the launch deploy (Phase 7 step 3)
and again within a day after it.

## The facts every listing must be consistent with

- Free: 1 inbox, **150 email actions per calendar month (UTC)**, the first
  7 days after signup not counted. `inbox_list` and the dashboard are never
  counted. At 150 every other email action is refused until the 1st of the
  next month; unattended automations pause and resume on the 1st; an email
  goes out at 80% and at 100%.
- Personal $5/month ($48/year), Pro $15/month ($144/year), Team $79/month:
  no monthly action cap, subject to fair use. **Never print a number for a
  paid tier.**
- Workspaces created before 2026-09-12 are early members and are not
  metered.
- Customer-facing unit: "email actions". Never print the internal ids
  (`solo` is Pro, `pro` is Team).

A listing is wrong if it says "unlimited", "no limits", "no caps", "not
priced by usage", or any number other than 150 about actions on Free, or
any number at all about actions on a paid tier. Old numbers that have
circulated and must not survive anywhere: 2,500, 5,000, 500 + 50/day,
50,000, 300,000, "Agent $12", "Scale $49".

## External listings (re-read by hand, edit where the platform allows)

| # | Listing | What to re-read | How to fix | Done |
| --- | --- | --- | --- | --- |
| 1 | Glama (`project_glama_grading_unblocked`) | Cached README render and the FAQ block (the Outlook FAQ line there is AI-generated, so the whole FAQ may carry stale numbers) | Re-cache from the repo README after this change lands; edit the FAQ by hand if it mentions actions | [ ] |
| 2 | Smithery | Description, README render, and the custom icon URL (still the old proxy URL, `project_favicon_ico_404`) | Edit by hand in the Smithery dashboard | [ ] |
| 3 | PulseMCP | Description and any "pricing" field | Email or edit form | [ ] |
| 4 | Docker MCP catalog | Description and README in the catalog entry | PR to the catalog repo | [ ] |
| 5 | mcp.so | Description (a correction ticket is already open, `project_directory_backlink_audit_20260910`) | Add the allowance to that ticket rather than opening a second one | [ ] |
| 6 | mcpservers.org (`/servers/mcpemails-com`) | Description | Edit form or email | [ ] |
| 7 | LobeHub | Description and README render | Re-sync from the repo | [ ] |
| 8 | freemcp.space (`project_freemcp_space_listing_20260910`) | Cached tool descriptions and the 7 prompts | **API re-cache is required** after any tool or description change (there is no edit UI). Never click Load Capabilities, Deploy or Sandbox (they build our repo) | [ ] |
| 9 | Cursor directory (cursor.directory) | Description | Edit or resubmit | [ ] |
| 10 | Claude Directory submission (`docs/claude-directory-submission.md`, In review since 2026-09-09) | The submission text says **5,000 actions per calendar month** in three places (see grep below). If the reviewer asks, or if the submission is reopened for edits, replace with 150/month, first 7 days uncounted. Do not withdraw the submission to fix a number | Edit the portal text if it is editable; otherwise fix on the next revision | [ ] |
| 11 | MCP registry `server.json` (repo root) | `description`: "Never-stored live email: read, send, organize, schedule and auto-triage Gmail or any IMAP mailbox." Says nothing numeric. No change needed, but a re-publish needs HTTP auth (`reference_publishing_npm_and_registry`) | None | [x] verified 2026-09-12 |
| 12 | npm README (package `mcpemails`) | Publishing is BLOCKED (`project_npm_publish_blocked_no_totp`), so whatever README is on npm today is the last published one. Check npmjs.com/package/mcpemails for "unlimited" or an action number | Cannot be fixed until publishing is unblocked; note the discrepancy on the package page if it exists | [ ] |
| 13 | `glama.json` (repo root) | No description field with a claim about actions (verified 2026-09-12) | None | [x] |
| 14 | `llms-install.md` (repo root) | No pricing claims (verified 2026-09-12) | None | [x] |
| 15 | Google Business Profile | Description | Edit by hand if it mentions "unlimited" or "free with no limits" | [ ] |

## Our own pages and copy: grep results

Run 2026-09-12 from the repo root with
`LC_ALL=C grep -rniaE "unlimited|no limit|no cap|not by how many|priced by|by connected inboxes|5,000|2,500|actions per"`
over `apps/web/messages`, `apps/web/components/marketing`, `apps/web/public`,
`apps/web/src/lib/compare`, `docs/claude-directory-submission.md`,
`server.json`, `glama.json`, `llms-install.md`. Every hit below was read in
context. "Inboxes", "API keys" and "members" hits are true statements about
those units and are listed only so nobody has to re-check them.

### MUST change (still false after Phase 4, in files Phase 4 does not own)

| path:line | Text | Why it is wrong | Owner |
| --- | --- | --- | --- |
| `apps/web/public/llms.txt:5` | "no daily caps, unlimited inboxes and API keys, and 2,500 billable actions per billing period ... Agent and Scale add larger action allowances" | Two pricing generations stale: Free is 1 inbox and 150 actions/month, there is no Agent or Scale, paid tiers have no printed number | Whoever owns `apps/web/public` (marketing/SEO); rewrite the whole pricing sentence | 
| `apps/web/public/llms.txt:12` | "Pricing: Free (no card, unlimited inboxes and API keys, 2,500 actions per billing period), Agent $12/mo (50,000 actions), Scale $49/mo (300,000 actions)" | Same. Replace with the four-tier facts above | Same |
| `apps/web/messages/en/home.json:126` (and the es/fr/nb/zh equivalents on the same line) | `pricing.title`: "Priced by inbox, not by usage." | Free now has a usage allowance. Suggest "Priced by inbox. Free includes 150 email actions a month." or drop the second clause | Home page owner (`home.json` is not a Phase 4 file) |
| `apps/web/src/lib/compare/email-mcp-servers.mjs:110` | `price: 'Free: 1 inbox, 60 requests a minute, no daily call cap. ...'` | Literally true (no daily cap) but next to competitors' per-day and per-month numbers it reads as "unlimited". State "150 email actions a month, first 7 days uncounted" | Compare page owner (`/best-email-mcp-servers`, the old `/email-mcp-servers-compared` route redirects there via `apps/web/proxy.ts:51`) |
| `apps/web/src/lib/compare/email-mcp-servers.mjs:248` | Free tier row, `us: '1 inbox, 60 req/min, no daily cap.'` | Same as above | Same |
| `docs/claude-directory-submission.md:56` | "Free plan cap is 5,000 actions per calendar month." | Old silent ceiling. Now 150/month public allowance, first 7 days uncounted; the reviewer workspace predates launch so it is exempt (D8 in the plan) | Directory submission owner |
| `docs/claude-directory-submission.md:249` | "Free covers one inbox and 5,000 actions a month." | Same | Same |
| `docs/claude-directory-submission.md:333` | "5,000 actions per calendar month; more inboxes need a paid plan from $5/month." | Same | Same |

### SHOULD review (true or nearly true, but worth a read by the owner)

| path:line | Text | Note | Owner |
| --- | --- | --- | --- |
| `apps/web/messages/en/dashboard.json:489` | `grandfatheredBody`: "... Personal keeps your unlimited inboxes and adds a higher monthly action ceiling, a faster burst limit ..." | Shown to pre-repricing users, who are all early members and therefore not metered. "Higher monthly action ceiling" is not a Personal delta for them. Phase 3 owns `dashboard.json` | Phase 3 |
| `apps/web/messages/en/home.json:137-175` | Home page plan cards: Free lists "Unlimited API keys", no allowance line | Not false. Consider adding "150 email actions a month, first 7 days uncounted" to Free and "No monthly action cap" to Personal so the home cards match the pricing cards | Home page owner |
| `apps/web/messages/en/home.json:207` | "Is there a free plan?" FAQ answer | Does not mention the allowance; not false. Consider one clause | Home page owner |
| `apps/web/messages/en/docs.json:62` | `infoRateLimits`: "... plus your plan's workspace ceiling" | Refers to the per-minute ceiling; fine as is | none |

### True, no change (listed so they are not re-checked)

- `apps/web/messages/*/pricing.json` "Unlimited API keys", "Unlimited connected inboxes" (Pro), "Unlimited members with roles" (Team), `comparison.values.unlimited` (used only for inboxes, keys, members): all about non-action units.
- `apps/web/messages/*/dashboard.json:116-117, 458, 472, 477, 486, 488` and `dashboardChrome.json:24, 180`: inboxes and members.
- `apps/web/components/marketing/PricingClient.jsx:76-77, 80`: `values.unlimited` on inboxes, keys, members only. The new `actions` row uses `values.actionsFree` / `values.actionsPaid`.
- `apps/web/components/marketing/Sections.jsx:689-769`: comments about the inbox grandfather.
- `apps/web/src/lib/compare/email-mcp-servers.mjs:251`: "Unlimited." is the self-hosted column, which is true.
- `server.json`, `glama.json`, `llms-install.md`, `lhm.plugin.json`: no action claims.

### Fixed by Phase 4 (2026-09-12), for the record

- `apps/web/messages/*/pricing.json` FAQ "What counts as an MCP call?" ("priced by connected inboxes, not by how many calls your agent makes") rewritten as "What counts as an email action?".
- `apps/web/messages/*/pricing.json` FAQ "What does Personal add over Free?" no longer says "We price by how many mailboxes you connect".
- `apps/web/messages/*/docs.json` `rateLimits.cap*` and `errors.rows.cap` no longer describe a silent ceiling that "is not something you buy your way past".
- `README.md` no longer says the ceiling "is never shown to customers, and cannot be bought past".

## After launch

- [ ] Open `/pricing` in all five locales and read the "Email actions per month" row and the three FAQ entries.
- [ ] Open `/docs#rate-limits` and read the "Monthly allowance" step and the error table's last row.
- [ ] Re-run the grep above; the MUST list should be empty.
- [ ] Re-cache freemcp.space (API), re-sync Glama and LobeHub, then spot-check each cached README for the new table row.
