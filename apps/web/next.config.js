// @ts-check

// ---------------------------------------------------------------------------
// Build-time environment variable validation
// ---------------------------------------------------------------------------
// These checks run when Next.js starts (dev) or builds (production/CI).
// They catch misconfigured deployments before bad code reaches users.
//
// CI builds supply placeholder values (see .github/workflows/ci.yml), so
// validation is skipped when the CI environment variable is set.
// ---------------------------------------------------------------------------

// Skip validation only for placeholder CI builds (e.g. GitHub Actions), which
// inject all-zero dummy secrets. Vercel ALSO sets CI=1, so we must NOT skip
// there — `!process.env.VERCEL` keeps validation ON for real deployments.
// (A missing/short CSRF_SECRET previously passed the build and only blew up at
// runtime because Vercel's CI=1 short-circuited this whole block.)
const SKIP_VALIDATION = Boolean(process.env.CI) && !process.env.VERCEL;

/** Variables required in every environment. */
const REQUIRED_ALWAYS = [
  // Supabase — public (safe to bundle in client JavaScript)
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  // App base URL — public
  'NEXT_PUBLIC_APP_URL',
  // Supabase service-role key — server-side only, bypasses RLS
  'SUPABASE_SERVICE_ROLE_KEY',
  // AES-256-GCM key for encrypting OAuth tokens at rest — server-side only
  'ENCRYPTION_KEY',
  // HMAC key for CSRF token signing — must be distinct from ENCRYPTION_KEY
  'CSRF_SECRET',
];

/** Secrets that must be exactly 64 hex characters (output of `openssl rand -hex 32`). */
const HEX64_SECRETS = ['ENCRYPTION_KEY', 'CSRF_SECRET'];

