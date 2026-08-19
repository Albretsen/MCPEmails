# Demo video tooling

Everything needed to record the home page demo, except the recording itself.

The marketing site currently offers a sceptic no verifiable proof of anything.
The two sections that look like proof are hand-drawn HTML containing invented
metrics on `app.mcpemails.com`, a domain that does not resolve. This replaces
the main one with a recording of the product actually working.

The shot-by-shot script, the recording checklist and the tone guidance live in
the shooting script artifact. This README covers only the two scripts.

## 1. Seed a throwaway mailbox

Never film a personal inbox. Create a throwaway account on a real IMAP provider
(Fastmail, Migadu, Zoho), generate an app password, then:

```bash
DEMO_IMAP_HOST=imap.fastmail.com \
DEMO_IMAP_USER=demo@yourdomain.tld \
DEMO_IMAP_PASS='app-specific-password' \
node scripts/demo/demo-mailbox.js seed
```

Fourteen fixture messages: three that plainly need a human, a cluster of noise
that plainly does not, and two deliberately in between, because a triage demo
where every call is obvious proves nothing.

Every address is on a `.example` domain. `.example` is reserved by RFC 2606 and
can never be registered, so no frame can point at a real person, and nobody can
later buy the domain to make it look like we did.

`list` prints the current contents. `purge` empties INBOX to reset between
takes.

## 2. Rehearse every call before filming

```bash
MCP_API_KEY=mcpe_live_... node scripts/demo/verify-demo-calls.js
MCP_API_KEY=mcpe_live_... node scripts/demo/verify-demo-calls.js --write
```

This exists because a production audit on 2026-08-19 found most of the tool
surface has no evidence of ever having worked. Fourteen days of the activity
log:

| Tool | Success | Error |
| --- | ---: | ---: |
| `inbox_list` | 10,442 | 18 |
| `email_read` | 671 | 166 |
| `contact_search` | 67 | 2 |
| `email_delete` | 8 | 8 |
| `email_compose` | 0 | 29 |
| `folder` | 0 | 1 |
| `email_organize` | 0 | 0 |
| `draft` | 0 | 0 |
| `schedule` | 0 | 0 |

A zero in both columns means nobody ever tried it, which reads identically to
"working" in a dashboard and very differently on camera.

Two failures are known and reproduced by the harness on purpose, so you can see
whether they are still live before you plan a beat around them:

- **Date-filtered search rejects its own documented example.** The schema wants
  a `Z` or `±HH:MM` suffix; the tool description's example is `"2026-06-01"`.
  This is the largest validation failure class in production.
- **`email_compose` has never succeeded.** A `reply` carrying a `subject` or
  `to` is a hard schema rejection, and that is the shape a model naturally
  produces.

Run with `--write` only against the throwaway mailbox.

## 3. Drop the files in

```
apps/web/public/demo/demo.mp4          H.264/AAC, 1920x1080
apps/web/public/demo/poster.jpg        first meaningful frame, 1920x1080
apps/web/public/demo/captions-en.vtt   WebVTT for the full cut
```

Then flip `DEMO_VIDEO_AVAILABLE` to `true` in
`apps/web/components/marketing/DemoVideo.jsx` and deploy. Until that flag flips
the home page keeps the old section, so all of this is safe to merge and deploy
ahead of the recording.

Serving notes, already handled:

- The production CSP sets no `media-src`, so it falls back to
  `default-src 'self'`. The video must be same-origin; no third-party host will
  load.
- `proxy.ts` now excludes `mp4|webm|mov|m4v|ogg|vtt` from its matcher. Without
  that, every ranged request would run `updateSession()` and a Supabase auth
  round-trip, then answer with cookies the CDN refuses to cache.
- `vercel.json` gives `/demo/*` a one-year immutable cache header. Re-cuts must
  therefore ship under a new filename.
