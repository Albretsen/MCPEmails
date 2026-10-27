// ---------------------------------------------------------------------------
// MCP Apps — the result card with Undo, for bulk moves and deletes.
//
// The bulk-plan card (mcp-app-bulk.ts) asks BEFORE acting, and only for an
// inbox with `bulk_review_mode = 'plan'` (1 of ~1,500). This card is the other
// half, for everyone: the tool runs exactly as it always has, and the card
// under the result says what happened in one line, shows a few of the messages,
// and offers one Undo button.
//
//   email_organize  move_batch / search_and_move   (and the per-operation names)
//   email_delete    delete_batch / search_and_delete
//
// ── What the model sees: nothing new ───────────────────────────────────────
// `content` is untouched, byte for byte. The envelope is merged into
// `structuredContent` (a superset of the published payload, the same rule as
// the draft card, contract §8), and the sample rows ride in the result's
// `_meta`, which a host hands to the view and does not render into the
// conversation. The stamp happens at the very end of `tools/call` in index.ts,
// after every note has been appended, so `attachResultNote`'s mirror check
// (content[0] === JSON.stringify(structuredContent)) still holds for every
// note and the model reads the same text it read before this card existed.
//
// ── An Undo is a bulk plan the server wrote ─────────────────────────────────
// "Move exactly these ids to exactly this folder, once, if asked within a
// window" is what a `bulk_plans` row already is, and `bulk_execute` already
// runs one safely: app-only, server-held scope (the card sends only the id),
// workspace and inbox-allowlist checks, the key must hold the action's scope,
// an atomic single-use claim, an expiry, and the one shared bulk move path. So
// Undo is a row with `scope_kind = 'undo'` and the card calls `bulk_execute`.
// No new tool: nothing new in any client's tool list, nothing for the OpenAI
// listing (which sits at its size budget) or its annotation review.
//
// What goes in the row: the ids the messages have NOW and the folder they came
// from. A UID is per mailbox, so on IMAP the move itself reports the new ids
// (COPYUID, RFC 4315; `BulkOpResult.newMessageIds` / `undoIds`). Chosen over a
// Message-ID header search: the new id is exact (a copy and its original share
// a Message-ID), costs no extra FETCH on 25k bulk calls a month, and a message
// moved again since simply fails the presence check (imap-uid-presence.ts)
// instead of being found somewhere else and dragged back. A message whose new
// id the server did not report (no UIDPLUS) is untracked and left alone.
//
// Offered only when it can be honest:
//   * IMAP. ~95% of these calls (30 days to 2026-10-27: 23.5k of 24.6k, 366 of
//     ~380 workspaces). A Gmail API "move" is a label change whose prior labels
//     this path never reads, and Outlook ids change on move with the new one
//     discarded, so neither has an exact inverse here today.
//   * One source folder. A plan has one destination, and "put these back" with
//     several origins would need several plans behind one button. A search
//     covers INBOX unless told otherwise, so this is the ordinary case.
//   * A soft delete or a move. A permanent delete says so and has no button.
//   * A key holding `manage:folders`, which `bulk_execute` requires to run a
//     move; a button that could only answer "scope denied" is not offered.
// ---------------------------------------------------------------------------

import { CARD_SCHEMA_VERSION } from "./mcp-app-approvals.ts";
import type { BulkAction, BulkCaller, BulkDeps, PlanSampleRow } from "./mcp-app-bulk.ts";
import { neutralizeText } from "./text-safety.ts";

/**
 * How long Undo stays available.
 *
 * A day covers "I looked again after lunch" and the next morning's second
 * look, and is short enough that the stored ids still point at the same
 * messages: the longer a record lives, the more likely the user, a rule or
 * another client has moved them again (those then fail the presence check,
 * but a button that mostly fails is worse than none).
 */
export const BULK_UNDO_TTL_MS = 24 * 60 * 60 * 1000;

/** Undo rows are kept this long past expiry, then pruned on the next insert. */
const BULK_UNDO_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Result `_meta` key for the sample rows. Card-only, never model context. */
export const BULK_SAMPLE_META_KEY = "mcpemails/bulk_sample";

