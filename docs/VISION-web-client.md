# Vision: app.mcpemails.com

A fast, focused web email client with an AI assistant built in. It feels like the
client people already know, but the AI can work directly on their mail, and every
action it takes is visible.

Ships as a web app and an installable PWA. Built so it can be wrapped in Electron
later without a rewrite.

## The problem

People still do email in a normal client. When they want AI help, they copy an email
into Claude or ChatGPT, get a reply, copy it back, and send. That round trip is the
friction. MCP Emails already gives the AI access to the mailbox. The client brings
the AI to where the email work already happens.

## Principles

1. **Speed is the feature.** Instant list rendering, keyboard-first, optimistic
   updates, no spinners where a cached answer exists. Every interaction is measured
   and budgeted.
2. **Familiar, not novel.** Inbox list, reading pane, compose. Nobody should have to
   learn the layout.
3. **No bloat.** Mail, folders, search, compose, AI. Nothing else earns a place
   without a clear reason.
4. **The AI works in the open.** Whatever the assistant does is shown in the inbox as
   it happens, never only in the chat transcript.
5. **Motion is information.** An animation exists only to show a state change the
   user didn't cause.

## Core surfaces

- **Unified inbox** across all connected mailboxes, with per-mailbox filtering.
- **Reading pane** with sanitized HTML rendered in a sandboxed iframe.
- **Compose / reply / forward**, with drafts and scheduled send.
- **AI side panel.** A chat that uses the same tools as the MCP server: read,
  search, draft, reply, move, organize.
- **Push notifications** for new mail and for AI actions that need approval.

## Visible AI

- When the AI **reads** an email, that row is highlighted in the list.
- When it **moves** or files an email, a short motion shows the row leaving and the
  destination folder's count changing.
- When it **drafts**, the draft opens in the normal compose view, where the user can
  edit it.
- When it **sends**, a confirm step is required. The AI reads untrusted mail, so
  sending never happens silently.
- The chat links every tool call to the email or folder it touched, and the
  reverse.

## Motion rules

- Motion runs only for changes the AI or the server makes, never as decoration.
- Short (≤200 ms), never blocks input, never delays the next action.
- Nothing moves under the user's pointer or selection. Changes that would shift the
  list the user is working in are held until they are idle or shown in place.
- `prefers-reduced-motion` swaps motion for a static highlight.

## Push notifications

- Web Push through the service worker (VAPID).
- The server watches mailboxes for new mail: Gmail watch, Microsoft Graph
  subscriptions, and IMAP IDLE for everything else.
- Notification types: new mail (filterable per mailbox) and "the AI wants to send
  this" (approve from the notification).
- iOS delivers web push only to a PWA added to the Home Screen, so onboarding
  prompts the install on iPhone.

## Architecture

- A client-rendered single-page app with a local cache (IndexedDB) that talks to the
  existing API. No server-rendered coupling that Electron would have to undo.
- Platform features (notifications, storage, badge count, deep links) sit behind one
  adapter, so web, PWA and a future Electron build each swap in their own
  implementation.
- The AI panel reuses the MCP tool layer. The client and MCP connectors share one
  source of truth for what the AI can do.

## Pricing

- The client itself is free on every plan. Manual reading, replying and filing do
  not count toward the action cap.
- The unified inbox follows the existing inbox limits per plan.
- The AI assistant has its own monthly allowance per plan, separate from the action
  cap, because MCP Emails pays for inference here. It applies to every workspace,
  including those exempt from the cap.

## Out of scope for now

Calendar, contacts beyond autocomplete, offline compose/sync, themes, plugins,
rules editors.

## How we'll know it works

Measured with an A/B test on new signups:

- More new signups get value within 24 hours.
- More signups reach the paywall and convert.
- The assistant's cost per active user stays inside the allowance.
