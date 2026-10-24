// ---------------------------------------------------------------------------
// Parked inboxes: connected, credentials kept, but outside the plan's inbox
// cap, so no tool may use them.
//
// `inboxes.parked_at` (migration 20261024150000) is set by the web app's
// parking module (apps/web/src/lib/billing/parking.ts) when a plan drops below
// the number of connected inboxes, and cleared on upgrade or resume. On this
// server that means:
//
//   * every query that resolves an inbox for a tool, enumerates inboxes for a
//     tool, or rolls inboxes up for a gate adds `parked_at is null`;
//   * `inbox_list` still returns parked inboxes, flagged `status: "parked"`
//     with `PARKED_INBOX_HINT`, so the assistant can explain instead of
//     concluding the mailbox is gone;
//   * a tool call that names a parked inbox gets `parkedInboxErrorText`, not
//     "No inbox matches";
//   * automations skip parked inboxes (their rules are paused with
//     `paused_reason = 'inbox_parked'`, and the triage loader refuses them);
//   * the scheduled-send dispatcher still delivers a row created BEFORE the
//     inbox was parked and fails one created after, see
//     `scheduledSendBlockedByParking`.
//
// DEPLOY ORDER: the migration first. PostgREST rejects a filter on a column it
// does not know.
// ---------------------------------------------------------------------------

import type { InboxQueryClient } from "./reachable-inbox.ts";

/** The `status` an `inbox_list` entry carries when its inbox is parked. */
export const PARKED_INBOX_STATUS = "parked";

/** `error_code` / `logErrorCode` for a tool call that named a parked inbox. */
export const PARKED_INBOX_ERROR_CODE = "inbox_parked";

/** The SQL predicate, stated once so it is quotable. */
export const NOT_PARKED_SQL = "parked_at is null";

/** Where the customer restores a parked inbox. */
export function billingPageUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/dashboard/settings`;
}

/**
 * One sentence for the assistant, on every parked `inbox_list` entry.
 *
 * No plan names or slugs: the assistant does not need them, and a slug is
 * never shown to a customer.
 */
export function parkedInboxHint(appUrl: string): string {
  return (
    "This inbox is parked: the workspace's current MCPEmails plan includes fewer " +
    "inboxes than are connected. Nothing was deleted, but no tool can use it until " +
    "it is restored. Tell the user they can restore it by upgrading on the billing " +
    `page: ${billingPageUrl(appUrl)}`
  );
}

/**
 * The error text for a tool call that named a parked inbox, or that had no
 * active inbox to fall back on because every inbox the key can see is parked.
 */
export function parkedInboxErrorText(emailAddresses: readonly string[], appUrl: string): string {
  const one = emailAddresses.length === 1;
  const subject = emailAddresses.length === 0
    ? "Every inbox this key can use is"
    : one
    ? `The inbox ${emailAddresses[0]} is`
    : `The inboxes ${emailAddresses.join(", ")} are`;
  const it = one ? "it" : "them";
  return (
    `${subject} parked: the workspace's current MCPEmails plan includes fewer inboxes ` +
    `than are connected, so this tool cannot use ${it}. Nothing was deleted and nothing ` +
    `was done. Tell the user they can restore ${it} by upgrading on the billing page: ` +
    `${billingPageUrl(appUrl)} . Call inbox_list to see which inboxes are active.`
  );
}

/** True when the row carries a non-null `parked_at`. An absent column is NOT parked. */
export function inboxIsParked(row: { parked_at?: unknown } | null | undefined): boolean {
  return !!row && row.parked_at !== undefined && row.parked_at !== null;
}

/**
 * Whether the scheduled-send dispatcher must refuse this row because its inbox
 * is parked.
 *
 * A send scheduled while the inbox was active is delivered: the customer
 * scheduled it while paying, and not sending it is worse than one uncounted
 * send (plan section 2.3, decision D4). One created at or after `parked_at`
 * could only have come from a path that skipped the resolver, and is refused.
 *
 * An unreadable timestamp on either side delivers, for the same reason: the
 * failure we can be sure is harmless is sending a mail the customer asked for.
 */
