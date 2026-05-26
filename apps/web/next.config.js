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

const IS_CI = Boolean(process.env.CI);

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

if (!IS_CI) {
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

  // Reject trivially weak ENCRYPTION_KEY values (all-same byte or sequential bytes).
  // A length-64 hex string that looks random passes silently; anything degenerate fails fast.
  const encKey = process.env.ENCRYPTION_KEY ?? '';
  if (encKey.length === 64) {
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

module.exports = nextConfig;
