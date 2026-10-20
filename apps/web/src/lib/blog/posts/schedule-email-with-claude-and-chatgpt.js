// Facts about Claude's and ChatGPT's own mail connectors below were checked on
// 2026-10-20 against the vendors' help centres:
//   - support.claude.com/en/articles/10166901 (Google Workspace connectors):
//     the Gmail connector lists search, read, draft, send, reply and forward,
//     and nothing about sending later.
//   - help.openai.com/en/articles/12512241 (Outlook Email and Calendar apps):
//     search and read messages, people and contact actions, plain-text send
//     from shared or delegated mailboxes; no scheduled send.
//   - help.openai.com/en/articles/10408842 (Google app data controls FAQ): data
//     use and Gmail event-triggered tasks; no scheduled send. OpenAI has no
//     separate Gmail capabilities article (help-centre search, 2026-10-20).
//   - help.openai.com/en/articles/10291617 (Scheduled tasks in ChatGPT) and
//     help.openai.com/en/articles/11487775 (Connected apps): tasks run a prompt
//     later, and "actions that require approval may pause the task".
//
// Review before sending is deliberately NOT described here. Checked
// 2026-10-20: an approved schedule_create is re-run by handleScheduledDispatch
// as executeScheduleSend(original), and the stored approval payload carries no
// send_at, so the re-run fails validation. Add the section back once that path
// is fixed and tested.
// Re-check all of them before editing the "What the built-in mail connectors
// do" section. ChatGPT setup is deliberately not described here: plans and
// menus moved again on 2026-10-20, and /docs/chatgpt owns those steps.
//
// MCPEmails behaviour is from supabase/functions/mcp-server/index.ts: the
// `schedule` spec in CONSOLIDATED_SPECS, executeScheduleSend,
// executeScheduleList, executeScheduleCancel and handleScheduledDispatch.
const post = {
  slug: 'schedule-email-with-claude-and-chatgpt',
  title: 'How to Schedule an Email with Claude or ChatGPT (Send Later)',
  description:
    'Schedule an email from Claude or ChatGPT to go out later from your own Gmail, Outlook, iCloud or IMAP mailbox: setup, time zones, cancelling and limits.',
  cover: '/blog/cover-agent-inbox.svg',
  coverAlt:
    'Claude and ChatGPT scheduling an email to send later from a connected mailbox with MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  tags: ['Scheduled send', 'Claude', 'ChatGPT', 'MCP'],
  featured: false,
  content: `To schedule an email with Claude or ChatGPT, the assistant needs a mail tool that can hold a message and send it later. MCPEmails has one. Connect your mailbox, add MCPEmails as a connector, and say when: "Send this to Dana on Monday at 9:00, Oslo time." The message waits in a queue on the MCPEmails server and goes out from your own address at that time, whether or not the chat, the app or your computer is still open.

It works the same way in Claude, in ChatGPT and in other MCP clients, and on Gmail and Google Workspace, Outlook and Microsoft 365, iCloud, Fastmail, Yahoo, Zoho and any mailbox that speaks IMAP and SMTP.

**Jump to:** [Built-in connectors](#what-the-built-in-mail-connectors-do) · [Setup](#how-to-schedule-an-email-with-claude-or-chatgpt) · [Time zones](#time-zones) · [Cancel or change](#check-cancel-or-change-a-scheduled-email) · [FAQ](#faq)

## What the built-in mail connectors do

Both assistants ship their own mail connectors. This is where they stood on 2026-10-20:

- **Claude.** Anthropic's help article on the Gmail connector lists searching, reading, drafting, sending, replying and forwarding. Scheduling a message for later is not on the list.
- **ChatGPT.** OpenAI's help page for its Outlook Email app covers searching and reading messages, people and contact actions, and sending plain-text email from shared or delegated mailboxes. Its Google app FAQ covers data use and Gmail-triggered tasks. Neither describes a scheduled send.

ChatGPT does have **scheduled tasks**, which run a prompt at a time you choose. That is not the same as a queued email. The message is written when the task runs, not when you approve the wording, and OpenAI notes that actions needing your approval may pause the task.

A scheduled send through MCPEmails is a finished message: you read the exact text now, and that text is what leaves at the set time.

## How to schedule an email with Claude or ChatGPT

1. **Connect your mailbox to MCPEmails.** In the dashboard, open **Inboxes**, then **Connect inbox**, and pick your provider. There is a page per provider under [connect](/connect).
2. **Add MCPEmails to your assistant.** In Claude, open **Settings**, then **Connectors**, choose **Add custom connector** and paste \`https://mcpemails.com/api/mcp\`. The [Claude guide](/blog/connect-claude-to-email) has every step. In ChatGPT, MCPEmails is added as a custom MCP connector; which plans offer that and where the menu sits have changed more than once this year, so follow the current steps in the [ChatGPT setup guide](/docs/chatgpt).
3. **Grant scheduling when you authorize.** The MCPEmails consent screen offers access levels. Choose **Full access**, or **Custom** with scheduling ticked. **Standard** leaves scheduling out, so a schedule request is refused.
4. **Ask for the email and the time.** Give the recipients, what to say, the date and time, and your time zone.

Behind the scenes, the assistant calls the \`schedule\` tool with action \`create\`, passing recipients, subject, body and the send time. MCPEmails checks the addresses, subject and body straight away, so a malformed address or an empty body is refused now instead of failing on Monday morning. It cannot tell a valid address you did not mean from one you did, which is why the prompts below ask to see the recipient first. The result carries the scheduled time and an id the assistant can use later to cancel.

At send time, a dispatcher on the MCPEmails server, which checks the queue every minute, sends the message through the mailbox's own provider: Gmail, Microsoft, or the mailbox's SMTP server. It leaves from your address, with your [signature](/blog/email-signatures-for-claude) added at that moment. Expect it within about a minute of the time you set; it is not meant for second-precise timing.

If the mail server turns the message away before accepting any of it, the dispatcher tries again each minute for up to 15 minutes after the send time. If the mailbox has been disconnected in the meantime, the message is not sent at all.

## Prompts that schedule cleanly

> Write a short thank-you to dana@example.com for today's call and schedule it for Monday at 09:00, Europe/Oslo. Show me the text and the send time before you schedule it.

> Schedule the payment reminder below from accounts@ to the three addresses in it, for the 1st of next month at 08:30 New York time.

> What emails do I have scheduled? List recipient, subject and send time in my time zone.

> Cancel the scheduled email to Dana.

Asking to see the text and the time first costs one extra message and catches the two things that go wrong most: the wrong recipient and the wrong hour. If you run several mailboxes, name the one to send from ("from accounts@"); [multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explains how the assistant tells them apart.

## Time zones

The \`schedule\` tool takes the send time as a timestamp with a time zone offset, for example \`2026-11-02T09:00:00+01:00\`. The assistant turns "Monday at 9" into that format, so it needs to know your zone. Name a city or zone in the prompt ("Oslo time", "Europe/Oslo", "US Eastern"); without one, the model has to guess.

Daylight saving is where guesses go wrong. Oslo is +02:00 until the last Sunday of October and +01:00 after it, so 09:00 Oslo time on 2 November 2026 is \`+01:00\`. Saying the city lets the assistant pick the right offset for that date.

The confirmation states the time in UTC. Ask the assistant to read it back in your local time before you rely on it. A time that is already in the past is refused.

## Check, cancel or change a scheduled email

- **See what is queued.** \`schedule_list\` returns the pending messages, earliest first, with recipients, subject, send time and status. Ask for all mailboxes or one.
- **Cancel.** The \`schedule\` tool with action \`cancel\` stops a message while it is still pending. Once the dispatcher has started sending it, it can no longer be cancelled.
- **Change.** There is no edit. Ask the assistant to cancel the message and schedule the corrected one; it can do both in one turn.
- **Signature edits carry over.** The signature is added at send time, so a change you make after scheduling is the one that goes out.

## What scheduling does not do

- **Reply inside a thread.** A scheduled email is a new message with its own subject, so it does not thread as a reply. For a reply that belongs in the conversation, have the assistant save a reply draft (\`draft\` with action \`reply\`) and send it yourself when the time comes.
- **Point at an attachment in another email.** The file has to be included in the request itself, 10 MB in total. Sending right now can attach a file straight from a message in your mailbox; scheduling cannot.
- **Repeat.** Each scheduled email goes out once. A weekly reminder means scheduling each one.
- **Hit the exact second.** The queue is checked once a minute.

A schedule request can carry an idempotency key. If the assistant retries it with the same key after a dropped connection, MCPEmails queues the message once, not twice. [Preventing duplicate AI email sends](/blog/prevent-duplicate-ai-agent-email-sends) explains how.

## Where the message waits

Most of what MCPEmails does is live: mail is read from your provider for each request and not kept. A scheduled email cannot work that way, because it has to exist somewhere until its send time. MCPEmails stores it encrypted (AES-256-GCM) in its database in Stockholm, and decrypts it only to send it or to show its recipients and subject when you list your scheduled sends. A cancelled message is never sent. The [security page](/security) has the details.

## FAQ

**Can Claude schedule an email to send later?**
Yes, through an MCP server with a scheduled-send tool. Connect your mailbox to MCPEmails, add it to Claude as a custom connector, grant scheduling, and ask Claude to send the message at a set date, time and time zone. Anthropic's own Gmail connector does not list scheduling.

**Can ChatGPT schedule an email?**
Yes, the same way: add MCPEmails as a custom MCP connector ([setup](/docs/chatgpt)) and ask. ChatGPT's scheduled tasks run a prompt later, which is different from queuing a finished message.

**Does Claude or ChatGPT need to stay open until the email goes out?**
No. The message is queued on the MCPEmails server and sent from there. You can close the chat, the app and your computer.

**Which email providers can schedule?**
Every mailbox MCPEmails can send from: Gmail and Google Workspace, Outlook and Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex and other IMAP and SMTP mailboxes. The message is sent through that mailbox's own provider.

**How do I cancel a scheduled email?**
Ask the assistant to cancel it. It looks the message up with \`schedule_list\` and cancels it by id, which works until the moment sending starts.

## Next step

[Start free](/signup), connect your mailbox, and ask Claude or ChatGPT to schedule a test email to yourself five minutes out. The [Claude guide](/blog/connect-claude-to-email) and the [ChatGPT guide](/blog/connect-chatgpt-to-email) cover the connection, and the [tool reference](/docs#tools) lists every scheduling argument.`,
};

export default post;