export function scheduledSendBlockedByParking(
  row: { created_at?: unknown },
  inbox: { parked_at?: unknown },
): boolean {
  if (!inboxIsParked(inbox)) return false;
  const parkedAt = Date.parse(String(inbox.parked_at));
  const createdAt = Date.parse(String(row.created_at ?? ""));
  if (Number.isNaN(parkedAt) || Number.isNaN(createdAt)) return false;
  return createdAt >= parkedAt;
}

/** The `error_detail` a refused scheduled send is failed with. */
export const SCHEDULED_SEND_PARKED_DETAIL =
  "The mailbox this message was scheduled from is parked because the workspace's " +
  "plan includes fewer inboxes, and the message was scheduled after it was parked. " +
  "Nothing was sent. Restore the inbox from the billing page, then schedule the " +
  "message again.";

export interface ParkedInboxMatch {
  id: string;
  email_address: string;
}

/** The selector a tool call used, as resolveInboxArg reads it. */
export interface ParkedInboxSelector {
  inboxId?: string | null;
  email?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The parked inbox a failed resolution named, or null.
 *
 * Asked only AFTER the ordinary resolver said "not found", so the hot path is
 * unchanged. Scoped exactly as the resolver is: the key's workspace, its
 * `inbox_ids` allowlist, not deleted. So it discloses nothing the key could not
 * already see through `inbox_list`. An address must match exactly (the
 * resolver's own rule: `ilike` is a pattern match).
 */
export async function findParkedInbox(
  db: InboxQueryClient,
  key: { workspace_id: string; inbox_ids: string[] | null },
  selector: ParkedInboxSelector,
): Promise<ParkedInboxMatch | null> {
  const raw = (selector.inboxId ?? "").trim() || (selector.email ?? "").trim();
  if (!raw) return null;
  const byId = UUID_RE.test(raw);
  if (!byId && !raw.includes("@")) return null;
  if (byId && key.inbox_ids !== null && key.inbox_ids.length > 0 && !key.inbox_ids.includes(raw)) return null;

  try {
    let query = db
      .from("inboxes")
      .select("id, email_address, parked_at")
      .eq("workspace_id", key.workspace_id)
      .is("deleted_at", null)
      .not("parked_at", "is", null);
    query = byId
      ? query.eq("id", raw)
      : query.ilike("email_address", raw.replace(/[\\%_*]/g, (char: string) => `\\${char}`));
    if (key.inbox_ids !== null && key.inbox_ids.length > 0) query = query.in("id", key.inbox_ids);
    const { data, error } = await query.limit(1).maybeSingle();
    if (error || !data) return null;
    const row = data as { id?: unknown; email_address?: unknown; parked_at?: unknown };
    if (typeof row.id !== "string" || typeof row.email_address !== "string" || !inboxIsParked(row)) return null;
    if (!byId && row.email_address.toLowerCase() !== raw.toLowerCase()) return null;
    return { id: row.id, email_address: row.email_address };
  } catch {
    // Best effort: the caller falls back to its ordinary "not found".
    return null;
  }
}

/**
 * The parked inboxes this key can see, for the "nothing active, but parked
 * ones exist" case of auto-resolution. Never throws; [] on any failure.
 */
export async function listParkedInboxes(
  db: InboxQueryClient,
  key: { workspace_id: string; inbox_ids: string[] | null },
): Promise<ParkedInboxMatch[]> {
  try {
    let query = db
      .from("inboxes")
      .select("id, email_address, parked_at")
      .eq("workspace_id", key.workspace_id)
      .is("deleted_at", null)
      .not("parked_at", "is", null);
    if (key.inbox_ids !== null && key.inbox_ids.length > 0) query = query.in("id", key.inbox_ids);
    const { data, error } = await query.order("created_at", { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return (data as Array<{ id?: unknown; email_address?: unknown; parked_at?: unknown }>)
      .filter((row) => typeof row.id === "string" && typeof row.email_address === "string" && inboxIsParked(row))
      .map((row) => ({ id: row.id as string, email_address: row.email_address as string }));
  } catch {
    return [];
  }
}