/**
 * Set on the request's activity context by the four bulk handlers, read once
 * at the end of `tools/call`. Plain data, so the handlers stay free of card
 * logic, and a client-api call (which has no activity context) leaves nothing.
 */
export interface BulkCardInput {
  action: BulkAction;
  inbox: { id: string; provider: string };
  /** Ids the operation was asked to act on (or the search matched). */
  requested: number;
  /** Ids it acted on, as they were BEFORE the operation. */
  succeeded: string[];
  failed: number;
  /** IMAP: old id -> id now (COPYUID). Missing key = not reported. */
  newIds?: Record<string, string>;
  permanent: boolean;
  /** The destination as the caller named it. Moves only. */
  destination: string | null;
  /** True when the run stopped before every id (budget or a human Stop). */
  stopped: boolean;
  /** Newest-first rows from a search the handler already ran. */
  sample?: PlanSampleRow[];
}

/** `INBOX` -> `Inbox`, `INBOX.Archive` -> `Archive`; otherwise as named. */
export function folderLabel(name: string): string {
  const n = name.trim();
  if (/^inbox$/i.test(n)) return "Inbox";
  return n.replace(/^INBOX[./]/i, "") || n;
}

function isDelete(action: BulkAction): boolean {
  return action === "delete_batch" || action === "search_and_delete";
}

