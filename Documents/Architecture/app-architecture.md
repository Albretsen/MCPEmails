# Application Architecture

## Purpose

This document is the single source of truth for how `apps/web` is structured, how data flows through the system, and where every new file should live. It covers the monorepo layout, Next.js App Router conventions, route groups, middleware behaviour, the server/client component boundary, state management, and the target annotated file tree. Read this before writing any code.

---

## 1. Monorepo Structure

The repository is an npm workspaces monorepo. The root `package.json` declares the workspace and provides top-level convenience scripts that delegate into the individual app.

```
/                             ← repo root
  package.json                ← workspaces: ["apps/*"]
  .gitignore
  CHECKLIST.md
  Documents/                  ← architecture, MCP, Email, AI docs
  apps/
    web/                      ← Next.js 15 app (the only app today)
  packages/                   ← (reserved) shared packages, not yet created
```

**`apps/web`** is the only workspace member today. Future packages (e.g., a shared TypeScript types package `packages/types`, or an email-parsing utility `packages/email-parser`) belong under `packages/` and are added to the workspaces glob — they do not live inside `apps/web`.

**Root scripts** delegate via `-w`:

```jsonc
"dev":   "npm run dev -w apps/web",
"build": "npm run build -w apps/web"
```

Direct `cd apps/web && npm run dev` also works, but the root scripts are preferred so that future workspace members can be added without changing the developer workflow.

---

## 2. Next.js App Router Conventions

`apps/web/app/` is the App Router root. Every file in this directory that matches a Next.js reserved name has a fixed purpose. No other file names should be used for routing.

| File | Purpose |
|---|---|
| `layout.js` | Wraps all children in a shared shell (HTML, `<head>`, CSS imports, theme script). Exported `metadata` object sets default title/description. |
| `page.js` | Renders the UI for that route segment. Exports `metadata` for per-page SEO. Must be the default export. |
| `route.ts` | API endpoint (Route Handler). Exports named functions `GET`, `POST`, `PATCH`, `DELETE`, etc. No JSX. Used for all backend API endpoints consumed by the frontend and for the MCP HTTP transport. |
| `loading.js` | React Suspense boundary fallback shown while the segment's `page.js` is fetching data. |
| `error.js` | Error boundary UI for the segment. Must be a Client Component (`'use client'`). |
| `not-found.js` | Rendered by `notFound()` calls within the segment. |
| `middleware.ts` | Runs on every request before any page or route handler. Lives at `apps/web/middleware.ts` (not inside `app/`). |

### File extension policy

- Page and layout files are `.js` or `.jsx`. Use `.jsx` when JSX is required and the file has no TypeScript.
- Route Handlers, middleware, and all `lib/` code are `.ts` or `.tsx`.
- The project targets TypeScript for all backend and utility code; existing `.jsx` pages will be migrated as each page is rebuilt.

---

## 3. Route Map

Every URL the app serves, its purpose, and the component that renders it.

### Public / Marketing

| URL | File | Purpose |
|---|---|---|
| `/` | `app/(marketing)/page.js` | Marketing home: Nav, Hero, Trusted, Features, HowItWorks, Quote, Pricing, Footer. Statically rendered. |
| `/pricing` | `app/(marketing)/pricing/page.js` | Full pricing page with plan comparison table. Links to `/signup`. |
| `/docs` | `app/(marketing)/docs/page.js` | Developer documentation landing page. Links to MCP endpoint reference, quickstart, and tool catalogue. |
| `/privacy` | `app/(marketing)/privacy/page.js` | Privacy policy. Static. |
| `/terms` | `app/(marketing)/terms/page.js` | Terms of service. Static. |

### Authentication

