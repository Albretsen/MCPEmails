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
