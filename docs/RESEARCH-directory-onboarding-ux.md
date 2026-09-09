# Research: onboarding for users arriving from the Claude connector directory

Written 2026-09-09. Every production figure was re-derived that day against prod with
`npx supabase db query --linked`. "External" excludes the `internal_accounts` table and
everything `growth_is_internal_email()` matches, the same rule `signup_scoreboard()` uses.

**Read this first: the brief's framing is wrong in three places, and two of the three
matter more than the thing it asked about.** Section 1 shows why. Section 2 ranks what to
build. If you only read one section, read 1.2.

## 0. Working conditions

Nothing in this document was changed, committed or deployed. The tree was already dirty
when this session started, and the dirt is not mine:

| Path | State |
| --- | --- |
| `tools/video-studio/scripts/lib/captions.mjs` | modified (peer session) |
| `tools/video-studio/src/components/Captions.tsx` | modified (peer session) |
| `docs/PROMPT-ab-testing.md` and 4 other `PROMPT-*.md` | untracked (peer session) |
| `docs/RESEARCH-500-action-cap.md` | untracked, written today by a peer session |
| `docs/RESEARCH-when-to-paywall.md` | untracked, appeared mid-session from a peer |

Note the snapshot in my brief listed `apps/web/app/api/inboxes/*`, `ConnectModal.jsx`,
`product-funnel.ts` and `supabase/migrations/20260909080000_funnel_auth_reason.sql` as
dirty. Those all landed while I worked: HEAD moved from `41528d9` to `c0c7476`. The
`auth_reason` instrumentation is live and already producing rows (section 1.6).

Both peer `RESEARCH-*.md` files are pricing questions and do not overlap this one. Three
sessions writing to `docs/` at once is the hazard `feedback_shared_tree_deploy_hazard`
describes; check `git status` before you act on any of us.

---

## 1. The funnel as it really is

### 1.1 The table in the brief cannot be read the way it is labelled

The brief segments by `workspaces.onboarding_client`. That column does not mean what its
name says. It has two writers and they fight.

**Writer one, the MCP server**, `supabase/functions/mcp-server/index.ts:2650`, sets it on
the first tool call to the output of `analyticsClient()`. That function, at
`index.ts:2626-2633`, classifies the client by substring-matching the **HTTP User-Agent**:

```ts
for (const [needle, client] of [["claude", "claude"], ["chatgpt", "chatgpt"], ...])
  if (ua.includes(needle)) return client;
return "unknown";
```

claude.ai's connector fetcher does not put a product name in User-Agent. Neither does
anything else we serve. The result, measured across the entire history of the product:

```
tool_client   | path    |  n  | first_seen | last_seen
--------------+---------+-----+------------+-----------
(no tool call)| -       | 199 |            |
unknown       | oauth   | 195 | 2026-07-31 | 2026-09-09
unknown       | api_key |  35 | 2026-07-30 | 2026-09-09
```

**`analytics_first_tool_client` has never held any value but `unknown`. Not once, in 230
tool-calling workspaces, since the product launched.** The detector has a 0% hit rate.

**Writer two, the dashboard wizard**, `apps/web/app/api/onboarding/route.ts` via the
`client_selected` action (`apps/web/src/lib/onboarding/state.ts`), sets it to whichever
card the user clicked in our own onboarding guide.

So the brief's rows decode as:

| Brief's label | What it actually is |
| --- | --- |
| `claude` = 21 | 21 people who clicked the "Claude" card in **our website's wizard**, after their first tool call had already been recorded (or who never made one) |
| `chatgpt` = 23 | same, "ChatGPT" card |
| `unknown` = 222 | everyone who has ever made a tool call, because the detector always returns this |
| `(not set)` = 162 | never made a tool call **and** never used the wizard's client picker |

This is why the `unknown` row shows 219 signups and 219 first tool calls: it is not a
cohort, it is the definition of having made a call. And it is why `(not set)` shows zero
first tool calls: also a definition, not a finding.

`apps/web/components/admin/users/detail.tsx:202` renders this column to you as **"Client"**
on every user detail page. That label is wrong for every row.

### 1.2 There is a correct instrument, it has been running since 2026-08-13, and nobody is reading it

`mcp_client_capabilities` is written at `initialize`, before any tool call, by
`recordClientCapabilities()` at `index.ts:2713`. It stores `clientInfo.name`, the version,
the negotiated protocol version and the declared capability object. Its own docstring says
"Observability only. Nothing branches on these rows." That is true and it is a waste,
because these rows are the only honest client attribution we have.

Distinct workspaces per real client family, all time:

| Family | Workspaces | Declares UI ext |
| --- | --- | --- |
| claude.ai (`Anthropic/ClaudeAI`, `claude-ai`, `Anthropic/Toolbox`, `claude-ios`, `ClaudeAndroid`, `connectors-manager`) | **172** | yes |
| `claude-code` (30+ versions) | 152 | no |
| openai (`openai-mcp`, `codex-mcp-client`, `ChatGPT`) | 37 | yes |
| cursor | 24 | partly |
| everything else (uesio, Poke, Manus, openclaw, lobehub, librechat, Smithery, Glama, grok-validator, sheet-add-in, ...) | ~60 | mostly no |

