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
  // isomorphic-dompurify pulls in jsdom, whose transitive deps ship as ESM
  // (@csstools/css-calc, etc.). Bundling them for the Node server turns their
  // `import` into a broken `require()` of an .mjs during page-data collection
  // (ERR_REQUIRE_ESM). Marking them external leaves them as runtime Node
  // imports so the sanitizer (used by the signature PATCH route) loads cleanly.
  serverExternalPackages: ['isomorphic-dompurify', 'jsdom'],

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
  // Security headers (local development)
  // ---------------------------------------------------------------------------
  // In production these headers are set by vercel.json. The rules below apply
  // the same policy during local development so the security posture is
  // consistent across all environments.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            // 'unsafe-eval' is required by React in development mode for call-stack
            // reconstruction. It is intentionally absent from the production CSP in vercel.json.
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.supabase.co https://lh3.googleusercontent.com https://avatars.githubusercontent.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com; font-src 'self'; frame-src https://js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self';",
          },
          { key: 'Cross-Origin-Opener-Policy',         value: 'same-origin' },
          { key: 'X-Permitted-Cross-Domain-Policies',  value: 'none' },
        ],
      },
    ];
  },
};

const createNextIntlPlugin = require('next-intl/plugin');
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

module.exports = withNextIntl(nextConfig);
