export default {
  slug: 'build-email-auto-responder-mcp-agent',
  title: 'Building an Email Auto-Responder With an MCP-Connected Agent',
  description: 'Build an email auto-responder with an MCP-connected AI agent: poll for unread mail, draft, and reply safely with scopes, rate limits, and guardrails.',
  cover: '/blog/cover-build-email-auto-responder-mcp-agent.svg',
  coverAlt: 'Building an email auto-responder with an MCP-connected agent — MCPEmails',
  authorId: 'asgeir',
  publishedAt: "2026-05-03T09:00:00.000Z",
  updatedAt: "2026-05-03T09:00:00.000Z",
  tags: ['Workflows', 'Tutorial', 'MCP', 'AI agents'],
  featured: false,
  content: `An email auto-responder built on MCP Emails is a loop, not a webhook. There are no server-initiated events, so your agent **polls** for unread mail on a schedule with \`email_read\` (action \`list\`), reads each message with \`email_read\` (action \`read\`), drafts a reply, and calls \`email_compose\` (action \`reply\`). This post walks the full build: the polling loop, the scopes you need, how to survive rate limits, and the guardrails that keep an agent from blasting your contacts with hallucinated replies.

This is the advanced end of the [give your AI agent email access](/blog/how-to-give-your-ai-agent-email-access) story. If you just want triage and morning summaries without sending anything, read [AI agent inbox triage and summarize](/blog/ai-agent-triage-summarize-inbox) first — it's the safer place to start. Come back here when you actually want the agent to hit send.

## The honest part: there is no webhook

Most "auto-responder" tutorials assume a push event fires the moment mail lands. MCP Emails doesn't work that way, and neither does any MCP server I know of. MCP is a request/response tool protocol. The server answers when your agent asks; it never calls you.

So a real auto-responder is a scheduler plus a poll. You run a tick every N seconds or minutes, ask for unread messages, and process whatever's new. That's it. It's less elegant than a webhook, but it's predictable, and it means *you* control the cadence and the blast radius.

Pick a poll interval that matches your tolerance for latency against your rate budget. Every 60 seconds is fine for support-style replies. Every 5 minutes is plenty for most inboxes and barely touches your limits. Don't poll every second — you'll burn quota for no reason and the inbox rarely changes that fast.

## What you need: an API key with send scope

An auto-responder almost always runs as a script or a cron job, not inside a chat client. That means the [API-key path, not OAuth](/blog/oauth-vs-api-keys-ai-email-access).

In the dashboard, go to **API Keys**, create a key, and grant it the scopes you actually need:

- \`read:email\` — to poll, list, and read messages with \`email_read\`.
- \`send:email\` — to call \`email_compose\` (action \`reply\`).

The key is shown once. Copy it. It looks like \`mcpe_live_...\` and you pass it on every request:

\`\`\`
Authorization: Bearer mcpe_live_YOUR_KEY
\`\`\`

The MCP endpoint is a single URL:

\`\`\`
https://www.mcpemails.com/api/mcp
\`\`\`

Grant **only** the scopes the job uses. If a future version of your responder needs to forward or flag mail, add those capabilities then. A key that can read and reply is a key that, if leaked, can only read and reply. (For the full picture on key handling and rotation, see [the docs](/docs).)

## The loop

Here's the shape of a working responder. I've written it as pseudo-code over the MCP tools so it's clear what calls happen in what order. The exact MCP client wiring depends on your stack, but the sequence is the point.

\`\`\`python
# Tools used: inbox_list, email_read, email_compose

inbox = inbox_list()[0]              # discover, never hardcode the UUID

while True:
    unread = email_read(
        action="list",
        inbox_id=inbox["inbox_id"],
        unread_only=True,
        limit=20,
    )

    for summary in unread["messages"]:
        if not should_handle(summary):   # allowlist + filters, see below
            continue

        msg = email_read(
            action="read",
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
        )

        draft = generate_reply(msg)      # your LLM call

        if not passes_guardrails(draft, msg):
            queue_for_human(msg, draft)  # don't send; flag it
            continue

        send_with_backoff(
            inbox_id=inbox["inbox_id"],
            message_id=summary["message_id"],
            body=draft,
        )

    sleep(60)
\`\`\`

Three things to notice. First, the agent calls \`inbox_list\` to discover the \`inbox_id\` rather than pasting a UUID into the code — that's the discovery-first pattern, and it keeps the script working if you reconnect an inbox. Second, \`unread_only: true\` is what makes this a *new mail* responder instead of a re-reply-to-everything machine. Third, every message passes through guardrails before anything sends.

### Marking messages handled

If you want a message to stop showing up as unread once you've replied, read it with \`mark_as_read\` set, or call \`mark_read\` explicitly. Be deliberate here: if your loop replies but never marks the message read, the next tick will reply again. Mark-as-handled is how the loop stays idempotent.

## Rate limits, and why you never blind-retry a send

Every API key is capped at **100 requests per minute, 1,000 per hour, and 10,000 per day**, regardless of plan. Your workspace also has a burst ceiling by tier — **60 req/min on Free, 300 on Agent, 1,000 on Scale** (see [pricing](/pricing)). A polite poll-and-reply loop lives well inside that, but a misbehaving one can trip it.

When you hit a limit, the server returns a retryable error (code \`-32029\`) carrying \`data.retry_after\` in seconds. Honor it. Sleep for that long, then continue.

Here's the rule that matters most: **never blindly auto-retry an \`email_compose\` send or reply.** A send is not idempotent. If a send call times out or returns ambiguously, a naive retry can deliver the same reply twice. Retry *reads* freely; treat *sends* as one-shot and only retry on an explicit retryable error, with backoff and a hard cap.

\`\`\`python
def send_with_backoff(**kwargs):
    delay = 2
    for attempt in range(3):
        try:
            return email_compose(action="reply", **kwargs)
        except RateLimited as e:
            sleep(e.retry_after or delay)
            delay *= 2
        except RetryableError:
            sleep(delay)
            delay *= 2
        # any other error: do NOT retry a send. log it, move on.
        else:
            break
    raise SendFailed(kwargs)
\`\`\`

Notice it only retries on rate-limit or explicitly retryable errors, caps at three attempts, and never loops forever. A send that fails three times is a human's problem, not the loop's.

## Guardrails: the difference between a tool and a liability

An auto-responder that sends without supervision is one bad prompt away from emailing your CEO a confidently wrong answer. Build the brakes before you build the engine.

### Allowlist who gets auto-replies

Don't reply to everyone. Start with a narrow allowlist — a support alias, a specific sender domain, messages matching a subject pattern. Everything else gets queued for a human or ignored. An allowlist is the single highest-leverage guardrail you can add, because it bounds the failure to a population you chose.

### Keep a human in the loop, at least at first

The safest version of this isn't an auto-responder at all — it's an auto-*drafter*. The agent reads, drafts, and stages the reply, but a person approves the send. MCP Emails supports drafts, so you can have the loop call \`draft\` (action \`create\`) instead of \`email_compose\`, then send the good ones yourself. Run in draft mode for a week. Read what it would have sent. Only then flip the ones you trust to auto-send.

### Stop loops and self-replies

Two classic failure modes:

- **Auto-reply ping-pong.** If you reply to a vacation autoresponder and it replies to your reply, you've built an infinite loop with someone else's bot. Filter out messages that look automated (check for \`Auto-Submitted\` headers, \`no-reply\` senders, or known autoresponder subjects) and never reply to your own address.
- **Re-replying to the same thread.** Mark messages read after handling, and keep a small record of message IDs you've already answered. Idempotency isn't optional when sending is involved.

### Constrain what the model can say

Give the drafting model tight instructions and a length cap. For support replies, a template with slots beats free-form generation. And run a cheap check before sending: does the draft contain a refund promise, a price, a legal commitment, or a link you didn't expect? If so, route it to a human. That's the \`passes_guardrails\` check in the loop above, and it's where you spend most of your engineering effort.

## A realistic first version

If I were shipping this for a real inbox tomorrow, I'd start small and boring:

1. API key with \`read:email\` and \`send:email\`, scoped to one inbox.
2. Poll \`email_read(action: "list", unread_only: true)\` every two minutes.
3. Allowlist exactly one support alias.
4. Draft mode only — create drafts, send nothing automatically.
5. After a week of reading the drafts, enable auto-send for the obvious cases and keep drafting the rest.

That's a system you can actually trust, and it generalizes. The same loop with a different prompt becomes a triage bot, a lead router, or a notifier. For the broader menu of what an agent can do once it's wired in, see [7 things an AI agent can do with inbox access](/blog/7-things-ai-agent-can-do-with-inbox-access). If you're still deciding whether to hand an agent send access at all, [is it safe to give an AI agent email access](/blog/is-it-safe-to-give-ai-agent-email-access) is worth your time before you ship.

Ready to build it? Create a scoped API key and read the tool reference in [the docs](/docs), or [start free](/signup) — Free includes 2,500 billable actions per billing period, with higher allowances on paid plans.`,
};