**172 workspaces have connected through a Claude first-party client, not 21.** The brief
undercounts Claude by roughly 8x. Whatever you conclude about the Claude channel, conclude
it from this table.

### 1.3 What claude.ai actually declares, measured on our own wire

This is the single most useful row in the database for deciding what to build, and it
settles the platform question without any web research:

```
client_name        | protocol   | capabilities
-------------------+------------+--------------------------------------------------------
Anthropic/ClaudeAI | 2025-11-25 | {"extensions":{"io.modelcontextprotocol/ui":
claude-ai          | 2025-11-25 |   {"mimeTypes":["text/html;profile=mcp-app"]}}}
claude-ios         | 2026-01-26 | ... mimeTypes + "text/html+mcp"
Anthropic/Toolbox  | 2025-11-25 | {}          (154 rows)
```

**claude.ai declares the MCP Apps UI extension and nothing else. No `elicitation`. No
`sampling`. No `roots`.** 191 rows for `Anthropic/ClaudeAI` and 186 for `claude-ai`, spanning
2026-08-13 to today, every one of them the same.

Independent web research agrees: elicitation reached the spec in 2025-06-18 (form) and
2025-11-25 (URL mode), Claude Code shipped it in v2.1.76, and
`anthropics/claude-ai-mcp#153` ("Elicitation Support") has been **open since 2026-04-06**
with no claude.ai support. Our own handshake data is the stronger evidence and it points
the same way.

**Conclusion: any recommendation built on elicitation is dead on claude.ai.** The brief
listed it first among the available levers. It is not available.

### 1.4 The real funnel

Workspaces created on or after 2026-08-13 (the date `mcp_client_capabilities` began, so
client attribution is trustworthy), external, not deleted. **n = 321.**

| Step | Workspaces | Of previous | Lost |
| --- | --- | --- | --- |
| Signed up | 321 | | |
| Started a mailbox connection | 289 | 90% | **32** |
| **Mailbox connected** | **243** | 84% | **46** |
| Initialized any MCP client | 195 | 80% | **48** |
| ...of which claude.ai specifically | 135 | | |
| First tool call | 187 | 96% | 8 |
| Value activation | 175 | 94% | 12 |
| Paid | 10 | 5.3% | |

Ranked by workspaces lost:

1. **Mailbox connection: 78 lost (24% of all signups).** 32 never start, 46 start and never
   finish. A further **77 workspaces succeeded only after at least one `auth_failed`**, so
   150 of 321 either failed here or fought their way through it. All-time the stage has
   1,038 `started` events for 414 `success` events.
2. **Connecting an MCP client: 48 lost (15%).** These people did the expensive step and
   skipped the cheap one. 119 of 321 never minted a credential of any kind.
3. **Everything after the first tool call: 20 lost.**
4. **The empty-inbox error the brief is about: about 3 lost.** See 1.5.

### 1.5 The suspected cliff is real, is correctly diagnosed, and currently costs about three users

I tested it three ways and all three agree.

**Test one, the error's own frequency.** `activity_log` since 2026-08-13:

| `error_code` | calls | workspaces |
| --- | --- | --- |
| `-32602` (invalid params) | 1,518 | 108 |
| `provider_error` | 973 | 75 |
| `search_timeout` | 211 | 39 |
| `folder_not_found` | 189 | 34 |
| `inbox_ambiguous` | 170 | 19 |
| ... | | |
| **`no_inbox_connected`** | **20** | **13** |

It is the 14th most common error. Of the 13 workspaces that hit it, **10 later recorded a
successful call**. Net cost so far: about 3 workspaces.

**Test two, ordering.** For the 135 post-08-13 workspaces that connected claude.ai:

| | n | median |
| --- | --- | --- |
| Connected the mailbox **before** first claude.ai connect | **127 (94%)** | 4.1 min before |
| Connected the mailbox **after** | 5 | 8.9 min after |
| Never connected a mailbox | 3 | |

**Test three, credential-before-mailbox.** Only 26 of 321 workspaces (8%) minted a
credential before any mailbox existed. Of those 26, **18 recovered anyway** (median 22
minutes later) and 8 did not. So the missing link costs roughly 31% of the people who reach
that state, and almost nobody reaches it.

**Why the number is small, and why you should still fix it.** The error is rare because the
*state* is rare, not because the message works. Today's population arrives at
mcpemails.com first, connects a mailbox in the dashboard (186 of 243 within ten minutes of
signup), and only then attaches the connector. The directory **inverts that order**. A
directory arrival has no reason to have seen the dashboard, so the state goes from 8% of
signups to essentially 100% of directory arrivals. The 69% self-recovery rate observed
today is an upper bound for them, because today's 26 had already been on the site.

So: the brief's diagnosis of the mechanism is right, its ranking of the mechanism is wrong
for today and right for tomorrow. Fix it because it is nearly free, not because it is
bleeding.

### 1.5.1 There are two empty-state exits, and the brief only found the worse-looking one

