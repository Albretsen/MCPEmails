// ---------------------------------------------------------------------------
// Draft events: a durable, content-free count of what happens to drafts, so
// the growth board can say whether the draft editor card is used and whether
// it changes how many drafts get sent (release read-out, 2026-10-27).
//
// ── Why a table of its own ─────────────────────────────────────────────────
// Nothing else can answer it for more than a week:
//   * `draft_card_activity` holds the card's saves and sends, but every insert
//     deletes rows older than 7 days (card-activity.ts).
//   * `activity_log` logs a card Send as `draft_send`, the same name as a send
//     the model makes, and is purged at 30 to 730 days by plan.
//   * `draft_lineage` keeps who wrote LAST, not who sent it.
//
// ── What is recorded ───────────────────────────────────────────────────────
//   drafted   draft{action:"create"|"reply"} succeeded. `card_offered` says
//             whether the result carried the editor envelope (workspace rolled
//             out and not hidden). Whether the host then DREW it is unknown to
//             the server; the board splits by client instead.
//   saved     draft_editor_save wrote something. Always `via_card`.
//   sent      draft{action:"send"} succeeded. `via_card` when it carried
//             base_revision, which is the card's marker (card-activity.ts says
//             why that is a marker and not proof).
//   deleted   draft{action:"delete"} succeeded, `via_card` the same way.
//   hidden    draft_editor_hide turned the card off for an inbox (inbox_id
//             set) or a workspace (inbox_id null).
//
// No subject, address, body, draft id or hash of one. A line id only, so the
// board can count distinct drafts the card touched.
//
// ── Fail soft ──────────────────────────────────────────────────────────────
// `recordDraftEvent` never throws and never fails the call it rides on. A
// database without the table (function deployed ahead of the migration)
// records nothing.
// ---------------------------------------------------------------------------

export type DraftEventName = "drafted" | "saved" | "sent" | "deleted" | "hidden";

export interface DraftEventScope {
  workspaceId: string;
  inboxId: string | null;
  apiKeyId: string;
}

export interface DraftEvent {
  event: DraftEventName;
  viaCard: boolean;
  /** `drafted` only: the result carried the editor envelope. */
  cardOffered?: boolean | null;
  lineId?: string | null;
}

export interface DraftEventStore {
  insert(row: Record<string, unknown>): Promise<void>;
}

interface PostgrestInsertLike {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
}

export function postgrestDraftEventStore(client: PostgrestInsertLike): DraftEventStore {
  return {
    async insert(row) {
      const { error } = await client.from("draft_events").insert(row);
      if (error) throw new Error(error.message);
    },
  };
}

/** The row `draft_events` stores. Exported for the test. */
export function draftEventRow(scope: DraftEventScope, ev: DraftEvent): Record<string, unknown> {
  return {
    workspace_id: scope.workspaceId,
    inbox_id: scope.inboxId,
    api_key_id: scope.apiKeyId,
    event: ev.event,
    via_card: ev.viaCard,
    card_offered: ev.event === "drafted" ? (ev.cardOffered ?? null) : null,
    line_id: ev.lineId ?? null,
  };
}

/** Never throws. A null store (introspection) records nothing. */
export async function recordDraftEvent(
  store: DraftEventStore | null,
  scope: DraftEventScope,
  ev: DraftEvent,
): Promise<void> {
  if (!store) return;
  try {
    await store.insert(draftEventRow(scope, ev));
  } catch (err) {
    console.warn("[mcp-server] draft_event_insert_failed", {
      workspace_id: scope.workspaceId,
      event: ev.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
