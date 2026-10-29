// Facts about Claude's and ChatGPT's scheduled tasks were read on 2026-10-29:
//   - support.claude.com/en/articles/13854387 (scheduled tasks in Cowork): all
//     paid plans (Pro, Max, Team, Enterprise); hourly, daily, weekly, weekdays
//     or manual; "Scheduled" in the sidebar, "New task", "Create with Claude"
//     or "Set up manually", or describe the task in a conversation; runs
//     remotely while the computer sleeps unless it needs local files or apps;
//     uses the same connectors as other tasks.
//   - support.claude.com/en/articles/13345190 (get started with Cowork): each
//     connector tool can be Always allow, Needs approval or Blocked.
//   - help.openai.com/en/articles/10291617 (tasks in ChatGPT): Free, Go, Plus,
//     Pro, Business, Enterprise, Edu; Free at most daily in flexible windows,
//     paid up to hourly at exact times; active task limits; apps named are
//     Gmail, Slack and GitHub; an action that sends or changes data may need
//     approval and pauses the task. It does not say whether a custom MCP app
//     works in a task, so this post does not claim it.
// Re-read all three before editing the Claude or ChatGPT sections.
//
// The MCPEmails morning brief is supabase/functions/mcp-server/
// morning-brief-engine.ts (sections, 10-inbox cap, skipped empty days,
// delivery by inserting into the inbox, no model) and the Pro gate in
// apps/web/src/lib/plans/pro-features.ts (plans solo = Pro, pro = Business;
// pricing_switches.pro_features_public was on when this was written). The
// settings labels are messages/en/dashboard.json settings.morningBrief.
const post = {
  slug: 'daily-email-briefing-with-claude-and-chatgpt',
  title: 'Daily Email Briefing with Claude and ChatGPT: Inbox Summaries on a Schedule',
  description:
    'Three ways to get a daily summary of your inbox: a Claude scheduled task, a ChatGPT scheduled task, or a morning brief MCPEmails puts in your inbox with no chat open. Setup, prompts and limits.',
  cover: '/blog/cover-agent-inbox.svg',
  coverAlt:
    'A daily email briefing from Claude and ChatGPT summarizing new mail across connected inboxes',
  authorId: 'asgeir',
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['Claude', 'ChatGPT', 'Automation', 'MCP'],
  featured: false,
  content: `**You can get a daily email briefing from Claude or ChatGPT by giving the assistant two things: access to your mailbox and a schedule.** Both assistants now run scheduled tasks. Claude's run a prompt hourly, daily, weekly or on weekdays, and ChatGPT's run at a set time on every plan. Point the task at your mailbox through a connector, and each morning the summary is waiting for you.

There is a third route that needs no chat at all: MCPEmails can put a morning brief straight into your inbox at the hour you choose. This guide covers all three, with the prompts to use and what each one cannot do.

**Jump to:** [Claude](#a-daily-email-summary-with-claude) · [ChatGPT](#a-scheduled-inbox-summary-in-chatgpt) · [Morning brief](#the-morning-brief-no-chat-needed) · [Which to pick](#which-one-to-pick) · [Prompts](#prompts-for-a-useful-briefing) · [FAQ](#faq)

## First, give the assistant your mailbox

A scheduled task can only summarize mail it can reach. Claude's own Gmail connector reaches one Google account, and its Microsoft 365 connector reaches work accounts once an administrator approves it. ChatGPT has its own Gmail app. For anything else, or for several mailboxes in one briefing, connect them through an MCP server.

MCPEmails is a hosted MCP server. You connect each mailbox once, then add one connector URL to Claude or ChatGPT:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

It works with Gmail and Google Workspace, Outlook and Microsoft 365, iCloud, Yahoo, Fastmail, Zoho and any mailbox that speaks IMAP and SMTP. Every connected mailbox shows up in the assistant by name, so one briefing can cover your own address, info@ and a personal Gmail together. [Multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explains that setup.

A briefing only reads, so connect with **Read-only** access when the consent screen asks. A task that runs while you are away then cannot send, move or delete anything, whatever the mail it reads says. [Read-only access](/docs/read-only-access) lists exactly what that connection can do.

## A daily email summary with Claude

Claude's scheduled tasks are part of Cowork in the Claude app, on every paid plan (Pro, Max, Team and Enterprise). According to [Anthropic's help article](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork), a task can run hourly, daily, weekly, on weekdays or only when you start it, and it uses the same connectors as your other tasks. Tasks run remotely, so they keep their schedule while your computer is asleep or the app is closed, unless the task needs local files or apps.

1. **Add MCPEmails to Claude.** Open **Customize → Connectors**, click **+ Add**, then **Add custom connector**. Name it MCPEmails, enter \`https://mcpemails.com/api/mcp\`, click **Continue**, keep the detected sign-in settings and click **Add**. Sign in to MCPEmails and choose **Read-only**. The [Claude setup guide](/blog/connect-claude-to-email) shows each screen.
2. **Create the task.** Click **Scheduled** in the sidebar, then **New task**, and choose **Create with Claude** or **Set up manually**. You can also describe the task in a conversation ("every weekday at 7, summarize my inbox") and Claude proposes a name, schedule and instructions for you to confirm with **Schedule**.
3. **Paste the briefing prompt** from the [prompts section](#prompts-for-a-useful-briefing) and pick **Weekdays** or **Daily**.
4. **Run it once by hand** to check the output before the first scheduled run.

Each connector tool can be set to **Always allow**, **Needs approval** or **Blocked** in Claude. For a briefing, block MCPEmails' sending and organizing tools, or keep the connection Read-only, so the task stays a summary.

## A scheduled inbox summary in ChatGPT

[OpenAI's help article on tasks](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt) says scheduled tasks are on every plan, including Free and Go. Free runs a task at most once a day in a loose window such as "morning". Paid plans can run tasks up to hourly at an exact time. Each plan has a limit on active tasks, from 3 on Free to 15 on Pro and Enterprise. You create a task from the **Scheduled** page or by asking in a chat, and ChatGPT can notify you by push or email when it finishes.

Tasks can use supported apps, and OpenAI names Gmail, Slack and GitHub. If your mail is in one Gmail account, ChatGPT's own Gmail app is the simplest source for the task.

OpenAI's article does not say whether an MCP server you added yourself is available inside a task. To use MCPEmails, add it as described in the [ChatGPT setup guide](/docs/chatgpt), then schedule the task a few minutes ahead and check that the first run reads your mail before you rely on it. OpenAI also notes that an action which sends a message or changes data may need your approval and pauses the task, one more reason to keep a briefing read-only.

## The morning brief: no chat needed

The Pro and Business plans of MCPEmails include a **morning brief**: a daily summary that MCPEmails builds on its own servers and places straight into one of your inboxes at the hour you set. No assistant, chat or open app is involved, so it arrives even on days you never open Claude or ChatGPT.

Each brief covers your local day:

- **VIP senders first.** New mail from the addresses or domains you list, across your inboxes.
- **New mail per inbox** since the last brief: how many messages, and the newest senders and subjects.
- **Follow-ups that are due.** Reminders your AI set for mail that got no reply.
- **Snoozed mail** coming back later today.
- **Scheduled sends** going out later today.

It covers up to 10 connected inboxes. Days with nothing new are skipped rather than sent empty. The brief is added to the inbox directly, so nothing is sent and nothing leaves your mailbox. It is built from rules, with no AI model reading your mail.

To turn it on, open **Settings** in the dashboard, find **Morning brief** under the workspace settings, tick **Put a morning brief in my inbox every day**, and choose the time, your time zone, the inbox it goes to and any VIP senders. Only workspace owners and admins can change it.

The follow-ups and snoozes in the brief come from your AI, and they are part of the same plans. Ask Claude or ChatGPT "remind me if Dana hasn't replied by Friday" or "snooze this until Monday morning", and MCPEmails tracks it on its servers even after the chat is closed.

## Which one to pick

- **You want the summary written in plain language, with judgment about what matters:** a Claude or ChatGPT scheduled task. The model reads the mail and decides what to call out.
- **You want it every day without depending on a chat app or its task limits:** the morning brief. It arrives in your inbox at the set hour, and it never improvises.
- **You want both:** they work together. The brief gives the fixed list each morning, and you ask the assistant about anything in it.

If you would rather have mail sorted than summarized, [automated email triage rules](/blog/automated-email-triage-rules) move, label and flag new mail on a schedule without a model.

## Prompts for a useful briefing

Ask for a short, fixed format. A briefing you can read in a minute is one you keep reading.

> Using MCPEmails, give me my morning brief for all connected inboxes: what came in since yesterday at this time, what needs a reply from me today, and anything with a deadline this week. Group by inbox, at most 10 lines. Do not send, move or change anything.

> Using MCPEmails, list unread mail from the last 24 hours in sales@ and info@ that is from a customer or a prospect. For each one: sender, one-line summary, and whether it needs a reply today. Skip newsletters and notifications. Read only.

> Using MCPEmails, check my inbox for invoices, contracts and anything mentioning a payment or a due date that arrived in the last week. One line each with the amount and date if stated. Read only.

Saying "read only" in the prompt is a good habit, but the reliable guard is the connection itself: a Read-only connection cannot send even if a message tells the model to. Mail is written by other people, and some of it is written to steer AI assistants. [Is it safe to give an AI agent email access?](/blog/is-it-safe-to-give-ai-agent-email-access) explains why.

For more triage prompts, see [AI agent triage and inbox summaries](/blog/ai-agent-triage-summarize-inbox). To write a reply on a schedule rather than read, [schedule an email with Claude or ChatGPT](/blog/schedule-email-with-claude-and-chatgpt) covers queued sends.

## FAQ

**Can Claude summarize my email every day?**
Yes. Create a scheduled task in Claude (Pro, Max, Team or Enterprise) that runs daily or on weekdays, with a connector to your mailbox. Claude's Gmail connector covers one Google account; MCPEmails covers any provider and several mailboxes at once.

**Can ChatGPT summarize my inbox on a schedule?**
Yes. ChatGPT's scheduled tasks can use its Gmail app on any plan, with Free limited to once a day. OpenAI does not say whether a custom MCP server works inside a task, so test one run before relying on it.

**Does the task run when my computer is off?**
Claude's scheduled tasks run remotely unless they need local files or apps. ChatGPT's tasks run on OpenAI's side. The MCPEmails morning brief runs on our servers and lands in your inbox either way.

**Is my mail stored for the briefing?**
Not by MCPEmails. Mail is fetched live from your provider for each request and dropped once the answer is sent. The morning brief is written into your own mailbox, not kept by us. See [security](/security).

**Which plan includes the morning brief?**
Pro and Business. A Claude or ChatGPT scheduled task can read through MCPEmails on any MCPEmails plan, including Free with one inbox. Current plans are on the [pricing page](/pricing).

## Next step

[Start free](/signup), connect your busiest mailbox with Read-only access, add MCPEmails to Claude or ChatGPT and run the briefing prompt once by hand. When the output is what you want, put it on a schedule.`,
};

export default post;
