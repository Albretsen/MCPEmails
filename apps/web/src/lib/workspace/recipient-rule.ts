/**
 * The Business recipient rule: `workspaces.allowed_recipient_domains`
 * (migration 20261111130000). null = any recipient. Otherwise mcp-server holds
 * every send with a To, Cc or Bcc address outside these domains for an owner
 * or admin to approve (supabase/functions/mcp-server/recipient-domain-rule.ts).
 *
 * Matching there is by EXACT domain: `example.com` does not cover
 * `sales.example.com`. Parsing here is the only place a list is accepted.
 */

/** The CHECK constraint's ceiling. */
export const MAX_ALLOWED_RECIPIENT_DOMAINS = 100;

// One label: letters, digits and inner hyphens, at most 63. Punycode (xn--)
// passes as it is plain ASCII. A TLD of at least two letters or a punycode TLD.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);

export type ParsedRecipientDomains =
  | { ok: true; domains: string[] | null }
  | { ok: false; error: string; invalid?: string };

/**
 * Parse what the settings field sends: a comma (or whitespace / semicolon)
 * separated string, a string array, or null. Lower-cased, a leading `@` and
 * a trailing dot dropped, de-duplicated in order. Empty = null (any recipient).
 */
export function parseRecipientDomains(input: unknown): ParsedRecipientDomains {
  let parts: string[];
  if (input === null || input === undefined) return { ok: true, domains: null };
  if (typeof input === 'string') {
    parts = input.split(/[\s,;]+/);
  } else if (Array.isArray(input) && input.every((x) => typeof x === 'string')) {
    parts = input as string[];
  } else {
    return { ok: false, error: 'domains must be a comma-separated string or a list of domains.' };
  }
  const out: string[] = [];
  for (const raw of parts) {
    const d = raw.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
    if (!d) continue;
    if (d.length > 253 || !DOMAIN_RE.test(d)) {
      return { ok: false, error: `"${raw.trim().slice(0, 80)}" is not a domain name.`, invalid: raw.trim().slice(0, 80) };
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > MAX_ALLOWED_RECIPIENT_DOMAINS) {
    return { ok: false, error: `At most ${MAX_ALLOWED_RECIPIENT_DOMAINS} domains.` };
  }
  return { ok: true, domains: out.length > 0 ? out : null };
}

/** The stored column as the UI shows it: null or a non-empty list. */
export function storedRecipientDomains(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return list.length > 0 ? list : null;
}

/** How many domains each list in an audit row keeps (the rest is a count). */
export const AUDIT_DOMAINS_PER_LIST = 15;

/**
 * The `details` of a recipient_rule_changed audit row: the change as a diff,
 * so a 100-domain list can never outgrow the row's size cap
 * (workspace_audit_events.details, 16 KB) and lose the audit row.
 *
 *   to         the new list, first AUDIT_DOMAINS_PER_LIST (null = any recipient)
 *   to_count   how many domains the new list has
 *   added      domains now allowed that were not, truncated the same way
 *   removed    domains no longer allowed, truncated the same way
 *   *_more     how many each list left out
 */
export function recipientRuleAuditDetails(
  previous: string[] | null,
  next: string[] | null,
): Record<string, unknown> {
  const before = new Set(previous ?? []);
  const after = new Set(next ?? []);
  const added = [...after].filter((d) => !before.has(d));
  const removed = [...before].filter((d) => !after.has(d));
  const cut = (list: string[]) => list.slice(0, AUDIT_DOMAINS_PER_LIST);
  return {
    to: next === null ? null : cut(next),
    to_count: next === null ? 0 : next.length,
    added: cut(added),
    removed: cut(removed),
    ...(next !== null && next.length > AUDIT_DOMAINS_PER_LIST ? { to_more: next.length - AUDIT_DOMAINS_PER_LIST } : {}),
    ...(added.length > AUDIT_DOMAINS_PER_LIST ? { added_more: added.length - AUDIT_DOMAINS_PER_LIST } : {}),
    ...(removed.length > AUDIT_DOMAINS_PER_LIST ? { removed_more: removed.length - AUDIT_DOMAINS_PER_LIST } : {}),
  };
}