`no_inbox_connected` at `index.ts:8485` is the loud exit. The quiet one is worse.

`inbox_list` is registered **first** in the tool registry, deliberately, because it is "the
entry point" for discovery (`index.ts:3313`). `SERVER_INSTRUCTIONS` tells the model
"`inbox_list` answers 'which inboxes do I have?'". With zero inboxes, `executeListInboxes`
returns at `index.ts:8181`:

```ts
return { result: jsonOk({ inboxes }, true), logStatus: "success", logErrorCode: null };
```

An empty array, **as a success**. No error, no guidance, no URL, and nothing in
`activity_log` to count. A model asked "what's in my inbox?" that starts with discovery
gets `{"inboxes": []}` and has to invent an explanation. That path is invisible in every
metric we have, including the 20-call figure above.

Whatever you do to `8485`, do to `8181`.

### 1.5.2 The consent screen already knows, and has been told not to say so

This is on our own page, under our full control, with no protocol involved.

`apps/web/app/authorize/page.js:262-271` loads the workspace's inboxes and passes them to
`AuthorizeApp`. `AuthorizeApp.jsx` has a correct zero-inbox notice with a
"connect an inbox" link at **line 743**. It is inside `{!allInboxes && ...}`.

And at **line 439**:

```jsx
const [allInboxes, setAllInboxes] = useState(true);
```

**The default is "all inboxes", so the zero-inbox notice is unreachable unless the user
manually switches to "specific inboxes" first.** A directory user with no mailbox sees a
normal consent screen, clicks Allow, is granted "all inboxes" over an empty set, and is
returned to Claude with 23 tools and nothing behind them. The footer text that would have
said how many inboxes are being granted renders `null` in this case
(`AuthorizeApp.jsx:772-780`).

The one moment where we have the user's full attention, on our own HTML, is spent telling
them nothing.

### 1.6 The cliff nobody mentioned: Gmail

39% of recent signups (125 of 321) use a `gmail.com` address. It is the largest domain by
3x. It is also our worst connection path by a wide margin.

Workspace-level connection success by provider, since 2026-08-13:

| Provider | Started | Succeeded | Rate | Lost with **no failure event at all** |
| --- | --- | --- | --- | --- |
| iCloud | 57 | 51 | 89.5% | 0 |
| Yahoo | 82 | 71 | 86.6% | 0 |
| Generic IMAP | 129 | 103 | 79.8% | 0 |
| **Gmail** | **80** | **42** | **52.5%** | **35** |

Gmail is the only provider that loses people silently, because it is the only one that
sends the user to a third party mid-flow. `apps/web/app/auth/gmail/route.ts:39-45` requests
four Gmail scopes at once (`gmail.readonly`, `gmail.send`, `gmail.modify`,
`gmail.settings.basic`), all restricted or sensitive.
`docs/admin-growth-redesign.md:103` establishes that the Google app is **published but
unverified**, which means every user sees the "Google hasn't verified this app" interstitial
and has to click through Advanced. A prior audit (2026-07-28, cited in that doc) measured
~59% all-time Gmail abandonment. My independent measurement gives 47.5%. Two methods, same
mechanism.

