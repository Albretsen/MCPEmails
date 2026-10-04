// ---------------------------------------------------------------------------
// The push feature's database access, behind one interface (the same split as
// ../store.ts: the routes and the dispatcher are testable with an in-memory
// store; `supabasePushStore` is the production implementation).
//
// Tables and functions: migrations 20261005100000 and 20261005100100. None of
// them has a column that could hold mail content, and nothing here writes any.
// ---------------------------------------------------------------------------

export type PayloadMode = "rich" | "private";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  workspace_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  disabled_at: string | null;
}

export interface PreferenceRow {
  inbox_id: string;
  enabled: boolean;
  payload_mode: PayloadMode;
  quiet_start: number | null;
  quiet_end: number | null;
  quiet_timezone: string | null;
}

/** One watched folder's change cursor: counters and sequence numbers, never content. */
export interface FolderCursor {
  fingerprint: string;
  total: number | null;
  unread: number | null;
}

export interface LeasedWatch {
  inbox_id: string;
  workspace_id: string;
  provider: string;
  /** For the per-host concurrency cap only. Never logged. */
  mail_host: string | null;
  lease_id: string;
  folders: Record<string, FolderCursor>;
  last_checked_at: string | null;
  failure_count: number;
  /** The inbox row's `last_error`: read for the refused-login marker only. Never logged. */
  inbox_last_error: string | null;
}

export interface WatchResult {
  folders: Record<string, FolderCursor>;
  last_checked_at: string | null;
  last_changed_at?: string;
  last_notified_at?: string;
  next_check_at: string;
  failure_count: number;
  backoff_until: string | null;
  last_error_code: string | null;
}

export interface Recipient {
  subscription_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  payload_mode: PayloadMode;
  quiet_start: number | null;
  quiet_end: number | null;
  quiet_timezone: string | null;
}

export interface PushResults {
  sent: string[];
  gone: string[];
  failed: string[];
}

export interface PushStore {
  /** Insert, or re-point the row with this endpoint at this user and workspace and re-enable it. */
  upsertSubscription(row: {
    userId: string;
    workspaceId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
  }): Promise<void>;
  /** Rows of this user, in any workspace, disabled ones included (the cap counts them all). */
  countSubscriptions(userId: string): Promise<number>;
  /** Delete this user's row for the endpoint. Returns how many rows went. */
  deleteSubscription(userId: string, endpoint: string): Promise<number>;
  /** This user's active subscriptions in one workspace. */
  subscriptions(userId: string, workspaceId: string): Promise<SubscriptionRow[]>;
  /** The row for an endpoint, whoever owns it (the token-free rotation route). */
  subscriptionByEndpoint(endpoint: string): Promise<SubscriptionRow | null>;
  /** Swap a row's endpoint and keys in place (the browser rotated its subscription). */
  rotateSubscription(id: string, next: { endpoint: string; p256dh: string; auth: string }): Promise<void>;
  preferences(userId: string, inboxIds: string[]): Promise<PreferenceRow[]>;
  savePreferences(userId: string, rows: PreferenceRow[]): Promise<void>;
  leaseWatches(limit: number, leaseSeconds: number): Promise<LeasedWatch[]>;
  /** Write a check's result and give the lease back. A no-op unless `leaseId` still holds the row. */
  releaseWatch(inboxId: string, leaseId: string, result: WatchResult): Promise<void>;
  recipients(inboxId: string): Promise<Recipient[]>;
  recordPushResults(results: PushResults): Promise<void>;
}

// deno-lint-ignore no-explicit-any
type Db = any;

const SUBSCRIPTION_COLUMNS = "id, user_id, workspace_id, endpoint, p256dh, auth, disabled_at";

