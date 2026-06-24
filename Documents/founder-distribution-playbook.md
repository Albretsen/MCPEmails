# Founder distribution playbook

Goal: get mcpemails.com in front of founders, anchored on the one use case we have daily proof of. Our single most active user is a founder who opens Claude every morning and clears the customer support queue with it. That is the wedge. Everything below points people to the new landing page built for exactly that person:

**Landing page: https://mcpemails.com/for/founders**

The page is live in 5 locales, carries FAQPage + WebPage structured data, and leads with "Answer every customer from inside your AI." Use it as the destination for every link below so the message a founder lands on matches the message that pulled them in.

---

## The one-line positioning

> You are the support team, the sales team, and the founder. mcpemails connects your inbox to Claude so you can triage, draft replies in your own voice, send, and schedule follow-ups without leaving the conversation.

Lead with the outcome (clear the support queue before coffee), not the plumbing (MCP, OAuth, IMAP). The plumbing is the proof, not the pitch.

---

## Tier 1: MCP directories (highest leverage, evergreen, do this first)

This is the cheapest, highest-intent distribution we have and it is mostly one-time setup. The audience is builders and founders actively wiring up AI tools, exactly the people who will try a managed email MCP. Many of these crawl the ecosystem automatically, so we may already appear unclaimed. The win is claiming each listing, fixing the description, and pointing it at /for/founders.

Start with the canonical record, then claim the directories that read from it:

1. **Official MCP Registry** publish a correct `server.json` under a name we have proven we own. A growing number of clients and directories read from this feed, so getting it right makes the rest of the ecosystem pull our data automatically.
2. **Glama** (glama.ai/mcp/servers) largest registry, ~47k+ servers mid-2026. Claim and verify ownership to move out of the anonymous-crawl pile.
3. **Smithery** (smithery.ai) clean app-store interface, strong search, hosted remote servers. We are a remote streamable-http server, which fits their hosted-remote listing well.
4. **PulseMCP** (pulsemcp.com/servers) hand-reviewed daily. Filter by remote + official-provider; submit for the official-provider badge.
5. **mcp.so** large community-submitted index. Submit directly.
6. **Awesome-MCP-servers GitHub lists** a PR adding mcpemails under an Email/Productivity heading is free, durable backlink and discovery.

### VERIFIED LISTING STATUS (2026-06-24)

Checked each directory directly via API, not web search. Current state:

- **Official MCP Registry, LISTED.** `com.mcpemails/emails`, status `active`, published 2026-06-10 (`curl https://registry.modelcontextprotocol.io/v0/servers?search=mcpemails`). The repo `server.json` was just enriched (commit b4917cb): added a `repository` link to the public GitHub repo + repo id, tightened the description, bumped to 1.0.1. **OWNER ACTION (~5 min):** republish so the new metadata (esp. the repository link, which Glama/PulseMCP use to index and rank) propagates: `mcp-publisher login dns --domain mcpemails.com` (add the printed TXT record to DNS) then `mcp-publisher publish` from repo root.
- **PulseMCP, LISTED** (pulsemcp.com/servers/mcpemails, ranked ~#12,810, ~384 lifetime visitors). Thin: no logo, no tool breakdown. Auto-ingested from the registry. The republish above improves it.
- **Smithery, LISTED** as `bjellanda/mcpemails`. **OWNER ACTION:** log in and claim/enrich (logo + the "unlimited free, no daily caps" differentiator vs mailmcp.io's 20/day cap).
- **Glama, NOT LISTED** (its "mcpemails" search hit is an unrelated repo, `meyannis/mcpemail`). Glama indexes from GitHub repos + the registry. Now that `server.json` carries a `repository` link and the repo is public, re-submit at glama.ai (the "Add server" / claim flow). **OWNER ACTION (~3 min)**, needs a Glama login. This is the single biggest missing surface (largest registry).
- **mcp.so, NOT LISTED.** **OWNER ACTION (~3 min):** submit at mcp.so/submit with the endpoint `https://mcpemails.com/api/mcp` and the description above.
- **awesome-mcp-servers (punkpeye/awesome-mcp-servers, ~60k stars), NOT LISTED.** A one-line PR under an "Email / Communication" heading is a durable backlink. PR is drafted and ready to fire (see Tier-1 appendix below); held for owner sign-off since it posts publicly under the Albretsen GitHub identity.

> Note: the official **Claude Connectors Directory** is not available to us. It is first-party only and we are a third-party aggregator, so that submission is closed (resolved, do not re-attempt). Glama, Smithery, PulseMCP, and mcp.so are the directories that do accept us.

For each: description should say "Email for any inbox (Gmail, iCloud, Fastmail, IMAP). Read, send, schedule, organize from Claude or any MCP client." Link to /for/founders, not just the homepage.

Sources: [Tallyfy: how to list on the MCP registry](https://tallyfy.com/how-to-list-mcp-server-registry-smithery-glama-pulsemcp/), [Glama registry](https://glama.ai/mcp/servers), [PulseMCP](https://www.pulsemcp.com/servers), [Best MCP registries 2026](https://www.truefoundry.com/blog/best-mcp-registries), [Favorite MCP directories](https://dev.to/techgirl1908/my-favorite-mcp-directories-573n)

---

## Tier 2: Founder and indie communities

Pick 2 to 3 and go deep. Contribution before promotion: roughly four genuine comments for every link you drop. The fast way to get banned is to treat these as ad slots.

### Indie Hackers (indiehackers.com)
100k+ bootstrappers who share revenue and lessons in public. The exact crowd doing their own support. Best move is not a launch post but a build-in-public story: "I automated my customer support with Claude and my own inbox, here is the exact 5-prompt routine." End with a soft link to /for/founders. Hyper-relevant audience for a bootstrapped tool.

### Hacker News, Show HN
A front-page Show HN can drive 10k+ visitors in hours. Title format: `Show HN: mcpemails – Answer customer email from Claude across any inbox`. First comment from you should be the honest backstory (built it because support was eating my mornings) plus the technical substance HN respects: standard streamable-http MCP, OAuth 2.1/DCR/PKCE, mail fetched live and never stored, works in Claude/Cursor/ChatGPT/n8n. HN rewards candor about limits, so name them (Gmail OAuth verification screen, app-password providers).

### Product Hunt
A top-5 finish can drive 5k to 20k visitors in a day. Tagline: "Answer customer email from Claude, across any inbox." Line up the launch, gather a few hunters in advance, and point the maker comment at /for/founders. Pair it with the Show HN on the same morning.

### BetaList
Curated directory of startups in beta, free tier available. Low effort, decent early-user trickle, good backlink.

### Reddit (mind the rules, they vary a lot)
- **r/SaaS** friendliest of the big three to self-promotion; founders regularly share for feedback. A "how I use AI to clear support" post does well.
- **r/startups** strict; promotion only in the weekly "Share Your Startup" thread. Use that thread, not a standalone post.
- **r/Entrepreneur** zero-tolerance for blatant promo; only contribute value, no links.
- **r/SideProject, r/IndieHackers, r/Emailmarketing, r/ChatGPT, r/ClaudeAI** softer, good for the build-in-public framing and the MCP angle.
Disclose affiliation, make the post valuable without a click, follow the 80/20 rule.

Sources: [Indie Hackers](https://www.indiehackers.com/), [Where to launch your startup 2026](https://bigideasdb.com/where-to-launch-your-startup-2026), [Reddit self-promotion rules for SaaS](https://oneup.today/blogs/reddit-self-promotion-rules-saas), [Best subreddits for SaaS founders 2026](https://www.subredditsignals.com/blog/best-subreddits-to-promote-a-tech-product-in-2026-rules-real-examples-and-outreach-tips-that-don-t-get-you-banned), [Best subreddits for startup founders 2026](https://www.thevccorner.com/p/20-best-subreddits-for-startup-founders-2026)

### X / Twitter build-in-public
Founders live here. Post the 5-prompt support routine as a thread with a short screen recording of Claude clearing the queue. Tag the build-in-public and Claude/MCP conversations. This is also where you reply to founders complaining about support load with a genuinely helpful note (and only then, the link).

### Slack and Discord founder communities
GrowthMentor Slack, Startup Grind, Tech Startups Discord, and similar. Treat as relationship channels, not link channels: answer support-load questions, mention the tool when it actually fits.

Sources: [15 best founder communities 2026](https://spotlightonstartups.com/15-best-online-communities-for-startup-founders-in-2026/), [25 best online startup communities](https://startupsavant.com/online-startup-communities), [awesome-founder-communities](https://github.com/DirectorySurf/awesome-founder-communities)

---

## Ready-to-post copy

All links go to https://mcpemails.com/for/founders

### Show HN (title + first comment)
**Title:** Show HN: mcpemails – Answer customer email from Claude, across any inbox

**First comment:**
I am a solo founder and customer support was quietly eating my mornings. I built mcpemails so I can do it from Claude instead: it connects my real inbox (Gmail over Google sign-in, plus iCloud, Fastmail, Yahoo, Zoho, Yandex, or any IMAP over an app password) and gives the model nine action-based tools to read, search, draft in my voice, send, schedule, and organize.

It is a standard streamable-http MCP server with OAuth 2.1 / DCR / PKCE, so the same inbox works in Cursor, VS Code, ChatGPT, n8n and others, not just Claude. Mail is fetched live from the provider on each request and never stored on our side; only an encrypted token or app password is kept so requests can authenticate, and you can revoke in one click. Free with unlimited inboxes and tool calls, no card.

Honest limits: Gmail still shows Google's "unverified app" screen until our verification clears, and non-Gmail providers need an app password. Happy to answer anything.

### Indie Hackers post
**Title:** I gave Claude my inbox and now customer support takes 5 minutes a day

**Body:**
For months, support was the work I could not drop and the work that broke my focus. So I wired my inbox into Claude. Now every morning is one pass:

1. "Show me unanswered customer emails from the last 3 days, newest first."
2. "Draft a reply to Maria's refund request, match the tone of my last reply to her."
3. "This is a feature request, reply thanks and file it under Feedback."
4. "Schedule this follow-up to send Monday 8am."
5. "Archive every newsletter so only real people are left."

I review, I send, I am done before coffee. I turned it into a product for other founders doing their own support: https://mcpemails.com/for/founders . Free to start, works with any inbox, and it is your inbox, not a separate help-desk silo. What does your support routine look like right now?

### Reddit r/SaaS (feedback framing)
**Title:** Solo founders: how do you keep up with customer email? I automated mine with Claude

**Body:**
Sharing a routine that gave me my mornings back, curious how others handle this. I connected my inbox to Claude so it can triage and draft replies in my voice, then I review and send. The thing that actually made it stick was telling it to match the tone of a past reply, so nothing goes out sounding like a help desk. I built it into a tool (happy to share if useful, it is free to start) but mostly I want to know: are you doing support by hand, with macros, or with something smarter?

### X / Twitter thread (opener)
I am a solo founder. Customer support used to eat my whole morning.

Now it takes 5 minutes, because Claude does it inside my real inbox.

Here is the exact routine 👇 (and yes, the replies sound like me, not a bot)

[then the 5 prompts, then: built it for other founders → mcpemails.com/for/founders]

### Product Hunt
**Tagline:** Answer customer email from Claude, across any inbox
**First comment:** Built this because support was eating my mornings as a solo founder. Connect any inbox once, then let Claude triage, draft in your voice, send, and schedule. Free to start, and it works in Cursor/ChatGPT/n8n too, not just Claude.

---

## Guardrails

- **Do not spam.** The 80/20 contribution rule is the difference between distribution and a ban. Warm up each community first.
- **Disclose affiliation** every time you mention the product. Founders smell stealth marketing instantly and it backfires.
- **Suppression list still applies** to any direct outreach: never email sandertorvik2@gmail.com or internal/test accounts. (See memory `project_outreach_suppression_list`.)
- **Honesty in copy:** keep the "mail fetched live, never stored" and the Gmail unverified-app caveat in promotional copy. It builds trust with a technical founder audience and matches what the site says.

## What to do this week (suggested order)

1. Claim and fix all Tier 1 MCP directory listings (Glama, Smithery, PulseMCP, mcp.so, official Registry) in one focused session, mostly evergreen.
2. Write the Indie Hackers build-in-public post (lowest risk, hyper-relevant audience).
3. Line up Show HN + Product Hunt for the same morning.
4. Start replying (not posting) in r/SaaS and X build-in-public threads to build standing before any link drops.

Measure against the baseline in memory (`project_growth_active_users_pass`): total_users=14 on 2026-06-23 (15 on 2026-06-24). Watch signups_7d and the inbox-connected activation rate after each wave.

---

## Appendix: ready-to-fire actions (staged 2026-06-24)

### A. Turn on the funnel measurement (DO THIS FIRST, keystone)

Web analytics is now wired in code (branch `feat/funnel-analytics`): the `<Analytics/>` component plus `track('signup_completed')` and `track('api_key_revealed')` events. The site had **zero** analytics before, so every growth call was blind. Two owner steps to make it live:

1. Deploy the branch: merge `feat/funnel-analytics` (or `vercel --prod` from a clean tree on it). Low-risk additive change, build is green, verified mounting on /signup.
2. Vercel dashboard → project `mcp-emails-web` → Analytics tab → **Enable Web Analytics** (one click). Until this toggle is on, the script no-ops and no data is collected.

Then within a few days you can finally answer the question that decides every other lever: **is the problem traffic (few arrivals) or conversion (arrivals bounce)?** The custom events expose the signup → key → connect-inbox drop-off precisely.

### B. awesome-mcp-servers PR (drafted, needs owner sign-off to post publicly)

Target: `punkpeye/awesome-mcp-servers` (~60k stars), `💬 Communication` section, alphabetical by repo name. Exact line:

```
- [Albretsen/MCPEmails](https://github.com/Albretsen/MCPEmails) 📇 ☁️ - Managed email for AI agents: read, search, send, organize, draft and schedule across Gmail, iCloud, Fastmail and any IMAP/SMTP inbox from Claude or any MCP client.
```

Fire it (gh is already authed as Albretsen):

```
gh repo fork punkpeye/awesome-mcp-servers --clone --remote
# add the line under the Communication heading, alphabetically
gh pr create --repo punkpeye/awesome-mcp-servers --title "Add MCP Emails (managed email for AI agents)" --body "Adds mcpemails.com, a managed remote MCP server for email (Gmail, iCloud, Fastmail, IMAP/SMTP). Remote streamable-http + OAuth, free tier. Listed in the official MCP Registry as com.mcpemails/emails."
```

Held rather than auto-fired because it posts publicly under the Albretsen identity. Same caution applies to all Tier-2 community posts.

### C. server.json republish (propagates the repository link to Glama/PulseMCP)

`server.json` now has a `repository` link + repo id (commit b4917cb, version 1.0.1). Republish so directories that read the registry pick it up:

```
# from repo root
mcp-publisher login dns --domain mcpemails.com   # add the printed TXT record to DNS, then re-run
mcp-publisher publish
```
