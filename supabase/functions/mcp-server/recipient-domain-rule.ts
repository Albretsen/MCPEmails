// ---------------------------------------------------------------------------
// recipient-domain-rule.ts - the Business recipient rule
// (workspaces.allowed_recipient_domains, migration 20261111130000).
//
// When a workspace sets a list of domains, a send whose To, Cc or Bcc holds
// any address outside that list is HELD for an owner or admin to approve. It
// is never dropped and never sent as is. Every outbound path asks this module:
// email_send, email_reply, email_forward (single and batch), draft_send (the
// card included), schedule_create, the scheduled-send dispatcher at send time,
// and the automation forward action. A send a human already approved (the
// approval dispatcher) is not asked again.
//
// MATCHING. Exact domain, case-insensitive: `example.com` allows
// `a@example.com` and `a@EXAMPLE.com`, NOT `a@sales.example.com`. Subdomains
// are deliberately not implied: a company that owns `example.com` does not
// necessarily trust everything under it (customer-hosted subdomains, partner
// tenants), and an admin who wants one adds it as its own entry.
//
// A recipient string with no address in it cannot be checked, so it counts
// as outside the list: over-matching can only hold more, never let one go.
//
// PURE: no I/O. The workspace read and the hold live in index.ts.
// Run: deno test supabase/functions/mcp-server/recipient-domain-rule.test.ts
// ---------------------------------------------------------------------------

import { extractAddresses } from "./outbound-allowlist.ts";

/** send_approvals.hold_reason for a send this rule held. */
export const RECIPIENT_RULE_HOLD_REASON = "recipient_rule";

/** activity_log error code for a send refused because the rule could not be read. */
export const RECIPIENT_RULE_UNAVAILABLE = "recipient_rule_unavailable";

/** activity_log error code for a web-client send refused by the rule. */
export const RECIPIENT_RULE_REFUSED = "recipient_rule_refused";

/**
 * The stored list as the rule uses it: lower-cased, trimmed, without a leading
 * `@`, de-duplicated. null (or an empty list) means any recipient is allowed.
 */
export function normalizeAllowedDomains(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const d = entry.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");
    if (d) out.add(d);
  }
  return out.size > 0 ? [...out] : null;
}

/** The domain part of a bare address, lower case. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase().replace(/\.+$/, "");
}

/**
 * The recipients outside the allowed domains, lower case and de-duplicated.
 * Empty when there is no rule (`allowed` null) or every recipient is inside.
 */
export function recipientsOutsideDomains(
  allowed: readonly string[] | null,
  recipients: readonly string[],
): string[] {
  if (!allowed || allowed.length === 0) return [];
  const ok = new Set(allowed.map((d) => d.toLowerCase()));
  const outside = new Set<string>();
  for (const recipient of recipients) {
    if (typeof recipient !== "string") continue;
    const found = extractAddresses([recipient]);
    if (found.length === 0) {
      if (recipient.trim()) outside.add(recipient.trim().toLowerCase());
      continue;
    }
    for (const address of found) {
      if (!ok.has(domainOf(address))) outside.add(address);
    }
  }
  return [...outside];
}

/**
 * The model-visible message for a send the rule held. Counts only: the
 * held-send contract (index.ts pendingApprovalPayload) echoes no recipient.
 */
export function recipientRuleHeldMessage(noun: string, outsideCount: number, reviewUrl: string): string {
  const who = outsideCount === 1 ? "1 recipient is" : `${outsideCount} recipients are`;
  return `This ${noun} has not been sent. Your workspace only sends to approved email domains, ` +
    `and ${who} outside them, so MCPEmails held it for a workspace owner or admin to approve. ` +
    `They can approve it at ${reviewUrl} (sign-in required). Nothing was sent.`;
}

/** The refusal for a web-client send (a person pressed Send; it is not queued). */
export function recipientRuleRefusalText(tool: string, outsideCount: number): string {
  const who = outsideCount === 1 ? "1 recipient is" : `${outsideCount} recipients are`;
  return `${tool}: not sent. Your workspace only sends to approved email domains, and ${who} ` +
    `outside them. Ask a workspace owner or admin to add the domain under Settings, Advanced.`;
}

/** The refusal when the rule could not be read. Nothing was sent; retryable. */
export function recipientRuleUnavailableText(tool: string): string {
  return `${tool}: not sent. MCPEmails could not check your workspace's allowed recipient ` +
    `domains just now. Nothing was sent; retry shortly.`;
}
