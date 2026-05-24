# Deployment Architecture

## Purpose

This document describes how MCPEmails is built, deployed, and operated across all environments. It covers the hosting topology, environment separation, environment variables, database migrations, CI/CD pipeline, secrets management, and rollback procedures. The goal is to give any developer or AI agent a complete picture of how code moves from a local workstation to production and what to do when something goes wrong.

---

## 1. Infrastructure Overview

MCPEmails is a multi-tier SaaS built on two managed platforms: **Vercel** for the Next.js application layer and **Supabase** for the data and serverless backend.

```
┌─────────────────────────────────────────────────────────────────┐
│                        INTERNET                                 │
│                                                                 │
│   mcpemails.com ──────────────────► Vercel Edge Network        │
│   (DNS via Vercel)                   (CDN + Edge Middleware)    │
│                                             │                   │
│                                   ┌─────────▼──────────┐      │
│                                   │  Next.js 15 App    │      │
│                                   │  (App Router)      │      │
│                                   │                    │      │
│                                   │  • Static pages    │      │
│                                   │  • RSC / SSR       │      │
│                                   │  • Route Handlers  │      │
│                                   │  • Middleware      │      │
│                                   └─────────┬──────────┘      │
│                                             │                  │
│                              ┌──────────────▼──────────────┐  │
│                              │       Supabase Project       │  │
│                              │                              │  │
│                              │  ┌─────────┐ ┌───────────┐  │  │
│                              │  │  Auth   │ │ PostgreSQL │  │  │
│                              │  │  (JWT)  │ │  + RLS    │  │  │
│                              │  └─────────┘ └───────────┘  │  │
│                              │                              │  │
│                              │  ┌─────────────────────────┐ │  │
│                              │  │     Edge Functions      │ │  │
│                              │  │  • mcp-server           │ │  │
│                              │  │  • token-refresh        │ │  │
│                              │  │  • partition-manager    │ │  │
│                              │  └─────────────────────────┘ │  │
│                              │                              │  │
│                              │  ┌─────────┐ ┌───────────┐  │  │
│                              │  │ Storage │ │  Realtime │  │  │
│                              │  │(Parquet │ │ (activity │  │  │
│                              │  │archives)│ │   feed)   │  │  │
│                              │  └─────────┘ └───────────┘  │  │
│                              └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Vercel Responsibilities

- Hosts the Next.js 15 application in the `apps/web/` workspace.
- Serves static assets from the CDN edge network globally.
- Runs Edge Middleware (`middleware.ts`) for session refresh and route protection.
- Executes Node.js Route Handlers for OAuth callbacks, Stripe webhooks, and any CPU-bound API logic.
- Provides preview deployments on every pull request.
- Provides instant rollback to any previous deployment.

### Supabase Responsibilities

- **PostgreSQL database** — the canonical data store for all application state, with Row-Level Security enforcing multi-tenant isolation.
- **Supabase Auth** — issues JWTs for the dashboard user sessions; stores magic-link OTPs; manages refresh token rotation.
- **Edge Functions** (Deno runtime) — runs the `mcp-server` function that AI agents connect to, the `token-refresh` scheduler, and the `partition-manager` for monthly `activity_log` partition creation.
- **Storage** — holds archived Parquet snapshots of old `activity_log` partitions.
- **Realtime** — pushes `activity_log` insert events to dashboard clients over WebSocket.
- **Vault (pgsodium)** — manages the encryption key used for OAuth tokens and IMAP passwords.

### Domain

`mcpemails.com` is registered externally and points to Vercel. DNS is managed in the Vercel dashboard (Vercel nameservers or custom DNS with CNAME/A records as documented in section 8).

---

## 2. Environment Separation

MCPEmails uses four distinct environments. Each has its own Supabase project (or branch) and Vercel deployment.

| Environment | Vercel Target | Supabase Target | URL |
|---|---|---|---|
| Local dev | `next dev` (localhost) | Supabase local (`supabase start`) | `http://localhost:3000` |
| Preview | Vercel preview deployment | Supabase preview branch | `https://<hash>.vercel.app` |
| Staging | Vercel preview (protected) | Supabase main project (staging schema) | `https://staging.mcpemails.com` |
| Production | Vercel production deployment | Supabase main project | `https://mcpemails.com` |