| URL | File | Purpose |
|---|---|---|
| `/login` | `app/(auth)/login/page.js` | Magic-link / OAuth sign-in form. Calls `supabase.auth.signInWithOtp()` or OAuth provider. Redirects to `/dashboard` on success. |
| `/signup` | `app/(auth)/signup/page.js` | Account creation form. Collects email, password, workspace name. OAuth shortcuts. On success redirects to `/dashboard?firstrun=1`. |
| `/forgot-password` | `app/(auth)/forgot-password/page.js` | Sends a password-reset magic link. Shows confirmation state without revealing whether the address exists. |
| `/reset-password` | `app/(auth)/reset-password/page.js` | Receives the reset token from the link, accepts and confirms a new password. |
| `/auth/callback` | `app/auth/callback/route.ts` | Route Handler only (no UI). Exchanges the Supabase `code` param for a session, writes cookies, and redirects to `/dashboard` or `?next=`. |

### Dashboard (authenticated)

| URL | File | Purpose |
|---|---|---|
| `/dashboard` | `app/(dashboard)/dashboard/page.js` | Overview: stat cards (inboxes connected, MCP calls 30d, avg response time, plan usage), calls-per-day chart, recent activity feed. |
| `/dashboard/inboxes` | `app/(dashboard)/dashboard/inboxes/page.js` | List of connected inboxes with status indicators. Connect and remove actions. |
| `/dashboard/keys` | `app/(dashboard)/dashboard/keys/page.js` | API key management: create, view prefix, copy, revoke. |
| `/dashboard/usage` | `app/(dashboard)/dashboard/usage/page.js` | Usage analytics: calls by tool, by inbox, by time window. Plan quota indicator. |
| `/dashboard/settings` | `app/(dashboard)/dashboard/settings/page.js` | Workspace settings: name, slug, plan, billing portal link. |
| `/dashboard/security` | `app/(dashboard)/dashboard/security/page.js` | Auth log, active sessions, sign-out-all-devices. |

### OAuth / MCP

| URL | File | Purpose |
|---|---|---|
| `/authorize` | `app/(auth)/authorize/page.js` | OAuth-style agent authorization screen. Agent requests scope; user reviews permissions per inbox, toggles, then clicks Allow. Issues a bearer token and shows copy-paste config snippet. |
| `/api/mcp` | `app/api/mcp/route.ts` | MCP Streamable HTTP transport endpoint. Authenticates via bearer token (`api_keys` table). Dispatches JSON-RPC 2.0 tool calls to `lib/mcp/server.ts`. All AI agent traffic enters here. |
| `/api/inboxes` | `app/api/inboxes/route.ts` | REST endpoint for dashboard CRUD on inboxes. Protected by session cookie. |
| `/api/keys` | `app/api/keys/route.ts` | REST endpoint for API key create and revoke. Protected by session cookie. |
| `/api/oauth/callback/gmail` | `app/api/oauth/callback/gmail/route.ts` | Receives the Gmail OAuth authorization code, exchanges it for tokens, stores encrypted in `inboxes`. |
| `/api/oauth/callback/outlook` | `app/api/oauth/callback/outlook/route.ts` | Same for Microsoft Graph / Outlook. |

---

## 4. Route Groups

Route groups are directories wrapped in parentheses. They are invisible in the URL but allow segments to share a `layout.js` without affecting the path.

### `(marketing)`

```
app/
  (marketing)/
    layout.js        ← imports marketing.css; no auth check
    page.js          ← /
    pricing/page.js  ← /pricing
    docs/page.js     ← /docs
    privacy/page.js  ← /privacy
    terms/page.js    ← /terms
```

The `(marketing)` layout is minimal: it applies `marketing.css` and `colors_and_type.css`. It does not check authentication. Pages in this group are statically rendered by default.

### `(auth)`

```
app/
  (auth)/
    layout.js        ← imports marketing.css + dashboard.css + theme.css; applies dot-grid background
    login/page.js    ← /login
    signup/page.js   ← /signup
    forgot-password/page.js
    reset-password/page.js
    authorize/page.js
```

The `(auth)` layout provides the centred card shell (`auth-shell`, `auth-wrap`) that all auth screens use. It imports all three CSS files because auth pages can render both marketing-style type and dashboard-style form components. No authentication check — middleware handles the redirect for already-authenticated users.

### `(dashboard)`

