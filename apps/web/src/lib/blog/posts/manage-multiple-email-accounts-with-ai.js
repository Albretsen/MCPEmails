const post = {
  slug: 'manage-multiple-email-accounts-with-ai',
  title: 'How to Manage Multiple Email Accounts With One AI Agent',
  description:
    'Run work, personal, and side-business mailboxes through one AI agent: how it discovers inboxes, how to scope a request, sender names that stay correct, and per-inbox send review.',
  cover: '/blog/cover-agent-inbox.svg',
  coverAlt:
    'One AI agent connected to work, personal, and side-business email accounts with MCP Emails',
  authorId: 'asgeir',
  publishedAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-26T09:00:00.000Z',
  tags: ['Multiple inboxes', 'Email', 'MCP', 'Workflow'],
  featured: false,
  content: `Almost nobody has one mailbox. You have a work address, a personal address, and at least one more for a side business or a domain you still own. Every question that crosses two accounts becomes a manual search in two places.

One AI agent across all of them removes the switching, but only if the agent knows which mailbox is which and replies leave from the right address.

**Jump to:** [Discovery](#your-agent-finds-the-mailboxes-itself) · [Scoping one request](#scope-one-request-to-one-mailbox) · [Plan limits](#where-the-plan-limits-land)

## Why one agent beats switching mail clients

A mail client shows you accounts. It does not answer questions. "Which of my accounts did the Stripe receipt land in?" is a search across three mailboxes plus a judgement. An agent with access to every mailbox does that in one request, and you stop being the router. The second gain: one set of habits, because the same tools sit behind every account.

## Your agent finds the mailboxes itself

You never paste a mailbox ID into a prompt. The agent calls \`inbox_list\`, which returns every inbox your key may use, each with its UUID, email address, display name, provider, optional service brand, and a capabilities object. Every other tool takes either \`inbox_id\` (a UUID, or an address) or \`inbox\` (an address), filled in from that result.

Two details worth knowing:

- **Discovery is free.** \`inbox_list\` is the one tool that does not count against the Free monthly action allowance, so an agent can re-orient itself at no cost.
- **Conflicting selectors are refused, not guessed.** A call carrying an \`inbox_id\` for one mailbox and an \`inbox\` address for a different one is refused, and the error names both. The usual cause is a stale ID carried over from earlier in the conversation. Tell the agent to retry with the address alone.

## Scope one request to one mailbox

Name the account. Addresses work everywhere an ID works, so plain language is enough:

> In jane@acme.com only, list everything unread from the last two days and tell me what needs a reply today. Leave my other accounts alone.

You can also enforce scope outside the prompt. In the dashboard, every API key has an **Inbox access** setting: all inboxes, or an explicit list. A key limited to your side-business mailbox cannot read the other two, whatever a prompt says.

## Fan-out is the agent calling once per mailbox

This is the part people get wrong: **one call reaches one mailbox.** Listing, reading, searching, moving, and deleting are all scoped to a single inbox, and there is no automatic fan-out. So "search all my accounts" is the agent running the search once per inbox and merging the results itself. That works well, with three consequences:

- Let it call \`inbox_list\` first, or say how many accounts you have. If it assumes one, it will confidently report on one.
- Ask for a merged answer ("one combined list, tagged with the account it came from"), or you get three separate reports.
- Volume scales with mailbox count. A three-mailbox triage is at least three billable actions, not one.

## Names and sender identity

One field does three jobs. Each inbox has a display name: it is the **Label** in your dashboard list, the \`display_name\` the agent reads from \`inbox_list\`, and the name recipients see in the From header, ahead of the address.

"work2" is therefore a bad name twice over: the agent cannot tell what the mailbox is for, and some client will render "work2" beside your address. Use something a stranger could read, such as "Jane Doe (Acme)" or "Northside Studio". Set it in the dashboard under the inbox's **Sender name**, or with \`signature_set\`, and read it back with \`signature_get\`. Names are capped at 100 characters.

Sending from an alias is narrower than people expect:

- Your own connected address always works as the From value, on every provider.
- A **different** address must be a verified Gmail Send As identity, listed under \`sender_identities\` in that inbox's \`inbox_list\` entry.
- On a non-Gmail provider, a From address that is not the inbox's own is refused rather than silently rewritten.

Signatures are per inbox too: a formal one on the work address, nothing on the personal one. See [email signatures for Claude](/blog/email-signatures-for-claude).

## Per-inbox send review

Review is configured per mailbox. Each inbox has a **Review before sending** setting with three options: send immediately, show a review card in the AI conversation, or review in the dashboard only.

That is what makes a mixed setup comfortable: leave the side-business mailbox on immediate send, hold every work send for review. In both review modes the email is prepared but not delivered, and approval happens only in a signed-in browser session held by an owner or admin. The in-conversation card is a convenience, not a permission boundary. [Human approval for AI agent email sends](/blog/approve-ai-agent-email-sends) goes deeper.

## Three cross-inbox routines worth stealing

**One morning triage across everything.** Ask for a single ranked list, not a per-account digest:

> Check all my connected inboxes. Give me one combined list of what needs a reply today, newest first, tagged with the account it arrived in. Do not move, send, or delete anything.

The [inbox triage playbook](/blog/ai-agent-triage-summarize-inbox) has rubrics to paste into that prompt.

**Finding a thread when you forget the account.**

> Find the invoice from Hetzner from August. Search every connected inbox, and tell me which account it is in and the amount.

**Moving a conversation between roles.** When a personal contact turns into a client, forward the thread to the business mailbox and have the reply composed from the business address. Ask the agent to confirm which inbox it is sending from first.

## What changes when you mix Gmail, Outlook and IMAP

Mixed setups are the normal case, and providers disagree about what a folder is.

- **Gmail has labels.** A move adds a label and removes the message from the inbox. Other labels stay attached, so a message can sit in several places.
- **IMAP has folders.** A move is a move: the message leaves one folder and lands in another.
- **Outlook has nested folders.** A move is a move, as on IMAP, and folders can sit inside other folders. Outlook has no labels, so an automation's label action applies an Outlook category instead.
- **Folder names differ.** Archive, All Mail, Spam, Junk, and localized names vary per provider. Have the agent call \`folder_list\` on the mailbox it is about to touch.
- **Folder scoping is per inbox.** Restricting a search to a set of folders applies inside one mailbox, so a folder-scoped search across accounts is still one call per account.

[Gmail labels vs IMAP folders](/blog/gmail-labels-vs-imap-folders-ai-agents) explains what "archive" really means on each side.

## Where the plan limits land

Connected inboxes are what plans are priced on:

- **Free, $0.** One connected inbox. 150 billable email actions per UTC calendar month, with the first 7 days uncounted. That monthly cap applies to workspaces created on or after 2026-09-13; workspaces created earlier are exempt.
- **Personal, $5 a month or $48 a year.** Three connected inboxes, no monthly action cap, 2x burst rate limit, email support.
- **Pro, $15 a month or $144 a year.** Unlimited connected inboxes, 5x burst rate limit, longer analytics history.
- **Team, $79 a month or $756 a year.** Unlimited members with roles, a separate workspace per client or business, SSO (SAML/OIDC) and audit log, priority support.

A cross-inbox routine costs one action per mailbox, so your mailbox count drives volume as much as your habits do. Details on [pricing](/pricing).

## FAQ

**How does the agent know which mailbox I mean?**
From \`inbox_list\`, which returns the address and display name of every inbox it may use. Name the address in your request. A mailbox ID and an address that disagree are refused, not guessed.

**Will replies go out from the right address?**
Yes, when you send from the inbox that owns the address: each inbox sends through its own provider, display name, and signature. A different From address requires a verified Gmail Send As identity, and is refused on other providers.

**Can I let the agent send freely from one mailbox and hold another?**
Yes. Review before sending is a per-inbox setting, so one mailbox can send immediately while another waits for your approval in a signed-in browser.

**Is my mail from all those accounts stored anywhere?**
No. Message content is fetched live from your provider on each request and discarded. Only the encrypted provider credential is retained. See [security](/security).

## Next step

[Start free](/signup), connect your busiest mailbox, and ask your agent what needs a reply today. Add the second and third accounts when you want one answer instead of three. The [documentation](/docs) has the full tool reference, and [provider details](/docs/providers) covers what each mailbox type supports.`,
};

export default post;