### Local Development

Developers run the Supabase stack locally using the Supabase CLI:

```bash
supabase start          # Starts PostgreSQL, Auth, Storage, Edge Functions locally
npm run dev             # Starts Next.js dev server on localhost:3000
```

The local Supabase instance runs on `http://localhost:54321` (API) and `http://localhost:54323` (Studio). Environment variables are loaded from `.env.local` (not committed to git).

Local Edge Functions are served with `supabase functions serve` for development of the MCP server. Functions automatically reload on file change.

### Supabase Preview Branches

When a pull request is opened, a GitHub Actions job creates a **Supabase preview branch** from the main project. The preview branch:

- Is a fully isolated PostgreSQL instance (not a schema; a separate compute container).
- Has all migrations applied automatically from the PR's `supabase/migrations/` directory.
- Is destroyed when the PR is merged or closed.
- Has its own unique API URL and keys injected into the corresponding Vercel preview deployment as environment variables via the Vercel-Supabase integration or the Vercel API.

This means every PR tests schema changes against a real PostgreSQL instance that mirrors production, not a mock or an in-memory store.

### Vercel Preview Deployments

Every push to any branch other than `main` triggers a Vercel preview deployment. The preview:

- Is built with `NODE_ENV=production` (same build pipeline as production).
- Gets the Supabase preview branch URL and keys as environment variables.
- Is accessible at `https://<deployment-hash>.vercel.app`.
- Is not indexed by search engines (Vercel sets `X-Robots-Tag: noindex` on preview deployments).

### Production

Merging to `main` after all CI checks pass triggers an automatic Vercel production deployment. The production deployment:

- Uses the main Supabase project's URL and keys.
- Runs all pending Supabase migrations via `supabase db push` in the CI pipeline before Vercel promotes the build.
- Applies Supabase Edge Function deployments via `supabase functions deploy`.

---

## 3. Environment Variables

The table below lists every environment variable the application requires. "Scope" indicates whether the variable is safe to embed in the client-side JavaScript bundle (`Public`) or must stay server-side only (`Secret`).

| Variable | Scope | Set In | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Vercel env UI (all envs); `.env.local` for local | Supabase project API URL. Exposed to browser for `createBrowserClient`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Vercel env UI (all envs); `.env.local` for local | Supabase anon key. Safe to expose; RLS enforces access. |
| `NEXT_PUBLIC_APP_URL` | Public | Vercel env UI (all envs); `.env.local` for local | Base URL of the app (e.g. `https://mcpemails.com`). Used to construct OAuth redirect URIs and magic link redirect URLs. |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Vercel env UI (server only); `.env.local` for local | Supabase service role key. Bypasses RLS. Used only in Edge Functions and admin scripts. Never exposed to client. |
| `ENCRYPTION_KEY` | Secret | Vercel env UI (server only); `.env.local` for local | 32-byte hex string used as the AES-256-GCM key for encrypting OAuth tokens and IMAP passwords at the application layer. Must match across all instances. |
| `GMAIL_CLIENT_ID` | Secret | Vercel env UI (server only); `.env.local` for local | Google OAuth 2.0 client ID for Gmail integration. |
| `GMAIL_CLIENT_SECRET` | Secret | Vercel env UI (server only); `.env.local` for local | Google OAuth 2.0 client secret for Gmail integration. |
| `OUTLOOK_CLIENT_ID` | Secret | Vercel env UI (server only); `.env.local` for local | Microsoft Identity Platform application (client) ID for Outlook integration. |
| `OUTLOOK_CLIENT_SECRET` | Secret | Vercel env UI (server only); `.env.local` for local | Microsoft Identity Platform client secret for Outlook integration. |
| `FASTMAIL_CLIENT_ID` | Secret | Vercel env UI (server only); `.env.local` for local | Fastmail OAuth 2.0 client ID. |
| `FASTMAIL_CLIENT_SECRET` | Secret | Vercel env UI (server only); `.env.local` for local | Fastmail OAuth 2.0 client secret. |
| `STRIPE_SECRET_KEY` | Secret | Vercel env UI (server only); `.env.local` for local | Stripe API secret key for billing operations. Use `sk_test_*` in dev/preview, `sk_live_*` in production. |
| `STRIPE_WEBHOOK_SECRET` | Secret | Vercel env UI (server only); `.env.local` for local | Stripe webhook signing secret used to verify that webhook payloads originate from Stripe. |

