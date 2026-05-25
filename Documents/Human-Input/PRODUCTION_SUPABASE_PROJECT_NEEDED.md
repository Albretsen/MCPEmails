# Production Supabase Project Setup Required

## What I need from you

Create a **new Supabase project** to serve as the production environment, then give the
agent its credentials so it can run migrations and verify RLS against the real
production database.

---

## Why

The development Supabase project (`swvaxorwumispmjaaszb.supabase.co`) must not serve
production traffic — it contains test data and does not have production-grade PITR
backups or performance settings. A separate production project is required.

The agent has already completed everything it can do autonomously:

- Written a full pgTAP RLS test suite (`supabase/tests/rls/`) with 42 assertions
  covering tenant isolation, soft-delete enforcement, and write isolation
- Updated `ci.yml` to run `supabase test db` on every pull request
- Updated `deploy-production.yml` to verify RLS immediately after every production
  migration

The one remaining step — creating the Supabase project itself — requires a logged-in
human with billing access to the Supabase dashboard.

---

## How to create the production project (step by step)

1. Go to [https://supabase.com/dashboard](https://supabase.com/dashboard) and sign in.

2. Click **New project**.

3. Fill in:
   - **Name**: `mcpemails-production` (or similar)
   - **Database password**: generate a strong random password and **save it** — you will
     need it below
   - **Region**: choose the region closest to your users (e.g. `eu-west-1` for Europe)
   - **Plan**: **Pro** (required for point-in-time recovery and custom domains)

4. Click **Create new project** and wait ~2 minutes for provisioning.

5. Once the project is ready, go to **Project settings → API** and copy:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **Project Reference ID** (the `xxxxxxxxxxxx` part)
   - **anon / public** key
   - **service_role** key (keep this secret)

---

## Where to put the credentials

### `.env.local` (local development — never committed)

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
```

### Vercel — Production environment variables

In the Vercel dashboard for the `mcpemails` project, go to **Settings → Environment
Variables** and add these for the **Production** environment only:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxxxxxxxxxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `<anon key>` |
| `SUPABASE_SERVICE_ROLE_KEY` | `<service_role key>` |

### GitHub Actions secrets

In the GitHub repository, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Your personal Supabase access token (from [https://supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)) |
| `SUPABASE_PROJECT_ID` | The project reference ID (`xxxxxxxxxxxx`) |
| `SUPABASE_DB_PASSWORD` | The database password you set in step 3 above |

### Supabase Edge Function secrets

After running migrations (see below), set these in the production project so the
Edge Functions can access email provider credentials:

```bash
supabase secrets set ENCRYPTION_KEY=<your-32-byte-hex-key> --project-ref xxxxxxxxxxxx
supabase secrets set GMAIL_CLIENT_ID=<value>               --project-ref xxxxxxxxxxxx
supabase secrets set GMAIL_CLIENT_SECRET=<value>           --project-ref xxxxxxxxxxxx
supabase secrets set OUTLOOK_CLIENT_ID=<value>             --project-ref xxxxxxxxxxxx
supabase secrets set OUTLOOK_CLIENT_SECRET=<value>         --project-ref xxxxxxxxxxxx
supabase secrets set FASTMAIL_CLIENT_ID=<value>            --project-ref xxxxxxxxxxxx
supabase secrets set FASTMAIL_CLIENT_SECRET=<value>        --project-ref xxxxxxxxxxxx
```

---

## Running migrations against the production project

Once you have the project ref and DB password, run this once from the repo root:

```bash
supabase db push \
  --project-ref xxxxxxxxxxxx \
  --password <db-password>
```

This applies all 8 migrations in `supabase/migrations/` in order.

After migrations complete, verify RLS in production:

```bash
supabase db query \
  --project-ref xxxxxxxxxxxx \
  --password <db-password> \
  "SELECT c.relname, c.relrowsecurity
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY c.relname"
```

Every row in the output should show `relrowsecurity = true`. If any show `false`,
something went wrong — do not route production traffic until this is resolved.

---

## What happens next

After the credentials are in place in GitHub Actions secrets and Vercel, the next merge
to `main` will:

1. Automatically run pending migrations against the production project
2. Automatically verify RLS is enabled on all tables
3. Deploy Edge Functions to the production project
4. Deploy the Next.js app to Vercel pointing at the production Supabase project

The final checklist item (`Set up separate Supabase production project`) can then be
marked complete.