function count(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "message" : "messages"}`;
}

/**
 * IMAP folder half of a message id (`<folder>:<uid>`). Same split as index.ts
 * `decodeImapId`; a bare uid is INBOX. The folder is opaque and server-native,
 * which is exactly what a move back into it needs.
 */
function imapFolderOf(id: string): string {
  const at = id.lastIndexOf(":");
  return at === -1 ? "INBOX" : id.slice(0, at);
}

/**
 * What Undo would do, or null when it cannot be offered honestly (see the
 * header). `ids` are where the messages are now; `back` is the one folder they
 * all came from. A Gmail-over-IMAP relocation out of All Mail keeps its id
 * (imapBulkMove), so it has no folder to go back to and is untracked.
 */
export function undoTarget(
  input: BulkCardInput,
  scopes: string[],
): { ids: string[]; back: string } | null {
  if (input.inbox.provider !== "imap" || input.permanent || !input.newIds) return null;
  if (!scopes.includes("manage:folders")) return null;
  const sources = new Set(input.succeeded.map(imapFolderOf));
  if (sources.size !== 1) return null;
  const back = [...sources][0];
  const ids: string[] = [];
  for (const id of input.succeeded) {
    const now = input.newIds[id];
    if (typeof now === "string" && imapFolderOf(now) !== back) ids.push(now);
  }
  return ids.length > 0 ? { ids, back } : null;
}

/** The one-line headline and the detail under it. */
export function bulkResultWords(input: BulkCardInput): { headline: string; detail: string } {
  const done = input.succeeded.length;
  const del = isDelete(input.action);
  if (done === 0) {
    const what = del ? "deleted" : "moved";
    return input.requested === 0
      ? { headline: `No messages matched. Nothing was ${what}.`, detail: "" }
      : { headline: `No messages were ${what}.`, detail: "The reply above says why." };
  }
  const verb = del && input.permanent ? "Deleted" : "Moved";
  const sources = new Set(input.inbox.provider === "imap" ? input.succeeded.map(imapFolderOf) : []);
  const from = sources.size === 1 ? ` from ${folderLabel([...sources][0])}` : "";
  const to = del
    ? (input.permanent ? " permanently" : " to Trash")
    : ` to ${folderLabel(input.destination ?? "the folder")}`;
  const of = done < input.requested ? `${done.toLocaleString("en-US")} of ${count(input.requested)}` : count(done);
  const parts: string[] = [];
  if (input.failed > 0) parts.push(`${count(input.failed)} could not be ${del ? "deleted" : "moved"}.`);
  if (input.stopped) parts.push("The rest were left as they were.");
  if (del && input.permanent) parts.push("They did not go to Trash, so this cannot be undone.");
  return { headline: neutralizeText(`${verb} ${of}${from}${to}`), detail: neutralizeText(parts.join(" ")) };
}

/**
 * Build the card for a finished bulk move or delete, writing the Undo plan
 * when one can be offered. Returns the envelope to merge into
 * `structuredContent` and the `_meta` to merge into the result.
 *
 * Never throws: a failed insert just means no button. The mail operation
 * already happened and its text result is already correct.
 */
export async function buildBulkResultCard(
  deps: BulkDeps,
  caller: BulkCaller,
  input: BulkCardInput,
): Promise<{ envelope: Record<string, unknown>; meta: Record<string, unknown> | null }> {
  const { headline, detail } = bulkResultWords(input);
  const done = input.succeeded.length;
  const target = undoTarget(input, caller.scopes);
  let undo: { undo_id: string; expires_at: string } | null = null;

  if (target) {
    const at = deps.now ? deps.now() : Date.now();
    const back = folderLabel(target.back);
    // The FrozenScope bulk_execute reads (mcp-app-bulk.ts#readScope).
    const scope = {
      message_ids: target.ids,
      destination_id: target.back,
      destination_label: back,
      permanent: false,
      description: `Undo: ${count(target.ids.length)} back to ${back}`,
      folder: null,
    };
    try {
      const expiresAt = new Date(at + BULK_UNDO_TTL_MS).toISOString();
      const { data, error } = await deps.db
        .from("bulk_plans")
        .insert({
          workspace_id: caller.workspace_id,
          inbox_id: input.inbox.id,
          api_key_id: caller.id,
          operation: "email_organize",
          action: "move_batch",
          scope: { v: 1, data: await deps.encrypt(JSON.stringify(scope)) },
          scope_encrypted: true,
          match_count: target.ids.length,
          scope_kind: "undo",
          permanent: false,
          status: "pending",
          expires_at: expiresAt,
        })
        .select("id")
        .maybeSingle();
      if (error || !data) throw new Error(error?.message ?? "no row");
      undo = { undo_id: (data as { id: string }).id, expires_at: expiresAt };
      // Housekeeping, fire and forget: this workspace's undo rows a week past
      // expiry. Ordinary plans are left alone.
      void deps.db
        .from("bulk_plans")
        .delete()
        .eq("workspace_id", caller.workspace_id)
        .eq("scope_kind", "undo")
        .lt("expires_at", new Date(at - BULK_UNDO_KEEP_MS).toISOString())
        .then(() => {}, () => {});
    } catch (error) {
      console.error("[mcp-server] bulk_undo_record_failed", {
        inbox_id: input.inbox.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const untracked = done - (target?.ids.length ?? 0);
  const note = undo && untracked > 0
    ? `Undo puts back ${count(target!.ids.length)}; the server did not report where the other ${untracked} went.`
    : "";
  const outcome = done === 0 && input.requested > 0 ? "failed" : "executed";
  const envelope: Record<string, unknown> = {
    schema_version: CARD_SCHEMA_VERSION,
    card: "receipt",
    dashboard_url: `${deps.appUrl}/dashboard`,
    state: outcome === "failed" ? "error" : "executed",
    receipt: {
      outcome,
      headline,
      detail: [detail, note].filter(Boolean).join(" "),
      affected_count: done,
      dashboard_url: `${deps.appUrl}/dashboard`,
      error_code: null,
    },
    // Present = the card offers Undo, which calls bulk_execute with this id.
    ...(undo ? { undo } : {}),
  };
  const sample = (input.sample ?? []).slice(0, 5).map((s) => ({
    from: neutralizeText(String(s.from ?? "")).slice(0, 120),
    subject: neutralizeText(String(s.subject ?? "")).slice(0, 200),
  }));
  return { envelope, meta: sample.length > 0 && done > 0 ? { [BULK_SAMPLE_META_KEY]: sample } : null };
}
