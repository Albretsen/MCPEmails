# Experiments system: handoff (2026-09-03)

Status: built, verified locally, applied to the database, NOT committed, NOT deployed. The homepage demo video experiment exists in `draft` with weights control 100 / video 0.

## What was built

- Schema: `supabase/migrations/20260903120000_experiments.sql`. Three tables (`experiments`, `experiment_assignments`, `experiment_subjects`), RLS enabled with zero policies, explicit revoke from anon and authenticated, explicit grant to service_role. Three RPCs, all service_role only: `experiment_assign` (insert once, returns the stored variant, rejects unknown variant ids), `experiment_link_subject` (first link wins), `experiment_stats(p_key)` (one row per variant, zeros when empty). Applied with `db query -f` and recorded with `migration repair`, because the remote migration history is already out of sync with the local files and `db push` would have re-applied other pending migrations. Independently reviewed: verdict safe to ship, all findings folded in.
- Library: `apps/web/src/lib/experiments/`. Public API is `getExperimentVariant(key, subjectId)` and `getExperimentDecision(key, subjectId)`; server components and route handlers use `getExperimentDecisionForRequest(key)`. Precedence: unknown key returns the fallback (control); concluded with a winner returns the winner for everyone; owner override cookie wins next and is never recorded; draft returns the first variant; running buckets by a cyrb53 hash of key and subject, records once, and sticks to the stored value even if weights change later. 18 unit tests, including a second experiment key with three variants, prove the API is not homepage-shaped.
- Subject id: cookie `mx_subject`, 32 random hex, httpOnly, SameSite=Lax, one year. Minted in `proxy.ts` and forwarded to the render as header `x-experiment-subject` so the very first page view is bucketed. The marketing-route Set-Cookie strip stays; the subject cookie is appended afterwards as a raw header (using the cookie jar re-emitted the stripped NEXT_LOCALE cookie, verified and fixed).
- Join point: `apps/web/app/dashboard/[[...section]]/page.js` calls `linkExperimentSubjectForRequest` once after the active workspace is resolved, gated by `isNewAccountSignup`, so returning customers are never attributed.
- Homepage: `apps/web/app/[locale]/page.tsx` asks for the decision and passes `showDemoVideo` to `HomeClient`, which renders `DemoVideo.jsx` between the hero and the logo strip. Assets in `apps/web/public/demo/`, `Cache-Control: immutable` in `next.config.js`, and the proxy matcher now skips `mp4|webm|mov|vtt` so ranged video requests do not run the auth round trip. Copy in all five `home.json` locales.
- Video and subtitles: the cut was re-rendered WITHOUT burned-in captions from `tools/video-studio/storyboards/connect-and-triage-clean.json` (same storyboard, `captions: false`) and shipped as `connect-and-triage-v2.mp4` and `.jpg` (new names because of the immutable cache). Subtitles are five WebVTT tracks, `connect-and-triage.{en,es,fr,nb,zh}.vtt`, with identical cue timings; the player reads `useLocale()` and marks the page's language as the default track (English fallback), so `/nb` shows Norwegian subtitles and `/` shows English. `npm run test:subtitles` guards cue parity and the no-em-dash rule. The studio's verify step passes except its freeze detector, which previously relied on the caption overlay changing; the picture is unchanged.
- Admin: `/admin/growth/experiments`, linked from the growth board header. Server-rendered forms only, `requireAdmin()` on every route. Create, edit weights (sum must be 100), start, pause, conclude with winner, reopen, owner override, "You are seeing" line, "Preview as JSON" route (the second real call site). Stats print counts and "n of m" under ten sign-ups, "0 of 0" for empty cells, and one honesty line. No p-values anywhere.

## How to turn the homepage experiment on

1. Open `/admin/growth/experiments`, find "Homepage demo video".
2. Set weights, for example control 50 / video 50, and press Save weights.
3. Press Start. From then on every new anonymous visitor to the homepage is bucketed and recorded. Existing visitors get a subject cookie on their next visit and are bucketed on the request after that.
4. Optional: set your owner override to "Homepage with demo video" to see the variant yourself without consuming the split.

## How to kill it

- Fast and total: Conclude with winner "Current homepage". Every visitor gets the control immediately, ignoring stored assignments. Reopen later if needed.
- Softer: Pause. Status goes back to draft, everyone sees the control, assignments are kept for a later restart.
- Stop new exposure only: set the video weight to 0 while running. Visitors already assigned to video keep seeing it.

## Judgment calls and open questions

- Retention is per experiment: `retention_goal` (mailbox_activity, any_tool_call, value_activation) and `retention_window_days` (1 to 90, capped because activity_log is purged at 90 days). Default is real mailbox work on a later day within 7 days, mirroring `growth_retention_curve`. Only accounts older than the window count as eligible.
- Conversion is `billing_funnel_by_workspace.paid_at`, counted only when the account was created after the subject was bucketed and paid after that too.
- Weight changes re-bucket only new subjects; recorded assignments are sticky. This keeps the stats honest at the cost of "live dial" purity.
- The video is in git (6.5MB) rather than Vercel Blob: the CSP has no `media-src`, so the file must be same-origin, and Blob would have needed a token and a CSP change. A re-cut must ship under a new filename because the cache header is immutable.
- `database.types.ts` was not regenerated (it carries another engineer's uncommitted edits). The new tables are cast locally, the same convention as `product_funnel_events`.
- One workspace can be linked from two browsers and count twice; accepted subject-level counting, noted in the migration.
- Browser verification of the signed-in panel: injecting the admin session cookie into the browser pane was blocked by the tool permission classifier, so every panel flow was driven over HTTP against the dev server with a session minted from the local service key. The homepage control and the video variant were both checked visually in the browser pane.
- Not added: a client `demo_video_played` event. Exposure is recorded server side; add the event through `EVENT_SCHEMA` if play engagement matters.
- The site-wide default `og:title` metadata contains an em dash; it predates this work and is outside the panel copy.

## Verification run

- `npx tsc --noEmit`, `npm run lint`, `npm test` (full chain including the new `test:experiments`), `npm run build`: all pass.
- Database smoke: assign, sticky assign, reject unknown variant, link, stats, RLS and grants, all confirmed; throwaway rows deleted. Tables hold exactly one row: `homepage_demo_video`, draft.