/** Error CODES only: a Postgres message can quote a row. */
function fail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}:${error?.code ?? "error"}`);
}

function cursorMap(raw: unknown): Record<string, FolderCursor> {
  const out: Record<string, FolderCursor> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Partial<FolderCursor> | null;
    if (!v || typeof v.fingerprint !== "string") continue;
    out[name] = {
      fingerprint: v.fingerprint,
      total: typeof v.total === "number" ? v.total : null,
      unread: typeof v.unread === "number" ? v.unread : null,
    };
  }
  return out;
}

export function supabasePushStore(db: Db): PushStore {
  return {
    async upsertSubscription(row) {
      const now = new Date().toISOString();
      const { error } = await db.from("push_subscriptions").upsert(
        {
          user_id: row.userId,
          workspace_id: row.workspaceId,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
          user_agent: row.userAgent,
          updated_at: now,
          failure_count: 0,
          disabled_at: null,
        },
        { onConflict: "endpoint" },
      );
      if (error) fail("push_subscribe_failed", error);
    },

    async countSubscriptions(userId) {
      const { count, error } = await db
        .from("push_subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (error) fail("push_count_failed", error);
      return count ?? 0;
    },

    async deleteSubscription(userId, endpoint) {
      const { data, error } = await db
        .from("push_subscriptions")
        .delete()
        .eq("user_id", userId)
        .eq("endpoint", endpoint)
        .select("id");
      if (error) fail("push_unsubscribe_failed", error);
      return Array.isArray(data) ? data.length : 0;
    },

    async subscriptions(userId, workspaceId) {
      const { data, error } = await db
        .from("push_subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .is("disabled_at", null)
        .order("created_at")
        .limit(50);
      if (error) fail("push_subscriptions_failed", error);
      return (data ?? []) as SubscriptionRow[];
    },

    async subscriptionByEndpoint(endpoint) {
      const { data, error } = await db
        .from("push_subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .eq("endpoint", endpoint)
        .maybeSingle();
      if (error) fail("push_lookup_failed", error);
      return (data as SubscriptionRow | null) ?? null;
    },

    async rotateSubscription(id, next) {
      const { error } = await db
        .from("push_subscriptions")
        .update({
          endpoint: next.endpoint,
          p256dh: next.p256dh,
          auth: next.auth,
          updated_at: new Date().toISOString(),
          failure_count: 0,
          disabled_at: null,
        })
        .eq("id", id);
      if (error) fail("push_rotate_failed", error);
    },

    async preferences(userId, inboxIds) {
      if (inboxIds.length === 0) return [];
      const { data, error } = await db
        .from("push_preferences")
        .select("inbox_id, enabled, payload_mode, quiet_start, quiet_end, quiet_timezone")
        .eq("user_id", userId)
        .in("inbox_id", inboxIds);
      if (error) fail("push_preferences_failed", error);
      return (data ?? []) as PreferenceRow[];
    },

    async savePreferences(userId, rows) {
      if (rows.length === 0) return;
      const now = new Date().toISOString();
      const { error } = await db.from("push_preferences").upsert(
        rows.map((row) => ({ ...row, user_id: userId, updated_at: now })),
        { onConflict: "user_id,inbox_id" },
      );
      if (error) fail("push_preferences_save_failed", error);
    },

    async leaseWatches(limit, leaseSeconds) {
      const { data, error } = await db.rpc("lease_inbox_watches", { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) fail("push_lease_failed", error);
      return ((data ?? []) as Array<Omit<LeasedWatch, "folders"> & { folders: unknown }>).map((row) => ({
        ...row,
        folders: cursorMap(row.folders),
      }));
    },

    async releaseWatch(inboxId, leaseId, result) {
      const { error } = await db
        .from("inbox_watch_state")
        .update({ ...result, lease_id: null, leased_until: null })
        .eq("inbox_id", inboxId)
        .eq("lease_id", leaseId);
      if (error) fail("push_release_failed", error);
    },

    async recipients(inboxId) {
      const { data, error } = await db.rpc("push_recipients", { p_inbox_id: inboxId });
      if (error) fail("push_recipients_failed", error);
      return (data ?? []) as Recipient[];
    },

    async recordPushResults(results) {
      if (results.sent.length + results.gone.length + results.failed.length === 0) return;
      const { error } = await db.rpc("record_push_results", {
        p_sent: results.sent,
        p_gone: results.gone,
        p_failed: results.failed,
      });
      if (error) fail("push_results_failed", error);
    },
  };
}
