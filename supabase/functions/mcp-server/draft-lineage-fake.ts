// An in-memory `draft_lineage` for tests, keyed the way the table is. Not
// imported by the server. Same idea as imap-fake-server.ts.
//
// `record` is a transcription of `public.draft_lineage_record` (migration
// 20261013120000_draft_lineage.sql). It runs without an `await` between its
// read and its write, which in a single-threaded runtime is what the SQL
// function's per-inbox advisory lock buys: no other record can interleave. Keep
// the two in step; supabase/tests/draft_lineage.sql pins the SQL side.
import type {
  DraftLineageRecord,
  DraftLineageRecorded,
  DraftLineageRow,
  DraftLineageScope,
  DraftLineageStore,
} from "./draft-lineage.ts";

type StoredRow = DraftLineageRow & { workspace_id: string; inbox_id: string };

export function memoryLineageStore(options: { failing?: boolean } = {}) {
  const rows: StoredRow[] = [];
  const mine = (scope: DraftLineageScope) =>
    rows.filter((r) => r.workspace_id === scope.workspaceId && r.inbox_id === scope.inboxId);
  const fail = () => {
    if (options.failing) throw new Error('relation "public.draft_lineage" does not exist');
  };
  const headOf = (scope: DraftLineageScope, lineId: string): StoredRow | null =>
    mine(scope).filter((r) => r.line_id === lineId).sort((a, b) => b.revision - a.revision)[0] ??
      null;
  /** INSERT ... ON CONFLICT (inbox_id, draft_id) DO UPDATE, plus the (inbox, line, revision) key. */
  const put = (scope: DraftLineageScope, row: Omit<StoredRow, "closed_at" | "closed_reason">) => {
    const at = rows.findIndex((r) => r.inbox_id === scope.inboxId && r.draft_id === row.draft_id);
    if (at !== -1 && rows[at].workspace_id !== scope.workspaceId) {
      throw new Error("draft_lineage_record: draft id belongs to another workspace");
    }
    const clash = rows.findIndex((r, i) =>
      i !== at && r.inbox_id === scope.inboxId && r.line_id === row.line_id &&
      r.revision === row.revision
    );
    if (clash !== -1) {
      throw new Error('duplicate key value violates unique constraint "draft_lineage_line_revision_key"');
    }
    const next: StoredRow = { ...row, closed_at: null, closed_reason: null };
    if (at === -1) rows.push(next);
    else rows[at] = next;
  };
  const store: DraftLineageStore = {
    find(scope, draftId) {
      fail();
      return Promise.resolve(mine(scope).find((r) => r.draft_id === draftId) ?? null);
    },
    head(scope, lineId) {
      fail();
      return Promise.resolve(headOf(scope, lineId));
    },
    record(scope, w: DraftLineageRecord): Promise<DraftLineageRecorded> {
      fail();
      let line: string | null = null;
      let headRev = 0;
      let contended = false;
      if (w.lineId !== null) {
        const head = headOf(scope, w.lineId);
        if (head && head.closed_at === null) {
          line = w.lineId;
          headRev = head.revision;
          contended = w.expectedRevision !== head.revision;
        } else {
          contended = true;
        }
      }
      if (line === null && w.adopt) {
        const row = mine(scope).find((r) => r.draft_id === w.draftId && r.closed_at === null);
        if (row && headOf(scope, row.line_id) === row) {
          line = row.line_id;
          headRev = row.revision;
          contended = true;
        }
      }
      if (line === null) {
        line = crypto.randomUUID();
        headRev = 0;
        if (w.seedDraftId !== null && w.seedDraftId !== w.draftId) {
          put(scope, {
            workspace_id: scope.workspaceId,
            inbox_id: scope.inboxId,
            line_id: line,
            draft_id: w.seedDraftId,
            revision: 1,
            written_by: w.writtenBy,
            written_at: w.writtenAt,
          });
          headRev = 1;
        }
      }
      const revision = headRev + 1;
      put(scope, {
        workspace_id: scope.workspaceId,
        inbox_id: scope.inboxId,
        line_id: line,
        draft_id: w.draftId,
        revision,
        written_by: w.writtenBy,
        written_at: w.writtenAt,
      });
      return Promise.resolve({ lineId: line, revision, contended });
    },
    close(scope, lineId, reason, at) {
      fail();
      for (const r of mine(scope)) {
        if (r.line_id === lineId) {
          r.closed_at = at;
          r.closed_reason = reason;
        }
      }
      return Promise.resolve();
    },
  };
  return { store, rows };
}
