# Homepage SEO baseline (English, https://mcpemails.com/)

Captured 2026-11-12 14:57 Oslo from the production HTML (no JavaScript). Staging renders the same page. Re-run with `python3 -I home-lab/extract_baseline.py <file.html> > out.json`.

## Head

- `<title>`: Email MCP Server: Gmail, Outlook, IMAP & Claude · mcpemails
  - The `· mcpemails` suffix belongs to the running snippet CTR test (PR #159). Variants never change metadata: `generateMetadata` in `app/[locale]/page.tsx` stays as it is for every variant.
- meta description: Hosted email MCP server for Claude, ChatGPT and Cursor. Connect Gmail, Outlook or any IMAP mailbox, several at once. Mail is fetched live and never stored.
- canonical and hreflang (`metaAlternates(locale, '')`):
  - canonical: https://mcpemails.com
  - en: https://mcpemails.com
  - nb: https://mcpemails.com/nb
  - es: https://mcpemails.com/es
  - fr: https://mcpemails.com/fr
  - zh: https://mcpemails.com/zh
  - de: https://mcpemails.com/de
  - pt-BR: https://mcpemails.com/pt
  - ja: https://mcpemails.com/ja
  - x-default: https://mcpemails.com

## Headings (document order)

- H1: Hosted email MCP server Give your AI agent an inbox.
- H2: What is an email MCP server?
- H2: Six things we believeabout email and agents.
- H3: Twenty-one focused tools. The essentials, covered.
- H3: Email is fetched live. Never stored.
- H3: You stay in control of every send.
- H3: Gmail, Outlook, iCloud, Fastmail & any IMAP inbox.
- H3: OAuth 2.0 for agents. One click to revoke.
- H3: Credentials are encrypted at rest.
- H2: See your whole MCP operation at a glance.
- H2: You're the user. We're the pipe.
- H3: Connect your inbox
- H3: Paste the URL: OAuth or API key
- H3: Your agent works the inbox
- H2: Just ask.It reads, writes, and files.
- H2: Priced by inbox. No metering on paid plans.
- H3: Free
- H3: Personal
- H3: Pro
- H3: Business
- H2: Questions, answered

Note: the current features section hard-codes a tool count ("Twenty-one focused tools"). Variants must not.

## First 150 words (rendered text, nav included)

> Email MCP Server: Gmail, Outlook, IMAP & Claude · mcpemails Features How it works Pricing Docs Blog Sign in Get started free Hosted email MCP server Give your AI agent an inbox. Connect Gmail, Outlook, iCloud, Fastmail, or any IMAP inbox once. Paste one MCP endpoint URL into Claude, Cursor, VS Code, ChatGPT, Windsurf, n8n, Make, or any MCP client. OAuth clients connect in a click, no API key setup. Your agent reads, searches, and sends mail live, and the mail it reads is never stored. Connect your inbox Read the docs 1 inbox free, forever No card required Email fetched live Running info@, sales@ and invoices@ for a company? All your work mailboxes in one agent . How a call flows t+0ms → t+312ms AI agent Claude · Cursor · VS Code · ChatGPT · any MCP client MCP MCPEmails /api/mcp endpoint IMAP Your provider Gmail · Outlook ·

## Word count

2769 words of visible text (nav, footer and FAQ answers included, scripts excluded). Every variant renders at least this many, in real sections.

## Main terms the title, H1 and first paragraph keep

email MCP server, MCPEmails, Claude, ChatGPT, connector, Gmail, Outlook, IMAP (plus iCloud, Fastmail in the first paragraph), and the fact that mail is fetched live and never stored.

## Google Search Console: homepage queries

Page `https://mcpemails.com/` (exact URL), web search, last 28 days (2026-10-14 to 2026-11-10), read 2026-11-12 15:00 Oslo.
Totals: 522 clicks, 6,670 impressions, CTR 7.8%, average position 4.4. 216 queries in all; top 24 by clicks:

| Query | Clicks | Impressions | CTR | Position |
|---|---|---|---|---|
| mcpemails | 137 | 211 | 64.9% | 1.1 |
| email mcp | 35 | 461 | 7.6% | 2.5 |
| mcp emails | 32 | 55 | 58.2% | 1.1 |
| mcpemail | 30 | 36 | 83.3% | 1.1 |
| mcp email | 21 | 135 | 15.6% | 1.6 |
| email mcp server | 8 | 268 | 3.0% | 4.5 |
| mcp mail | 8 | 72 | 11.1% | 1.8 |
| mail mcp | 7 | 174 | 4.0% | 3.7 |
| mcpmail | 4 | 31 | 12.9% | 2.6 |
| mcp mail server | 4 | 27 | 14.8% | 2.9 |
| mcp-email-server | 3 | 59 | 5.1% | 3.2 |
| imap mcp | 3 | 49 | 6.1% | 8.4 |
| email-mcp | 3 | 30 | 10.0% | 2.2 |
| webmail mcp | 3 | 16 | 18.8% | 1.2 |
| mcp email server | 2 | 68 | 2.9% | 6.0 |
| claude email mcp | 1 | 119 | 0.8% | 1.7 |
| email mcp servers | 1 | 39 | 2.6% | 3.4 |
| email client with mcp | 1 | 31 | 3.2% | 2.9 |
| mcp-mail-server | 1 | 29 | 3.4% | 4.9 |
| mcp for email | 1 | 25 | 4.0% | 2.6 |
| mail mcp server | 1 | 20 | 5.0% | 5.6 |
| mcp server for email | 1 | 13 | 7.7% | 2.1 |
| mcp email client | 1 | 11 | 9.1% | 1.5 |
| mcp-email | 1 | 5 | 20.0% | 1.8 |

Takeaway for builders: brand queries carry most clicks; the generic "email mcp (server)", "mail mcp", "imap mcp" and "claude email mcp" terms carry the impressions. Keep them in the H1, first paragraph and H2s.


## Lighthouse mobile (today's homepage)

Lighthouse 12.8.2, mobile form factor, headless Chrome on a Mac, https://mcpemails.com/, 2026-11-12 15:01 Oslo. Two good runs (a third failed with NO_NAVSTART):

| Run | Performance | LCP | CLS | TBT | FCP | Transfer | SEO | Accessibility |
|---|---|---|---|---|---|---|---|---|
| 1 | 100 | 1.4 s | 0 | 10 ms | 1.1 s | 329 KB | 100 | 96 |
| 2 | 99 | 1.9 s | 0 | 40 ms | 1.1 s | 328 KB | 100 | 96 |

Variant budgets (on the staging URL): performance at least 95, LCP under 1.8 s, CLS under 0.05, TBT under 150 ms, first-load transfer at most 350 KB excluding lazy media.


## Internal links (every one stays reachable from the page)

- `/`
- `/#features`
- `/#how`
- `/about`
- `/best-email-mcp-servers`
- `/blog`
- `/blog/claude-imap-connector`
- `/blog/connect-chatgpt-to-email`
- `/blog/connect-claude-to-email`
- `/cancel`
- `/cancel?type=withdraw`
- `/changelog`
- `/connect`
- `/connect/fastmail`
- `/connect/gmail`
- `/connect/icloud`
- `/connect/imap`
- `/connect/outlook`
- `/connect/yahoo`
- `/connect/yandex`
- `/connect/zoho`
- `/de`
- `/developers`
- `/docs`
- `/docs#oauth`
- `/docs#quickstart`
- `/docs#tools`
- `/docs/api`
- `/docs/clients`
- `/docs/providers`
- `/docs/read-only-access`
- `/dpa`
- `/es`
- `/for/business`
- `/for/founders`
- `/fr`
- `/help`
- `/ja`
- `/login`
- `/native-connectors-vs-mcp`
- `/nb`
- `/pricing`
- `/privacy`
- `/pt`
- `/security`
- `/self-hosting`
- `/signup`
- `/signup?redirect=%2Fapi%2Fstripe%2Fcheckout%2Fstart%3Fplan%3Dpersonal%26interval%3Dmonth`
- `/signup?redirect=%2Fapi%2Fstripe%2Fcheckout%2Fstart%3Fplan%3Dpro%26interval%3Dmonth`
- `/signup?redirect=%2Fapi%2Fstripe%2Fcheckout%2Fstart%3Fplan%3Dsolo%26interval%3Dmonth`
- `/status`
- `/terms`
- `/terms#agreement`
- `/tools/email-settings-lookup`
- `/zh`
- `mailto:hello@mcpemails.com`
- `mailto:support@mcpemails.com`

## External links

- https://vikse.dev/
- https://www.google.com/maps/reviews/data=!4m8!14m7!1m6!2m5!1sCi9DQUlRQUNvZENodHljRjlvT2s5RGNWbEllazFaYUZOblNWQnBVM1puVFZZNFNtYxAB!2m1!1s0x0:0x40013a8d36c2b552!3m1!1s2@1:CAIQACodChtycF9oOk9DcVlIek1ZaFNnSVBpU3ZnTVY4Smc%7C%7C?hl=en-US

## FAQ (`home.faq.items`, shown on the page and mirrored in the FAQPage JSON-LD)

- Is MCPEmails an IMAP MCP server?
- Can one agent work several mailboxes at once?
- How do I add the email MCP connector to Claude or ChatGPT?
- Do you use analytics?
- Which AI clients does it work with?
- Which email providers can I connect?
- Is my email stored anywhere?
- Is it really free?
- What can the AI actually do with my inbox?
- How do I connect an inbox?
- Can I self-host it?

## JSON-LD

Built by `homeJsonLd()` in `apps/web/src/i18n/seo.ts` and rendered by `app/[locale]/page.tsx` for every variant. One `@graph`: Organization, WebSite, SoftwareApplication (featureList, offers from `planOffers`, review markup from `components/marketing/reviews.mjs`), FAQPage (`#faq`, the same `home.faq.items`). Node types found:

- Organization https://mcpemails.com/#organization
- WebSite https://mcpemails.com/#website
- SoftwareApplication 
- FAQPage https://mcpemails.com#faq

## Images in the HTML

- {'src': '/logo-wordmark.svg', 'alt': 'MCPEmails', 'width': '280', 'height': '48', 'loading': None}
- {'src': '/logo-wordmark-dark.svg', 'alt': 'MCPEmails', 'width': '280', 'height': '48', 'loading': None}
- {'src': '/logo-mark-dark.svg', 'alt': 'MCPEmails', 'width': '48', 'height': '48', 'loading': None}
