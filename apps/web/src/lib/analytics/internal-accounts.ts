/**
 * Which accounts are ours rather than a customer's.
 *
 * "Internal" and "comped" are different facts and must not be conflated. An
 * internal account is one we operate: the monitor, a founder's own workspace, a
 * test account. Its traffic is real load but it is not a customer, and counting
 * it as one flatters every engagement number on the page.
 *
 * A comped account is a BILLING fact. Some of them are real external users who
 * were given a free plan for a good reason, such as sustained useful feedback.
 * Treating "comped" as a synonym for "not a real user" greyed those people out
 * of the roster and quietly removed them from the external-usage numbers, which
 * is the opposite of the truth: they are exactly the users worth watching.
 *
 * The address list lives in `GROWTH_INTERNAL_EMAILS` (comma-separated), not in
 * this file, because this repository is public and the accounts involved are
 * personal addresses. Same convention as ADMIN_EMAILS. Anyone not listed, and
 * not on an internal domain, counts as external no matter what plan they hold,
 * which is the safe direction to be wrong in: a missing entry overstates
 * external usage rather than hiding a real user.
 */

/** Domains we own outright. Everything under them is ours by definition. */
const INTERNAL_DOMAINS = ['@mcpemails.com', '@mcpemails.dev'];

/**
 * The same two inputs, for the reporting functions that must exclude internal
 * accounts in SQL because they return aggregates rather than rows. The list is
 * passed as a parameter rather than written into a migration: this repository
 * is public and the addresses are personal.
 */
export function internalAccountMatchers(): { emails: string[]; domains: string[] } {
  return { emails: [...configuredInternalEmails()], domains: [...INTERNAL_DOMAINS] };
}

function configuredInternalEmails(): Set<string> {
  return new Set(
    (process.env.GROWTH_INTERNAL_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isInternalAccount(email: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (INTERNAL_DOMAINS.some((domain) => normalized.endsWith(domain))) return true;
  return configuredInternalEmails().has(normalized);
}