### Rules

1. Variables prefixed `NEXT_PUBLIC_` are bundled into the client-side JavaScript by Next.js. Never put secrets in a `NEXT_PUBLIC_` variable.
2. `SUPABASE_SERVICE_ROLE_KEY` must never appear in any file or log that could reach a browser or be stored in version control.
3. Each Vercel environment (Development, Preview, Production) gets separate values for `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to ensure environment isolation.
4. `STRIPE_SECRET_KEY` uses Stripe's test mode key in Development and Preview environments and the live mode key only in Production.
5. `.env.local` is in `.gitignore`. The repository contains a `.env.example` file listing every variable name with placeholder values and documentation comments — no actual values.

---

## 4. Supabase Migrations

All database schema changes are managed as timestamped SQL migration files in `supabase/migrations/`. No schema change is ever applied by hand in the Supabase Studio UI on any environment except throwaway local experiments.

### Directory Structure

```
supabase/
  migrations/
    20260524000001_create_users.sql
    20260524000002_create_workspaces.sql
    20260524000003_create_workspace_members.sql
    20260524000004_create_inboxes.sql
    20260524000005_create_api_keys.sql
    20260524000006_create_oauth_states.sql
    20260524000007_create_activity_log.sql
    20260524000008_create_auth_logs.sql
    20260524000009_create_rls_policies.sql
    20260524000010_create_indexes.sql
    20260524000011_create_triggers.sql
    ...
  tests/
    rls/
      inboxes.test.sql
      api_keys.test.sql
      activity_log.test.sql
      ...
  config.toml
  seed.sql
```

### Naming Convention

Migration files are named `<timestamp>_<description>.sql` where:

- `<timestamp>` is `YYYYMMDDHHMMSS` (UTC). The Supabase CLI generates this automatically with `supabase migration new <description>`.
- `<description>` is a lowercase, underscore-separated summary of what the migration does (e.g. `add_inbox_status_column`, `create_activity_log_partition_july`).

All migration files must be idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE POLICY IF NOT EXISTS`). Migrations that cannot be idempotent (e.g. `ALTER TABLE ... ADD COLUMN`) must be guarded with `DO $$ BEGIN IF NOT EXISTS (...) THEN ... END IF; END $$;` blocks.

Every migration that creates a new table must include:

1. `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` immediately after `CREATE TABLE`.
2. All RLS policies for that table.
3. The `moddatetime` trigger for `updated_at` if the table has that column.

### Applying Migrations

**Local**: `supabase db reset` applies all migrations from scratch (drops and recreates the local database). `supabase db push` applies only pending migrations without resetting.

**Preview**: The CI pipeline runs `supabase db push --db-url $PREVIEW_DATABASE_URL` against the preview branch.

**Production**: The CI pipeline runs `supabase db push --db-url $PRODUCTION_DATABASE_URL` before Vercel promotes the new build to production. The database migration always runs before the application deployment to avoid serving code that depends on schema that does not yet exist.

### Down Migrations

Every migration that alters existing structures must have a corresponding down migration documented as a comment at the top of the file:

```sql
-- Down migration:
-- ALTER TABLE inboxes DROP COLUMN IF EXISTS status;

-- Up migration:
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
```

Down migrations are not applied automatically; they are applied manually by a developer in an emergency rollback scenario (see section 10).

---

## 5. Vercel Configuration

The `vercel.json` at the repository root (alongside the `apps/` directory) configures the deployment. Because this is a monorepo, the Vercel project root is set to `apps/web/` in the Vercel project settings.