```
app/
  (dashboard)/
    layout.js        ← session guard; fetches user + workspace server-side; renders shell
    dashboard/
      page.js        ← /dashboard
      inboxes/page.js
      keys/page.js
      usage/page.js
      settings/page.js
      security/page.js
```

The `(dashboard)` layout does two things:
1. Calls `supabase.auth.getUser()` server-side. If not authenticated, calls `redirect('/login')`.
2. Fetches the user's workspace and passes it as a prop (or via React context via a small Provider) to all child pages, avoiding per-page re-fetching of workspace metadata.

It renders the two-column shell: `<Sidebar>` on the left, `<main>` on the right. All dashboard pages receive the authenticated user and workspace as server props.

### Root layout

`app/layout.js` is the root layout shared by every group. It sets the `<html>` element, injects the anti-FOUC theme script (reads `localStorage` and sets `data-theme` before first paint), and exports the default `metadata`. It does not import any CSS — each group layout handles its own CSS imports.

---

## 5. Middleware

`apps/web/middleware.ts` runs before every request that is not a static asset. Its responsibilities are:

1. **Session refresh.** Calls `updateSession(request)` from `lib/supabase/middleware.ts`. This creates a Supabase server client that reads existing session cookies, calls `supabase.auth.getUser()` to validate the token server-side (not just locally), and — if the access token has expired — uses the refresh token to obtain a new one. Updated cookies are written onto the response via the `setAll` callback.

2. **Route protection.** After refreshing the session, if no authenticated user is found and the request is for a protected path, the middleware returns a `NextResponse.redirect` to `/login?redirect=<original-path>`. Protected prefixes: `/dashboard`, `/api/inboxes`, `/api/keys`, `/api/mcp`.

3. **Auth redirect.** If an already-authenticated user requests `/login` or `/signup`, the middleware redirects them to `/dashboard` to avoid double sign-in.

The middleware matcher excludes Next.js internal paths and static files:

```typescript
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

**What middleware does not do:** It does not fetch workspace data, render UI, or perform any database queries beyond the session validation call. Heavy business logic belongs in Server Components or Route Handlers, not middleware.

---

## 6. Server vs Client Component Boundary

### The rule

A component is a Server Component by default. Add `'use client'` only when the component needs one of:

- Browser-only APIs (`window`, `document`, `localStorage`, `navigator`)
- React state (`useState`, `useReducer`)
- React effects (`useEffect`, `useLayoutEffect`)
- Event handlers attached directly to DOM elements (`onClick`, `onChange`, etc.)
- Next.js client hooks (`useRouter`, `useSearchParams`, `usePathname`)

If none of these apply, keep it a Server Component.

### What stays server-side

- All page files (`page.js`) that fetch data from Supabase should be async Server Components. They call `createClient()` from `lib/supabase/server.ts`, query the database, and pass the result as props to Client Components that need interactivity.
- The `(dashboard)` layout fetches user + workspace once server-side and passes it down.
- Any component that only renders static markup, formats data, or conditionally renders based on props (not state) should be a Server Component.

### What must be a Client Component

- The entire `DashboardApp` and its children (`Sidebar`, `Topbar`, `Pages`, `ConnectModal`) because they manage local UI state (current route within the dashboard, modal open/closed, toast messages).
- `SignupApp` and `AuthorizeApp` because they contain forms, validation state, and `useRouter`.
- The marketing `Home` page because it uses `useTweaks` (design-time variant picker) and `useEffect` for theme persistence.
- Any component that subscribes to Supabase Realtime (activity feed).

### The boundary pattern

The boundary is always drawn at the lowest component that requires client features. The page file itself should be a Server Component that fetches data and passes it to a leaf Client Component:

```
app/(dashboard)/dashboard/inboxes/page.js   ← Server Component
  async function InboxesPage() {
    const supabase = await createClient();
    const { data: inboxes } = await supabase.from('inboxes').select(...);
    return <InboxesList inboxes={inboxes} />;    ← Client Component
  }