**And it got worse six days ago.** Commit `d31dcce` ("feat(gmail): connect over IMAP with a
Google app password, by default") made Gmail an app-password provider. The last
`provider='gmail'` (OAuth) inbox row is dated 2026-09-03; everything since is
`provider='imap', service='gmail'`.

| Era | Started | Succeeded | Rate |
| --- | --- | --- | --- |
| Before 2026-09-03 (OAuth default) | 59 | 32 | 54.2% |
| After 2026-09-03 (app password default) | 23 | 10 | **43.5%** |

Small sample (23 workspaces), so treat the exact number as noisy, but the direction is not
an improvement and Gmail is now last by a distance. Post-09-03, every other provider:
Yahoo 29/29 (100%), iCloud 18/21 (85.7%), generic IMAP 40/49 (81.6%). **App passwords are
not the problem; Google's app-password flow specifically is.** It sits behind 2-Step
Verification, is unavailable on accounts that have not enabled 2SV, and is hard to find.
The brand-new `auth_reason` instrumentation (live today) has already classified two
`account_password_used` events, users pasting their Google account password instead of an
app password.

**A directory channel is consumer-shaped. Consumer means Gmail. Gmail is 43.5%.** This is
the largest number in this document and it is not the thing the brief asked about.

**One live risk to log, now defused but worth knowing.** The Gmail OAuth client is capped at
100 distinct Google accounts ever granted, cumulative, non-refundable, until CASA AL1
verification completes. We are at **71 of 100** (40 as of 2026-08-13, so +31 in 27 days).
`d31dcce` stopped the burn by accident, since almost nobody takes the OAuth path now. If
anyone restores Gmail OAuth as the default before verification lands, there are 29 slots
and roughly three weeks of headroom at August's rate.
`docs/../project_casa_al1_assessment` notes the deadline is 2026-10-31 and no lab had been
engaged as of 2026-09-01. There are also 123 stale `oauth_states` rows, which are abandoned
consent attempts.

### 1.7 What the `(not set)` cohort actually is

The brief flagged this as possibly the biggest finding available. It is a real cohort and a
real problem, but it is **not the directory's problem**, and it cannot be.

`(not set)` decodes as "never made a tool call and never used the wizard's client picker".
Splitting the clean era by whether the workspace ever completed an MCP `initialize`:

| | n | has credential | live mailbox | tool call | paid |
| --- | --- | --- | --- | --- | --- |
| Initialized a client | 195 | 195 | 184 | 186 | 9 |
| **Never initialized** | **126** | **6** | **49** | 1 | 1 |

126 of 321 recent signups (39%) never complete a connector handshake at all. **49 of them
connected a mailbox first**, i.e. they did the expensive step and then failed at the cheap
one. Only 6 ever obtained a credential.

A directory arrival **cannot** land in this cohort by construction: the directory flow is
OAuth then `initialize`, seconds apart. So this is the website signup funnel leaking, not
the directory funnel. It is worth its own piece of work. It is out of scope here, and I
would not let it be renamed a directory problem.

**The structural point that matters most for the launch:** the directory removes the
biggest cliff in the current funnel (48 to 126 users lost at "connect a client", depending
how you count) and makes the smallest one (the empty-inbox state) universal. That is a good
trade. It is also why the empty-inbox fix, cheap as it is, should ship before the listing
goes live.

---

## 2. Ranked recommendations

Ranked by expected users recovered per hour of work. I say where I am guessing.

### R1. Put a URL in both empty-state exits, and tell the model to re-render it

**Cost: about 1 hour including tests. Confidence: high on mechanism, guessing on magnitude.**

Two edits, plus a helper:

- `supabase/functions/mcp-server/index.ts:8484-8486`, the `case "none"` branch of the inbox
  selector failure.
- `supabase/functions/mcp-server/index.ts:8181`, `executeListInboxes`. When `inboxes` is
  empty, return the same guidance instead of a bare `{"inboxes": []}` success.

**The URL alone is not enough, and this is the part that is easy to get wrong.** claude.ai
renders MCP tool results **collapsed behind an expander by default**
(`anthropics/claude-code#53256`). A URL sitting inside a tool result is invisible to the
user until they click to expand it. This is exactly why every server that has solved this
problem ships an explicit instruction to the *model* alongside the URL. Paragon's is the
cleanest and I would copy its shape almost verbatim
(`useparagon/paragon-mcp`, `src/tools.ts:154-180`):

> "Instruct the user to set up their ... integration by visiting the link. Format the setup
> link in Markdown."

Composio/Rube: "Always show the returned `redirect_url` as a FORMATTED MARKDOWN LINK to the
user." Arcade ships a separate `llm_instructions` content item saying "Please show the
following link to the end user formatted as markdown". Merge: "hand the URL to the user
verbatim."

The instruction is the delivery mechanism, not decoration. Without it the link stays folded
inside a collapsed block and the user never sees it.

**Why the URL-in-text approach and not something richer:** web research could not confirm
that claude.ai renders `resource_link` blocks or embedded resources as clickable UI, and
there are open defects on both (`anthropics/claude-ai-mcp#287`, `#753`, the latter
specifically breaking MCP App tool-result delivery when a `resource_link` is present). Plain
`text` content relayed by the model is the only path with production evidence behind it.

**Why it is not a guess:** this file already does exactly this, twelve hundred lines
earlier, for the adjacent failure. `authFailedResult()` at `index.ts:385-405` and
`reconnectUrl()` at `index.ts:353-358`. Its docstring is the argument for R1 verbatim: it
"gives a single clickable reconnect link the agent can relay to the user". The
`no_inbox_connected` branch is the one case in the family that was missed. Follow the
existing pattern, do not invent one. There is further precedent for the URL style at
`index.ts:1576`, `1610`, `1645`, `1662` and `2576`.

**One decision to make deliberately: `isError`.** Three serious implementations disagree.
Paragon returns **`isError: false`** for "not connected", on purpose, so clients do not
swallow or auto-retry it. Arcade and AgentMail return `isError: true`, AgentMail with a code
comment that it makes clients "surface it as an actionable failure". Our
`no_inbox_connected` is currently `isError: true` and `inbox_list`'s empty result is a
success. My recommendation is to leave both as they are and change only the text, because
changing `isError` also changes what `activity_log` counts and you want the before/after
comparison to stay clean. Revisit once you can measure.

**This is also a directory-review risk, not only a UX one.** Anthropic's connector review
criteria require that tools "return actionable error messages", and the submission is live.
A bare refusal naming a destination with no link is the textbook case that guidance is
written against. Anthropic's own tool-writing guidance says the same: "prompt-engineer your
error responses to clearly communicate specific and actionable improvements, rather than
opaque error codes."

**Expected recovery:** roughly 3 workspaces to date. Post-directory, it is on the critical
path for every arrival. I cannot size directory volume and will not pretend to.

### R2. Stop the consent screen from letting a directory user leave with zero inboxes

**Cost: 4 to 8 hours. Confidence: high. This is the actual fix; R1 is the safety net.**

`apps/web/components/auth/AuthorizeApp.jsx`.

1. Move the zero-inbox branch (currently line 743, inside `{!allInboxes && ...}`) out of the
   mode conditional so it renders whenever `inboxes.length === 0`, in both modes.
2. When `inboxes.length === 0`, make it the primary content, not a footnote: a
   "Connect a mailbox" action that opens `/dashboard/inboxes` (or better, the connect flow
   inline) and returns to the same authorize URL with all OAuth params intact.
3. Decide deliberately whether Allow should be **disabled** at zero inboxes. The button is
   already conditionally disabled at line 781 (`(!allInboxes && grantCount === 0) || ...`);
   extending that to the all-inboxes case is a one-line change. My recommendation is to
   allow it but make continuing the visibly secondary choice, because hard-blocking an
   OAuth consent screen risks the user abandoning the connector entirely rather than
   detouring.

**Why it works:** it deletes the empty state rather than annotating it. The user is already
on our page, already authenticated, already in a "set this up" frame of mind, and 186 of
243 successful connections happen within ten minutes of signup anyway. The window is
minutes long and this is inside it. No MCP capability is involved, so nothing here can be
broken by a client update.

**Evidence:** `AuthorizeApp.jsx:439` (`useState(true)`) proves the notice is currently
unreachable on the default path. The ordering data in 1.5 proves that everyone who succeeds
today does this step first anyway; R2 just makes the directory path match the path that
already works.

### R3. Fix Gmail

**Cost: days to weeks, and mostly not UX work. Confidence: high on the problem, low on the best remedy.**

Gmail is 39% of signups and converts at 43.5%. Closing half the gap to generic IMAP's 81.6%
is worth more users than R1 and R2 combined, at current volumes and even more so for a
consumer-shaped directory channel.

I am not going to pretend a UX tweak fixes this. The options, honestly ranked:

- **Finish CASA AL1 and Google verification.** Removes the unverified interstitial, removes
  the 100-user cap, lets OAuth be the default again. The code work is done (`af515cf`); the
  blocker is engaging a lab, and the deadline is 2026-10-31 with nothing booked as of
  2026-09-01. This is the real fix and it is a calendar problem, not an engineering one.
- **Instrument the app-password path before changing it again.** `d31dcce` is six days old
  and the new `auth_reason` column landed today. Give it two weeks and read
  `auth_reason` (`account_password_used`, `password_rejected`, `imap_disabled`) before
  reversing anything. Right now 23 workspaces is too thin to act on and I would not act on
  it.
- **Reduce the scope request.** `gmail.readonly` is redundant with `gmail.modify`
  (`route.ts:41,43`). Dropping it is a one-line change that shortens the consent screen and
  narrows the CASA surface. Small, safe, do it whenever you next touch the file.

Not a recommendation, an observation: iCloud (85.7%) and Yahoo (100% post-09-03) prove our
app-password UX is good. Gmail is the outlier because Google's app-password flow is.

### R4. Fix client attribution before the listing goes live

**Cost: 1 to 2 hours. Recovers zero users directly. Do it anyway.**

`index.ts:2626-2633`. Replace the User-Agent substring match with `clientInfo.name` from
`initialize`, which we already capture correctly in `mcp_client_capabilities` and already
know the real values for (1.2). Stop `index.ts:2650` from overwriting the wizard's
`client_selected` value with a garbage one, or split the two into separate columns.

Without this you cannot tell a directory arrival from an organic signup, which means you
cannot measure whether R1 and R2 worked. You are about to open a new channel with the
odometer disconnected. Also fix the "Client" label at
`apps/web/components/admin/users/detail.tsx:202`, which currently misreports every row.

### R5. Make `SERVER_INSTRUCTIONS` state-dependent, and only then add the connect URL

**Cost: 2 to 3 hours. Confidence: medium. Better than it first looks.**

The obvious version of this is bad: append "connect an inbox at ..." to
`SERVER_INSTRUCTIONS` (`index.ts:891-918`) for everyone. The budget is 1,800 bytes
(`SERVER_INSTRUCTIONS_MAX_BYTES`, `index.ts:863`) and the comment above it explains that
Claude Code shares roughly 4KB across all configured servers and truncates silently, and
that these are "the most expensive bytes we ship". Spending them on a sentence that is
irrelevant to the 94% who already have an inbox is a bad trade.

**The good version: compute `instructions` per connection.** Two production servers already
do this and it is the right shape for us:

- **Hugging Face** (`https://huggingface.co/mcp`, verified live) varies its `instructions` by
  auth state. Anonymous sessions get: "Direct the User to set their HF_TOKEN (instructions
  at https://hf.co/settings/mcp/), or create an account at https://hf.co/join for higher
  limits." Authenticated ones do not.
- **Cloudflare** appends the caller's account list into `instructions` via
  `AccountManager.instructionsSuffix()`, so the model knows the IDs before it can possibly
  error. **GitHub** composes per-toolset blocks the same way.

We can do this because our OAuth already identifies the workspace at `initialize`. The
`apiKey` is in hand at that point (it is already passed to `recordClientCapabilities()`,
`index.ts:2713`), so a single count query decides whether to append the sentence. Zero bytes
for everyone who has an inbox, a directly-addressed instruction for everyone who does not.

The cost above the naive version is one query on the handshake path and a test. `initialize`
already does a write there, so the shape is not new.

**Micro-item, low confidence, mention only:** `serverInfo` gained `websiteUrl`, `description`
and `icons` in the 2025-11-25 schema, and Context7 populates `websiteUrl`. We echo
`2025-06-18` (`SUPPORTED_PROTOCOL_VERSION`, `index.ts:831`), and that constant carries an
explicit "do not helpfully bump this" warning backed by a tested compatibility matrix, so
**do not raise the version for this**. Adding an unknown key to `serverInfo` is probably
harmless (clients ignore unknown fields) but it is unverified whether any Claude surface
renders it. Not worth a deploy on its own.

---

## 3. What competitors do

Four companies have solved exactly our problem and all four converged on the same answer:
**return the setup URL inside the tool result, and include an explicit instruction telling
the model to re-render that URL as a markdown link.** Nobody relies on the URL alone.

### The servers that get it right

**Paragon** (`useparagon/paragon-mcp`, `src/tools.ts:154-180`) is the closest match to our
situation and the best thing to copy:

> "The ... integration is not enabled for the user. To set it up and use this tool, the user
> will need to visit: `${setupUrl}`. Instruct the user to set up their ... integration by
> visiting the link. Format the setup link in Markdown."

Returned with **`isError: false`** deliberately. The URL is a short-lived signed JWT
(`generateSetupLink`, `src/utils.ts:247`) pointing at a page that opens the connect portal
scoped to that one integration. Paragon sets no `instructions` field at all; everything
rides in the tool result.

**AgentMail**, an email MCP, hits our exact case (OAuth succeeds, account not set up):

> "Your account has no AgentMail Organization yet. Sign in once at
> https://console.agentmail.to to finish setup, then retry this tool."

Its multi-org variant refuses rather than guessing, and names the tool that fixes it. The
code comment justifying that refusal is worth stealing wholesale: silently picking the first
membership "could land destructive ops (e.g. delete_inbox) in the wrong org."

**Pipedream** does it as platform behaviour, per their docs: "If a user doesn't have a
connected account that's required for a given tool call, the server will return a URL in the
tool call response", with "there's no additional implementation required". Links expire in
4 hours.

**Composio/Rube** exposes `RUBE_MANAGE_CONNECTIONS` returning a branded auth link, with the
agent instruction "Always show the returned redirect_url as a FORMATTED MARKDOWN LINK to the
user", and a hard policy: "DO NOT execute any toolkit tool without an ACTIVE connection."

**Arcade** returns `isError: true` plus a second content item carrying `authorization_url`
and an `llm_instructions` field reading "Please show the following link to the end user
formatted as markdown".

**Merge** returns a `magic_link_url` with "hand the URL to the user verbatim", and has a
`reauth_required` error whose `reauth_reason` includes `not_connected`, defined as "No
credential exists for this user and Connector, because they never linked it".

### The counterexamples, including ours

**Notion** returns prose with no URL. **Cloudflare** returns a JSON error with an
`available_accounts` array so the model can self-recover, no URL. **Stripe** returns a docs
URL, not a dashboard URL. **Postmark** has the right URLs but writes them to stderr and
exits, so the model never sees them. The popular `GongRzhe/Gmail-MCP-Server` registers every
tool and then fails each call with a raw google-auth error and no guidance at all.

**That last one is our current state, minus one sentence.** And our nearest competitor
`anymailmcp` has the same gap: magic-link sign-in, then "you add your mailbox from your
profile afterwards", with no in-chat tool. Their exact string is unverifiable (closed
source), but their FAQ confirms they do return actionable links for the adjacent quota case.
So this is not a solved problem in our category, and fixing it is a small differentiator
rather than catching up.