### vercel.json

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build -w apps/web",
  "outputDirectory": "apps/web/.next",
  "installCommand": "npm install",
  "framework": "nextjs",
  "functions": {
    "apps/web/app/api/stripe/webhook/route.ts": {
      "maxDuration": 30
    },
    "apps/web/app/api/oauth/callback/route.ts": {
      "maxDuration": 15
    }
  },
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=63072000; includeSubDomains; preload"
        },
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        }
      ]
    },
    {
      "source": "/_next/static/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ],
  "rewrites": [],
  "redirects": [
    {
      "source": "/home",
      "destination": "/",
      "permanent": true
    }
  ]
}
```

### Runtime Decisions

| Route | Runtime | Reason |
|---|---|---|
| `middleware.ts` | Edge Runtime | Session refresh must run at the edge on every request for minimum latency. `@supabase/ssr` is compatible with the Edge Runtime. |
| `app/api/oauth/callback/route.ts` | Node.js (default) | The `code_verifier` exchange with Google/Microsoft requires outbound HTTPS calls that benefit from Node.js's full TLS stack. |
| `app/api/stripe/webhook/route.ts` | Node.js (default) | Stripe's webhook signature verification library (`stripe` npm package) is Node.js only. |
| `app/api/mcp/route.ts` | Node.js (default) | Handles streaming JSON-RPC; benefits from Node.js streams. The main MCP server lives in Supabase Edge Functions; this route is a thin proxy/health check only. |
| All other Route Handlers | Node.js (default) | Safe default; avoids Edge Runtime restrictions on npm packages. |
| All Server Components | Serverless Node.js | Rendered at request time on Vercel's serverless infrastructure. |

The `mcp-server` Edge Function runs on Supabase's Deno runtime, not on Vercel. AI agent connections go directly to the Supabase Edge Function URL.

---

## 6. CI/CD Pipeline

The CI/CD pipeline uses GitHub Actions. There are three distinct workflow files.

### Workflow: `ci.yml` — Runs on every pull request

```yaml
name: CI

on:
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
  SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}