```

`InboxesList` handles add/remove interactions, optimistic updates, and the connect modal. It receives `inboxes` as a serialisable prop and is responsible only for the interactive layer.

### CSS imports and Server Components

CSS files are imported in layout or page files, not in individual components. A component file must never contain `import '../../styles/foo.css'` — that import belongs in the nearest layout that activates for that route group.

---

## 7. Shared State

MCPEmails does not use a global state library (no Redux, no Zustand, no React Query). State is managed at the appropriate level:

### Server state (authoritative data)

Data that lives in Supabase (`inboxes`, `api_keys`, `activity_log`) is fetched in Server Components on each page load. On mutation (add inbox, revoke key), the client calls the relevant API route, which writes to Supabase, and then the page is re-fetched via `router.refresh()` to revalidate the server cache.

### URL state

The current dashboard section is communicated via URL. `/dashboard/inboxes` renders the inboxes view; `/dashboard/keys` renders the keys view. This enables deep-linking, back-button navigation, and sharing a link to a specific section. The sidebar navigates via `<Link href="/dashboard/keys">`, not via `setRoute()`.

**Note on the current implementation:** The current `DashboardApp` uses an in-component `route` state string and renders all sections as conditionals within a single page. This is a prototype shortcut. The target architecture uses discrete Next.js pages per section as shown in the route map above. The migration path is: add the page files, update the `Sidebar` to use `<Link>`, and remove the `route` state from `DashboardApp`.

### Local UI state

Modal open/closed, toast messages, form field values, and optimistic updates live in `useState` within the component that owns them. This state is never shared across pages — it is scoped to the component tree that needs it.

### First-run flow

After signup, the user is redirected to `/dashboard?firstrun=1`. The `(dashboard)` layout reads this query param server-side and passes `firstrun: true` to the client shell. The shell auto-opens the `ConnectModal` after a 400ms delay to let the page settle. After the first inbox is connected, the shell redirects to `/dashboard/keys` to nudge the user to generate an API key.

### Theme

Theme (`light` / `dark`) is persisted to `localStorage` under the key `mcpe-theme`. The root layout injects an inline script that reads this key before the page renders, setting `data-theme` on `<html>` to prevent flash-of-unstyled-content. Components that toggle the theme write to `localStorage` and set `data-theme` directly — no context or global store is needed.

### Workspace context

The authenticated user's workspace is fetched once in the `(dashboard)` layout Server Component. It is passed to child pages as a prop. If a page needs workspace data, it receives it from the layout — it does not re-fetch it. For deeply nested Client Components that need workspace data, a small `WorkspaceProvider` (React context) wraps the dashboard shell.

---

## 8. `lib/` Directory Structure

`lib/` lives at `apps/web/lib/` and contains all non-component, non-route logic. It is TypeScript-only. No JSX belongs here.

### `lib/supabase/`

Three Supabase client factories, one per execution context. Never import the wrong factory for a context.

```
lib/supabase/
  client.ts       ← createBrowserClient() — used in Client Components only
  server.ts       ← createServerClient() using next/headers cookies() — used in Server Components and Route Handlers
  middleware.ts   ← createServerClient() using request/response objects — used only in middleware.ts
  types.ts        ← re-exports the generated Database type; import from here, not from generated file directly
```

`client.ts` and `server.ts` each export a single `createClient()` function. The function name is intentionally identical so that code can be mechanically moved between client and server contexts by changing only the import path.

### `lib/email/`

All logic for communicating with email providers. Nothing in this directory touches the database or Next.js primitives — it is pure email protocol code.

```
lib/email/
  gmail.ts        ← Gmail API client wrapper: list, read, send, reply, search
  outlook.ts      ← Microsoft Graph client wrapper: same interface as gmail.ts
  imap.ts         ← IMAP/SMTP client (Fastmail, generic): same interface
  providers.ts    ← Union type EmailProvider; factory function getEmailClient(inbox: Inbox): EmailClient
  types.ts        ← Email, Attachment, Thread, Folder types shared across providers
  parse.ts        ← MIME parsing, encoding normalisation, attachment extraction
  rate-limit.ts   ← Per-provider rate-limit state and exponential backoff helper