### Zapier, whose model is worth understanding even though we should not copy it

The brief's premise about Zapier is out of date. Their default is now agentic: 14 static
meta-tools always exist so `tools/list` is never empty, and on OAuth they auto-provision
from existing connections. Their documented empty case:

> "auto-provisioning has nothing to pre-enable and your server starts empty. Your agent
> still works: it finds an action ... and prompts you to connect the app the first time it
> needs one."

They also ship a client-side onboarding Skill with a four-state diagnosis table (`Healthy` /
`Fresh install` / `Auth broken` / `Not connected`) keyed on "Only configuration tools
available (no actions yet)". Its fresh-install copy is "You're connected but don't have any
tools set up yet. Let's add some."

### The dedicated setup-tool pattern, and why it is not in section 2

Several servers expose a tool the model can reach for proactively: Zapier's
`get_configuration_url`, Klavis's `handle_auth_failure`, Nango's `connect_session_create`,
AgentMail's `select_organization`, Plaid's `plaid_get_tools_introduction`.

The sharpest idea in the set is **Merge's conditional presence**: `authenticate_<connector>`
exists in the catalogue *only while unauthenticated* and drops out afterwards. They also
document its failure mode, that tool search will not surface it, and call it "the trap most
agents fall into".

I am not recommending a new tool. It adds a 24th to a surface the token-cost work has been
shrinking, and `inbox_list` already occupies that slot conceptually: it is registered first
precisely as the discovery entry point. Make `inbox_list`'s empty payload do this job (R1)
rather than adding a sibling.

