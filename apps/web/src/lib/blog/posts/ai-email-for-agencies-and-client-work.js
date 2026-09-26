const post = {
  slug: 'ai-email-for-agencies-and-client-work',
  title: 'AI Email Access for Agencies: One Agent Across Every Client Mailbox',
  description:
    'How an agency or freelancer gives an AI agent access to several client mailboxes without mixing clients up: a workspace per client, scoped keys, read-only first, and an approval hold on every send.',
  cover: '/blog/cover-best-ways-to-let-claude-manage-your-inbox.svg',
  coverAlt:
    'One AI agent working across separate client mailboxes with scoped access, MCP Emails',
  authorId: 'asgeir',
  publishedAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
  tags: ['Agencies', 'Teams', 'Security', 'Email'],
  featured: false,
  content: `If you run email for more than one client, you live by one rule: nothing from client A may surface in a thread for client B. An AI agent does not change that rule, it makes it easier to break. One agent holding one credential that reaches every mailbox you manage is a careless prompt away from quoting the wrong invoice to the wrong person.

Three failures are worth designing against: **cross-client leakage**, where a too-wide credential lets a search match the wrong mailbox; **the departing contractor**, whose laptop still holds a working API key; and **the unreviewed send**, where an agent answers a client's customer politely and wrongly. Build the separation into the access itself and the agent cannot cross a boundary even when a prompt asks it to.

**Jump to:** [A workspace per client](#a-workspace-per-client) · [Scoped API keys](#scoped-api-keys-per-engagement) · [The approval hold](#the-approval-hold-on-outgoing-mail)

## A workspace per client

A workspace is the unit of separation. Inboxes, members, API keys, and activity live inside one, and the boundary is enforced in the database with row-level security rather than by careful filtering in application code. A key issued in the Acme workspace cannot read a Bolt mailbox, whatever the prompt says.

More than one workspace is a **Team** feature ($79/month, $756/year), which also brings unlimited members with roles, SSO (SAML / OIDC), an audit log, and priority support. The subscription attaches to your account rather than to one workspace, so one Team subscription covers every client workspace you create. Name each after the client, connect only that client's inboxes inside it, and switch between them in the dashboard sidebar.

Below Team the plans are one person in one workspace: **Pro** ($15/month, $144/year) connects unlimited inboxes, **Personal** ($5/month) three, **Free** one. Cheaper, and every mailbox shares one blast radius. See [pricing](/pricing) and the [provider matrix](/docs/providers).

## Members and roles

Four roles: **owner**, **admin**, **member**, **viewer**. Only the owner can change roles. Admins can invite and remove members but cannot remove another admin. Viewers are read-only, and that is enforced in the credential layer too: a key held by a viewer may carry only \`read:email\` and \`search:email\`.

Adding people at all is a Team feature, since Free, Personal, and Pro are single-person plans. The arrangement that works: a client's account manager is an admin in that client's workspace and a member of no other, a junior doing triage is a viewer in the one workspace they work in, and nobody but you holds a login spanning your whole book of business.

## Scoped API keys per engagement

An API key is what your agent uses when the client tool has no OAuth. Two dials narrow it. Turn both.

**Scopes.** A key carries an explicit list from this vocabulary: \`read:email\`, \`search:email\`, \`send:email\`, \`manage:folders\`, \`delete:email\`, \`manage:drafts\`, \`manage:contacts\`, \`schedule:email\`, \`manage:automations\`. A triage key needs \`read:email\` alone. Treat \`manage:automations\` as the strongest of the lot: an automation keeps acting when nobody is watching.

**Inboxes.** A key either reaches every inbox in the workspace, including ones connected later, or is restricted to an explicit list. For client work, restrict it.

Issue one key per engagement or automation, named for the job, so revoking it is a decision about that job and not your whole setup. The raw key is shown once, because only a SHA-256 hash is stored.

If the client tool speaks OAuth, as Claude and most MCP clients do, use that instead and add the endpoint:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

The consent screen offers a read-only, standard, or full grant, plus a per-scope option. [OAuth vs API keys](/blog/oauth-vs-api-keys-ai-email-access) covers which to pick.

## Read-only first, send later

Start every engagement read-only. An agent that can read, search, and summarize already covers triage, reporting, and "what did we promise them in March", which is most of the value.

> Summarize the unread mail in the Acme support inbox from the last two business days. Group it into needs a reply today, waiting on the client, and noise. Do not send, move, or delete anything.

Add capability one scope at a time, when a task needs it. Granting too little is recoverable: a call needing a missing scope returns a clear insufficient-scope response, so the client can step up for that one scope and retry.

## The approval hold on outgoing mail

For anything reaching a client's customer, turn on the send review. It is a per-inbox setting with three modes: send immediately, a review card in the AI conversation, or review in the dashboard only.

In both review modes the email is prepared but not delivered, and approval happens in one place only: a signed-in browser session held by a workspace owner or admin. The assistant has no browser session, so it cannot approve its own send. It can reject one, which is the safe direction. The review card is a convenience, not a permission boundary.

The review screen shows the sender, the To and Cc recipients, a count of any Bcc recipients, the subject, attachments, and the text, with any HTML shown as source rather than rendered. A pending request expires after 24 hours. The hold works on every plan, Free included. More in [human approval for AI agent email sends](/blog/approve-ai-agent-email-sends).

## Shared mailboxes like support@ and billing@

Shared addresses are ordinary inboxes here. Connect support@ or billing@ with a provider app password, inside the workspace for the client that owns them. The sender display name is a per-inbox setting, so replies go out as "Acme Support" rather than as you.

Your agent finds mailboxes with \`inbox_list\` and addresses them by name, so you never paste mailbox IDs into prompts. From there the set is small: \`email_read\` and \`email_compose\`, \`email_organize\` and \`email_search_and_move\` for triage, \`draft\` and \`schedule\` for anything that should wait for a person.

Set one expectation early: MCP Emails is poll-based. The agent checks for new mail when you ask it to, or when a scheduled automation runs, so "we reply within 60 seconds" is not a promise this architecture makes.

## Handover and offboarding

Rehearse this before you need it. Each is one action in the dashboard.

- **Revoke a key.** It stops working immediately, everywhere it was pasted.
- **Remove a member.** That also revokes the API keys they created in the workspace, and the same teardown runs when someone leaves on their own.
- **Demote to viewer.** Demotion revokes their keys holding scopes beyond read-only, rather than silently weakening a credential someone still relies on.
- **Disconnect the inbox.** The stored credential is the only inbox data ever retained, and disconnecting removes it.
- **Revoke at the provider.** Have the client delete the app password or revoke the Google grant. That path does not involve you, which is why it reassures them.

There is no ownership transfer, so you cannot hand a workspace over at the end of a project. A client taking mail in-house opens their own account and connects their own inboxes.

## What you can and cannot promise a client

Claims you can put in writing:

- Message content is never stored. It is fetched live from the client's provider on each request and discarded.
- The only inbox data retained is the provider credential, encrypted at rest with AES-256-GCM, the key held separately.
- Activity is logged as metadata only: tool name, inbox, timestamp, status, never content.
- No AI provider is a subprocessor. MCP Emails neither sends email to a model of its own nor trains on it. The subprocessors are Supabase, Vercel, and Stripe.
- The one exception to "never stored" is a message scheduled for later, held encrypted until its send time.

Do not promise that prompt injection is solved. It is contained, not solved, which is why read-only keys, restricted inboxes, and the approval hold exist. Do not promise instant reaction, and do not promise certifications the product has not claimed. Send the client's reviewer to [/security](/security) and write your contract to match that page, not ahead of it. The code is public and self-hostable, which answers a security review better than a promise.

## FAQ

**Do I need a separate MCP Emails account for each client?**  
No. One account, one Team subscription, a separate workspace per client. The subscription follows your user, so each workspace inherits the plan.

**Can one client see another client's mail?**  
Not if each client's inboxes live in their own workspace. Separation is enforced with row-level security, and a key issued in one workspace cannot read another's inboxes.

**What happens the day a contractor leaves?**  
Remove them from the workspace, which revokes the keys they created there in the same action. If they stay but should stop writing, demote them to viewer.

**Does this work for a client on Microsoft 365?**  
Yes. A Microsoft 365 mailbox connects with Sign in with Microsoft, no app password. Many organisations require an IT admin to approve the app once for the whole organisation before anyone can connect; the dashboard gives you a link to send to your client's IT admin, and after that each mailbox connects normally.

## Next step

[Create a free account](/signup), connect one client mailbox read-only, and run a triage prompt before you touch anything else. When separation matters, move to Team on the [pricing page](/pricing). The [documentation](/docs) has the full tool and scope reference, and [/security](/security) is the page to hand a client's IT reviewer.`,
};

export default post;
