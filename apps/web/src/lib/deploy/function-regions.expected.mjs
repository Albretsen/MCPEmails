// ---------------------------------------------------------------------------
// EXPECTATION DATA for function-regions.test.mjs. Data only, no logic.
//
// One row for every file under app/ that Next.js turns into a server function
// (pages, route handlers, metadata routes). The test walks app/ and fails if a
// file has no row, if a row has no file, or if the region a row names is not
// the region that file actually resolves to. A new route therefore cannot
// silently land in whatever the default happens to be: adding one means adding
// a row, and adding a row means writing down where it should run.
//
// Columns: [source file, region, database round trips, other network calls]
//
//   region   'iad1'  Washington, D.C. (US East)
//            'arn1'  Stockholm, next to the Supabase project (eu-north-1)
//            'edge'  an edge-runtime function. It runs at the edge location
//                    nearest the visitor and takes no region from vercel.json.
//   database round trips, per request, in series. A plain number is a count of
//            Supabase call sites in the handler file; '~' and ranges are
//            measured or traced figures for the hot paths. Each costs about
//            124 ms from iad1 and about 10 ms from arn1.
//   other    third parties the handler itself talks to, which is what can make
//            arn1 the wrong answer.
//
// THE DECISIONS (2026-10-02). The regions are set in apps/web/vercel.json;
// this table is what that file is checked against.
//
// Rule of thumb per request: moving to arn1 saves about 114 ms per database
// round trip, costs about 100 ms per round trip to a US-hosted third party,
// and costs about 100 ms once for a caller who enters at a US edge.
//
//   arn1  Everything that mostly talks to the database: the dashboard (5
//         serial stages, about 570 ms saved), the OAuth handshake (/authorize
//         8, consent 10-11, token exchange 9, refresh 6: 680 to 1,250 ms per
//         step), API keys, approvals, workspaces, onboarding, usage, security,
//         /admin, /invite, the sign-in pages, the Supabase /auth/callback and
//         the routes that only build a provider redirect (/auth/gmail,
//         /auth/outlook, /auth/google, /auth/github, admin-consent/link).
//         Stripe and Resend are US-hosted, and the routes that call them
//         still win: checkout about 7 x 114 - 2 x 100 = +600 ms, the portal
//         +480 ms, the Stripe webhook +500 ms (and its caller is a machine).
//         The chat checkout link (/u/[token]) runs the same checkout core plus
//         the link lookup, and its success page (/upgrade/done) makes two
//         reads for one Stripe call, so both follow checkout to arn1. The
//         expired page touches nothing and stays on the iad1 default.
//
//   iad1  app/api/automations/preview: a proxy to the Supabase edge function,
//         which runs in the Supabase region nearest its caller. From arn1
//         that is Frankfurt, 700 to 1,000 ms further from the US mail hosts
//         per cold IMAP session (it opens an IMAP session there). Pinned so a
//         change of the project default cannot move it. /api/mcp is no longer
//         a function: vercel.json rewrites it to the edge function with
//         forceFunctionRegion=us-east-1, for the same reason.
//
//   iad1  The routes that log in to a mail host from this function:
//         inboxes/imap, inboxes/app-password, inboxes/fastmail-app-password,
//         inboxes/[id]/check, inboxes/[id]/folders and inboxes/[id]/connection. About 12 database round trips would save
//         1,370 ms, but the IMAP + SMTP probes are 10 to 14 round trips to a
//         host that for Gmail, Yahoo, iCloud and Fastmail is in the US, which
//         costs 1,000 to 1,400 ms back: a wash, and a loss for a US caller.
//         Moving them would also make the first login to a mailbox come from
//         Sweden and every later one (the MCP server) from the US. That
//         changes what the mail provider sees, which is more than a speed-up,
//         so they stay.
//
//   iad1  The same rule for OAuth mailboxes: one region per mailbox, as seen by
//         the provider. auth/gmail/callback and auth/outlook/callback redeem
//         the user's code at the Google / Microsoft token endpoint and probe
//         the mailbox (Gmail profile, Graph); inboxes/[id] sends the stored
//         refresh token to Google's revoke endpoint on delete;
//         auth/outlook/admin-consent is the tenant-admin leg of the Outlook
//         connect flow. Every later call for those mailboxes comes from the
//         US (the edge function, and inboxes/[id]/check above), so these stay
//         in iad1 and the provider keeps seeing what it sees today. The cost
//         is the database saving they would have had (8, 11, 8 and 3 round
//         trips).
//
//   iad1  app/[locale] (marketing), robots, sitemap and app/.well-known. None
//         but the home page touches the database (2 round trips, +230 ms),
//         about half of marketing visits enter at a US edge (-100 ms each),
//         and the discovery documents are fetched by MCP clients hosted in
//         the US. Left where they are.
//
// Not in this table because they have no source file a pattern can name: the
// proxy (proxy.ts), which runs before routing at the edge location nearest
// the visitor, and the framework's own _not-found and _global-error
// functions, which stay on the project default.
// ---------------------------------------------------------------------------