### Nobody is using elicitation or an MCP App for first-run setup

I could not confirm a single named production server doing either. URL-mode elicitation is
the spec-sanctioned answer (Anthropic's own write-up says it "keep[s] the user in the flow
instead of sending them to a settings page") but Anthropic states plainly that URL mode is
"supported in Claude Code, with more clients in progress". That matches our handshake data
in 1.3 exactly.

The one prompt-based example is Shipmail, which registers a `setup_domain` prompt whose body
is a numbered workflow naming the exact tools to call. Interesting, but see section 4 on why
prompts are not a first-run surface on claude.ai.

### What Anthropic says about the surface we control

The single most relevant paragraph, from the lazy-authentication doc, is written about auth
but describes our failure mode precisely:

> "A `200` with `isError: true` is an application-level tool failure. Claude passes the error
> text to the model as the tool result and moves on, there is no auth prompt ... If users are
> seeing 'please sign in' text in the chat instead of a Connect button, the server is
> returning the wrong one."

The review criteria require tools to "return actionable error messages". The submission
portal's "Use cases" step asks "what users need before they can connect (accounts, plans, or
other setup)", but that text goes to reviewers, not to users in chat. The in-product setup
help link is explicitly **not** partner-customizable and there is no documented post-install
message surface. Whether the listing's own 2,000-character description is the right place to
say "connect a mailbox at mcpemails.com first" is worth testing once the listing is live; it
is free if it works.

