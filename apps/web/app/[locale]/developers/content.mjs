// Copy for /developers, the developer landing page, in every locale.
//
// Kept next to the page rather than in messages/: a messages/ namespace is
// serialised into every marketing page, and this copy is only read here
// (apps/web/CLAUDE.md).
//
// TRANSLATION: only `en` is written. nb, es, fr, de and zh point at the
// English object until they are translated; replace each with its own object
// of the same shape.
//
// Every claim is traced to code. If one of these changes, change the page:
//   providers              src/lib/email-providers/*, /docs/providers;
//                          Fastmail is an app password only (no OAuth, no JMAP)
//   one endpoint           supabase/functions/mcp-server/index.ts, /api/mcp
//   flat price             src/lib/stripe/plans.ts: paid plans carry no
//                          per-call price; the page names no limit
//   webhooks               PR claude/dev-api-webhooks (Pro and Business,
//                          HMAC-SHA256 signature, retries up to 24 hours,
//                          about two minutes, polling)
//   idempotency            claimOutboundIdempotency + idempotency-replay.ts
//   scoped keys            src/lib/api-keys/scopes.ts, api_keys.inbox_ids
//   send approval          send_review_mode per inbox (every plan)
//   open source            /self-hosting, github.com/Albretsen/MCPEmails
//
// No competitor names on this page, and no tool count.
// Inline markup: `code`, **bold** and [label](/path), rendered by the page.

const en = {
  meta: {
    title: 'Email API for AI agents, on the inboxes you already have',
    description:
      'Give scripts, n8n workflows and your own AI agents a real Gmail, Outlook or IMAP mailbox over one HTTPS endpoint. MCP and signed webhooks on the same key, scoped keys, idempotent sends and a flat plan price.',
  },
  breadcrumb: 'Developers',
  hero: {
    eyebrow: 'Developers',
    title: 'An email API for AI agents, on the inboxes you already have',
    lead:
      'Connect Gmail, Outlook or any IMAP mailbox once. Your scripts, workflows and agents then read, search, draft and send from those real addresses over one HTTPS endpoint, with MCP and webhooks on the same key.',
    primary: 'Read the developer guide',
    secondary: 'See pricing',
  },
  why: {
    h: 'What you get',
    cards: [
      {
        h: 'Your real mailboxes',
        p: 'Gmail, Outlook and Microsoft 365, iCloud, Yahoo, Zoho, Fastmail with an app password, and any IMAP server. Agents work on the addresses your customers already know, with their history and their sender reputation. Nothing to migrate.',
      },
      {
        h: 'MCP and webhooks on one key',
        p: 'The endpoint that Claude and ChatGPT connect to also answers plain HTTPS from your code. On Pro and Business, a webhook starts your workflow when mail arrives, usually within about two minutes.',
      },
      {
        h: 'A flat price',
        p: 'Paid plans have a fixed monthly price and no per-call charge, so a busy workflow costs the same as a quiet one. Start free with one inbox.',
      },
      {
        h: 'Signed webhooks',
        p: 'Every delivery is signed with HMAC-SHA256 over a timestamp and the body, carries an event id for deduplication, and is retried up to six times when your endpoint does not answer.',
      },
      {
        h: 'Idempotent sends',
        p: 'Pass an `idempotency_key` and retry after a dropped connection without sending twice. The retry hands back the original message id.',
      },
      {
        h: 'Scoped keys',
        p: 'Each key holds only the permissions and inboxes it needs, so a triage script can read the support inbox and nothing else. Revoke one key without touching the others.',
      },
      {
        h: 'Send approval',
        p: 'Hold every send from an inbox until a person approves it. A good default while a new automation proves itself.',
      },
      {
        h: 'Open source',
        p: 'The server is open source, so you can read how each call is handled. You can also [run it yourself](/self-hosting).',
      },
    ],
  },
  how: {
    h: 'How it works',
    steps: [
      'Connect a mailbox in the dashboard. Outlook signs in with Microsoft; most other providers take an app password.',
      'Create an API key, tick the scopes it needs and, if you like, pin it to some inboxes.',
      'Call `tools/list` to see what the key can do, then `tools/call` to read, search, draft or send.',
      'On Pro or Business, add a webhook endpoint so new mail reaches your workflow without polling.',
    ],
    codeLabel: 'bash',
  },
  uses: {
    h: 'What developers build',
    items: [
      '**n8n and other workflow tools:** start a workflow on new mail, read it, and file, draft or reply.',
      '**Coding agents:** give Claude Code a real inbox over HTTP with one command and a key.',
      '**Support and sales agents:** triage a shared inbox, draft answers for a person to approve, follow up on schedule.',
      '**Your own agent:** call the same tools from any language that can send an HTTPS request.',
    ],
  },
  cta: {
    title: 'Connect an inbox and make your first call',
    sub: 'One inbox is free, forever. No card required.',
    button: 'Get started free',
    guide: 'Developer guide',
    pricing: 'See pricing',
  },
  featureList: [
    'Email API over HTTPS (JSON-RPC 2.0, Model Context Protocol)',
    'Works with existing Gmail, Outlook, Microsoft 365 and IMAP mailboxes',
    'Signed webhooks for new mail',
    'Idempotency keys for safe retries',
    'Scoped API keys with per-inbox access',
    'Human approval before sending',
  ],
};

// Placeholders until translated: every locale renders English. See the header.
export const DEVELOPERS = { en, nb: en, es: en, fr: en, de: en, zh: en };

export function developersCopy(locale) {
  return DEVELOPERS[locale] ?? en;
}