/** The Vercel project's Function Region setting. A function no pattern matches runs here. */
export const PROJECT_DEFAULT_REGION = 'iad1';

/**
 * false: no function may be matched by a vercel.json pattern; every one
 *        resolves through the project default.
 * true:  every Node.js function must be matched by a vercel.json pattern, so a
 *        later change to the project default moves nothing.
 */
export const EVERY_FUNCTION_IS_PINNED = true;

/**
 * vercel.json `functions` entries that may carry `maxDuration` next to
 * `regions`. None do: durations are route segment exports (below).
 */
export const PATTERNS_ALLOWED_MAX_DURATION = [];

/** Every `export const maxDuration` under app/, in seconds. */
export const ROUTE_MAX_DURATIONS = {
  'app/api/automations/preview/route.ts': 90,
  'app/api/inboxes/[id]/connection/route.ts': 90, // same detection + relay retry as inboxes/imap, one half
  'app/api/inboxes/app-password/route.ts': 60,
  'app/api/inboxes/fastmail-app-password/route.ts': 60,
  'app/api/inboxes/imap/route.ts': 90, // relay retry after direct detection (relay-fallback.ts)
  'app/api/internal/activation-help/dispatch/route.ts': 60,
  'app/api/internal/billing-lifecycle/dispatch/route.ts': 60,
  'app/api/internal/black-week-email/dispatch/route.ts': 60,
  'app/api/internal/eur-launch/dispatch/route.ts': 60,
  'app/api/internal/first-30-days/dispatch/route.ts': 60,
  'app/api/internal/onboarding-morning-brief/dispatch/route.ts': 60,
  'app/api/internal/paywall-followup/dispatch/route.ts': 60,
  'app/api/internal/pro-price-notice/dispatch/route.ts': 60,
  'app/api/internal/referrals/dispatch/route.ts': 60,
  'app/api/internal/pass-expiry/route.ts': 60,
  'app/api/internal/site-feed/dispatch/route.ts': 60,
  'app/api/onboarding/inbox-proof/route.ts': 30, // one IMAP session, capped at 15 s in the handler
  'app/api/stripe/webhook/route.ts': 30,
  'app/api/webhooks/resend/route.ts': 30,
  'app/auth/callback/route.ts': 15,
  'app/auth/gmail/callback/route.ts': 15,
  'app/auth/outlook/callback/route.ts': 15,
};