```

All providers implement the `EmailClient` interface defined in `types.ts`:

```typescript
interface EmailClient {
  listInbox(params: ListInboxParams): Promise<Email[]>;
  readEmail(id: string): Promise<Email>;
  sendEmail(params: SendEmailParams): Promise<void>;
  replyToEmail(id: string, body: string): Promise<void>;
  searchEmails(query: string): Promise<Email[]>;
  forwardEmail(id: string, to: string): Promise<void>;
}
```

The MCP layer calls `getEmailClient(inbox)` and uses only this interface — it has no knowledge of which provider is underneath.

### `lib/mcp/`

The MCP server implementation. This code runs inside the `/api/mcp` Route Handler.

```
lib/mcp/
  server.ts       ← MCP server instance; registers all tools; handles initialize/tools/list/tools/call
  tools/
    list-inbox.ts     ← list_inbox tool handler
    read-email.ts     ← read_email tool handler
    send-email.ts     ← send_email tool handler
    reply-email.ts    ← reply_to_email tool handler
    search-emails.ts  ← search_emails tool handler
    forward-email.ts  ← forward_email tool handler
  auth.ts         ← bearer token validation against api_keys table; returns resolved key + scopes
  scope-check.ts  ← throws McpError if the key's scopes do not permit the requested tool
  activity.ts     ← writes a row to activity_log after each tool invocation
  errors.ts       ← typed MCP error codes and error factory functions
```

Each tool handler in `tools/` receives a validated, scope-checked `inbox`, calls the appropriate `lib/email/` method, and returns the MCP-format result. Tool handlers do not talk to the database directly — they receive an `inbox` object that has already been loaded by `server.ts`.

### `lib/utils/`

Pure utility functions with no side effects. Safe to import anywhere.

```
lib/utils/
  crypto.ts       ← encrypt() / decrypt() using AES-256-GCM; key from Vault secret
  format.ts       ← formatDate(), formatBytes(), truncate(), formatEmailAddress()
  validate.ts     ← validateEmail(), validateWorkspaceSlug(), validateScope()
  slugify.ts      ← converts arbitrary strings to URL-safe workspace slugs
  pagination.ts   ← buildPaginationParams(), PaginatedResult type
