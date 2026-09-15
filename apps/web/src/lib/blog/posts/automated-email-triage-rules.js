const post = {
  slug: 'automated-email-triage-rules',
  title: 'Automated Email Triage Rules That Run Without a Model in the Loop',
  description:
    'How MCP Emails automations work: a stored search plus one fixed action, on a cadence, with no model interpreting your mail. Preview, create, enable, read the run log.',
  cover: '/blog/cover-ai-agent-triage-summarize-inbox.svg',
  coverAlt:
    'Unattended email triage rules in MCP Emails: a stored search plus one fixed action on a schedule',
  authorId: 'asgeir',
  publishedAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-15T09:00:00.000Z',
  tags: ['Automations', 'Inbox triage', 'MCP', 'Email'],
  featured: false,
  content: `> **Outlook and Microsoft 365 are in progress.** They cannot be connected in production yet.

Every morning you ask your agent to clear the noise: file the build notifications, mark the receipts read, forward invoices to your bookkeeper. It works. It also costs a model call every time, and it does something slightly different on Tuesday than it did on Monday.

MCP Emails has a second surface for exactly that mail. An **automation** is a stored search plus one fixed action, evaluated on a cadence, with no model in the loop. Mail is matched, never interpreted.

**Jump to:** [What a rule is](#what-an-automation-actually-is) · [Build one](#build-one-preview-create-enable) · [What it can and cannot do](#what-a-rule-can-and-cannot-do) · [When not to write one](#when-not-to-write-a-rule)

## What an automation actually is

Three parts, and nothing else.

- **A filter.** The same structured criteria a search takes: \`from\`, \`to\`, \`cc\`, \`subject\`, \`body\`, \`text\`, \`unread\`, \`has_attachment\`, \`flagged\`, \`since\`, \`before\`. At least one criterion is required. An empty filter is refused outright: on a fast cadence it would process your entire mailbox, which is far more likely to be a typo than an intent.
- **One action.** Exactly one, from a closed set, fixed when you create the rule.
- **A cadence.** \`interval_minutes\`, from a fixed ladder: 15, 30, 60, 180, 360, 720 or 1440 minutes. A ladder rather than a free integer, because a one-minute rule achieves nothing except getting you rate limited.

Set \`max_messages_per_run\` too (default 25, maximum 200): it is the per-run blast radius, capping how much mail a bad filter can touch before a human sees the run log. A rule runs as the credential that created it, and authority is re-derived on every run, so revoking the key stops the rule on its next run.

## Why a rule beats asking an agent every morning

- **Cost.** A rule spends no tokens. The morning conversation spends them daily, on mail whose handling you decided months ago.
- **Repeatability.** The same filter produces the same action. There is no "it decided differently today" because there is no deciding.
- **No hallucinated moves.** A rule cannot invent a folder, improvise a recipient, or act on an instruction it found inside an email body.
- **It runs while you sleep.** MCP Emails is otherwise poll-based: the agent checks for new mail when you ask it to. A rule is the part that needs no asking.

## Agent triage and unattended rules do different jobs

Rules handle mail identifiable from its envelope: a known sender, a stable subject prefix, an unread flag, an attachment. Conversation handles mail that needs judgment. Do not express judgment as a filter: a rule that guesses intent from a subject line will be wrong unattended, at scale, for weeks. If the decision needs the body understood, keep it in a conversation and use the [triage and summarize playbook](/blog/ai-agent-triage-summarize-inbox).

## Build one: preview, create, enable

Three steps in that order. The order is the safety property.

### Step 1: dry-run the filter

\`automation_read\` with action \`preview\` is a dry run. It reports what a filter matches right now, applies nothing, sends nothing, and does not claim any message in the deduplication ledger, so it never consumes mail a later real run should see. Preview an unsaved \`filter\`, or a stored rule by \`automation_id\`.

> Preview an automation filter on my work inbox: unread mail from notifications@github.com. Show me what it would match right now. Do not create or change anything.

Read the matches. If anything in that list would be wrong to move, the filter is wrong: tighten it and preview again.

### Step 2: create the rule

\`automation\` with action \`create\` needs four things: \`name\`, \`filter\`, \`rule_action\` and \`interval_minutes\`. Note the two keys, because they are easy to confuse. On the tool, \`action\` selects the operation (create, update, enable, disable, delete). \`rule_action\` is what the **rule** does to matching mail.

> Create an automation called "GitHub notifications" on my work inbox. Filter: from notifications@github.com. Rule action: move to the Notifications folder. Interval: 60 minutes.

The rule is created **disabled**, and that is not a flag you can flip in the same call. Enabling is always a separate, explicit act, so no unattended mailbox work starts as a side effect of creating a rule.

### Step 3: enable it

\`automation\` with action \`enable\`. The rule becomes due immediately, runs, then follows its cadence. This is the moment the server starts touching your mailbox with nobody watching, which is why it gets its own step. \`delete\` removes a rule but keeps its run history.

## What a rule can and cannot do

The five rule actions:

- **move** to a folder you name.
- **label**, applied as a Gmail label, an Outlook category or an IMAP keyword. On IMAP a label is an atom, so spaces become underscores.
- **mark_read**.
- **forward** to up to ten recipients, with an optional short note. A forward is **always** held for [human approval](/blog/approve-ai-agent-email-sends), whatever the inbox's approval setting says: that setting means "a human is watching this mailbox's sends", and an unattended runner is exactly what breaks the assumption.
- **draft_reply**, which only ever writes a draft and never sends. Its template substitutes \`{{sender_name}}\`, \`{{sender_email}}\`, \`{{subject}}\` and \`{{date}}\` and nothing else. Message bodies are never interpolated at all.

What a rule cannot do:

- **Delete mail.** Deleting is not available to an automation. Moving to Trash, Junk or Spam is refused too: every provider empties those on a timer, so filing into them is a delete with a delayed fuse. File to a folder you own and delete it yourself once you have read the run log.
- **Interpret anything.** No summarizing, no "if it sounds urgent".
- **Chain two actions.** Labelled and marked read is two rules over the same filter.

## Watching run history

\`automation_read\` with action \`runs\` lists recent runs and their counters: matched, processed, succeeded, failed, skipped. Action \`list\` gives every rule in the workspace with its schedule, action and health; \`get\` reads one in full, filter and failure state included.

The counter worth understanding is **skipped**. A high skipped count against a low processed count is not a problem: it means an overlapping run was correctly deduplicated. Each rule claims a message before acting on it, so a re-dispatched run cannot move the same mail twice. Rules also stop themselves after five consecutive failed runs, rather than grinding against a broken folder name forever.

## When not to write a rule

- The decision needs the body read and understood. Keep it in conversation.
- The sender is not stable. A filter on a moving target ages badly.
- It is a one-off cleanup. Ask the agent to run \`email_search_and_move\` once and watch it.
- You have not previewed it. A rule you have not dry-run is a scheduled guess.

## A realistic inbox: a few rules plus one conversation

Four rules that clear everything mechanical, plus one morning conversation over what is left:

1. Deploy notifications from a known sender, moved to a folder, every 60 minutes.
2. Receipts and order confirmations, labelled, every 180 minutes.
3. Invoices from a known billing address, forwarded to your bookkeeper and held for your approval, every 720 minutes.
4. A newsletter sender you keep but never read, marked read, every 1440 minutes.

Then you ask your agent about the thirty messages left instead of the hundred and eighty that arrived. The rules are not trying to be clever. They remove everything that never needed intelligence.

## Rules count toward your plan's actions

Every action a rule applies is metered exactly like an interactive one, because it is the same mailbox effect. On the **Free** plan that is 150 billable email actions per UTC calendar month, with the first 7 days uncounted. That monthly cap applies to workspaces created on or after 2026-09-13; workspaces created earlier are exempt. When a workspace reaches its allowance a rule **pauses** rather than fails: it stays enabled, and its next run moves to the moment the allowance period ends. **Personal** at $5 per month removes the monthly action cap and allows 3 connected inboxes. See [pricing](/pricing).

## FAQ

**Does an automation use an LLM?**  
No. A rule is a stored search plus one fixed action. Mail is matched, never interpreted, and message bodies are never copied into anything a rule produces.

**Can a rule delete my email?**  
No. Deleting is not available to automations, and moving mail into Trash, Junk or Spam is refused for the same reason.

**What scope does this need?**  
Every automation action requires \`manage:automations\`, a separate grant from reading or sending, because holding it means a client may create standing rules that touch your mailbox unattended.

**Will a forward rule send mail on its own?**  
Never. A forward is always held for human approval regardless of your inbox's approval setting, and a \`draft_reply\` rule only ever writes a draft.

## Next step

[Create a free account](/signup), connect an inbox, and ask your agent to preview one filter before it saves anything. When the matches look right, create the rule, enable it, and read the run log tomorrow. The [documentation](/docs) has the full tool reference.`,
};

export default post;
