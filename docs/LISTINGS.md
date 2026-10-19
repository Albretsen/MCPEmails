# Directory listing kit

The one source every external listing is synced from. Each fact below was read from code on 2026-10-19 (sources at the end). If code changes, change this file first, then the listings.

## Name

- Default: **MCP Emails**
- Where a title may not contain "MCP" or "Server" (Docker MCP catalog, Claude Directory slug): **Emails**
- Registry id: `com.mcpemails/emails`. npm package: `mcpemails`.
- Transport: **remote, Streamable HTTP** at `https://mcpemails.com/api/mcp` (OAuth 2.0 + PKCE, or a `mcpe_` API key as a bearer token). Optional: the `mcpemails` npm package, a **stdio bridge** to that same endpoint for clients that can only spawn a local command. Any listing that says "stdio" only is wrong. Never use the connect URL as a website link: a browser GET is a 405.

## One-liner (99 chars, fits the MCP registry's 100 cap)

> Never-stored live email: read, send and triage Gmail, Outlook / Microsoft 365, or any IMAP mailbox.

This is the `server.json` description verbatim. Keep them identical.

ACTION: the registry still serves v1.0.5, whose description says "...Gmail or any IMAP mailbox" (no Outlook). `server.json` in the repo is already 1.0.7 with this one-liner but was never published. Republish it (`mcp-publisher publish`, see the registry note in project memory for auth).

## Short description (297 chars)

> Hosted email for AI agents. Connect Gmail, Outlook / Microsoft 365 or any IMAP mailbox to Claude, ChatGPT, Cursor and other MCP clients, then read, search, send, organize, draft, schedule and auto-triage mail. Email is fetched live and never stored. Free for 1 inbox and 150 email actions a month.

## Long description

> MCP Emails is a hosted MCP server that gives your AI agent your real inbox. Connect Gmail, Outlook / Microsoft 365, Fastmail, iCloud, Yahoo, Zoho or any IMAP/SMTP mailbox once, add https://mcpemails.com/api/mcp to Claude, ChatGPT, Cursor, VS Code or any MCP client, and your agent can read, search, send, reply, forward, organize, draft, schedule and auto-triage email.
>
> Email is fetched live from your provider on every call and never stored. Outbound mail is sent by your own provider from your real address. If a provider refuses connections from cloud addresses, the connection goes through our own relay instead, a plain tunnel; TLS still runs end to end to your provider, so the relay never sees your mail or password. Credentials are encrypted at rest. Permissions are scoped per API key and per inbox, so a key can be read-only, or allowed to send but never delete. Clients that support MCP Apps get in-chat cards to review a held send, preview a bulk move or delete before it runs, and edit a draft.
>
> 19 tools, 7 workflow prompts (morning triage, follow-up radar, reply drafts, safe cleanup and more). OAuth sign-in for Claude, ChatGPT and Cursor; a scoped API key for everything else.
>
> Pricing: Free connects 1 inbox with 150 email actions a month (the first 3 days are not counted). Personal $9/month for 3 inboxes, Pro $15/month for unlimited inboxes, Team $79/month adds members, roles, SSO and an audit log. Paid plans have no monthly action cap (fair use).
>
> LIMITS: Gmail connects with a Google app password over IMAP. Gmail has labels, not folders: there is no copy, and delete moves to Trash (no permanent delete). Labels are Gmail-only; Outlook uses folders. Outlook search cannot combine text with the unread, attachment, flagged or date filters. Work or school Microsoft 365 accounts can need an IT admin to approve the app once; personal Outlook.com, Hotmail, Live and MSN accounts do not. A Microsoft account with no Exchange Online mailbox cannot connect. Plain IMAP servers cannot search by "has attachment".

Wording rule: never write "no relay", "nothing in between" or "never our mail relay". Since PR #109 (2026-10-15) IMAP and SMTP connections to a provider that refuses cloud addresses go through our tunnel (`supabase/functions/mcp-server/smtp-client.ts:283-297`, `smtp-relay.ts:26-30`). What stays true: the provider sends the mail, from the user's address, and TLS is end to end. Fix any listing that claims otherwise.

## Tools (19 model-visible)

`inbox_list`, `email_read`, `email_organize`, `email_search_and_move`, `email_delete`, `email_compose`, `folder_list`, `folder`, `draft_list`, `draft`, `schedule_list`, `schedule`, `signature_get`, `signature_set`, `automation_read`, `automation`, `contact_search`, `draft_read`, `draft_editor_hide`

