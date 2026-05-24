# MCPEmails — Development Checklist

Each item represents one meaningful unit of work: enough to make real progress, small enough to complete in a single agent wake-up. Items are ordered so each builds on the last.

---

## 1. Infrastructure & Configuration

- [x] Set up Supabase project: create all database tables (`users`, `workspaces`, `inboxes`, `api_keys`, `usage_logs`, `audit_log`) with correct columns, types, foreign keys, and indexes
- [x] Write and apply all Row-Level Security (RLS) policies so users can only access their own workspace's data
- [ ] Configure Supabase Auth: enable email/password provider, set site URL and redirect URLs, configure email templates (confirm, reset, invite)
- [ ] Add Supabase server client and browser client utility files (`lib/supabase/server.ts`, `lib/supabase/client.ts`, `lib/supabase/middleware.ts`)
- [ ] Add Next.js middleware to protect dashboard routes and redirect unauthenticated users to `/login`
- [ ] Document all required environment variables in `.env.example` and wire them up in `next.config.js`

---

## 2. Authentication Pages & Flows

- [ ] Build functional `/login` page: email/password form, Supabase Auth sign-in, error handling, redirect to dashboard on success
- [ ] Build functional `/signup` page: email/password form, Supabase Auth sign-up, success state with "check your email" message
- [ ] Build `/forgot-password` page and `/reset-password` page: send reset email, handle token from URL, update password, redirect to login
- [ ] Implement auth callback route (`/auth/callback`): exchange code for session, handle errors, redirect to intended destination
- [ ] Wire sign out button in dashboard sidebar to Supabase Auth sign-out and redirect to `/`

---

## 3. Dashboard — Core & Overview

- [ ] Replace all mock/static data in the dashboard with real Supabase queries: user name, email, avatar initials in sidebar
- [ ] Build the Overview page with live data: connected inbox count, API keys count, total MCP calls today, calls this month — all from real DB queries
- [ ] Build the Overview page activity feed: list the last 10 MCP tool calls from `audit_log` with tool name, inbox, timestamp

---

## 4. Email Provider OAuth — Gmail

- [ ] Implement Gmail OAuth: authorization URL generation with correct scopes, redirect to Google, handle callback route `/auth/gmail/callback`
- [ ] Implement Gmail token exchange: exchange code for access + refresh tokens, encrypt and store in `inboxes` table, redirect to dashboard
- [ ] Implement Gmail token refresh: before every Gmail API call, check expiry and refresh if within 5 minutes, update stored tokens

---

## 5. Email Provider OAuth — Outlook

- [ ] Implement Outlook (Microsoft) OAuth: authorization URL with correct scopes, callback route `/auth/outlook/callback`, token exchange, encrypted storage
- [ ] Implement Outlook token refresh logic and error handling for revoked tokens (prompt user to reconnect)

---

## 6. Email Provider OAuth — Fastmail

- [ ] Implement Fastmail OAuth: authorization URL, callback route `/auth/fastmail/callback`, token exchange, encrypted storage
- [ ] Implement Fastmail app-password connection as an alternative to OAuth: form to enter email + app password, validate via IMAP, store encrypted

---

## 7. Dashboard — Inboxes Page

- [ ] Build Inboxes page: fetch and display all connected inboxes from Supabase with provider icon, email address, status badge (connected / error / expired)
- [ ] Build "Connect Inbox" modal: provider selection step (Gmail, Outlook, Fastmail cards), clicking a provider initiates its OAuth redirect
- [ ] Implement inbox reconnect flow: "Reconnect" button on errored inboxes that restarts the OAuth flow for that provider
- [ ] Implement disconnect inbox: confirmation dialog, revoke OAuth tokens with provider, delete row from `inboxes` table

---

## 8. Dashboard — API Keys Page

- [ ] Build API Keys list page: fetch and display all keys with name, masked key value, scopes, created date, and last used date
- [ ] Implement create API key: modal with name field and scope checkboxes, generate cryptographically secure key, hash and store in DB, show full key once in a copy modal
- [ ] Implement revoke API key: confirmation dialog with key name, delete from DB, show success state

---

## 9. Shared Email Utilities

- [ ] Build email parsing utility (`lib/email/parser.ts`): decode base64 and quoted-printable content, extract plain text and HTML parts from multipart MIME messages, list attachments
- [ ] Build HTML sanitization utility (`lib/email/sanitize.ts`): strip `<script>`, event handlers, and dangerous attributes from email HTML before returning it to MCP clients
- [ ] Build IMAP connection utility (`lib/email/imap.ts`): create a pooled IMAP connection from stored credentials, with retry and error handling

---

## 10. MCP Server — Foundation

- [ ] Create Supabase Edge Function `mcp-server`: handle HTTP POST, parse JSON-RPC 2.0 request body, route to correct method handler, return JSON-RPC response
- [ ] Implement API key authentication in `mcp-server`: extract key from `Authorization: Bearer` header, hash it, look up in `api_keys` table, reject with `-32001` if invalid or revoked
- [ ] Implement `initialize` handler in `mcp-server`: validate `protocolVersion`, return server capabilities (`tools: { listChanged: false }`)
- [ ] Implement `tools/list` handler: return the full list of available MCPEmails tools with names, descriptions, and input schemas
- [ ] Implement per-key rate limiting in `mcp-server`: check call count in rolling windows (100/min, 1000/hr, 10000/day), return `-32029` if exceeded
- [ ] Implement usage logging in `mcp-server`: write every tool call to `usage_logs` and `audit_log` (key ID, tool name, inbox ID, timestamp, success/error)

