// An in-memory `draft_lineage` for tests, keyed the way the table is. Not
// imported by the server. Same idea as imap-fake-server.ts.
import type {
  DraftLineageRow,
  DraftLineageScope,
  DraftLineageStore,
} from "./draft-lineage.ts";

export function memoryLineageStore(options: { failing?: boolean } = {}) {
  const rows: (DraftLineageRow & { workspace_id: string; inbox_id: string })[] = [];
  const mine = (scope: DraftLineageScope) =>
    rows.filter((r) => r.workspace_id === scope.workspaceId && r.inbox_id === scope.inboxId);
  const fail = () => {
    if (options.failing) throw new Error('relation "public.draft_lineage" does not exist');
  };
  const store: DraftLineageStore = {
    find(scope, draftId) {
      fail();
      return Promise.resolve(mine(scope).find((r) => r.draft_id === draftId) ?? null);
    },
    head(scope, lineId) {
      fail();
      const line = mine(scope).filter((r) => r.line_id === lineId)
        .sort((a, b) => b.revision - a.revision);
      return Promise.resolve(line[0] ?? null);
    },
    upsert(scope, writes) {
      fail();
      for (const w of writes) {
        // Unique on (inbox_id, draft_id), as in the migration.
        const at = rows.findIndex((r) => r.inbox_id === scope.inboxId && r.draft_id === w.draft_id);
        const row = {
          ...w,
          closed_at: null,
          closed_reason: null,
          workspace_id: scope.workspaceId,
          inbox_id: scope.inboxId,
        };
        if (at === -1) rows.push(row);
        else rows[at] = row;
      }
      return Promise.resolve();
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