A full-scope key's `tools/list` has 26 entries. The other 7 are app-only card plumbing and must not be listed as tools: `approval_review`, `approval_decide`, `approval_update`, `approval_schedule`, `bulk_execute`, `bulk_cancel`, `draft_editor_save`.

ChatGPT and Codex keys get a different, per-operation listing (one tool per action, for OpenAI's review rules). Quote 19 everywhere else. Do not quote the per-operation count on general directories.

## Prompts (7)

`morning_inbox_triage`, `find_and_brief`, `follow_up_radar`, `decision_tracker`, `prepare_reply_drafts`, `clean_up_safely`, `review_scheduled_sends`

## Providers

- Gmail and Google Workspace (Google app password, IMAP/SMTP)
- Outlook and Microsoft 365 (Sign in with Microsoft, Microsoft Graph)
- Fastmail, iCloud, Yahoo, Zoho, Yandex (app password)
- Any IMAP/SMTP mailbox, including mail on your own domain at a web host (IONOS, cPanel, Plesk and similar)

Full matrix: https://mcpemails.com/docs/providers. Do not advertise "Sign in with Google" for Gmail: it exists but is an unverified Google app with a lifetime 100-account cap.

## Pricing line

> Free: 1 inbox, 150 email actions a month (first 3 days uncounted). Personal $9/mo: 3 inboxes. Pro $15/mo: unlimited inboxes. Team $79/mo: members, roles, SSO, audit log. Paid plans: no monthly action cap. Annual saves about 20%.

Rules: the unit is "email actions". Never print an action number for a paid plan. Annual prices are $86.40, $144 and $756 a year.

## Icons

| Use | URL |
| --- | --- |
| Directories that draw the icon on their own background (LobeHub, Glama, mcp.so, PulseMCP, Claude Directory, Cursor, OpenAI) | https://mcpemails.com/icon.png (512x512 filled tile) |
| Theme-aware surfaces (MCP registry `icons`, Smithery) | https://mcpemails.com/connector-icon-light.svg and https://mcpemails.com/connector-icon-dark.svg (transparent glyphs) |

Glama takes its icon from the GitHub owner avatar; there is no repo field for it.

## Landing pages

| Page | Use for |
| --- | --- |
| https://mcpemails.com/docs/clients | General directories: the setup hub for every client |
| https://mcpemails.com/docs/<client> | Client-specific directories. Slugs: `claude`, `claude-code`, `chatgpt`, `cursor`, `vscode`, `cline`, `windsurf`, `gemini-cli`, `zed`, `jetbrains`, `raycast`, `warp`, `curl`. `/docs/claude-desktop` is a 404 |
| https://mcpemails.com/docs/providers | Provider matrix |
| https://mcpemails.com/connect | Per-provider connect guides |
| https://mcpemails.com/pricing | Pricing |

UTM scheme: `utm_source=<directory>&utm_medium=directory&utm_campaign=listing`. Use the exact `utm_source` values below: the site maps them to a fixed list of categories (see "What the UTMs record").

## Directories

| Directory | Listing | How it is edited | Landing URL | Followed links? |
| --- | --- | --- | --- | --- |
| Official MCP registry | https://registry.modelcontextprotocol.io/v0/servers?search=com.mcpemails/emails (API only, no page) | `mcp-publisher publish` of `server.json` with a new `version` | `websiteUrl` stays https://mcpemails.com (no UTM: it is an identity field) | n/a |
| npm | https://www.npmjs.com/package/mcpemails | `npm publish` of `packages/mcpemails` (README + `homepage`). Blocked: no TOTP | https://mcpemails.com/docs/clients?utm_source=npm&utm_medium=directory&utm_campaign=listing | no (nofollow) |
| Glama | https://glama.ai/mcp/servers/Albretsen/MCPEmails | Glama Admin > Profile (GitHub sign-in), then Sync Server; also re-reads README | https://mcpemails.com/docs/clients?utm_source=glama&utm_medium=directory&utm_campaign=listing | no (ugc nofollow) |
| Smithery | https://smithery.ai/servers/bjellanda/mcpemails | smithery.ai dashboard (WorkOS: GitHub, then emailed code). Re-scan with every scope ticked | https://mcpemails.com/docs/clients?utm_source=smithery&utm_medium=directory&utm_campaign=listing | YES |
| LobeHub | https://lobehub.com/mcp/albretsen-mcpemails | `lhm plugin update` from `lhm.plugin.json`. README copy is cached with no re-crawl | https://mcpemails.com/docs/clients?utm_source=lobehub&utm_medium=directory&utm_campaign=listing | YES |
| PulseMCP | https://www.pulsemcp.com/servers/mcpemails | No self-serve editor found; request changes from PulseMCP | https://mcpemails.com/docs/clients?utm_source=pulsemcp&utm_medium=directory&utm_campaign=listing | YES |
| freemcp.space | https://freemcp.space/asgeiralbretsen/mcpemails | Owner API with the owner token (no edit UI). Never click Deploy / Try in Sandbox | https://mcpemails.com/docs/clients?utm_source=freemcp&utm_medium=directory&utm_campaign=listing (its homepage link pointed at /api/mcp, a 405) | yes |
| mcp.so | https://mcp.so/servers/mcpemails | No owner edit form; support ticket to the maintainer | https://mcpemails.com/docs/clients?utm_source=mcp.so&utm_medium=directory&utm_campaign=listing (`mcp.so` with the dot; `mcp_so` records as other) | no (nofollow ugc) |
| mcpservers.org | https://mcpservers.org/servers/mcpemails-com | "Request update" on the page, or reply to contact@mcpservers.org | https://mcpemails.com/docs/clients?utm_source=mcpservers&utm_medium=directory&utm_campaign=listing | no (nofollow) |
| mcpservers.org (duplicate) | https://mcpservers.org/servers/albretsen/mcpemails | Same contact. Ask them to merge it into `mcpemails-com`, or sync it to the same text | same as above | no (nofollow) |
| punkpeye/awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | PR editing our one line | https://mcpemails.com/docs/clients?utm_source=github_punkpeye&utm_medium=directory&utm_campaign=listing | no (GitHub nofollows) |
| TensorBlock/awesome-mcp-servers | https://github.com/TensorBlock/awesome-mcp-servers (`docs/communication--messaging.md`) | PR editing our line | https://mcpemails.com/docs/clients?utm_source=github_tensorblock&utm_medium=directory&utm_campaign=listing | no (GitHub nofollows) |
| Docker MCP catalog | https://github.com/docker/mcp-registry/pull/4973 (open) | Push to the PR branch. Title must be "Emails" | https://mcpemails.com/docs/clients?utm_source=docker&utm_medium=directory&utm_campaign=listing | unknown until merged |
| best-of-mcp-servers | https://github.com/tolkonepiu/best-of-mcp-servers/pull/386 (open) | Push to the PR branch (`projects.yaml`) | https://mcpemails.com/docs/clients?utm_source=github_bestof&utm_medium=directory&utm_campaign=listing | no (GitHub nofollows) |
| Claude Directory | claude.ai/directory (sign-in only); submission at claude.ai/admin-settings/directory/submissions/emails, in review | Submission form (editable in review). "Sync from server" refreshes tool and prompt NAMES only | https://mcpemails.com/docs/claude?utm_source=claude_directory&utm_medium=directory&utm_campaign=listing | n/a (behind sign-in) |
| OpenAI app directory | Not submitted yet (needs reviewer credentials) | OpenAI developer portal submission | https://mcpemails.com/docs/chatgpt?utm_source=chatgpt_directory&utm_medium=directory&utm_campaign=listing | unknown |
| Cursor directory | https://cursor.directory/plugins/mcpemails | PR to https://github.com/cursor/community-plugins | https://mcpemails.com/docs/cursor?utm_source=cursor_directory&utm_medium=directory&utm_campaign=listing | unknown |

## What the UTMs record

UTMs are captured end to end, but only as coarse categories, first touch, for 30 days, in the visitor's browser.

- Every page (the root layout mounts `AcquisitionCapture`) stores a sanitized record in `localStorage` key `mcpe-acquisition` on first visit; an unexpired record is never overwritten.
- At signup it lands in `public.workspaces`: `acquisition_source`, `acquisition_landing`, `acquisition_landing_path`, `acquisition_locale`, `acquisition_referrer`, `acquisition_utm_source`, `acquisition_utm_medium`, `acquisition_utm_campaign`. Password signups go through `auth.users.raw_user_meta_data` and the `handle_new_user` trigger; Google and GitHub signups carry the params through the OAuth round trip and `/auth/callback` writes them.
- Raw UTM strings are never stored. `utm_source` maps to one of: smithery, glama, cursor, lobehub, pulsemcp, mcpservers, mcp_so, freemcp, github, claude, chatgpt, and others (else `other`). `utm_source` also becomes `acquisition_source`.
- `utm_medium=directory` is stored as `other` (allowed: organic, paid_search, social, email, referral, affiliate, display, other). `utm_campaign=listing` is stored as `other`.
- `acquisition_landing_path` keeps the route shape, so `/docs/clients`, `/docs/claude` and `/connect` all survive.
- Before PR #143: npm, the MCP registry and Docker recorded as `other`; all three GitHub lists as `github`; the Claude Directory as `claude`; `utm_medium=directory` and `utm_campaign=listing` as `other`.
- After PR #143 (needs its migration applied first, see the PR): every `utm_source` in the table above is its own `acquisition_source` value, `directory` and `listing` are allowed medium and campaign values, and /admin/growth labels each one. Filter on `acquisition_utm_medium = 'directory'` for the total across listings.
- Caveat: the record lives in one browser. A visitor who reads a listing on a phone and signs up on a laptop records as `direct`.

## Monthly drift check

1. Tool count and names: run `tool-surface.test.ts` ("tools/list advertises exactly the post-split surface") and compare with the 19 + 7 split above. Check `DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES` in `mcp-app-resources.ts`.
2. Prompt count: `WORKFLOW_PROMPTS` in `supabase/functions/mcp-server/index.ts`.
3. Prices, inbox limits, Free allowance and grace days: `PLANS`, `FREE_ACTION_ALLOWANCE` and `FREE_ACTION_GRACE_DAYS` in `apps/web/src/lib/stripe/plans.ts`.
4. Provider limits: `COMPATIBILITY_PROFILES` in `supabase/functions/mcp-server/index.ts`.
5. Each listing above, in a real browser (several are SPAs that return 200 for any slug): tool count, prompt count, price, "7 days" (now 3), Outlook claims, icon, and where the website link points.
6. `lhm.plugin.json` tools and prompts still match, then `lhm plugin update`.
7. `server.json` description still equals the one-liner.
8. One signup per directory in `workspaces.acquisition_source` for the month (exclude internal workspaces).

## Sources

- Registry order and contents: `supabase/functions/mcp-server/index.ts:8710-8732`; app-only approval and bulk tools pushed with `appOnlyReviewCardToolMeta()` at `index.ts:8774-8776` and `8795-8797`; draft editor tools at `index.ts:8854-8856`. `signature` unlisted: `advertised-schema.ts:121`. Full list pinned by `tool-surface.test.ts:105-141`.
- Visibility: `mcp-app-resources.ts:383-387` (the three draft editor tools), `:428-431` (`draft_read` and `draft_editor_hide` are model + app), `:765-772` (`draft_editor_save` app-only when the editor is on). Editor defaults off for customers: `supabase/migrations/20260916140000_draft_editor_flag.sql:32`; with it off `draft_editor_save` refuses (`index.ts:8840-8841`).
- Prompts: `WORKFLOW_PROMPTS`, `index.ts:31116-31172`, filtered by scope at `index.ts:31193`.
- Prices and inboxes: `apps/web/src/lib/stripe/plans.ts:227,246` (Free), `:277,294-295` (Personal), `:332,346-347` (Pro), `:375,385-390` (Team). Allowance and grace: `plans.ts:168-169`, `supabase/migrations/20261017160000_free_grace_three_days.sql:25-27`.
- Provider limits: `index.ts:9526-9527` (Gmail copy and permanent delete unavailable), `:9553`, `:9555`, `:9556` (Outlook), `:9566` (IMAP attachment search). No Exchange mailbox: `apps/web/app/auth/outlook/callback/route.ts:334`. Gmail OAuth cap: `apps/web/components/marketing/ProvidersClient.jsx:89-96`.
- Docs slugs: `apps/web/src/lib/clients/clients.mjs:45-232`.
- Icons: `apps/web/public/icon.png`, `connector-icon-light.svg`, `connector-icon-dark.svg`.
- UTMs: `apps/web/app/layout.js:99`; `apps/web/components/analytics/acquisition-storage.mjs:16,30,114-116`; `apps/web/src/lib/acquisition-context.mjs:29-51,139-149,173-254,274-293`; `apps/web/components/auth/SignupApp.jsx:160-174`; `apps/web/app/auth/callback/route.ts:95-115`; `supabase/migrations/20261005113000_attribute_business_landing_pages.sql:84-91,127-145`.
