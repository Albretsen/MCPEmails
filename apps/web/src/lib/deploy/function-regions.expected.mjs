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
// THIS FILE DESCRIBES TODAY'S PRODUCTION STATE: there is no per-function region
// configuration anywhere, so every Node.js function runs in the Vercel
// project's default region (functionDefaultRegions: ["iad1"]). The commit that
// moves the database-bound functions changes the region column and the
// constants below, and nothing in the test.
// ---------------------------------------------------------------------------

/** The Vercel project's Function Region setting. A function no pattern matches runs here. */
export const PROJECT_DEFAULT_REGION = 'iad1';

/**
 * false: no function may be matched by a vercel.json pattern; every one
 *        resolves through the project default (today's state).
 * true:  every Node.js function must be matched by a vercel.json pattern, so a
 *        later change to the project default moves nothing.
 */
export const EVERY_FUNCTION_IS_PINNED = false;

export const ROUTES = [
  ['app/(auth)/forgot-password/page.js', 'iad1', '0', '-'],
  ['app/(auth)/login/page.js', 'iad1', '1', '-'],
  ['app/(auth)/reset-password/page.js', 'iad1', '1', '-'],
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
  ['app/[locale]/docs/[client]/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/clients/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/page.js', 'iad1', '0', '-'],
  ['app/[locale]/docs/providers/page.js', 'iad1', '0', '-'],
  ['app/[locale]/email-mcp-servers-compared/page.js', 'iad1', '0', '-'],
  ['app/[locale]/for/business/page.js', 'iad1', '0', '-'],
  ['app/[locale]/for/founders/page.js', 'iad1', '0', '-'],
  ['app/[locale]/native-connectors-vs-mcp/page.js', 'iad1', '0', '-'],
  ['app/[locale]/page.tsx', 'iad1', '2', 'Stripe prices (cached 1h)'],
  ['app/[locale]/pricing/page.js', 'iad1', '0', 'Stripe prices (cached 1h)'],
  ['app/[locale]/privacy/page.js', 'iad1', '0', '-'],
  ['app/[locale]/security/page.js', 'iad1', '0', '-'],
  ['app/[locale]/self-hosting/page.js', 'iad1', '0', '-'],
  ['app/[locale]/status/page.js', 'iad1', '0 (snapshot cached 5 min)', '-'],
  ['app/[locale]/terms/page.js', 'iad1', '0', '-'],
  ['app/admin/growth/dunning/page.tsx', 'iad1', '2+', '-'],
  ['app/admin/growth/experiments/[key]/update/route.ts', 'iad1', '2+', '-'],
  ['app/admin/growth/experiments/create/route.ts', 'iad1', '2+', '-'],
  ['app/admin/growth/experiments/override/route.ts', 'iad1', '2+', '-'],
  ['app/admin/growth/experiments/page.tsx', 'iad1', '2+', '-'],
  ['app/admin/growth/kiosk/page.tsx', 'iad1', 'many (growth RPCs, cached)', 'Stripe API (operator revenue, cached)'],
  ['app/admin/growth/page.tsx', 'iad1', 'many (growth RPCs, cached)', 'Stripe API (operator revenue, cached)'],
  ['app/admin/growth/refresh/route.ts', 'iad1', '2+', '-'],
  ['app/admin/growth/usage-cap/exempt/route.ts', 'iad1', '2+', '-'],
  ['app/admin/growth/usage-cap/page.tsx', 'iad1', '2+', '-'],
  ['app/admin/growth/users/[id]/page.tsx', 'iad1', '2+', '-'],
  ['app/admin/growth/users/page.tsx', 'iad1', '2+', '-'],
  ['app/api/[[...unmatched]]/route.ts', 'iad1', '0', '-'],
  ['app/api/admin/experiments/[key]/preview/route.ts', 'iad1', '2+', '-'],
  ['app/api/admin/growth/metric/[key]/route.ts', 'iad1', '2+', '-'],
  ['app/api/admin/usage-exemptions/route.ts', 'iad1', '2+', '-'],
  ['app/api/analytics/first-tool-reported/route.ts', 'iad1', '2', '-'],
  ['app/api/analytics/multi-inbox-prompt/route.ts', 'iad1', '1', '-'],
  ['app/api/analytics/paywall/route.ts', 'iad1', '1', '-'],
  ['app/api/analytics/pricing-view/route.ts', 'iad1', '1', '-'],
  ['app/api/api-keys/[id]/revoke/route.ts', 'iad1', '3', '-'],
  ['app/api/api-keys/[id]/route.ts', 'iad1', '5', '-'],
  ['app/api/api-keys/route.ts', 'iad1', '8-9', '-'],
  ['app/api/approvals/[id]/decide/route.ts', 'iad1', '3', '-'],
  ['app/api/approvals/route.ts', 'iad1', '4', '-'],
  ['app/api/automations/[id]/route.ts', 'iad1', '5', '-'],
  ['app/api/automations/[id]/runs/route.ts', 'iad1', '6', '-'],
  ['app/api/automations/preview/route.ts', 'iad1', '3', 'Supabase edge function triage-preview (opens the IMAP session)'],
  ['app/api/automations/route.ts', 'iad1', '6', '-'],
  ['app/api/email/unsubscribe/route.ts', 'iad1', '3', '-'],
  ['app/api/inboxes/[id]/check/route.ts', 'iad1', '5', 'IMAP login to the mail host, or Gmail API / Microsoft Graph'],
  ['app/api/inboxes/[id]/route.ts', 'iad1', '8', 'Google / Microsoft token revoke on delete'],
  ['app/api/inboxes/[id]/signature/image/route.ts', 'iad1', '4', '-'],
  ['app/api/inboxes/app-password/route.ts', 'iad1', '~12', 'IMAP + SMTP login probes to the mail host'],
  ['app/api/inboxes/autodiscover/route.ts', 'iad1', '2', 'DNS SRV/MX + autoconfig fetch to the mailbox domain'],
  ['app/api/inboxes/fastmail-app-password/route.ts', 'iad1', '~12', 'IMAP + SMTP login probes to the mail host'],
  ['app/api/inboxes/imap/route.ts', 'iad1', '~12', 'IMAP + SMTP login probes to the mail host'],
  ['app/api/internal/billing-lifecycle/dispatch/route.ts', 'iad1', '7', 'Stripe API + Resend per queued email; caller is the scheduler'],
  ['app/api/internal/paywall-followup/dispatch/route.ts', 'iad1', '2', 'Stripe API + Resend per queued email; caller is the scheduler'],
  ['app/api/kiosk/health/route.ts', 'iad1', '1+', '-'],
  ['app/api/kiosk/version/route.ts', 'iad1', '1+', '-'],
  ['app/api/mcp/route.ts', 'iad1', '0', 'Supabase edge function mcp-server (proxy only)'],
  ['app/api/oauth/authorize/route.ts', 'iad1', '10-11', 'CIMD fetch (client-hosted, memoised)'],
  ['app/api/oauth/register/route.ts', 'iad1', '2', '-'],
  ['app/api/oauth/revoke/route.ts', 'iad1', '1-2', '-'],
  ['app/api/oauth/token/route.ts', 'iad1', '9 (refresh 6)', 'CIMD fetch (client-hosted, memoised)'],
  ['app/api/oauth/userinfo/route.ts', 'iad1', '2', '-'],
  ['app/api/onboarding/route.ts', 'iad1', '4', '-'],
  ['app/api/security/audit-log/route.ts', 'iad1', '3', '-'],
  ['app/api/security/sessions/route.ts', 'iad1', '9', '-'],
  ['app/api/stripe/checkout/route.ts', 'iad1', '~7', 'Stripe API x1-3'],
  ['app/api/stripe/checkout/start/route.ts', 'iad1', '~7', 'Stripe API x1-3'],
  ['app/api/stripe/portal/route.ts', 'iad1', '6', 'Stripe API x1-2'],
  ['app/api/stripe/webhook/route.ts', 'iad1', '7+', 'Stripe API, Resend; caller is Stripe (US)'],
  ['app/api/usage/route.ts', 'iad1', '2', '-'],
  ['app/api/user/delete-account/route.ts', 'iad1', '11', '-'],
  ['app/api/user/email/route.ts', 'iad1', '3', '-'],
  ['app/api/user/password/route.ts', 'iad1', '5', '-'],
  ['app/api/user/profile/route.ts', 'iad1', '3', '-'],
  ['app/api/webhooks/resend/route.ts', 'iad1', '2-3', 'caller is Resend (US)'],
  ['app/api/workflows/runs/route.ts', 'iad1', '3', '-'],
  ['app/api/workspaces/[id]/leave/route.ts', 'iad1', '1', '-'],
  ['app/api/workspaces/[id]/route.ts', 'iad1', '15', '-'],
  ['app/api/workspaces/active/route.ts', 'iad1', '2', '-'],
  ['app/api/workspaces/invite-cancel/[id]/route.ts', 'iad1', '3', '-'],
  ['app/api/workspaces/invite-resend/[id]/route.ts', 'iad1', '5', 'Resend x1'],
  ['app/api/workspaces/invite/[token]/accept/route.ts', 'iad1', '3', '-'],
  ['app/api/workspaces/invite/[token]/route.ts', 'iad1', '6', '-'],
  ['app/api/workspaces/invite/route.ts', 'iad1', '7', 'Resend x1'],
  ['app/api/workspaces/members/[userId]/route.ts', 'iad1', '5', '-'],
  ['app/api/workspaces/route.ts', 'iad1', '3', '-'],
  ['app/approvals/[id]/page.js', 'iad1', '1', '-'],
  ['app/auth/callback/route.ts', 'iad1', '4', '-'],
  ['app/auth/error/page.tsx', 'iad1', '0', '-'],
  ['app/auth/fastmail/app-password/page.tsx', 'iad1', '1', '-'],
  ['app/auth/github/route.ts', 'iad1', '1', '-'],
  ['app/auth/gmail/callback/route.ts', 'iad1', '8', 'Google token endpoint + Gmail API (global)'],
  ['app/auth/gmail/route.ts', 'iad1', '3', '-'],
  ['app/auth/google/route.ts', 'iad1', '1', '-'],
  ['app/auth/outlook/admin-consent/link/route.ts', 'iad1', '1', '-'],
  ['app/auth/outlook/admin-consent/result/page.tsx', 'iad1', '0', '-'],
  ['app/auth/outlook/admin-consent/route.ts', 'iad1', '3', 'Microsoft Graph (global)'],
  ['app/auth/outlook/callback/route.ts', 'iad1', '11', 'Microsoft token endpoint + Graph (global)'],
  ['app/auth/outlook/route.ts', 'iad1', '3', '-'],
  ['app/authorize/page.js', 'iad1', '8', 'CIMD fetch (client-hosted, memoised)'],
  ['app/dashboard/[[...section]]/page.js', 'iad1', '5 serial stages', '-'],
  ['app/invite/[token]/page.js', 'iad1', '4', '-'],
  ['app/opengraph-image.tsx', 'edge', '0', '-'],
  ['app/robots.ts', 'iad1', '0', '-'],
  ['app/signup/page.js', 'iad1', '0', '-'],
  ['app/sitemap.ts', 'iad1', '0', '-'],
];