---

## 4. What NOT to do

**Do not build on elicitation.** claude.ai does not declare it. This is not a reading of the
spec, it is 377 rows of our own handshake data (1.3) plus `anthropics/claude-ai-mcp#153`,
open since April. It works in Claude Code and nowhere else that matters here. The brief
listed it first; it should not be on the list.

**Do not build an MCP App connect card yet.** It is genuinely within reach, which is exactly
why it is tempting. Three specific reasons to wait:

1. `_meta.ui` is **per-tool, not per-call**, and the file already carries a long comment
   (`index.ts:7190-7208`) about the last time that was forgotten: the review card was
   stamped unconditionally and ~99% of sends rendered an empty skeleton. A connect card
   would have to be gated per key on "this workspace has zero inboxes", via
   `handleToolsList` the way `keyReviewCardGates` does.
2. **`tools.listChanged` is `false`** (`index.ts:24704-24708`, with a comment saying clients
   must not subscribe). `tools/list` runs once per host page load. So the card would keep
   claiming "no inbox" for the rest of the session after the user connects one, until they
   reload. Fixing that means turning on `listChanged` and emitting notifications, which is a
   much bigger change than it sounds.
3. It is **unconfirmed** whether claude.ai mounts the App iframe at all for a call that
   returns `isError: true` immediately. The extension spec says a mounted View receives
   `ui/notifications/tool-result` including `isError`, but nothing settles whether the mount
   happens first. Do not design around an unverified mount.

Plus: 3 to 5 new carousel screenshots and a resubmission, and ~2,600 lines of existing app
frontend to extend. Call it 2 to 4 days for something R1 achieves in an hour at 80% of the
value. Revisit after the listing is live and you can measure.

The good news for later: `openLink` is already implemented in `apps/mcp-app/src/bridge.ts:312`
and used in `App.tsx:98,224`, and the submission already declares `https://mcpemails.com`
as an allowed link origin, which suppresses the confirmation modal. When you do build it,
that half is done. Note the modal is only suppressed for **directory** connectors and only
after a real user gesture.

**Do not return a 401 to force Claude's inline Connect card.** A transport-level 401 with
`WWW-Authenticate` genuinely does render a real Connect button with automatic retry, and it
will be tempting once someone learns that a `200` + `isError: true` gets you nothing but
text. It is the wrong tool: a 401 starts an OAuth flow, and the user needs to connect a
*mailbox*, not re-authorize *us*. They would land back where they started, having consented
twice. The step-up 403 path we already ship is the correct use of this mechanism and should
stay scoped to scopes.

