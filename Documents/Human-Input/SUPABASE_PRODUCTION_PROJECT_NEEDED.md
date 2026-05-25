# Supabase Production Project Setup Required

## What I need from you

Create a new Supabase project for production (separate from the existing dev project at `swvaxorwumispmjaaszb.supabase.co`), then provide the project reference ID, database password, anon key, and service role key so the agent can apply migrations and verify RLS.

## Why

The last unchecked checklist item is: **"Set up separate Supabase production project, run migrations, and verify RLS in production environment."**

The agent's Supabase MCP tools are scoped to the existing dev project and cannot create a new project. A new production-grade project must be created manually through the Supabase dashboard or Supabase Management API.

## Step-by-step instructions

### 1. Create the production Supabase project

1. Go to https://supabase.com/dashboard and sign in.
2. Click **New project**.
3. Select your organisation.
4. Fill in:
   - **Project name**: `mcpemails-production`
   - **Database password**: generate a strong random password (at least 20 characters) and **save it somewhere safe** — you will need it below
   - **Region**: choose the region closest to your Vercel deployment (e.g. `eu-west-1` for Ireland, `us-east-1` for US East)
   - **Pricing plan**: **Pro** (required for Point-in-Time Recovery and >500 MB storage)
5. Click **Create new project** and wait ~2 minutes for provisioning.

### 2. Collect credentials

Once the project is created, navigate to **Settings → API** and copy:

| Value | Where to find it |
|---|---|
| **Project URL** | `https://<ref>.supabase.co` — shown at the top of the API settings page |
| **Project reference ID** | The `<ref>` portion of the URL (e.g. `abcdefghijklmnop`) |
| **`anon` public key** | Under "Project API keys" → `anon` `public` |
| **`service_role` key** | Under "Project API keys" → `service_role` `secret` (click to reveal) |
| **Database password** | The password you chose in step 1 |

### 3. Enable the `pgsodium` / Vault extension (for token encryption)

1. In the production project dashboard, go to **Database → Extensions**.
2. Search for `pgsodium` and enable it (it may already be enabled by default).
3. Search for `moddatetime` and enable it (required for `updated_at` auto-update triggers).
4. Search for `pg_cron` and enable it (required for `token-refresh` and `partition-manager` cron jobs).

### 4. Update environment variables

#### In Vercel (if already configured per `VERCEL_PROJECT_SETUP_NEEDED.md`):

Go to your Vercel project → **Settings → Environment Variables** and set these for the **Production** environment only:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<production-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Production service role key |

#### In GitHub Actions secrets:

Go to your GitHub repository → **Settings → Secrets and variables → Actions** and update/add:

| Secret | Value |
|---|---|
| `SUPABASE_PROJECT_ID` | Production project reference ID |
| `SUPABASE_DB_PASSWORD` | Production database password |
| `SUPABASE_ACCESS_TOKEN` | Your Supabase personal access token (Account → Access Tokens → Generate new token) — if not already set |

#### In your local `.env.local` (for running migrations):

Add or update:
```
SUPABASE_PROJECT_ID=<production-ref>
SUPABASE_DB_PASSWORD=<production-database-password>
```

### 5. Apply migrations to the production project

Run this from the repository root (requires Supabase CLI installed: `brew install supabase/tap/supabase`):

```bash
supabase login   # authenticate if not already logged in
supabase db push --project-ref <production-ref> --password <production-database-password>
```

This applies all 8 existing migrations in order:
1. `create_initial_schema`
2. `row_level_security_policies`
3. `configure_auth_user_provisioning`
4. `gmail_token_exchange_schema_fixes`
5. `workspaces_soft_delete`
6. `add_get_current_user_sessions_function`
7. `oauth_clients_and_auth_codes`
8. `add_stripe_to_workspaces`

### 6. Verify RLS is active on all tables

In the Supabase production dashboard, go to **SQL Editor** and run the RLS verification query from `supabase/verify_rls_production.sql` (created alongside this file). All rows should show `rls_enabled = true`. If any table shows `false`, RLS was not enabled by the migration — stop and investigate before going live.

### 7. Set Edge Function secrets on the production project

Run these commands (replace placeholders with real values):

```bash
supabase secrets set --project-ref <production-ref> \
  ENCRYPTION_KEY=<same-64-char-hex-as-dev> \
  GMAIL_CLIENT_ID=<value> \
  GMAIL_CLIENT_SECRET=<value> \
  OUTLOOK_CLIENT_ID=<value> \
  OUTLOOK_CLIENT_SECRET=<value> \
  OUTLOOK_TENANT_ID=common \
  FASTMAIL_CLIENT_ID=<value> \
  FASTMAIL_CLIENT_SECRET=<value>
```

> **Important**: Use the **same** `ENCRYPTION_KEY` value that was used for the dev project. If they differ, tokens stored before a user is migrated cannot be decrypted in production.

### 8. Configure Auth settings on the production project

In the Supabase production dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://mcpemails.com`
- **Redirect URLs**: Add the following (one per line):
  - `https://mcpemails.com/auth/callback`
  - `https://mcpemails.com/auth/gmail/callback`
  - `https://mcpemails.com/auth/outlook/callback`
  - `https://mcpemails.com/auth/fastmail/callback`

In **Authentication → Email Templates**, copy the custom templates from the dev project if you have customised them.

### 9. Tell the agent what to do next

Once you have completed steps 1–8, create a file at:

```
Documents/Human-Input/PRODUCTION_SUPABASE_REF.md
```

…with just one line:

```
SUPABASE_PROD_REF=<your-production-project-ref>
```

The next agent run will pick up the checklist item, connect to the production project using the MCP tool (update the MCP server's project ref if needed), run the RLS verification SQL, deploy the Edge Functions, and mark the checklist item done.

## What happens next

Once all the above is done and the production ref file exists, the agent will:
1. Connect to the production Supabase project
2. Verify all 8 migrations are applied
3. Run the RLS verification query and confirm every public table is protected
4. Deploy the three Edge Functions (`mcp-server`, `token-refresh`, `partition-manager`) to production
5. Mark the checklist item as complete