if (!SKIP_VALIDATION) {
  const missing = REQUIRED_ALWAYS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      [
        '',
        '══════════════════════════════════════════════════════════════',
        '  MCPEmails — Missing required environment variables',
        '══════════════════════════════════════════════════════════════',
        '',
        '  The following variables must be set before starting:',
        ...missing.map((k) => `    • ${k}`),
        '',
        '  Copy .env.example to .env.local and fill in the values.',
        '  See Documents/Architecture/deployment-architecture.md §3.',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
  }

  // Enforce 64-hex format. The runtime helpers (csrf.ts, crypto) require exactly
  // 64 hex chars and throw otherwise — catch a malformed value at build time so
  // it can never reach a user as a 500.
  const HEX64 = /^[0-9a-f]{64}$/i;
  const malformed = HEX64_SECRETS.filter((key) => !HEX64.test(process.env[key] ?? ''));
  if (malformed.length > 0) {
    throw new Error(
      [
        '',
        '══════════════════════════════════════════════════════════════',
        '  MCPEmails — Malformed secret(s)',
        '══════════════════════════════════════════════════════════════',
        '',
        '  These must be exactly 64 hexadecimal characters:',
        ...malformed.map((k) => `    • ${k}`),
        '',
        '  Generate each with: openssl rand -hex 32',
        '  Check for stray whitespace, quotes, or trailing newlines.',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
  }

  // Reject trivially weak ENCRYPTION_KEY values (all-same byte or sequential bytes).
  // Length is already guaranteed 64 by the check above.
  const encKey = process.env.ENCRYPTION_KEY ?? '';
  const bytes = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(encKey.slice(i, i + 2), 16));
  const allSame      = bytes.every((b) => b === bytes[0]);
  const isAscending  = bytes.every((b, i) => i === 0 || b === (bytes[i - 1] + 1) % 256);
  const isDescending = bytes.every((b, i) => i === 0 || b === (bytes[i - 1] - 1 + 256) % 256);
  if (allSame || isAscending || isDescending) {
    throw new Error(
      [
        '',
        '══════════════════════════════════════════════════════════════',
        '  MCPEmails — Weak ENCRYPTION_KEY detected',
        '══════════════════════════════════════════════════════════════',
        '',
        '  ENCRYPTION_KEY is trivially weak (all-same or sequential bytes).',
        '  Generate a secure key with: openssl rand -hex 32',
        '',
        '══════════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
  }
}

const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ---------------------------------------------------------------------------
  // Turbopack workspace root (Next.js 16)
  // ---------------------------------------------------------------------------
  // Prevents Next.js from auto-detecting the wrong workspace root when there
  // are multiple package-lock.json files on the filesystem above this package.
  turbopack: {
    root: path.resolve(__dirname, '../..'),
  },

  // ---------------------------------------------------------------------------
  // Server-only external packages
  // ---------------------------------------------------------------------------
  // Deliberately empty. isomorphic-dompurify/jsdom used to be listed here, but
  // externalizing makes the server require() them raw at runtime, and jsdom's
  // ESM-only transitive deps (@csstools/css-calc via @asamuzakjp/css-color)
  // then crash with ERR_REQUIRE_ESM on every request. Listing them here does
  // not even help, because Next's BUILT-IN default externals list already
  // contains jsdom, so it stays external either way. The real fix: no server
  // code imports isomorphic-dompurify at all anymore. Route handlers use the
  // dependency-free src/lib/sanitizeSignatureHtmlServer.js; the DOMPurify
  // module (src/lib/sanitizeSignatureHtml.js) is only imported by client
  // components, where it uses the native browser DOM. Do not re-import it in
  // any Node route handler; it cannot load under the Vercel runtime.
  serverExternalPackages: [],

  // ---------------------------------------------------------------------------
  // Image optimisation
  // ---------------------------------------------------------------------------
  // Allow Next.js to optimise images served from Supabase Storage.
  // Supabase project storage domains follow the pattern <ref>.supabase.co.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Security headers
  // ---------------------------------------------------------------------------
  // These are the REAL production headers, not a local-development mirror. The
  // comment here used to say "in production these headers are set by
  // vercel.json"; that is false and was worth checking rather than believing.
  // The Vercel project's Root Directory is apps/web (see .vercel/project.json),
  // and Vercel only reads a vercel.json found inside the Root Directory — the
  // one at the repo root is never loaded. Production proves it: mcpemails.com
  // returns `strict-transport-security: max-age=63072000` (Vercel's default),
  // not the `; includeSubDomains; preload` that the root vercel.json asks for.
  // Everything below is what actually ships.
  //
  // The Content-Security-Policy is deliberately NOT here any more. It carries a
  // per-request nonce now, so it is built and set in proxy.ts (see src/lib/csp.ts).
  // It must not also be emitted from this file: two Content-Security-Policy
  // headers are enforced as an intersection, so a second, static, nonce-less
  // policy would have to allow 'unsafe-inline' to let the framework's inline
  // scripts through — reintroducing exactly the hole this removed, and showing
  // up as `unsafe-inline` in any header scan an assessor runs.
  //
  // proxy.ts's matcher covers every HTML document. It skips /_next/static,
  // /_next/image, favicon.ico and bare image/font files, which therefore no
  // longer carry a CSP. That is an accepted, small loss: those paths serve
  // first-party static assets only (public/ holds SVG, one PNG and llms.txt —
  // no user-supplied content), CSP does not govern the execution of a .js file
  // fetched as a script, and nosniff + X-Frame-Options still apply to them.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            // Two years, matching the HSTS preload-list requirement. This was
            // declared in the repo-root vercel.json, which Vercel never loads
            // (Root Directory is apps/web), so production has been serving
            // Vercel's bare `max-age=63072000` with neither directive. Only www
            // resolves besides the apex and it already redirects to HTTPS, so
            // includeSubDomains is safe.
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          // Content-Security-Policy is set per request in proxy.ts — see the
          // block comment above this headers() function before adding it back.
          { key: 'Cross-Origin-Opener-Policy',         value: 'same-origin' },
          { key: 'X-Permitted-Cross-Domain-Policies',  value: 'none' },
        ],
      },
    ];
  },

  // ---------------------------------------------------------------------------
  // Redirects
  // ---------------------------------------------------------------------------
  // /home is a legacy path that never existed in this app. It 404s today
  // because the redirect declaring it lived in the same dead repo-root
  // vercel.json as the HSTS value above.
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
    ];
  },
};

const createNextIntlPlugin = require('next-intl/plugin');
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

module.exports = withNextIntl(nextConfig);
