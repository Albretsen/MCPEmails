# GitHub OAuth Setup Needed

The "Continue with GitHub" button is in the UI on both `/login` and `/signup`. It needs credentials wired up to work.

## Step 1 — Create GitHub OAuth app

1. Go to [GitHub → Settings → Developer Settings → OAuth Apps](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - **Application name**: `MCP Emails`
   - **Homepage URL**: `https://mcpemails.com`
   - **Authorization callback URL**: `https://swvaxorwumispmjaaszb.supabase.co/auth/v1/callback`
4. Click **Register application**
5. On the next screen, note the **Client ID**
6. Click **Generate a new client secret** and save it immediately (only shown once)

## Step 2 — Enable GitHub provider in Supabase

1. Go to [Supabase → Authentication → Providers → GitHub](https://supabase.com/dashboard/project/swvaxorwumispmjaaszb/auth/providers)
2. Toggle **GitHub** on
3. Paste the **Client ID** and **Client Secret** from Step 1
4. Click **Save**

## Step 3 — Verify

Try "Continue with GitHub" on `/login`. It should redirect to GitHub's authorization screen and return to the dashboard after approval.
