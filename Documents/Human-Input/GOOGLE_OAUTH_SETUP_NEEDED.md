# Google OAuth Setup Needed

The "Continue with Google" button is in the UI on both `/login` and `/signup`. It will silently fail until the OAuth credentials are wired up.

## Step 1 — Create Google OAuth app

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Click **Create Credentials** → **OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: `MCP Emails`
5. **Authorized JavaScript origins**: `https://mcpemails.com` (and `http://localhost:3000` for dev)
6. **Authorized redirect URIs**: `https://swvaxorwumispmjaaszb.supabase.co/auth/v1/callback`
7. Click **Create** — save the **Client ID** and **Client Secret**

## Step 2 — Enable Google provider in Supabase

1. Go to [Supabase → Authentication → Providers → Google](https://supabase.com/dashboard/project/swvaxorwumispmjaaszb/auth/providers)
2. Toggle **Google** on
3. Paste the **Client ID** and **Client Secret** from Step 1
4. Click **Save**

## Step 3 — Verify

After saving, try "Continue with Google" on `/login`. It should redirect to Google's consent screen and return to the dashboard after approval.

## What happens for new vs returning users

- **New user via Google**: Supabase creates a record in `auth.users` with the Google email. The `handle_new_user` database trigger fires automatically and provisions their workspace — no extra work needed.
- **Returning user via Google**: Supabase matches by email and signs them into their existing account.
