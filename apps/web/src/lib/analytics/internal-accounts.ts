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

/**
 * Plus-addressed variants of a listed address are the same person.
 *
 * `bjellanda+test@gmail.com` is an alias of `bjellanda@gmail.com`, not a
 * second human, and it is how our own test accounts get made. Matching only
 * the exact string let one of those through as an external customer: it had
 * completed a live 100% off checkout, so the kiosk's checkout funnel reported
 * two people as having paid us when one of them was us. The list stays a list
 * of real addresses and the aliasing is handled here, because asking whoever
 * adds the next test account to also remember to list its alias is how the
 * same wrong number comes back.
 *
 * Only the tag is stripped, and only against addresses we have already
 * declared internal. Gmail's dot-insensitivity is deliberately NOT emulated:
 * it is Gmail-specific, and folding `a.b@` into `ab@` across every provider
 * would silently merge accounts belonging to different people.
 */
export function isInternalAccount(email: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (INTERNAL_DOMAINS.some((domain) => normalized.endsWith(domain))) return true;
  const configured = configuredInternalEmails();
  return configured.has(normalized) || configured.has(withoutPlusTag(normalized));
}

/** `name+anything@host` becomes `name@host`. Anything else is returned as is. */
function withoutPlusTag(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return email;
  return `${local.slice(0, plus)}${email.slice(at)}`;
}