jobs:
  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm run type-check -w apps/web

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm run lint -w apps/web

  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm test -w apps/web -- --coverage --reporter=verbose

  migration-check:
    name: Migration Dry-Run
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Start local Supabase
        run: supabase start --ignore-health-check
      - name: Apply migrations (dry-run against local)
        run: supabase db reset
      - name: Run RLS tests
        run: supabase test db
      - name: Verify all tables have RLS enabled
        run: |
          supabase db query "
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
            AND tablename NOT IN (
              SELECT tablename FROM pg_tables t
              JOIN pg_class c ON c.relname = t.tablename
              WHERE c.relrowsecurity = true AND t.schemaname = 'public'
            )
          " | grep -c "0 rows" || (echo "ERROR: Some tables are missing RLS" && exit 1)

  build:
    name: Build Check
    runs-on: ubuntu-latest
    env:
      NEXT_PUBLIC_SUPABASE_URL: https://placeholder.supabase.co
      NEXT_PUBLIC_SUPABASE_ANON_KEY: placeholder-anon-key
      NEXT_PUBLIC_APP_URL: https://mcpemails.com
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm run build -w apps/web

  create-preview-branch:
    name: Create Supabase Preview Branch
    runs-on: ubuntu-latest
    needs: [migration-check]
    outputs:
      db_url: ${{ steps.branch.outputs.db_url }}
      anon_key: ${{ steps.branch.outputs.anon_key }}
      api_url: ${{ steps.branch.outputs.api_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Create preview branch
        id: branch
        run: |
          BRANCH_NAME="pr-${{ github.event.pull_request.number }}"
          supabase branches create "$BRANCH_NAME" --project-ref $SUPABASE_PROJECT_ID
          # Retrieve connection details and set outputs
          DB_URL=$(supabase branches get "$BRANCH_NAME" --project-ref $SUPABASE_PROJECT_ID --json | jq -r '.db_url')
          echo "db_url=$DB_URL" >> "$GITHUB_OUTPUT"
```

### Workflow: `deploy-preview.yml` — Runs on push to any non-main branch

Vercel handles preview deployments automatically via its GitHub integration — no additional workflow is needed for the Vercel side. The `create-preview-branch` job in `ci.yml` creates the Supabase branch, and the Vercel-Supabase integration (configured in the Vercel project dashboard) injects the preview branch environment variables into the Vercel preview deployment automatically.

### Workflow: `deploy-production.yml` — Runs on push to main (after merge)

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

env:
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
  SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  migrate:
    name: Apply Database Migrations
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Apply pending migrations to production
        run: |
          supabase db push \
            --project-ref $SUPABASE_PROJECT_ID \
            --password $SUPABASE_DB_PASSWORD

  deploy-edge-functions:
    name: Deploy Supabase Edge Functions
    runs-on: ubuntu-latest
    needs: [migrate]
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Deploy mcp-server Edge Function
        run: |
          supabase functions deploy mcp-server \
            --project-ref $SUPABASE_PROJECT_ID \
            --no-verify-jwt
      - name: Deploy token-refresh Edge Function
        run: |
          supabase functions deploy token-refresh \
            --project-ref $SUPABASE_PROJECT_ID
      - name: Deploy partition-manager Edge Function
        run: |
          supabase functions deploy partition-manager \
            --project-ref $SUPABASE_PROJECT_ID

  deploy-vercel:
    name: Deploy to Vercel Production
    runs-on: ubuntu-latest
    needs: [migrate, deploy-edge-functions]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install -g vercel@latest
      - name: Pull Vercel environment variables
        run: vercel pull --yes --environment=production --token=$VERCEL_TOKEN
      - name: Build for production
        run: vercel build --prod --token=$VERCEL_TOKEN
      - name: Deploy to production
        id: deploy
        run: |
          URL=$(vercel deploy --prebuilt --prod --token=$VERCEL_TOKEN)
          echo "url=$URL" >> "$GITHUB_OUTPUT"
      - name: Record deployment
        run: echo "Deployed to ${{ steps.deploy.outputs.url }}"
```

### Dependency Order

The production deployment enforces a strict ordering:

1. Migrations run first (`migrate` job).
2. Edge Functions are deployed second (`deploy-edge-functions` depends on `migrate`).
3. The Next.js application is deployed last (`deploy-vercel` depends on both).

This ordering guarantees that when the new application code starts serving traffic, the database schema it requires already exists and the Edge Functions it relies on are updated.

---

## 7. Supabase Edge Functions Deployment

### Function Inventory

| Function | Trigger | JWT Verification | Purpose |
|---|---|---|---|
| `mcp-server` | HTTP request | Custom (API key bearer token) | Serves the MCP JSON-RPC 2.0 interface to AI agents. |
| `token-refresh` | Supabase Cron (every 5 min) | None (internal) | Finds OAuth tokens expiring within 10 minutes and refreshes them. |
| `partition-manager` | Supabase Cron (monthly) | None (internal) | Creates the next month's `activity_log` partition before month-end. |

### Directory Structure

```
supabase/
  functions/
    mcp-server/
      index.ts
      _shared/
        auth.ts        # API key validation
        db.ts          # Supabase service-role client
        tools/
          list-inbox.ts
          read-email.ts
          send-email.ts
          reply-to-email.ts
          search-emails.ts
    token-refresh/
      index.ts
    partition-manager/
      index.ts
```

### Local Development

```bash
# Serve all functions locally with hot reload
supabase functions serve

# Serve a specific function and watch for changes
supabase functions serve mcp-server --env-file .env.local

# Test with curl
curl -i --location --request POST 'http://localhost:54321/functions/v1/mcp-server' \
  --header 'Authorization: Bearer mcpe_<your-api-key>' \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_inbox","arguments":{}}}'
```

### Deployment

Edge Functions are deployed independently of the Next.js application. In the CI pipeline, all three functions are deployed in the `deploy-edge-functions` job. A single function can be redeployed hotfix-style without a full application deployment:

```bash
supabase functions deploy mcp-server --project-ref <project-ref>
```

The `mcp-server` function uses `--no-verify-jwt` because it authenticates via its own API key mechanism (bcrypt hash comparison against `api_keys.key_hash`), not via Supabase Auth JWTs. All other functions use standard JWT verification or are invoked by internal Supabase cron mechanisms.

### Environment Variables for Edge Functions

Edge Functions access secrets via Supabase's secrets store (not Vercel environment variables):

```bash
# Set secrets for Edge Functions (run once; stored in Supabase Vault)
supabase secrets set ENCRYPTION_KEY=<hex-string> --project-ref <project-ref>
supabase secrets set GMAIL_CLIENT_ID=<value> --project-ref <project-ref>
supabase secrets set GMAIL_CLIENT_SECRET=<value> --project-ref <project-ref>
supabase secrets set OUTLOOK_CLIENT_ID=<value> --project-ref <project-ref>
supabase secrets set OUTLOOK_CLIENT_SECRET=<value> --project-ref <project-ref>
supabase secrets set FASTMAIL_CLIENT_ID=<value> --project-ref <project-ref>
supabase secrets set FASTMAIL_CLIENT_SECRET=<value> --project-ref <project-ref>
```

The Supabase project URL and service role key are automatically available inside Edge Functions via the built-in `Deno.env.get('SUPABASE_URL')` and `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` — these are injected by the Supabase runtime and do not need to be set manually.

---

## 8. Domain and DNS

### Primary Domain

`mcpemails.com` is pointed to Vercel by setting Vercel as the authoritative nameserver or by adding the DNS records Vercel specifies in the project settings. The recommended approach is using Vercel nameservers for simplicity:

```
NS  mcpemails.com  ns1.vercel-dns.com
NS  mcpemails.com  ns2.vercel-dns.com
```

If the registrar requires A/CNAME records instead:

```
A     mcpemails.com        76.76.21.21
CNAME www.mcpemails.com    cname.vercel-dns.com
```

### Supabase Edge Function Domain

The `mcp-server` Edge Function is accessible at the Supabase-assigned URL:

```
https://<project-ref>.supabase.co/functions/v1/mcp-server
```

AI agents that connect via MCP use this URL directly. There is no Vercel proxy in front of the MCP server; agent traffic goes directly to Supabase to avoid unnecessary latency and Vercel function timeout constraints.

A CNAME alias `api.mcpemails.com` pointing to the Supabase Edge Function domain improves discoverability and allows the MCP endpoint URL to remain stable if the Supabase project ref changes (requires a Supabase custom domain configuration):

```
CNAME api.mcpemails.com  <project-ref>.supabase.co
```

Custom domains on Supabase require the Supabase Pro plan or above and are configured in the Supabase dashboard under "Custom Domains".

### SSL

- **mcpemails.com on Vercel**: TLS is provisioned automatically by Vercel using Let's Encrypt. The certificate covers `mcpemails.com` and `www.mcpemails.com`. HSTS is enforced via the `Strict-Transport-Security` header in `vercel.json` with a two-year `max-age` and `preload` directive.
- **Supabase Edge Functions**: TLS is provided by Supabase's infrastructure. No additional SSL configuration is required.

---

## 9. Secrets Management

### Rule: Never in Code

No secret of any kind ever appears in source code, committed configuration files, or log output. This includes:

- OAuth client secrets
- Stripe keys
- The `ENCRYPTION_KEY`
- Database passwords
- The Supabase service role key

### Where Secrets Live

| Secret | Storage Location | Who Can Access |
|---|---|---|
| Next.js server-side env vars | Vercel environment variables (Production/Preview/Development environments in Vercel dashboard) | Vercel build workers and serverless function runtime |
| Supabase Edge Function secrets | Supabase secrets store (`supabase secrets set`) | Supabase Deno runtime only |
| Local development secrets | `.env.local` (git-ignored) | Local developer machine only |
| CI/CD secrets | GitHub Actions repository secrets | GitHub Actions runners only |

### Adding a New Secret

1. Add the variable name (with a placeholder value) to `.env.example` in the repository with a documentation comment explaining what the value is.
2. Set the actual value in the Vercel dashboard for each environment (Development, Preview, Production) separately.
3. If the secret is also needed in Edge Functions, set it with `supabase secrets set`.
4. If the secret is needed in the CI/CD pipeline, add it to GitHub Actions repository secrets.
5. Update this document with the new variable in the table in section 3.

### Rotating a Secret Without Downtime

Rotating a secret must not cause downtime. The procedure below applies to any secret that is read at runtime (not baked into the build).

**Example: rotating `ENCRYPTION_KEY`**

The `ENCRYPTION_KEY` is the most sensitive rotation because existing ciphertext in the database was encrypted with the old key. A naive key swap would render all existing tokens unreadable.

1. **Generate a new key**: `openssl rand -hex 32`
2. **Add a key version column** (if not already present): the application must support reading with both the old and new key during the transition. In practice this means storing a `key_version` column on `inboxes` and `api_keys` and having the decryption function try the correct version.
3. **Deploy application code** that accepts both old and new key (via `ENCRYPTION_KEY_V1` and `ENCRYPTION_KEY_V2` env vars).
4. **Run a background job** (as a one-off Edge Function invocation) that re-encrypts each row under the new key and updates `key_version`.
5. **After all rows are migrated**, remove the old key from environment variables and deploy.
6. Revoke the old key everywhere (Vercel, Supabase secrets, GitHub secrets).

**Example: rotating an OAuth client secret (Gmail, Outlook, Fastmail)**

1. Generate a new client secret in the provider's developer console (Google Cloud, Azure, Fastmail).
2. Set the new value in Vercel environment variables and Supabase secrets simultaneously.
3. Trigger a new Vercel deployment to pick up the new value (Vercel applies env var changes on next deployment; in-flight functions continue to use the old value until they finish).
4. Revoke the old client secret in the provider console once the deployment is live and no in-flight OAuth flows reference the old secret. Wait at least 5 minutes for in-flight requests to drain.

**Example: rotating `STRIPE_SECRET_KEY`**

1. Create a new restricted key (or roll the standard key) in the Stripe dashboard.
2. Update in Vercel environment variables.
3. Deploy. Stripe accepts both old and new keys simultaneously during the brief window between update and deployment.
4. Revoke the old key in the Stripe dashboard.

---

## 10. Rollback Strategy

### Vercel Instant Rollback

Vercel retains every previous production deployment indefinitely. If a bad deploy reaches production:

1. Go to the Vercel dashboard → Deployments.
2. Find the last known-good deployment.
3. Click "Promote to Production". Vercel instantly routes traffic to the old deployment — no rebuild required, sub-second switch.

This is always the first action. A Vercel rollback does not touch the database.

### Supabase Migration Rollback

If a schema migration introduced a bug, rolling back the database is more complex than rolling back the application code. The procedure depends on severity.

#### Safe schema changes (additive only)

If the migration only added new tables, columns, or indexes (no dropped columns, no altered constraints), the database is backward-compatible with both the old and new application code. Rolling back Vercel to the previous deployment is sufficient — the extra columns are ignored by the old code.

#### Breaking schema changes (altered or dropped columns)

If the migration dropped a column or changed a constraint that the previous application version depends on:

1. **Immediately promote the last-good Vercel deployment** (section above). This stops new traffic from hitting the broken code path.
2. **Apply the down migration manually**:

```bash
# Connect to the production database
supabase db connect --project-ref <project-ref>

# Apply the documented down migration from the migration file header
# Example for reverting a dropped column:
ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS legacy_status text;
```

3. **Verify** that the application is functioning correctly against the reverted schema.
4. **Merge a fix** for the migration into `main` and let the normal CI/CD pipeline deploy it.

#### Data loss during a breaking change

If a migration caused data loss (e.g., a `DROP TABLE` or `DELETE FROM` that was not intended):

1. Stop all writes immediately: scale down active connections or put the app in maintenance mode (add a `/_maintenance` redirect in Vercel).
2. Restore from the most recent Supabase point-in-time recovery snapshot. Supabase Pro and above supports PITR with 1-second granularity.
3. Apply the corrected migrations on top of the restored snapshot.
4. Remove maintenance mode.

Supabase automated backups run daily on the Free plan and every few minutes (PITR) on Pro and above. Production must run on Pro or above. Confirm the retention window in the Supabase dashboard before enabling production traffic.

### Edge Function Rollback

Supabase does not maintain a deployment history for Edge Functions in the same way Vercel does. To roll back an Edge Function:

1. Check out the previous version of the function from git (`git show <previous-commit>:supabase/functions/mcp-server/index.ts > index.ts`).
2. Deploy the previous version: `supabase functions deploy mcp-server --project-ref <project-ref>`.

This takes approximately 10–30 seconds.

### Runbook: Production Incident Response

```
1. Detect (Vercel alerts, Sentry error spike, user report)
2. Assess: application bug or schema bug?
   a. Application bug only → Vercel instant rollback (30 seconds)
   b. Schema bug (additive) → Vercel instant rollback only
   c. Schema bug (breaking) → Vercel rollback + manual down migration
   d. Data loss → maintenance mode → PITR restore → corrected migration → restore
3. Communicate: update status page at status.mcpemails.com
4. Post-mortem: document root cause, add test coverage, update runbook
```

---

## Appendix A: vercel.json (Full)

The `vercel.json` referenced in section 5 is reproduced here in full for copy-paste convenience. Place this file at the repository root (`/vercel.json`).

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build -w apps/web",
  "outputDirectory": "apps/web/.next",
  "installCommand": "npm install",
  "framework": "nextjs",
  "functions": {
    "apps/web/app/api/stripe/webhook/route.ts": {
      "maxDuration": 30
    },
    "apps/web/app/api/oauth/callback/route.ts": {
      "maxDuration": 15
    }
  },
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=63072000; includeSubDomains; preload"
        },
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        }
      ]
    },
    {
      "source": "/_next/static/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ],
  "redirects": [
    {
      "source": "/home",
      "destination": "/",
      "permanent": true
    }
  ]
}
```

---

## Appendix B: CI/CD Workflow (Full)

The complete GitHub Actions workflow for the CI pipeline (`ci.yml`) is reproduced here. Place it at `.github/workflows/ci.yml`.

```yaml
name: CI