```

---

## 9. Target Directory Tree

The following is the full annotated target tree for `apps/web/`. Items marked `[exists]` are already present; everything else is to be created as the corresponding tasks complete.

```
apps/web/
│
├── app/                              ← Next.js App Router root
│   ├── layout.js                     [exists] Root layout: <html>, theme script, default metadata
│   │
│   ├── (marketing)/                  ← Route group: public pages, no auth
│   │   ├── layout.js                 Imports marketing.css, colors_and_type.css
│   │   ├── page.js                   [exists] → move from app/page.js; marketing home
│   │   ├── pricing/
│   │   │   └── page.js               /pricing
│   │   ├── docs/
│   │   │   └── page.js               /docs — developer quickstart + tool reference
│   │   ├── privacy/
│   │   │   └── page.js               /privacy
│   │   └── terms/
│   │       └── page.js               /terms
│   │
│   ├── (auth)/                       ← Route group: auth screens, shared card shell
│   │   ├── layout.js                 Imports marketing.css + dashboard.css + theme.css
│   │   ├── login/
│   │   │   └── page.js               /login — magic link + OAuth sign-in
│   │   ├── signup/
│   │   │   └── page.js               [exists] /signup — workspace creation
│   │   ├── forgot-password/
│   │   │   └── page.js               /forgot-password
│   │   ├── reset-password/
│   │   │   └── page.js               /reset-password
│   │   └── authorize/
│   │       └── page.js               [exists] → move from app/authorize/; /authorize — agent OAuth screen
│   │
│   ├── (dashboard)/                  ← Route group: authenticated dashboard
│   │   ├── layout.js                 Session guard + workspace fetch + shell (Sidebar + main)
│   │   └── dashboard/
│   │       ├── page.js               [exists] /dashboard — overview stats + activity feed
│   │       ├── inboxes/
│   │       │   └── page.js           /dashboard/inboxes
│   │       ├── keys/
│   │       │   └── page.js           /dashboard/keys
│   │       ├── usage/
│   │       │   └── page.js           /dashboard/usage
│   │       ├── settings/
│   │       │   └── page.js           /dashboard/settings
│   │       └── security/
│   │           └── page.js           /dashboard/security
│   │
│   ├── auth/
│   │   ├── callback/
│   │   │   └── route.ts              /auth/callback — exchanges Supabase code for session
│   │   └── error/
│   │       └── page.js               /auth/error — shown if callback exchange fails
│   │
│   └── api/
│       ├── mcp/
│       │   └── route.ts              /api/mcp — MCP Streamable HTTP transport; bearer auth
│       ├── inboxes/
│       │   └── route.ts              /api/inboxes — GET list, POST create, DELETE remove
│       ├── keys/
│       │   └── route.ts              /api/keys — GET list, POST create, DELETE revoke
│       └── oauth/
│           └── callback/
│               ├── gmail/
│               │   └── route.ts      /api/oauth/callback/gmail
│               └── outlook/
│                   └── route.ts      /api/oauth/callback/outlook
│
├── components/                       ← UI components; sub-directories mirror route groups
│   │
│   ├── Primitives.jsx                [exists] Icon, Btn, Badge, Avatar, ProviderLogo — dashboard primitives
│   ├── MarketingPrimitives.jsx       [exists] MIcon, MBtn — marketing-only primitives
│   ├── tweaks-panel.jsx              [exists] Design-time variant/theme picker (dev-only overlay)
│   │
│   ├── marketing/                    ← Marketing page components
│   │   ├── Sections.jsx              [exists] Nav, Hero, Trusted, Features, HowItWorks, Quote, Pricing, Footer
│   │   └── App.jsx                   [exists] Marketing page root (to be replaced by page.js server component)
│   │
│   ├── auth/                         ← Auth screen components (all Client Components)
│   │   ├── SignupApp.jsx             [exists] Sign-up / sign-in form
│   │   ├── AuthorizeApp.jsx          [exists] Agent authorization screen
│   │   ├── LoginApp.jsx              /login form (magic link + OAuth)
│   │   ├── ForgotPasswordApp.jsx     /forgot-password form
│   │   └── ResetPasswordApp.jsx      /reset-password form
│   │
│   └── dashboard/                    ← Dashboard components (all Client Components)
│       ├── App.jsx                   [exists] DashboardApp root — owns local route state (transitional)
│       ├── Sidebar.jsx               [exists] Sidebar nav + Topbar
│       ├── Pages.jsx                 [exists] OverviewPage, InboxesPage, KeysPage, UsagePage, SettingsPage, SecurityPage
│       ├── ConnectModal.jsx          [exists] Multi-step inbox connection modal
│       ├── InboxRow.jsx              Single inbox row with status badge and actions
│       ├── KeyRow.jsx                Single API key row with prefix, scopes, revoke
│       ├── ActivityFeed.jsx          Real-time activity log (Supabase Realtime subscription)
│       ├── UsageChart.jsx            Calls-per-day bar chart
│       └── WorkspaceProvider.jsx     React context provider for workspace data (wraps dashboard shell)
│
├── lib/                              ← Non-component, non-route logic; TypeScript only
│   ├── supabase/
│   │   ├── client.ts                 createBrowserClient() — Client Components only
│   │   ├── server.ts                 createServerClient() with next/headers — Server Components + Route Handlers
│   │   ├── middleware.ts             createServerClient() with request/response — middleware only
│   │   └── types.ts                 Re-exports generated Database type
│   │
│   ├── email/
│   │   ├── types.ts                  Email, Attachment, Thread, EmailClient interface
│   │   ├── providers.ts              getEmailClient(inbox) factory; EmailProvider union
│   │   ├── gmail.ts                  Gmail API wrapper implementing EmailClient
│   │   ├── outlook.ts               Microsoft Graph wrapper implementing EmailClient
│   │   ├── imap.ts                   IMAP/SMTP wrapper implementing EmailClient
│   │   ├── parse.ts                  MIME parsing and encoding normalisation
│   │   └── rate-limit.ts             Per-provider backoff state and retry helper
│   │
│   ├── mcp/
│   │   ├── server.ts                 MCP server instance; registers all tools
│   │   ├── auth.ts                   Bearer token → api_key row resolution
│   │   ├── scope-check.ts            Throws McpError if scope insufficient for tool
│   │   ├── activity.ts              Appends row to activity_log after each call
│   │   ├── errors.ts                 Typed MCP error codes and factory functions
│   │   └── tools/
│   │       ├── list-inbox.ts         list_inbox tool (scope: read:email)
│   │       ├── read-email.ts         read_email tool (scope: read:email)
│   │       ├── send-email.ts         send_email tool (scope: send:email)
│   │       ├── reply-email.ts        reply_to_email tool (scope: send:email)
│   │       ├── search-emails.ts      search_emails tool (scope: read:email)
│   │       └── forward-email.ts      forward_email tool (scope: send:email)
│   │
│   └── utils/
│       ├── crypto.ts                 encrypt() / decrypt() — AES-256-GCM via Supabase Vault key
│       ├── format.ts                 formatDate, formatBytes, truncate, formatEmailAddress
│       ├── validate.ts               validateEmail, validateWorkspaceSlug, validateScope
│       ├── slugify.ts                URL-safe slug generation for workspace names
│       └── pagination.ts             buildPaginationParams, PaginatedResult<T>
│
├── styles/                           ← Global CSS; no CSS Modules; imported in layout/page files only
│   ├── colors_and_type.css           [exists] Design tokens: colours, typography, spacing, radius
│   ├── theme.css                     [exists] Dark mode overrides (data-theme="dark"), auth shell styles
│   ├── marketing.css                 [exists] Marketing page layout and component styles
│   └── dashboard.css                 [exists] Dashboard shell, sidebar, page, card, form styles
│
├── public/                           ← Static assets; served at /
│   ├── favicon.svg                   [exists]
│   ├── logo-wordmark.svg             [exists]
│   ├── logo-mark.svg                 [exists]
│   ├── logo-mark-dark.svg            [exists]
│   └── illustration-pipe.svg        [exists]
│
├── middleware.ts                     Session refresh + route protection (runs before every request)
├── next.config.js                    [exists] (currently empty; add image domains, env rewrites here)
└── package.json                      [exists] next@^15, react@^18; devDeps: eslint, eslint-config-next
```

---

## Addendum: Key Design Constraints

**Two auth systems, zero overlap.** The dashboard uses Supabase session cookies. The MCP endpoint uses bearer tokens from the `api_keys` table. A session cookie cannot call `/api/mcp`; a bearer token cannot access `/dashboard`. These are enforced separately at the middleware level and in each route handler.

**Encrypted credentials never leave the server.** OAuth tokens and IMAP passwords are AES-256-GCM encrypted before being written to Supabase. They are decrypted only inside Supabase Edge Functions (token refresh, MCP tool execution) and never in Next.js Server Components or Route Handlers that handle user-facing requests. The decryption key lives in Supabase Vault.

**RLS is not optional.** Every table that holds tenant data has Row-Level Security enabled. Application queries filter by `workspace_id` in code as a first defence; RLS enforces isolation at the database level as the last defence. The `service_role` key is never used in any code path that handles a user request.

**CSS is global, not modular.** The design system uses CSS custom properties (`var(--cobalt-500)`, `var(--font-sans)`) defined in `colors_and_type.css`. Components use these variables directly. CSS Modules are not used. This is intentional — the token system provides the necessary isolation, and a single global namespace makes theme overrides (`data-theme="dark"`) straightforward to implement.

**No `select('*')`.** Database queries always name their columns explicitly. Encrypted `bytea` columns on `inboxes` are never fetched unless the code is about to use the credential. This reduces log exposure and prevents accidentally serialising ciphertext into API responses.
