# Supabase Auth Dashboard Configuration Needed

## Progress
- [x] Step 1 — Enable Email provider (confirmed 2026-05-25)
- [x] Step 2 — Set Site URL (confirmed 2026-05-25)
- [x] Step 3 — Add Redirect URLs (confirmed 2026-05-25)
- [x] Step 4 — Email Templates (uploaded via Management API 2026-05-25, brand name fixed to "MCP Emails")
- [ ] Step 5 — SMTP (optional)

---

## What I need from you

Apply the following configuration in the Supabase dashboard for the MCP Emails project.
These settings cannot be applied via migration or the Supabase CLI — they must be set
through the web UI at https://supabase.com/dashboard/project/swvaxorwumispmjaaszb.

---

## Step 1 — Enable the Email provider

1. Go to **Authentication → Providers**
2. Click **Email** to expand it
3. Confirm **Enable Email provider** is ON
4. Set **Confirm email** to **Enabled** (users must click a confirmation link)
5. Set **Secure email change** to **Enabled**
6. Under **Auth → Settings**, set **OTP Expiry** to `3600` (1 hour)
7. Save changes

> **Note**: MCPEmails uses **magic link / OTP** sign-in, not email + password.
> Password-based sign-in does not need to be enabled.

---

## Step 2 — Set the Site URL

1. Go to **Authentication → URL Configuration**
2. Set **Site URL** to your production domain:
   ```
   https://mcpemails.com
   ```
   (Use `http://localhost:3000` for local development.)
3. Save changes

---

## Step 3 — Add Redirect URLs

In the same **URL Configuration** section, add the following to **Redirect URLs**:

```
http://localhost:3000/auth/callback
https://mcpemails.com/auth/callback
https://*.vercel.app/auth/callback
```

These are the URLs that Supabase Auth will accept as redirect targets after a user
clicks a magic link. The wildcard `*.vercel.app` entry covers Vercel preview deployments.

---

## Step 4 — Configure Email Templates

1. Go to **Authentication → Email Templates**
2. For each template listed below, paste the HTML from the corresponding file in
   `supabase/templates/`:

| Template name        | File to paste                              |
|----------------------|--------------------------------------------|
| Confirm signup       | `supabase/templates/confirm_signup.html`   |
| Magic Link           | `supabase/templates/magic_link.html`       |
| Invite user          | `supabase/templates/invite.html`           |
| Reset password       | `supabase/templates/reset_password.html`   |

For each template:
- Open the file from the `supabase/templates/` folder
- Copy the full HTML content
- Paste it into the **Message (HTML)** field in the Supabase template editor
- Set the **Subject** as shown below:

| Template          | Subject line                          |
|-------------------|---------------------------------------|
| Confirm signup    | `Confirm your MCPEmails account`      |
| Magic Link        | `Your MCPEmails sign-in link`         |
| Invite user       | `You've been invited to MCPEmails`    |
| Reset password    | `Reset your MCPEmails password`       |

- Click **Save** after each template

---

## Step 5 — Configure SMTP (optional but recommended for production)

By default Supabase sends auth emails from `noreply@mail.supabase.io`. For production
you should configure a custom SMTP server so emails come from `hello@mcpemails.com`.

1. Go to **Project Settings → Auth → SMTP Settings**
2. Enable **Custom SMTP**
3. Fill in your SMTP provider credentials (Postmark, Resend, SendGrid, etc.)
4. Set **Sender name** to `MCPEmails` and **Sender email** to `hello@mcpemails.com`
5. Send a test email to verify delivery

---

## What happens next

Once these settings are applied, the next agent run can build the `/login` page (task 4)
which calls `supabase.auth.signInWithOtp()` to send magic links to users.
