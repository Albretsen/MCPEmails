// ---------------------------------------------------------------------------
// outbound-allowlist.ts - who a non-production deploy may send mail to.
//
// Staging connects test mailboxes only, but automations, scheduled sends and
// reminders run unattended, and a tester can type any address. When
// OUTBOUND_RECIPIENT_ALLOWLIST is set, every recipient (to, cc, bcc) of every
// send must match it, or the send is refused before anything reaches the
// provider. When it is unset (production), nothing here does anything.
//
// The checks sit at the provider send functions, not the tool handlers, so a
// new tool or an unattended path inherits them:
//   SMTP   sendViaSmtp (smtp-client.ts), the envelope RCPT TO list
//   Gmail  every messages.send / drafts.send call in index.ts
//   Graph  graphSendDraft (outlook-graph.ts), which every Outlook send uses
//
// Entries are comma or whitespace separated: an exact address
// (`staging-a@mcpemails.com`) or a whole domain (`@mcpemails.com`). Matching is
// case-insensitive. A domain entry matches that domain only, not subdomains.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { MessageBuildError } from "./send-stages.ts";

export interface OutboundAllowlist {
  addresses: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

/** Parses the env value. Unset or blank means no allowlist: every recipient is allowed. */
export function parseOutboundAllowlist(raw: string | undefined | null): OutboundAllowlist | null {
  const entries = (raw ?? "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return null;
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("@")) domains.add(entry.slice(1));
    else addresses.add(entry);
  }
  return { addresses, domains };
}

const ADDRESS_RE = /[^\s<>(),;:"']+@[^\s<>(),;:"']+/g;

/**
 * The bare addresses in a list of recipient strings ("Name <a@b>", "a@b").
 * Anything that looks like an address counts, including one inside a display
 * name: over-matching can only refuse more, never let one through.
 */
export function extractAddresses(recipients: readonly string[]): string[] {
  const out: string[] = [];
  for (const recipient of recipients) {
    for (const match of recipient.matchAll(ADDRESS_RE)) out.push(match[0].toLowerCase().replace(/\.+$/, ""));
  }
  return out;
}

/** Recipients the allowlist refuses. Empty when there is no allowlist. */
export function disallowedRecipients(
  allowlist: OutboundAllowlist | null,
  recipients: readonly string[],
): string[] {
  if (!allowlist) return [];
  const refused = new Set<string>();
  for (const recipient of recipients) {
    const found = extractAddresses([recipient]);
    // A recipient string with no address in it cannot be checked, so it is refused.
    if (found.length === 0 && recipient.trim()) refused.add(recipient.trim());
    for (const address of found) {
      const domain = address.slice(address.lastIndexOf("@") + 1);
      if (!allowlist.addresses.has(address) && !allowlist.domains.has(domain)) refused.add(address);
    }
  }
  return [...refused];
}

export const OUTBOUND_RECIPIENT_NOT_ALLOWED = "outbound_recipient_not_allowed";

/**
 * A send refused by the allowlist. A MessageBuildError, so every handler
 * already reports it as not_sent: nothing reached the provider.
 */
export class OutboundRecipientRefusedError extends MessageBuildError {
  readonly refused: string[];
  constructor(refused: string[]) {
    super(
      `${OUTBOUND_RECIPIENT_NOT_ALLOWED}: this is a test deployment and only sends to addresses on ` +
        `OUTBOUND_RECIPIENT_ALLOWLIST. Not on it: ${refused.join(", ")}. ` +
        `Send to an allowed test address instead.`,
    );
    this.name = "OutboundRecipientRefusedError";
    this.refused = refused;
  }
}

let cached: { raw: string | undefined; list: OutboundAllowlist | null } | null = null;

/** The deploy's allowlist, from OUTBOUND_RECIPIENT_ALLOWLIST. Null in production. */
export function outboundAllowlist(): OutboundAllowlist | null {
  const raw = Deno.env.get("OUTBOUND_RECIPIENT_ALLOWLIST");
  if (!cached || cached.raw !== raw) cached = { raw, list: parseOutboundAllowlist(raw) };
  return cached.list;
}

/** Throws OutboundRecipientRefusedError when any recipient is outside the allowlist. */
export function assertOutboundRecipientsAllowed(
  recipients: readonly string[],
  allowlist: OutboundAllowlist | null = outboundAllowlist(),
): void {
  const refused = disallowedRecipients(allowlist, recipients);
  if (refused.length > 0) throw new OutboundRecipientRefusedError(refused);
}