**Do not put this in MCP prompts.** We publish four and `prompts/list` works, and there is
at least one server using a prompt as a setup surface (Shipmail's `setup_domain`). But on
claude.ai they are effectively undiscoverable: there is no documented place a user finds a
connector's prompts, `anthropics/claude-ai-mcp#333` reports them vanishing from the UI, and
`#23` notes the model cannot enumerate them programmatically. A first-run user will never
type `/`. It works for Shipmail because their audience is developers in Claude Code.

**Do not solve this with a lifecycle email.** 186 of 243 successful mailbox connections
happen within ten minutes of signup, 43 more within the hour, and only 14 ever after that.
78 never connect at all. The window is minutes long and an email arrives after it closes.
`docs/PLAN-activation-lifecycle-email.md` is aimed at a different cohort and should stay
that way.

**Do not ship fifteen things.** R1 and R2 together are under a day and cover the entire
directory empty state. R4 is the only other one I would insist on before launch, and it
recovers nobody; it just lets you see. R3 is bigger than all of them and is not a UX
project.

---

## 5. The business angle

**Short answer: it is a channel problem, not a UX problem, and I would not spend UX effort
trying to bias the funnel toward business users. But your segmentation is measuring the
wrong column, and fixing that is free.**

### The signal is in the connected mailbox, not the signup address

Recent cohort (n = 321), segmented two ways:

| By **signup email** domain | n | paid | rate |
| --- | --- | --- | --- |
| Business | 88 | 5 | 5.7% |
| Consumer | 233 | 5 | 2.1% |

| By **connected mailbox** domain | n | paid | rate |
| --- | --- | --- | --- |
| Business mailbox | 88 | 7 | **7.95%** |
| Consumer mailbox | 145 | 2 | **1.38%** |
| No mailbox | 88 | 1 | 1.1% |

The mailbox domain separates 5.8x; the signup domain separates 2.7x. **34 workspaces signed
up with a consumer address and connected a business mailbox**, and 2 of them pay. They are
business users sitting in your consumer bucket. Segment on `inboxes.email_address`, not
`users.email`. That is a query change, not a product change, and it makes every future
read of this segment sharper. (Paid counts are 7, 2 and 1 against a total of 10, so these
rates rest on single-digit numerators; the direction is solid, the decimals are not.)

### Can onboarding bias toward business users?

Barely, and we already do the one thing that works.

Business-domain users overwhelmingly connect over generic IMAP (57 of 104 provider
selections) at 84.2% success. Consumers spread across Gmail, Yahoo and iCloud.
`ConnectModal.jsx:384` already leads the provider grid with "IMAP / SMTP" and the comment
there gives the right reason: it is the path that works with every mailbox and the only one
that does not send the user to a third-party consent screen. **The highest-converting path
is already first and it is already the business path.** There is no second move of that
size available in the connect modal.

Everything else that looks like a lever is really a channel lever wearing a UX costume:
the directory listing copy, the categories chosen at submission, the screenshots, the
example prompts. Those decide who shows up. Onboarding decides whether whoever showed up
succeeds.

### The honest warning

A consumer-shaped channel routes people into the Gmail path, which converts at 43.5%, while
the segment that pays routes into the generic IMAP path, which converts at 81.6%. So the
directory will most likely **lower** your average conversion rate and raise your absolute
numbers at the same time. Do not read that as onboarding regressing. Watch business-mailbox
conversion as its own series or the mix shift will hide everything.

If you want more business-domain users, the lever is `docs/PLAN-multi-mailbox-business-segment.md`
and the acquisition work, not this document.

---

## 6. What I could not verify

Stated plainly, because a confident wrong number is worse than an admitted gap.

- **Directory volume.** I cannot size it. Every "post-directory" claim here is a rate, never
  a level.
- **The unverified-app interstitial.** I infer it from `docs/admin-growth-redesign.md`,
  from the restricted-scope set, and from Gmail being the only provider with silent
  abandonment. I did not see the screen. One minute in an incognito window would settle it.
- **Whether claude.ai mounts an MCP App iframe on an immediately-failing tool call.**
  Unconfirmed, and load-bearing for the connect-card option in section 4.
- **Whether claude.ai renders links from tool-result text as clickable.** The model relaying
  the URL into its own prose is the reliable path; direct rendering of `resource_link` and
  embedded resources is unconfirmed and has open defects against it. Note also that tool
  results are collapsed by default (`anthropics/claude-code#53256`), which is why R1's
  model-directed instruction matters more than the URL itself.
- **`anymailmcp`'s exact empty-state string.** Closed source. Their FAQ confirms the
  adjacent quota case returns actionable links, and their docs confirm mailbox setup happens
  on their site after sign-in, so the gap is real, but I could not read the string.
- **Whether the directory listing's "what users need before they can connect" text is
  published or review-only.** Check once the listing appears.
- **The post-09-03 Gmail app-password rate (43.5%)** rests on 23 workspaces and six days.
  The direction is clear, the number is not settled.
- **I ran no live first-run test.** Per the brief I did not create an account or touch
  `directory-review@mcpemails.com`. Everything here is from the database and the source.

## 7. Reproducing the numbers

Every figure above came from `npx supabase db query --linked`. The base predicate used
throughout:

```sql
select w.*
from public.workspaces w
join public.users u on u.id = w.owner_id
where not public.growth_is_internal_email(u.email)
  and w.deleted_at is null
  and w.created_at >= '2026-08-13'   -- mcp_client_capabilities starts here
```

The `2026-08-13` cutoff matters: before it, client attribution does not exist, and a
workspace whose only activity predates it will look like it never connected a client. The
all-time numbers in 1.2 deliberately drop the date filter; every funnel number keeps it.