on:
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
  SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}

jobs:
  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm run type-check -w apps/web

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm run lint -w apps/web

  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm test -w apps/web -- --coverage --reporter=verbose

  migration-check:
    name: Migration Dry-Run
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Start local Supabase
        run: supabase start --ignore-health-check
      - name: Apply all migrations against local DB
        run: supabase db reset
      - name: Run RLS test suite
        run: supabase test db
      - name: Verify all public tables have RLS enabled
        run: |
          UNPROTECTED=$(supabase db query \
            "SELECT tablename FROM pg_tables t \
             JOIN pg_class c ON c.relname = t.tablename \
             WHERE t.schemaname = 'public' AND c.relrowsecurity = false" \
            --csv | tail -n +2)
          if [ -n "$UNPROTECTED" ]; then
            echo "ERROR: The following tables are missing RLS:"
            echo "$UNPROTECTED"
            exit 1
          fi
          echo "All public tables have RLS enabled."

  build:
    name: Build Check
    runs-on: ubuntu-latest
    env:
      NEXT_PUBLIC_SUPABASE_URL: https://placeholder.supabase.co
      NEXT_PUBLIC_SUPABASE_ANON_KEY: placeholder-anon-key
      NEXT_PUBLIC_APP_URL: https://mcpemails.com
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install
      - run: npm run build -w apps/web