export const ROUTES = [
  ['app/(auth)/forgot-password/page.js', 'arn1', '0', '-'],
  ['app/(auth)/login/page.js', 'arn1', '1', '-'],
  ['app/(auth)/reset-password/page.js', 'arn1', '1', '-'],
  ['app/.well-known/glama.json/route.ts', 'iad1', '0', '-'],
  ['app/.well-known/oauth-authorization-server/route.ts', 'iad1', '0', '-'],
  ['app/.well-known/oauth-protected-resource/[...resource]/route.ts', 'iad1', '0', '-'],
  ['app/.well-known/oauth-protected-resource/route.ts', 'iad1', '0', '-'],
  ['app/.well-known/openai-apps-challenge/route.ts', 'iad1', '0', '-'],
  ['app/.well-known/openid-configuration/route.ts', 'iad1', '0', '-'],
  ['app/.well-known/security.txt/route.ts', 'iad1', '0', '-'],
  ['app/[locale]/about/page.js', 'iad1', '0', '-'],
  ['app/[locale]/best-email-mcp-servers/page.js', 'iad1', '0', '-'],
  ['app/[locale]/blog/[slug]/page.js', 'iad1', '0', '-'],
  ['app/[locale]/blog/page.js', 'iad1', '0', '-'],
  ['app/[locale]/changelog/page.js', 'iad1', '0', '-'],
  ['app/[locale]/connect/[provider]/page.js', 'iad1', '0', '-'],
  ['app/[locale]/connect/page.js', 'iad1', '0', '-'],
  ['app/[locale]/developers/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/[client]/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/api/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/clients/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/(catalogue)/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/(catalogue)/providers/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/providers/data/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/read-only-access/page.js', 'iad1', '0', '-'],
  ['app/[locale]/email-mcp-servers-compared/page.js', 'iad1', '0', '-'],
  ['app/[locale]/for/business/page.js', 'iad1', '0', '-'],
  ['app/[locale]/for/founders/page.js', 'iad1', '0', '-'],
  ['app/[locale]/help/page.js', 'iad1', '1-4 (session, ticket context)', '-'],
  ['app/[locale]/native-connectors-vs-mcp/page.js', 'iad1', '0', '-'],
  ['app/[locale]/page.tsx', 'iad1', '2', 'Stripe prices (cached 1h)'],
  ['app/[locale]/pricing/page.js', 'iad1', '0', 'Stripe prices (cached 1h)'],
  ['app/[locale]/privacy/page.js', 'iad1', '0', '-'],
  ['app/[locale]/security/page.js', 'iad1', '0', '-'],
  ['app/[locale]/self-hosting/page.js', 'iad1', '0', '-'],
  ['app/[locale]/status/page.js', 'iad1', '0 (snapshot cached 5 min)', '-'],
  ['app/[locale]/terms/page.js', 'iad1', '0', '-'],
  ['app/[locale]/tools/email-settings-lookup/page.js', 'iad1', '0', '-'],
  ['app/[locale]/cancel/page.js', 'iad1', '0', '-'],
  ['app/[locale]/withdrawal/page.js', 'iad1', '0', '-'],
  ['app/[locale]/billing/feedback/page.js', 'iad1', '0', '-'],
  ['app/admin/growth/dunning/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/growth/first-30-days/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/growth/experiments/[key]/update/route.ts', 'arn1', '2+', '-'],
  ['app/admin/growth/experiments/create/route.ts', 'arn1', '2+', '-'],
  ['app/admin/growth/experiments/override/route.ts', 'arn1', '2+', '-'],
  ['app/admin/growth/experiments/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/growth/kiosk/page.tsx', 'arn1', 'many (growth RPCs, cached)', 'Stripe API (operator revenue, cached)'],
  ['app/admin/growth/page.tsx', 'arn1', 'many (growth RPCs, cached)', 'Stripe API (operator revenue, cached)'],
  ['app/admin/growth/refresh/route.ts', 'arn1', '2+', '-'],
  ['app/admin/growth/usage-cap/exempt/route.ts', 'arn1', '2+', '-'],
  ['app/admin/growth/usage-cap/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/growth/users/[id]/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/growth/users/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/referrals/page.tsx', 'arn1', '2+', '-'],
  ['app/admin/referrals/rewards.csv/route.ts', 'arn1', '2+ (paged)', '-'],
  ['app/api/[[...unmatched]]/route.ts', 'arn1', '0', '-'],
  ['app/api/admin/experiments/[key]/preview/route.ts', 'arn1', '2+', '-'],
  ['app/api/admin/growth/metric/[key]/route.ts', 'arn1', '2+', '-'],
  ['app/api/admin/usage-exemptions/route.ts', 'arn1', '2+', '-'],
  ['app/api/analytics/activation-event/route.ts', 'arn1', '~5', '-'],
  ['app/api/analytics/checkout-feedback/route.ts', 'arn1', '~6', '-'],
  ['app/api/analytics/first-tool-reported/route.ts', 'arn1', '2', '-'],
  ['app/api/analytics/multi-inbox-prompt/route.ts', 'arn1', '1', '-'],
  ['app/api/analytics/paywall-click/route.ts', 'arn1', '1', '-'],
  ['app/api/analytics/paywall/route.ts', 'arn1', '~3', '-'],
  ['app/api/analytics/referral/route.ts', 'arn1', '~3', '-'],
  ['app/api/analytics/pricing-view/route.ts', 'arn1', '1', '-'],
  ['app/api/api-keys/[id]/revoke/route.ts', 'arn1', '3', '-'],
  ['app/api/api-keys/[id]/route.ts', 'arn1', '5', '-'],
  ['app/api/api-keys/route.ts', 'arn1', '8-9', '-'],
  ['app/api/approvals/[id]/decide/route.ts', 'arn1', '3', '-'],
  ['app/api/approvals/[id]/route.ts', 'arn1', '2', '-'],
  ['app/api/approvals/route.ts', 'arn1', '4', '-'],
  ['app/api/billing/feedback/route.ts', 'arn1', '4-5', '-'],
  ['app/api/automations/[id]/route.ts', 'arn1', '5', '-'],
  ['app/api/automations/[id]/runs/route.ts', 'arn1', '6', '-'],
  ['app/api/automations/preview/route.ts', 'iad1', '3', 'Supabase edge function triage-preview (opens the IMAP session)'],
  ['app/api/automations/route.ts', 'arn1', '6', '-'],
  ['app/api/billing/pass-offer/route.ts', 'arn1', '~8', '-'],
  ['app/api/email/unsubscribe/route.ts', 'arn1', '3', '-'],
  // Reads one request header and the EUR switch. From the launch date that
  // switch includes the launch flag, one pricing_switches read cached 60 s
  // (src/lib/stripe/eur-launch.ts); before it, no database at all.
  ['app/api/geo/route.ts', 'arn1', '0-1', '-'],
  ['app/api/inboxes/[id]/check/route.ts', 'iad1', '5', 'IMAP login to the mail host, or Gmail API / Microsoft Graph'],
  ['app/api/inboxes/[id]/connection/route.ts', 'iad1', '4', 'IMAP or SMTP login probe to the mail host when a half is added'],
  ['app/api/inboxes/[id]/folders/route.ts', 'iad1', '5', 'IMAP login + LIST to the mail host'],
  ['app/api/inboxes/[id]/instructions/route.ts', 'arn1', '5', '-'],
  ['app/api/inboxes/[id]/route.ts', 'iad1', '8', 'Google / Microsoft token revoke on delete'],
  ['app/api/inboxes/[id]/send-as/route.ts', 'arn1', '4-8', 'Resend (one verification mail on add / resend)'],
  ['app/api/inboxes/[id]/signature/image/route.ts', 'arn1', '4', '-'],
  ['app/api/inboxes/app-password/route.ts', 'iad1', '~12', 'IMAP + SMTP login probes to the mail host'],
  ['app/api/inboxes/swap-parked/route.ts', 'arn1', '~15', '-'],
  ['app/api/inboxes/autodiscover/route.ts', 'arn1', '2', 'DNS SRV/MX + autoconfig fetch to the mailbox domain'],
  ['app/api/inboxes/fastmail-app-password/route.ts', 'iad1', '~12', 'IMAP + SMTP login probes to the mail host'],
  ['app/api/inboxes/imap/route.ts', 'iad1', '~12', 'IMAP + SMTP login probes to the mail host'],
  ['app/api/internal/activation-help/dispatch/route.ts', 'arn1', '~8', 'Resend per email; auth admin read per send; caller is the scheduler'],
  ['app/api/internal/billing-lifecycle/dispatch/route.ts', 'arn1', '7', 'Stripe API + Resend per queued email; caller is the scheduler'],
  ['app/api/internal/black-week-email/dispatch/route.ts', 'arn1', '5+', 'paged user reads, Stripe API + Resend batches; caller is the scheduler'],
  ['app/api/internal/eur-launch/dispatch/route.ts', 'arn1', '2-4', 'Stripe API (preflight reads; on launch day the catalogue writes and the capped legacy swap); caller is the scheduler'],
  ['app/api/internal/first-30-days/dispatch/route.ts', 'arn1', '2+', 'Resend per email; one IMAP APPEND per stuck-note draft; caller is the scheduler'],
  ['app/api/internal/growth-expire/route.ts', 'arn1', '0', '-'],
  ['app/api/internal/webhook-disabled/route.ts', 'arn1', '3', 'Resend (one email to the owner); caller is the client-api edge function'],
  ['app/api/internal/onboarding-morning-brief/dispatch/route.ts', 'arn1', '2-4', 'Resend per email; caller is the scheduler'],
  ['app/api/internal/paywall-followup/dispatch/route.ts', 'arn1', '2', 'Stripe API + Resend per queued email; caller is the scheduler'],
  ['app/api/internal/pro-price-notice/dispatch/route.ts', 'arn1', '~6', 'Resend per email, one run on one day; caller is the scheduler'],
  ['app/api/internal/referrals/dispatch/route.ts', 'arn1', '~12 per row', 'Stripe API x4-6 + Resend per due referral; caller is the scheduler'],
  ['app/api/internal/pass-expiry/route.ts', 'arn1', '2+', '-'],
  ['app/api/internal/site-feed/dispatch/route.ts', 'arn1', '3-6', 'one Supabase RPC (figure job) + albretsen.no, up to 4 POSTs; caller is the scheduler'],
  ['app/api/kiosk/health/route.ts', 'arn1', '1+', '-'],
  ['app/api/kiosk/version/route.ts', 'arn1', '1+', '-'],
  ['app/api/oauth/authorize/route.ts', 'arn1', '10-11', 'CIMD fetch (client-hosted, memoised)'],
  ['app/api/oauth/register/route.ts', 'arn1', '2', '-'],
  ['app/api/referrals/route.ts', 'arn1', '~8 (POST attach ~10)', 'Stripe API x0-3 (balance; paid-history check on POST)'],
  ['app/api/oauth/revoke/route.ts', 'arn1', '1-2', '-'],
  ['app/api/oauth/token/route.ts', 'arn1', '9 (refresh 6)', 'CIMD fetch (client-hosted, memoised)'],
  ['app/api/oauth/userinfo/route.ts', 'arn1', '2', '-'],
  ['app/api/onboarding/assist/route.ts', 'arn1', '3-5', 'Resend for the two email actions'],
  // "Send this error to support" from the onboarding inbox step: the ticket
  // path of app/api/support/tickets, so the same region.
  ['app/api/onboarding/authorize-event/route.ts', 'arn1', '4 (auth, workspace, dedupe read, insert)', '-'],
  ['app/api/onboarding/connect-help/route.ts', 'arn1', '4-8', 'Resend x2'],
  // Onboarding provider detection: the same lookups as inboxes/autodiscover.
  ['app/api/onboarding/detect/route.ts', 'arn1', '1', 'DNS MX/SRV + autoconfig.thunderbird.net (fixed origin)'],
  // The onboarding proof card logs in to the mail host like inboxes/[id]/check.
  ['app/api/onboarding/inbox-proof/route.ts', 'iad1', '4', 'IMAP login + STATUS/SEARCH/FETCH to the mail host'],
  ['app/api/onboarding/first-week/route.ts', 'arn1', '4-7 (GET; most owners stop at 4)', '-'],
  ['app/api/onboarding/route.ts', 'arn1', '4', '-'],
  ['app/api/onboarding/status/route.ts', 'arn1', '2 (auth, then 5 parallel reads)', '-'],
  ['app/api/seasonal-offer/route.ts', 'arn1', '0', 'Stripe API x0-4 in the Black Week window (cached 60 s), none outside it'],
  ['app/api/security/audit-log/route.ts', 'arn1', '3', '-'],
  ['app/api/security/sessions/route.ts', 'arn1', '9', '-'],
  ['app/api/sso/connection/route.ts', 'arn1', '~6', 'Supabase Management API x1-2 (PUT only)'],
  ['app/api/sso/domains/[id]/route.ts', 'arn1', '~6', '-'],
  ['app/api/sso/domains/[id]/verify/route.ts', 'arn1', '~7', 'DNS TXT lookup'],
  ['app/api/sso/domains/route.ts', 'arn1', '~7', '-'],
  ['app/api/sso/route.ts', 'arn1', '~8', '-'],
  ['app/api/stripe/checkout/route.ts', 'arn1', '~7', 'Stripe API x1-3'],
  ['app/api/stripe/checkout/start/route.ts', 'arn1', '~7', 'Stripe API x1-3'],
  ['app/api/stripe/portal/route.ts', 'arn1', '6', 'Stripe API x1-2'],
  ['app/api/stripe/payment-fix/route.ts', 'arn1', '3', 'Stripe API x2-3'],
  ['app/api/billing/pause/route.ts', 'arn1', '~8', 'Stripe API x1-2'],
  ['app/api/billing/downgrade/route.ts', 'arn1', '~8', 'Stripe API x1-2'],
  ['app/api/stripe/webhook/route.ts', 'arn1', '7+', 'Stripe API, Resend; caller is Stripe (US)'],
  ['app/api/support/preview/route.ts', 'arn1', '1 (session)', '-'],
  ['app/api/support/tickets/route.ts', 'arn1', '4-8', 'Resend x2'],
  ['app/api/legal/contract-request/route.ts', 'arn1', '4-8', 'Resend x2'],
  ['app/api/support/visibility/route.ts', 'arn1', '1 (session)', '-'],
  ['app/api/usage/route.ts', 'arn1', '2', '-'],
  ['app/api/upgrade/status/route.ts', 'arn1', '2', 'Stripe API x1'],
  ['app/api/user/delete-account/route.ts', 'arn1', '11', '-'],
  ['app/api/user/email/route.ts', 'arn1', '3', '-'],
  ['app/api/user/password/route.ts', 'arn1', '5', '-'],
  ['app/api/user/profile/route.ts', 'arn1', '3', '-'],
  ['app/api/webhook-endpoints/[id]/deliveries/route.ts', 'arn1', '4', '-'],
  ['app/api/webhook-endpoints/[id]/route.ts', 'arn1', '5', '-'],
  ['app/api/webhook-endpoints/[id]/test/route.ts', 'arn1', '5', 'POST to the customer\'s webhook URL (test ping)'],
  ['app/api/webhook-endpoints/route.ts', 'arn1', '5-6', '-'],
  ['app/api/webhooks/resend/route.ts', 'arn1', '2-3', 'caller is Resend (US)'],
  ['app/api/workflows/runs/route.ts', 'arn1', '3', '-'],
  ['app/api/workspaces/[id]/leave/route.ts', 'arn1', '1', '-'],
  ['app/api/workspaces/[id]/morning-brief/route.ts', 'arn1', '6', '-'],
  ['app/api/workspaces/[id]/route.ts', 'arn1', '15', '-'],
  ['app/api/workspaces/active/route.ts', 'arn1', '2', '-'],
  ['app/api/workspaces/invite-cancel/[id]/route.ts', 'arn1', '3', '-'],
  ['app/api/workspaces/invite-resend/[id]/route.ts', 'arn1', '5', 'Resend x1'],
  ['app/api/workspaces/invite/[token]/accept/route.ts', 'arn1', '3', '-'],
  ['app/api/workspaces/invite/[token]/route.ts', 'arn1', '6', '-'],
  ['app/api/workspaces/invite/route.ts', 'arn1', '7', 'Resend x1'],
  ['app/api/workspaces/members/[userId]/route.ts', 'arn1', '5', '-'],
  ['app/api/workspaces/route.ts', 'arn1', '3', '-'],
  ['app/approvals/[id]/page.js', 'arn1', '1', '-'],
  ['app/auth/callback/route.ts', 'arn1', '4', '-'],
  ['app/auth/error/page.tsx', 'arn1', '0', '-'],
  ['app/auth/fastmail/app-password/page.tsx', 'arn1', '1', '-'],
  ['app/auth/github/route.ts', 'arn1', '1', '-'],
  ['app/auth/gmail/callback/route.ts', 'iad1', '8', 'Google token endpoint + Gmail API (global)'],
  ['app/auth/gmail/route.ts', 'arn1', '3', '-'],
  ['app/auth/google/route.ts', 'arn1', '1', '-'],
  ['app/auth/microsoft/route.ts', 'arn1', '1', '-'],
  ['app/auth/outlook/admin-consent/link/route.ts', 'arn1', '1', '-'],
  ['app/auth/outlook/admin-consent/result/page.tsx', 'arn1', '0', '-'],
  ['app/auth/outlook/admin-consent/route.ts', 'iad1', '3', 'Microsoft Graph (global)'],
  ['app/auth/outlook/callback/route.ts', 'iad1', '11', 'Microsoft token endpoint + Graph (global)'],
  ['app/auth/outlook/route.ts', 'arn1', '3', '-'],
  ['app/auth/sso/route.ts', 'arn1', '2', '-'],
  ['app/authorize/page.js', 'arn1', '8', 'CIMD fetch (client-hosted, memoised)'],
  ['app/dashboard/[[...section]]/page.js', 'arn1', '5 serial stages', '-'],
  ['app/data/imap-providers.csv/route.ts', 'iad1', '0', '-'],
  ['app/data/imap-providers.json/route.ts', 'iad1', '0', '-'],
  ['app/invite/[token]/page.js', 'arn1', '4', '-'],
  ['app/onboarding/page.tsx', 'arn1', '4 serial (auth, workspace, member, variant); status streams', '-'],
  ['app/onboarding/back-to-chat/page.js', 'arn1', '1 (auth)', '-'],
  ['app/opengraph-image.tsx', 'iad1', '0', 'prerendered at build; static'],
  ['app/r/[code]/route.ts', 'arn1', '2', '-'],
  ['app/robots.ts', 'iad1', '0', '-'],
  ['app/signup/page.js', 'arn1', '0', '-'],
  ['app/sitemap.ts', 'iad1', '0', '-'],
  ['app/u/[token]/route.ts', 'arn1', '~8', 'Stripe API x1-2 (chat checkout link, same trade as checkout)'],
  ['app/upgrade/done/page.js', 'arn1', '2', 'Stripe API x1'],
  ['app/upgrade/expired/page.js', 'iad1', '0', '-'],
];
