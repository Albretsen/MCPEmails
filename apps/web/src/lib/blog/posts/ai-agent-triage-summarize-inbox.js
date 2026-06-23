export default {
  slug: 'ai-agent-triage-summarize-inbox',
  title: 'How to Get Your AI Agent to Triage and Summarize Your Inbox',
  description:
    'A practical how-to for AI agent inbox triage: copy-paste prompts that list unread mail, read what matters, summarize and prioritize, and poll on a schedule.',
  cover: '/blog/cover-ai-agent-triage-summarize-inbox.svg',
  coverAlt: 'AI agent triaging and summarizing an inbox over MCP — MCP Emails',
  authorId: 'asgeir',
  publishedAt: "2026-04-23T09:00:00.000Z",
  updatedAt: "2026-04-23T09:00:00.000Z",
  tags: ['Workflows', 'Claude', 'Tutorial', 'AI agents'],
  featured: false,
  content: `The fastest way to get an AI agent to triage your inbox is to lean on two tools in order: \`inbox_list\` to find your mailbox, then \`email_read\` — with \`action: list\` and \`unread_only: true\` to pull what's new, then \`action: read\` for the handful that look important — and then a plain-English instruction to summarize and rank them. That's the whole loop. If you want it to draft or send responses, you add \`email_compose\` with \`action: reply\` at the end.

This post gives you the exact prompts I use, what good output looks like, and how to run the same loop on a schedule so your morning triage happens before you sit down. It assumes your agent already has email access through [MCP Emails](/blog/how-to-give-your-ai-agent-email-access). If you haven't connected an inbox yet, the [under-two-minutes connect guide](/blog/connect-email-to-ai-agent-under-2-minutes) gets you there first.

## The triage loop, in one picture

Every triage session is the same five steps. Your agent figures out the order on its own once you describe the goal, but it helps to know what's happening under the hood:

1. \`inbox_list\` — discover connected inboxes and their \`inbox_id\` UUIDs. The agent never hardcodes a UUID; it looks one up here.
2. \`email_read\` with \`action: list\` and \`unread_only: true\` — pull the unread queue for one inbox, newest first.
3. \`email_read\` with \`action: read\` — open the full body for the few messages worth reading in detail.
4. Summarize and prioritize — pure reasoning, no tool call. The model groups, ranks, and explains.
5. \`email_compose\` with \`action: reply\` (optional) — draft or send for the ones that need an answer.

Steps 1 through 4 are read-only. If you connected with a \`read:email\`-scoped [OAuth grant or API key](/blog/oauth-vs-api-keys-ai-email-access), the agent physically cannot send anything, which is exactly what you want for an automated summary you'll skim later.

## Prompt 1: the morning summary

Start simple. This is the one I run most days. Paste it into Claude (or any MCP client connected to MCP Emails) and let it work:

> Look at my main inbox. Pull everything unread, then give me a summary grouped into three buckets: needs a reply today, FYI / can wait, and probably noise. For each item in the first two buckets, give me one line: who it's from and what they want. Don't open anything I don't need — skim the subjects and senders first, only read the body when the subject is ambiguous.

Notice what that prompt does. It tells the agent to lean on \`email_read\` (action list) metadata (sender, subject, snippet) and to call \`email_read\` with \`action: read\` sparingly. That keeps the session fast and stays well under the rate limits — 100 requests per minute per API key, and a per-workspace ceiling that starts at 60/min on the Free plan. A 40-message unread queue triaged this way is maybe a dozen tool calls, not forty.

A good response looks like this:

\`\`\`text
NEEDS A REPLY TODAY (3)
- Dana (Acme): contract redline is back, wants sign-off before Fri
- Priya: blocked on the staging creds, asking you directly
- Stripe: a payment dispute opened, response due in 5 days

FYI / CAN WAIT (4)
- GitHub: 2 PRs merged into main overnight
- Notion: weekly digest
- Lena: shared the Q3 deck, no ask
- AWS: scheduled maintenance next Tuesday

PROBABLY NOISE (11): newsletters, 2 calendar invites already on your
calendar, LinkedIn, 6 marketing blasts.
\`\`\`

That is genuinely useful in a way a raw inbox is not. The agent read the three messages where the subject didn't make the ask obvious, and it left the eleven newsletters closed.

## Prompt 2: deep triage with priorities and reasoning

When the unread count is ugly — a Monday after a long weekend — I want more than buckets. I want the agent to defend its ranking so I can trust it:

> My inbox is a mess. Triage everything unread from the last 4 days. Rank the top 8 by how urgent they actually are, not by how loud the sender is. For each, tell me the deadline if there is one, who's blocked, and your one-sentence reasoning for the rank. Read the full body for anything in your top 8 so you're not guessing.

The "not by how loud the sender is" line matters. Without it, agents over-index on ALL CAPS subjects and "URGENT" from automated systems. With it, you get judgment:

\`\`\`text
1. Priya — blocked on staging creds since Thu. A teammate can't ship
   until you respond. No formal deadline but it's costing time now.
2. Stripe dispute — hard deadline in 5 days, money attached, but you
   have buffer so it's #2 not #1.
3. Dana (Acme) — contract sign-off by Fri. Important, not yet urgent.
...
\`\`\`

For this prompt the agent will call \`email_read\` with \`action: read\` eight times, once per top item, because you asked it to stop guessing. That's the right trade: a few extra calls for rankings you can act on. If the agent does hit a limit mid-run, MCP Emails returns a retryable error with a \`retry_after\` value in seconds — a well-behaved client waits that long and resumes rather than hammering the server.

## Prompt 3: triage that ends in a reply

Triage is more valuable when it closes loops. Once you trust the summaries, let the agent draft. I keep a human in the loop for sends, so my prompt asks for drafts, not autopilot:

> Same triage as usual. For anything in "needs a reply today" that I can answer in two sentences, draft the reply and show it to me. Don't send yet — I'll say "send 1 and 3" or edit them. Match my usual tone: short, direct, no corporate filler.

The agent runs the read-only loop, then writes drafts inline. When you say "send 1 and 3," it calls \`email_compose\` with \`action: reply\` for those two. Replies thread automatically — MCP Emails sets the \`In-Reply-To\` and \`References\` headers for you, so your answer lands in the right conversation instead of starting a new one. The mail goes out through your own provider (Gmail API, Microsoft Graph, or your SMTP), so deliverability and your domain reputation stay yours. Nothing is relayed from some shared sending domain.

If you want to take the next step and remove yourself from the loop entirely, that's a different shape of automation — see [building an email auto-responder with an MCP agent](/blog/build-email-auto-responder-mcp-agent) for the guardrails I'd put on it before letting an agent send unattended.

## Running triage on a schedule

Here's the honest limitation: MCP is **poll, not push.** MCP Emails has no webhooks and sends no server-initiated events. Your agent doesn't get pinged when mail arrives. To do ongoing triage, something has to call \`email_read\` with \`action: list\` and \`unread_only: true\` on a timer.

In practice that means one of two setups:

- A scheduled job — a cron entry, a scheduled task in your agent platform, or Claude's own scheduling if your client supports it — that fires the morning-summary prompt at 8am and again after lunch. Twice a day covers most people.
- An always-on agent loop that polls every few minutes during work hours. This is overkill for a personal inbox and burns rate limit for little gain. Reserve it for genuinely time-sensitive mailboxes like support@ or alerts@.

I run the scheduled-job version. Two polls a day, each one a single morning-summary prompt against my main inbox. It costs a handful of tool calls and lands a clean digest in front of me before I open the mail client. For most people, that beats a real-time loop on every axis that matters.

Whatever cadence you pick, keep the polling honest: more frequent polling does not mean faster, it just means more requests against the same 60-to-1,000-per-minute ceiling. Match the interval to how fast the inbox actually moves.

## A few things that make triage noticeably better

- **Name the inbox.** If you've connected more than one account, say "my work inbox" or "the support inbox." The agent resolves it from \`inbox_list\` titles, and you avoid it triaging the wrong mailbox.
- **Give it a rubric, not just "summarize."** "Urgent = someone is blocked or there's a same-day deadline" produces dramatically better rankings than leaving urgency undefined.
- **Cap the reads.** "Only open the body when the subject is ambiguous" or "read the top 8" keeps sessions fast and cheap. Unbounded "read everything" is slow and rarely better.
- **Stay read-only until you trust it.** Run with a \`read:email\` scope for a week. Add \`send:email\` only once the drafts are consistently good.

If triage is the first workflow you're trying, it's a good one to start with — it's read-only, the payoff is immediate, and it builds the trust you'll want before handing over send access. For more ideas once you're comfortable, here are [seven things an AI agent can do with inbox access](/blog/7-things-ai-agent-can-do-with-inbox-access).

## Try it on your own inbox

Connect an inbox, paste Prompt 1, and watch your agent thin out a 40-message backlog in under a minute. It's [free to start](/signup), no card required, and you can revoke access from the dashboard in one click. The [tool reference in the docs](/docs) has every parameter if you want to wire the loop into a script instead of a chat.`,
};
