// The routes the built-output suites request, and what each must answer.
//
// Chosen to cover every provider situation rather than every URL: the home
// page in three locales, one page per marketing namespace that client code
// reads (pricing, docs, blog, compare, forFounders), pages whose copy is
// server-only (privacy, connect, changelog), the app-realm screens that render
// without a session, and a 404 from inside the localized tree and from outside
// it. /dashboard and /approvals need a signed-in session and redirect to
// /login here, so their own HTML is NOT covered by this suite.

export const ROUTES = [
  // --- marketing, URL-localized (app/[locale]) -----------------------------
  { route: '/', status: 200 },
  { route: '/nb', status: 200 },
  { route: '/zh', status: 200 },
  { route: '/pricing', status: 200 },
  { route: '/zh/pricing', status: 200 },
  { route: '/docs', status: 200 },
  { route: '/fr/docs', status: 200 },
  { route: '/docs/providers', status: 200 },
  { route: '/docs/clients', status: 200 },
  { route: '/docs/claude', status: 200 },
  { route: '/blog', status: 200 },
  { route: '/blog/connect-claude-to-email', status: 200 },
  { route: '/es/blog/connect-claude-to-email', status: 200 },
  { route: '/connect', status: 200 },
  { route: '/connect/yahoo', status: 200 },
  { route: '/nb/connect/yahoo', status: 200 },
  { route: '/changelog', status: 200 },
  { route: '/for/founders', status: 200 },
  { route: '/nb/for/founders', status: 200 },
  { route: '/for/business', status: 200 },
  { route: '/native-connectors-vs-mcp', status: 200 },
  { route: '/best-email-mcp-servers', status: 200 },
  { route: '/about', status: 200 },
  { route: '/privacy', status: 200 },
  { route: '/terms', status: 200 },
  { route: '/security', status: 200 },
  { route: '/self-hosting', status: 200 },
  // --- app realm, not URL-localized (AppLocaleProvider) --------------------
  { route: '/signup', status: 200 },
  { route: '/login', status: 200 },
  { route: '/forgot-password', status: 200 },
  { route: '/reset-password', status: 200 },
  // No client_id: the consent screen renders its error card.
  { route: '/authorize', status: 200 },
  { route: '/auth/error', status: 200 },
  { route: '/auth/outlook/admin-consent/result', status: 200 },
  // --- not found ------------------------------------------------------------
  // notFound() thrown by a page inside app/[locale], default and prefixed.
  { route: '/blog/this-post-does-not-exist', status: 404 },
  { route: '/nb/blog/this-post-does-not-exist', status: 404 },
  // No route at all.
  { route: '/this-page-does-not-exist', status: 404 },
  // --- session-gated: only the redirect is observable -----------------------
  { route: '/dashboard', status: 307, location: '/login?redirect=%2Fdashboard' },
];

export function snapshotName(route) {
  return (route === '/' ? 'index' : route.slice(1).replace(/\//g, '__')) + '.txt';
}
