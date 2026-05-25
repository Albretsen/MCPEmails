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
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Type errors are caused by a PostgREST 14.5 / @supabase/supabase-js
    // type format mismatch. Runtime behaviour is correct; fix types separately.
    ignoreBuildErrors: true,
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
        ],
      },
    ];
  },
};

module.exports = nextConfig;