---

## 11. MCP Tools — Implementation

- [ ] Implement `list_inbox` tool: list folders/labels and message counts for a connected inbox using the provider's API (Gmail Labels API, IMAP LIST, Graph mailFolders)
- [ ] Implement `read_email` tool: fetch a single email by ID using provider API, parse MIME, sanitize HTML, return structured object (from, to, subject, date, text, html, attachments)
- [ ] Implement `send_email` tool: validate required fields (to, subject, body), construct MIME message, send via Gmail API / SMTP / Graph API, return message ID
- [ ] Implement `reply_to_email` tool: fetch original message to get headers (Message-ID, References), construct reply with correct threading headers, send via provider
- [ ] Implement `search_emails` tool: run provider-native search (Gmail `q=`, IMAP SEARCH, Graph `$search`), return up to 100 results with ID, subject, from, date, snippet

---

## 12. Dashboard — Usage Page

- [ ] Build Usage page chart: show daily MCP call volume for the past 30 days using real data from `usage_logs`, render as a bar chart
- [ ] Build Usage page breakdown table: calls grouped by tool name and by inbox, with counts and percentage of total

---

## 13. Dashboard — Settings Page

- [ ] Build Profile settings section: display name update form, read-only email display, save changes to Supabase user metadata
- [ ] Build Password change section: current password + new password + confirm fields, call Supabase `updateUser`, show success/error toast
- [ ] Build Delete Account section: confirmation dialog requiring the user to type their email, soft-delete workspace data, sign out

---

## 14. Dashboard — Security Page

- [ ] Build Security page audit log: paginated table of recent MCP tool calls from `audit_log` with tool, inbox, API key name, timestamp, and success/failure
- [ ] Build active sessions section: list current Supabase Auth sessions with device info and a "Sign out all other sessions" button

---

## 15. Authorize Page (MCP Client OAuth)

- [ ] Wire the `/authorize` page to real logic: validate `client_id` query param against registered MCP clients, display real app name and requested scopes
- [ ] Implement approve flow on `/authorize`: create a short-lived authorization code, store in DB, redirect to `redirect_uri` with code
- [ ] Implement token exchange endpoint (`/api/oauth/token`): exchange authorization code for a scoped API key, return key as bearer token

---

## 16. Marketing Site — Final

- [ ] Update homepage hero, features, and how-it-works sections with final production copy and accurate descriptions of real features
- [ ] Build Pricing section on homepage and full `/pricing` page with plan tiers (Free / Pro / Enterprise), feature comparison table, and CTA buttons
- [ ] Build `/docs` landing page: quick-start guide (install MCP client → connect Gmail → start using), tool reference table with parameters and example responses

---

## 17. Legal Pages

- [ ] Build `/privacy` page with full Privacy Policy (data collected, how used, retention, third parties, contact)
- [ ] Build `/terms` page with full Terms of Service (acceptable use, liability, account termination, governing law)

---

## 18. Error Handling & Loading States

- [ ] Implement toast notification system in the dashboard for success/error feedback on all user actions (key created, inbox connected, settings saved, etc.)
- [ ] Add loading skeleton components for all dashboard pages so there is no layout shift while data loads
- [ ] Add empty state components for all dashboard pages (no inboxes connected, no API keys, no usage yet) with clear CTA
- [ ] Build `/404` and `/500` custom error pages with navigation back to the dashboard or homepage

---

## 19. Mobile Responsiveness

- [ ] Audit and fix dashboard layout on mobile: collapsible sidebar, touch-friendly tap targets, scrollable tables
- [ ] Audit and fix marketing site on mobile: hero, features, pricing, and docs pages all fully usable on 375px viewport

---

## 20. Billing — Stripe Integration

- [ ] Integrate Stripe: create Free / Pro / Enterprise products and prices, add Stripe SDK, store `stripe_customer_id` on workspace
- [ ] Implement subscription checkout: "Upgrade" button triggers Stripe Checkout session, redirect back to dashboard on success
- [ ] Implement Stripe webhook handler (`/api/webhooks/stripe`): handle `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` — sync plan to DB
- [ ] Implement Stripe Customer Portal link in dashboard settings so users can manage billing, update card, and cancel
- [ ] Enforce plan limits in the MCP server and dashboard: inbox count cap, daily call quota — return clear error when limit reached

---

## 21. SEO & Launch Prep

- [ ] Add `<meta>` Open Graph tags, Twitter card tags, and canonical URLs to all public pages
- [ ] Generate `sitemap.xml` and add `robots.txt`
- [ ] Configure Vercel project: set production domain `mcpemails.com`, add all production environment variables, enable preview deployments
- [ ] Set up separate Supabase production project, run migrations, and verify RLS in production environment

---

**Total: 66 items**
