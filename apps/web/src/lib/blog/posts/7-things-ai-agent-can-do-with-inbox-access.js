export default {
  slug: '7-things-ai-agent-can-do-with-inbox-access',
  title: '7 Things Your AI Agent Can Do Once It Has Inbox Access',
  description:
    'Seven concrete things an AI agent can do with inbox access: triage unread mail, summarize threads, draft replies, find attachments, chase follow-ups, and route mail.',
  cover: '/blog/cover-7-things-ai-agent-can-do-with-inbox-access.svg',
  coverAlt: 'Seven things your AI agent can do with inbox access over MCP — MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-06-01T12:00:00.000Z',
  updatedAt: '2026-06-01T12:00:00.000Z',
  tags: ['Workflows', 'AI agents', 'Email'],
  featured: false,
  content: `Once your agent can read and send real email, the demo-ware stops and the actual work starts. Here are seven things you can have it do today: triage the unread pile, summarize a long thread, draft replies in your voice, dig up that one attachment, chase down follow-ups, route mail to the right place, and ship you a weekly digest.

Every example below maps to real MCP tools you can call right now. The tools are the same whether you connect Gmail, Outlook, iCloud, Fastmail, or a generic IMAP box. If you haven't wired an agent to your inbox yet, the [complete guide to giving your AI agent email access](/blog/how-to-give-your-ai-agent-email-access) covers the setup; the [2-minute connect walkthrough](/blog/connect-email-to-ai-agent-under-2-minutes) is the fast path.

One honest caveat up front, because it shapes half of this list: **MCP Emails is poll-based, not push.** There are no webhooks and no server-initiated events. The agent doesn't get pinged when mail arrives. It checks on a schedule. That sounds like a limitation, and for a few use cases it is, but it also means nothing fires without a clock you control. I'll flag where polling matters.

## The toolset, in one breath

Everything here runs on six core tools: \`list_inboxes\`, \`list_messages\`, \`read_email\`, \`search_emails\`, \`send_email\`, and \`reply_to_email\`. There are a few more for marking read, flags, folders, scheduled send, and contact lookup. The first call your agent should always make is \`list_inboxes\` to discover the connected accounts and their \`inbox_id\` values, so you never hardcode a UUID into a prompt.

The prompts below are written the way I'd actually type them to Claude or Cursor. The agent figures out which tool to call.

### 1. Triage the unread pile

The morning inbox is mostly noise with three things buried in it that matter. Have the agent sort that out before you've finished your coffee.

> Check my work inbox for unread mail from the last 24 hours. Group it into "needs a reply today," "FYI," and "newsletters/automated." For the first group, give me one line each on what they want.

Under the hood the agent calls \`list_messages\` with \`unread_only: true\` on the inbox \`list_inboxes\` returned, reads the few that look important with \`read_email\`, and skips the rest. It can mark the obvious noise as read so it stops cluttering the count. For a deeper version of this, the [triage and summarize playbook](/blog/ai-agent-triage-summarize-inbox) goes tool by tool.

### 2. Summarize a long thread

You get added to a 40-message thread at message 38. Nobody is going to read up. The agent will.

> Read the thread with subject "Q3 vendor migration" and tell me where it actually landed: what was decided, who owns what, and any open question I need to answer.

\`search_emails\` finds the thread (it uses your provider's native search syntax, so Gmail operators, Outlook KQL, and IMAP text search all work), then \`read_email\` pulls the parsed plain text of each message. \`read_email\` can also return sanitized HTML and attachments when you ask, but for a summary the plain text is faster and cheaper.

### 3. Draft replies in your voice

Drafting is where agents earn their keep. The model writes the boring reply, you skim and send.

> Draft a reply to the latest message from Dana declining the meeting but offering two times next week. Match my usual tone, short and direct.

The agent uses \`reply_to_email\`, which sets the threading headers (In-Reply-To and References) for you, so the reply lands in the right conversation instead of starting a new one. Replies support CC, BCC, HTML, and attachments up to 10 MB total. My rule: let the agent draft freely, but keep a human on the send button for anything that leaves the building. Treat \`send_email\` and \`reply_to_email\` as the steps you actually review.

### 4. Find that one attachment

You know someone sent the signed contract in March. You do not know which of 200 threads it's in. Search beats scrolling.

> Find the most recent email with a PDF attachment from anyone at acme.com about the renewal, and pull the attachment out.

\`search_emails\` narrows it down with a provider-native query, then \`read_email\` with \`include_attachments\` returns the file. Because the email is fetched live and discarded after the call, that attachment isn't sitting in some cache later. The [never-stored architecture](/blog/why-email-never-stored-matters) is the reason this is safe to point an agent at.

### 5. Follow-up reminders (this one is polling)

"Did the client ever reply?" is a question you forget to ask until it's too late. An agent can hold the thread for you, but here's where the poll-not-push reality bites.

> Every weekday at 4pm, check whether anyone replied to the proposals I sent this week. List the ones still waiting with the original send date.

There's no event that wakes the agent when a reply arrives. Instead you run it on a schedule, a cron job, your client's scheduled-task feature, whatever fits, and each run does the work: \`search_emails\` for sent proposals, then \`list_messages\` to see what came back. If you want a stale thread to nudge itself, the agent can even draft and queue a follow-up. The [auto-responder build](/blog/build-email-auto-responder-mcp-agent) walks through the polling loop in detail, including how to honor the \`retry_after\` value when you hit a rate limit so you're not hammering the server.

### 6. Route or forward to the right place

Not every email is for you. Some belong in a shared box, a ticketing address, or a teammate.

> Forward anything that looks like an invoice to accounting@, and flag receipts I should keep for taxes.

The forward tool sends through your own provider, so the message keeps your domain's reputation instead of getting relayed from some third party. Flags and folders let the agent file things without deleting them. This is the kind of standing rule that pairs naturally with the unread-triage pass in #1, one run, two outcomes.

### 7. A weekly digest

End the week with a written summary instead of a guilty glance at an inbox you never cleared.

> Friday at 5pm: summarize everything I received this week that I haven't replied to, grouped by sender, with the single most important action item across all of it. Email it to me.

This stitches the others together: \`search_emails\` and \`list_messages\` to gather the week, \`read_email\` for the ones that need detail, then \`send_email\` to deliver the digest to yourself. Like the follow-up nudge, it's a scheduled run, not a reaction. You decide the cadence.

## What this costs and where the limits sit

All seven work on the [Free plan](/pricing), which is $0 with unlimited inboxes and tool calls. The plans differ on burst rate, not on what the tools can do. Free allows 60 requests per minute, Solo ($12/month) bumps to 300, and Team ($49/month) goes to 1,000 with team roles and SSO. A weekly digest barely touches those ceilings; an aggressive every-minute triage loop across many inboxes is where you'd feel Free's limit and want Solo.

When you do hit a limit, the server returns a retryable error with \`data.retry_after\` in seconds. Honor it. And never blindly auto-retry a \`send_email\` call, because a retry on a timeout can mean two copies of the same message land in someone's inbox.

## Start with one

Don't try to build all seven on day one. Pick the triage pass or the weekly digest, get it boring and reliable, then add the next. [Connect an inbox](/signup) and have your agent run \`list_inboxes\` as its first move. The [tool reference in the docs](/docs) has the exact parameters for every call above.`,
};