```

The complete production deployment workflow (`deploy-production.yml`) is placed at `.github/workflows/deploy-production.yml`:

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

env:
  SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
  SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}
  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
  VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

jobs:
  migrate:
    name: Apply Database Migrations
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Apply pending migrations to production
        run: |
          supabase db push \
            --project-ref $SUPABASE_PROJECT_ID \
            --password $SUPABASE_DB_PASSWORD

  deploy-edge-functions:
    name: Deploy Supabase Edge Functions
    runs-on: ubuntu-latest
    needs: [migrate]
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      - name: Deploy mcp-server
        run: |
          supabase functions deploy mcp-server \
            --project-ref $SUPABASE_PROJECT_ID \
            --no-verify-jwt
      - name: Deploy token-refresh
        run: |
          supabase functions deploy token-refresh \
            --project-ref $SUPABASE_PROJECT_ID
      - name: Deploy partition-manager
        run: |
          supabase functions deploy partition-manager \
            --project-ref $SUPABASE_PROJECT_ID

  deploy-vercel:
    name: Deploy to Vercel Production
    runs-on: ubuntu-latest
    needs: [migrate, deploy-edge-functions]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install -g vercel@latest
      - name: Pull Vercel environment
        run: vercel pull --yes --environment=production --token=$VERCEL_TOKEN
      - name: Build for production
        run: vercel build --prod --token=$VERCEL_TOKEN
      - name: Deploy to production
        id: deploy
        run: |
          URL=$(vercel deploy --prebuilt --prod --token=$VERCEL_TOKEN)
          echo "Deployed to $URL"
```

---

**Version**: 1.0
**Last Updated**: 2026-05-24
**Next Review**: 2026-08-24
