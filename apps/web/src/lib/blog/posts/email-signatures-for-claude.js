const post = {
  slug: 'email-signatures-for-claude',
  title: 'Email Signatures for Claude: Auto-Signed, Every Time',
  description:
    'Set a signature once per inbox, and Claude signs every email it sends automatically, on Gmail, Outlook, Fastmail, iCloud, and any IMAP account.',
  cover: '/blog/cover-email-signatures-for-claude.svg',
  coverAlt:
    'Email signatures for Claude — set a per-inbox signature once and Claude signs every message it sends, on every provider',
  authorId: 'asgeir',
  publishedAt: '2026-06-23T12:00:00.000Z',
  updatedAt: '2026-06-23T12:00:00.000Z',
  tags: ['Feature', 'Email', 'Claude', 'MCP'],
  featured: false,
  content: `When Claude sends an email for you, it should look like you sent it. That includes the sign-off — your name, your title, your company line, that link to your booking page. Until now you either typed your signature into every prompt or accepted mail that ended a little abruptly. Today that changes: **MCP Emails now applies your signature automatically to every message Claude sends.**

Signatures are **per-inbox**. Each connected mailbox keeps its own, so the founder hat goes on your work address and a plain "— Sam" goes on your personal one. Once it's set, you never think about it again.

## What gets signed

Set it once and the signature is appended automatically to everything Claude sends from that inbox:

- **New emails** — \`email_compose\` (action \`send\`).
- **Replies and forwards** — \`email_compose\` (actions \`reply\` and \`forward\`).
- **Drafts** — \`draft\`, so what you review already has your sign-off in place.
- **Scheduled sends** — \`schedule\`, so a message queued for Monday morning goes out signed.

There's nothing extra to say in your prompt. "Reply to Dana and tell her the deck is attached" produces a complete, signed email.

## Replies and forwards get it right

The fiddly part of signatures is placement, and that's where most tools fall down. On a reply or forward, MCP Emails puts your signature **after your new text and before the quoted thread** — exactly where a person would put it — instead of stranding it at the very bottom under pages of history.

It's also smart about back-and-forth. There's a **reply mode** so the signature isn't repeated every time Claude answers within the same thread. The first reply is signed; the rapid follow-ups in that conversation aren't stacked with duplicate sign-offs. You get clean threads, not a wall of repeated names.

## Works on every provider

This isn't a Gmail-only nicety. Signatures apply on **all** connected providers — Gmail, Outlook, Fastmail, iCloud, and any other IMAP account. Because MCP Emails composes the outgoing message itself, the behavior is identical no matter where the mailbox lives. Connect a new inbox of any kind and signatures just work.

## Two ways to set it up

**1. The signature editor in the dashboard.** Open an inbox in the MCP Emails dashboard and edit its signature inline. Each inbox has its own, so you can give every address the right voice.

**2. Just ask Claude.** There's a new \`signature\` tool, so you can set or change your signature in plain language without leaving the chat:

> "Set my signature for my work inbox to: Sam Rivera, Founder, Acme — calendly.com/sam"

Claude writes it for that inbox, and from then on every send is signed. Ask it to update the signature later and it does the same thing.

## When you want a bare message

Sometimes a signature is noise — a one-word "Thanks!" doesn't need three lines of contact details under it. For those one-off cases there's an **\`include_signature\` option**: tell Claude to skip the signature for a single message and it sends the terse version. Your saved signature stays in place for everything after.

> "Reply 'On my way' to the last text from the office — no signature."

## How it fits the rest of the workflow

Signatures slot into the tools you already use. If Claude is running your morning triage and firing off replies, every one of them now carries your sign-off without you mentioning it. The same goes for the [auto-responder patterns](/blog/build-email-auto-responder-mcp-agent) and the [triage-and-summarize playbook](/blog/ai-agent-triage-summarize-inbox) — anything that ends in a send now ends signed.

And the privacy model is unchanged: your email is still [never stored](/blog/why-email-never-stored-matters). The signature is a small piece of per-inbox configuration; your messages are still fetched live and discarded the moment Claude has them.

## FAQ

**Are signatures per inbox or per account?**
Per inbox. Every connected mailbox has its own signature, so you can sign your work and personal addresses differently.

**Do replies and forwards get the signature in the right place?**
Yes. It's placed after your new text and before the quoted thread, and reply mode keeps it from repeating across a back-and-forth in the same thread.

**Which providers support signatures?**
All of them — Gmail, Outlook, Fastmail, iCloud, and any other IMAP account. MCP Emails composes the outgoing message, so behavior is the same everywhere.

**Can I send a message without my signature?**
Yes. Use the \`include_signature\` option (just tell Claude to skip the signature) for a one-off terse message. Your saved signature stays put for everything else.

**How do I set my signature?**
Two ways: edit it per inbox in the dashboard, or ask Claude — e.g. "set my signature to …" via the new \`signature\` tool.

## Wrap-up

Set your signature once, per inbox, and every email Claude sends from that mailbox — new, reply, forward, draft, or scheduled — goes out signed like you wrote it. It works on every provider, places itself correctly in threads, and gets out of the way with \`include_signature\` when you want a bare reply.

[Open your dashboard](/dashboard) to set a signature, or just tell Claude what yours should be. Not connected yet? [Start free](/signup) and connect an inbox in about two minutes.`,
};

export default post;
