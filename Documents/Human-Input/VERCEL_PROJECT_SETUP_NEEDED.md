# Vercel Project Setup Required

## What I need from you

Create a Vercel project for MCPEmails, connect it to your GitHub repository, set the production domain to `mcpemails.com`, and add all required environment variables for Production, Preview, and Development environments.

## Why

The `vercel.json`, CI workflow files, and deploy pipeline have been written to disk. The code side is complete. The Vercel project itself must be created and configured through the Vercel dashboard — this cannot be done by the agent.

## Step-by-step instructions

### 1. Create the Vercel project

1. Go to https://vercel.com and sign in.
2. Click **Add New → Project**.
3. Import the `MCPEmails` GitHub repository.
4. On the "Configure Project" screen:
   - **Framework Preset**: Next.js
   - **Root Directory**: `apps/web`
   - **Build Command**: leave as default (Vercel reads `vercel.json` from the repo root)
   - **Output Directory**: leave as default
5. Click **Deploy** to trigger the first deployment (it will likely fail due to missing env vars — that is expected at this step).

### 2. Set the production domain

1. In the Vercel project dashboard, go to **Settings → Domains**.
2. Add `mcpemails.com`.
3. Vercel will show you DNS records to add. Choose one of:
   - **Option A (recommended)**: Point your domain's nameservers to `ns1.vercel-dns.com` and `ns2.vercel-dns.com` at your domain registrar. Vercel then manages all DNS.
   - **Option B**: Add these records at your registrar:
     - `A  mcpemails.com  76.76.21.21`
     - `CNAME  www.mcpemails.com  cname.vercel-dns.com`
4. Also add `www.mcpemails.com` in the Vercel domains list and set it to redirect to `mcpemails.com` (Vercel provides this option in the domain settings).

### 3. Enable preview deployments

Preview deployments are enabled by default when you connect the GitHub repository. Verify by going to **Settings → Git** and confirming "Preview Deployments" is enabled.

### 4. Add environment variables

In the Vercel project dashboard, go to **Settings → Environment Variables**. Add each variable below. For each one, select which environments it applies to (Production, Preview, Development) as noted.

#### Public variables (safe for all environments, exposed to browser)

| Variable | Environments | Value |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Production | `https://mcpemails.com` |
| `NEXT_PUBLIC_APP_URL` | Preview | _(leave blank — Vercel auto-sets `VERCEL_URL` for previews; see note below)_ |
| `NEXT_PUBLIC_APP_URL` | Development | `http://localhost:3000` |
| `NEXT_PUBLIC_SUPABASE_URL` | Production | Your Supabase production project URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Preview, Development | Your Supabase dev/staging project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production | Your Supabase production anon key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Preview, Development | Your Supabase dev/staging anon key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Production | `pk_live_...` from Stripe live dashboard |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Preview, Development | `pk_test_...` from Stripe test dashboard |

**Note on `NEXT_PUBLIC_APP_URL` for Preview**: Each preview deployment gets a unique URL, so you cannot set a static value. The recommended approach is to set it to an empty string for Preview and handle it in code using `NEXT_PUBLIC_VERCEL_URL` (which Vercel sets automatically). Alternatively, set it to your staging subdomain `https://staging.mcpemails.com` if you use a fixed preview URL.

#### Secret variables (server-side only, never exposed to browser)

| Variable | Environments | Value |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Production | Supabase production service role key |
| `SUPABASE_SERVICE_ROLE_KEY` | Preview, Development | Supabase dev/staging service role key |
| `ENCRYPTION_KEY` | All | 64-char hex string — generate with `openssl rand -hex 32`. Use the **same value** across all environments so tokens encrypted in dev can be decrypted after deploy. |
| `GMAIL_CLIENT_ID` | All | From Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | All | From Google Cloud Console |
| `OUTLOOK_CLIENT_ID` | All | From Azure App Registration |
| `OUTLOOK_CLIENT_SECRET` | All | From Azure App Registration |
| `OUTLOOK_TENANT_ID` | All | `common` (or a specific Azure AD tenant GUID) |
| `FASTMAIL_CLIENT_ID` | All | From Fastmail developer portal |
| `FASTMAIL_CLIENT_SECRET` | All | From Fastmail developer portal |
| `STRIPE_SECRET_KEY` | Production | `sk_live_...` from Stripe live dashboard |
| `STRIPE_SECRET_KEY` | Preview, Development | `sk_test_...` from Stripe test dashboard |
| `STRIPE_WEBHOOK_SECRET` | Production | From Stripe → Developers → Webhooks → production endpoint |
| `STRIPE_WEBHOOK_SECRET` | Preview, Development | From Stripe → Developers → Webhooks → test endpoint |
| `STRIPE_PRICE_PRO_MONTHLY` | Production | Live mode price ID |
| `STRIPE_PRICE_PRO_MONTHLY` | Preview, Development | Test mode price ID |
| `STRIPE_PRICE_PRO_YEARLY` | Production | Live mode price ID |
| `STRIPE_PRICE_PRO_YEARLY` | Preview, Development | Test mode price ID |
| `STRIPE_PRICE_ENTERPRISE_MONTHLY` | Production | Live mode price ID |
| `STRIPE_PRICE_ENTERPRISE_MONTHLY` | Preview, Development | Test mode price ID |
| `STRIPE_PRICE_ENTERPRISE_YEARLY` | Production | Live mode price ID |
| `STRIPE_PRICE_ENTERPRISE_YEARLY` | Preview, Development | Test mode price ID |

### 5. Add GitHub Actions secrets

For the CI/CD pipeline to work, add these secrets in your GitHub repository under **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | From Supabase dashboard → Account → Access Tokens → Generate new token |
| `SUPABASE_DB_PASSWORD` | Your Supabase database password (set during project creation) |
| `SUPABASE_PROJECT_ID` | Your Supabase project reference ID (e.g. `abcdefghijklmnop`) |
| `VERCEL_TOKEN` | From Vercel dashboard → Settings → Tokens → Create Token |
| `VERCEL_ORG_ID` | From Vercel dashboard → Settings → General → "Vercel ID" |
| `VERCEL_PROJECT_ID` | From your Vercel project → Settings → General → "Project ID" |

### 6. Redeploy

After adding all environment variables, go to **Deployments** in the Vercel dashboard and click **Redeploy** on the most recent deployment. This will pick up all the new env vars and should produce a working production build.

## What happens next

Once this is complete, the next agent run will pick up the following checklist item: setting up the separate Supabase production project.
