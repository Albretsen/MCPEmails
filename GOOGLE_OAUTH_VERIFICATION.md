# Google OAuth Verification — mcpemails (full walkthrough)

A click-by-click guide to get rid of the "Google hasn't verified this app" warning.
Written so you can follow it with zero prior Google Cloud experience.

> **What you're doing, in one sentence:** Your app already works with Gmail using an OAuth
> client that lives in an existing Google Cloud project. You're going to find that project,
> fill in its public-facing details (name, logo, privacy policy), then submit it to Google's
> review team so the scary warning goes away for everyone.

> **Time expectation:** Setup below is ~1 hour. Google's review then takes **weeks**, because
> your Gmail scopes are "restricted" and require a paid security assessment (CASA). There is
> no faster path for restricted scopes. Don't worry — you can keep using the app yourself the
> whole time.

---

## YOUR VALUES — keep this open in another tab, you'll paste these in

| Field | Value to paste |
|---|---|
| Sign in to Google as | `bjellanda@gmail.com` |
| **Google Cloud project number** (how you find the right project) | `701989117631` |
| App name | `mcpemails` |
| App home page | `https://mcpemails.com` |
| Privacy policy URL | `https://mcpemails.com/privacy` |
| Terms of service URL | `https://mcpemails.com/terms` |
| Authorized domain | `mcpemails.com` |
| Support email (shown to users) | `privacy@mcpemails.com` |
| Developer contact email | `bjellanda@gmail.com` |
| Logo to upload (already made for you) | `apps/web/public/google-consent-logo.png` |

**The three scopes you'll justify (copy these exactly):**
```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.modify
```

---

# PART 1 — Log in and land in the RIGHT project

You do **not** create a new project. You must edit the *existing* one that holds your Gmail
OAuth client, or verification won't apply to your live app.

1. Open this exact URL in your browser:
   **https://console.cloud.google.com/auth/overview**
2. If asked, sign in as **`bjellanda@gmail.com`**.
3. Look at the **top blue bar**. Just to the right of "Google Cloud" there's a **project
   picker** (it shows the current project name with a small ▼ dropdown). Click it.
4. A dialog opens listing your projects. Each row shows a **name** and an **ID/number**.
   Find the project whose number is **`701989117631`** (that's the number embedded in your
   Gmail client ID). Click it to select it.
   - Can't see the number column? Click any project to open it; the number is shown on the
     project's dashboard. Or use the dialog's search box and type `701989117631`.
5. Confirm the project picker in the top bar now shows that project. **You are now in the
   right place.** Everything below happens inside this project.

> **Sanity check (optional):** In the top search bar type `Clients`, open **Google Auth
> Platform → Clients**, and confirm you see an OAuth client whose ID starts with
> `701989117631-`. That's the client your app uses. If you see it, you're definitely in the
> correct project.

---

# PART 2 — Open the Google Auth Platform

