/**
 * Which deployment this is: production (mcpemails.com) or staging
 * (staging.mcpemails.com, a separate Supabase project and Vercel project).
 *
 * APP_ENV is read at call time. Anything other than an explicit non-production
 * value means production, so a deploy with the variable unset behaves exactly
 * as production always has. Only `staging` turns on the staging gates:
 * robots `Disallow: /`, `X-Robots-Tag: noindex`, the STAGING ribbon, Vercel
 * Analytics off, and sign-in limited to EMAIL_RECIPIENT_ALLOWLIST.
 *
 * Client components cannot read APP_ENV; they read NEXT_PUBLIC_APP_ENV, which
 * the staging project sets to the same value (see .env.staging.example).
 *
 * EMAIL_RECIPIENT_ALLOWLIST is a comma- or whitespace-separated list of exact
 * addresses (`a@example.com`) and whole domains (`@example.com`). It does two
 * jobs outside production: the Resend factory (src/lib/email/resend.ts) drops
 * every other recipient, and staging admits only these addresses to sign in.
 */

export type AppEnv = 'production' | 'staging' | 'development';

export function appEnv(env: Record<string, string | undefined> = process.env): AppEnv {
  const raw = (env.APP_ENV ?? env.NEXT_PUBLIC_APP_ENV ?? '').trim().toLowerCase();
  if (raw === 'staging') return 'staging';
  if (raw === 'development') return 'development';
  return 'production';
}

export function isProduction(env?: Record<string, string | undefined>): boolean {
  return appEnv(env) === 'production';
}

export function isStaging(env?: Record<string, string | undefined>): boolean {
  return appEnv(env) === 'staging';
}

/** Lowercased entries: exact addresses and `@domain` suffixes. */
export function recipientAllowlist(env: Record<string, string | undefined> = process.env): string[] {
  return (env.EMAIL_RECIPIENT_ALLOWLIST ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Extracts the bare address from `Name <a@b.c>` or `a@b.c`. */
function bareAddress(value: string): string {
  const angle = /<([^<>]+)>\s*$/.exec(value);
  return (angle ? angle[1] : value).trim().toLowerCase();
}

export function isAllowlistedAddress(address: string | null | undefined, allowlist: string[]): boolean {
  if (!address) return false;
  const bare = bareAddress(address);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = bare.slice(at);
  return allowlist.some((entry) => (entry.startsWith('@') ? domain === entry : bare === entry));
}

/**
 * Whether this address may sign in. Always true in production; in staging only
 * allowlisted addresses (an empty allowlist admits nobody).
 */
export function mayUseThisDeployment(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isStaging(env)) return true;
  return isAllowlistedAddress(email, recipientAllowlist(env));
}

/** The /auth/error reason (and 403 body) for a refused staging sign-in. */
export const STAGING_RESTRICTED_REASON = 'staging_restricted';
