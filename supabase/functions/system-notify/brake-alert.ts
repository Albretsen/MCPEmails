// Send-brake alerts: one email per inbox and brake per 24 hours.
//
// mcp-server records an `outbound.brake_tripped` system event every time a
// brake trips. A customer sending a newsletter in batches, or an agent
// retrying a held send every hour, trips the fan-out brake again and again:
// on 2026-11-16/17 two inboxes produced 9 alerts. Every trip is still
// recorded in system_events (that is the history); only the email is skipped
// when an earlier event for the same inbox and brake is under 24 hours old.

export const BRAKE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BRAKE_ALERT_REPEAT_ERROR = "repeat_within_24h";

type Row = Record<string, unknown>;
type Answer = { data: unknown; error: { message: string } | null };

/** The slice of the Supabase query builder this uses. */
export interface BrakeAlertDb {
  from(table: "system_events"): {
    select(columns: string): BrakeAlertQuery;
  };
}
export interface BrakeAlertQuery extends PromiseLike<Answer> {
  eq(column: string, value: unknown): BrakeAlertQuery;
  lt(column: string, value: unknown): BrakeAlertQuery;
  gt(column: string, value: unknown): BrakeAlertQuery;
  limit(count: number): BrakeAlertQuery;
  maybeSingle(): PromiseLike<Answer>;
}

/**
 * True when an earlier brake event for the same inbox and brake exists in the
 * 24 hours before this one, so this one must not be emailed. Ordered by the
 * event's own created_at, never "now": two trips seconds apart must not each
 * see the other and both stay silent. Any read failure is false (alert).
 */
export async function isRepeatBrakeAlert(
  db: BrakeAlertDb,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const inboxId = typeof payload.inbox_id === "string" ? payload.inbox_id : "";
  const brake = typeof payload.brake === "string" ? payload.brake : "";
  if (!inboxId || !brake) return false;
  try {
    const own = await db.from("system_events").select("created_at").eq("id", eventId).maybeSingle();
    const createdAt = (own.data as Row | null)?.created_at;
    if (own.error || typeof createdAt !== "string") return false;
    const ownMs = Date.parse(createdAt);
    if (!Number.isFinite(ownMs)) return false;
    const earlier = await db
      .from("system_events")
      .select("id")
      .eq("event_type", "outbound.brake_tripped")
      .eq("payload->>inbox_id", inboxId)
      .eq("payload->>brake", brake)
      .lt("created_at", createdAt)
      .gt("created_at", new Date(ownMs - BRAKE_ALERT_WINDOW_MS).toISOString())
      .limit(1);
    if (earlier.error || !Array.isArray(earlier.data)) return false;
    return earlier.data.length > 0;
  } catch {
    return false;
  }
}