This is the new home for everything OAuth-consent-related (it used to be called the "OAuth
consent screen").

1. With the right project selected, go to: **https://console.cloud.google.com/auth/overview**
2. **If you see a "Google Auth Platform not configured yet" message with a `GET STARTED`
   button** → click **GET STARTED** and do PART 3A below (first-time setup wizard).
3. **If you instead see a left-hand menu with `Overview`, `Branding`, `Audience`, `Clients`,
   `Data Access`, `Verification Center`** → it's already configured. Skip to PART 3B.

---

# PART 3A — First-time setup wizard (only if you clicked GET STARTED)

The wizard has a few short screens. Fill them like this:

**Screen "App Information"**
- App name: `mcpemails`
- User support email: pick `bjellanda@gmail.com` or `privacy@mcpemails.com` from the dropdown
- Click **Next**.

**Screen "Audience"**
- Choose **External** (this means any Google user can use it — required for a public app).
- Click **Next**.

**Screen "Contact Information"**
- Email address: `bjellanda@gmail.com`
- Click **Next**.

**Finish**
- Agree to the policy checkbox, click **Create / Continue**.

Now continue to PART 3B to fill in the rest (logo, links, domain).

---

# PART 3B — Branding (logo, links, domain)

1. Left menu → **Branding**.
2. Fill in / confirm:
   - **App name:** `mcpemails`
   - **User support email:** `privacy@mcpemails.com`
   - **App logo:** click **Browse / Upload** and choose the file
     `apps/web/public/google-consent-logo.png` from this repo. *(It's a 120×120 PNG I already
     generated — Google rejects SVGs, which is all your repo had.)*
   - **App home page:** `https://mcpemails.com`
   - **Application privacy policy link:** `https://mcpemails.com/privacy`
   - **Application terms of service link:** `https://mcpemails.com/terms`
   - **Authorized domains:** click **+ Add domain**, enter `mcpemails.com`
   - **Developer contact information:** `bjellanda@gmail.com`
3. Click **Save**.

> If it refuses the logo: make sure the file is reachable and under 1 MB (yours is 2.5 KB).
> If it refuses the domain: you may need to verify it first (PART 5) — you can come back.

---

# PART 4 — Set the audience to Production (this starts the clock)

1. Left menu → **Audience**.
2. Confirm **User type** is **External**.
3. Find **Publishing status**. If it says **Testing**, click the **Publish app** button and
   confirm. Status should change to **In production**.
   - This is the switch that makes verification possible. Until you're verified, external
     users still see the warning — that's expected — but now you're allowed to submit.

---

# PART 5 — Verify you own mcpemails.com (Google Search Console)

Google won't verify an app for a domain you haven't proven you control.

1. Open a new tab: **https://search.google.com/search-console** — sign in as
   `bjellanda@gmail.com` (same account, important).
2. Click **Add property** → choose the **Domain** box (left side) → enter `mcpemails.com` →
   **Continue**.
3. Google shows a **TXT record** (a long `google-site-verification=...` string).
4. Log in to wherever **mcpemails.com's DNS** is managed (your domain registrar or host) and
   add a **TXT record** at the root (`@`) with that value. Save.
5. Wait a few minutes (DNS can take longer), then back in Search Console click **Verify**.
6. Once verified here, the **Authorized domain** `mcpemails.com` in PART 3B will be accepted.

> Stuck on DNS? Tell me who hosts mcpemails.com's DNS (e.g. Cloudflare, Namecheap, Vercel)
> and I'll give you the exact record-adding steps for that provider.

---

# PART 6 — Add / confirm the scopes

1. Left menu → **Data Access**.
2. Click **Add or remove scopes**.
3. In the **"Manually add scopes"** box, paste these (one per line) and click **Add to table**:
   ```
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/gmail.modify
   ```
4. They should appear in the **"Your restricted scopes"** section. Click **Update**, then
   **Save**.

---

# PART 7 — Submit for verification (Verification Center)

1. Left menu → **Verification Center** (or a **Prepare for verification** button on Overview).
2. Click **Prepare for verification**. Review the summary (name, logo, links, scopes). Fix
   anything flagged, then **Save and continue**.
3. **Scope justification** — for each restricted scope, paste a reason. Use these:
   - **gmail.readonly:** "Users connect their Gmail so their AI agent can read mail on their
     behalf. We list messages and fetch message bodies so the agent (via our MCP server) can
     search, summarize, and answer questions about the user's email."
   - **gmail.send:** "The user's AI agent composes and sends email on the user's behalf —
     replies and new messages the user asks it to send."
   - **gmail.modify:** "The agent organizes the user's mailbox on their behalf: adding/removing
     labels and moving messages to trash as part of agent-driven email management."
4. **Demo video** — paste an **unlisted YouTube** link (see PART 8 for what to record).
5. Click **Submit for verification**.

You'll get confirmation, and Google emails `bjellanda@gmail.com` with next steps. Brand
verification usually clears in a few business days; the security assessment is the long pole.

---

# PART 8 — The demo video (required for restricted scopes)

Record your screen (QuickTime/Loom) and upload to YouTube as **Unlisted**. It must clearly show:

1. The browser URL bar on **`https://mcpemails.com`**.
2. Clicking **Connect Gmail** and the **Google consent screen** appearing — with your app
   name `mcpemails` and the three Gmail permissions visible.
3. Completing sign-in, then **each scope used in the product**:
   - reading/searching a message (readonly),
   - sending a message (send),
   - adding a label or trashing a message (modify).
4. Keep it 1–3 minutes, no edits that hide the flow. Narration or captions help reviewers.

---

# PART 9 — CASA security assessment (the slow, paid part)

Because all three scopes are **restricted**, after you submit, Google's OAuth review team will
**email you** to begin an annual independent security assessment (CASA).

1. Watch `bjellanda@gmail.com` for the email; it links you to an authorized assessor (via the
   App Defense Alliance).
2. You complete a security questionnaire; for the higher tier they run a scan/pen-test against
   `mcpemails.com`.
3. You pay the assessor's fee (commonly a few hundred to a few thousand USD, **annual**).
4. Pass → the assessor reports to Google → Google finalizes verification → **warning gone for
   everyone, and refresh tokens no longer expire after 7 days.**

---

# Meanwhile — using the app during the (weeks-long) review

You don't have to wait to keep working:

- The warning only blocks *strangers*. For your own accounts, on the warning screen click
  **Advanced → Go to mcpemails (unsafe) → Continue**. That's safe for accounts you control.
- Optionally add specific testers under **Audience → Test users**.

---

# Before you submit — make /privacy pass review

Google reviewers open your live privacy page and reject if it's missing required language.
Confirm `https://mcpemails.com/privacy` clearly says:

- [ ] What Google data you access (Gmail messages + metadata) and why.
- [ ] That your use complies with the **Google API Services User Data Policy**, including its
      **Limited Use** requirements.
- [ ] You don't sell Google user data and don't use it for advertising.
- [ ] How users revoke access and request deletion.

*(Source of the page: `apps/web/app/privacy/page.js`.)* Ask me and I'll audit it against this
list before you hit submit.

---

# If you get stuck

Tell me **which PART and which button/screen**, and what it says. Common ones:
- "I don't see project 701989117631" → you may be signed into the wrong Google account.
- "Domain won't verify" → DNS TXT not propagated, or wrong Google account in Search Console.
- "Logo rejected" → must be PNG/JPG/BMP under 1 MB (use the file in PART 3B).
