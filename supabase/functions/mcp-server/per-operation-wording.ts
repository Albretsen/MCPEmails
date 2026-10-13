// ---------------------------------------------------------------------------
// Wording for the per-operation surface (the listing OpenAI clients get).
//
// The legacy tool definitions are read by two audiences. Their argument
// descriptions are merged into the consolidated tools, and several of them are
// advertised as they stand (folder_list, draft_list, schedule_list,
// email_search_and_move, contact_search), so their prose points at the
// consolidated surface: "email_organize (action 'move')", "the draft tool
// (action 'update')". On the per-operation surface those tools are not listed
// and nothing takes an operation-selecting `action`, so the same sentence
// would send a model after a tool it cannot see.
//
// The text cannot simply be edited at the source, because the consolidated
// listing must stay byte-identical. So the per-operation copy is derived: each
// phrase below is replaced, exactly, wherever it occurs in a listed
// description. per-operation-surface.test.ts holds both ends of that: no
// listed string may still name a consolidated-only tool or an action selector,
// and every entry here must still match something, so a phrase reworded at the
// source fails the test instead of silently going stale.
//
// Pure and dependency-free so it can be tested without booting the server.
// ---------------------------------------------------------------------------

/** Exact phrase on the consolidated surface → its per-operation wording. */
export const PER_OPERATION_REWORDINGS: ReadonlyArray<readonly [string, string]> = [
  [
    "then fetch the one file you need with action: attachment by its attachment_index",
    "then fetch the one file you need with email_attachment by its attachment_index",
  ],
  [
    "obtained from a previous call to email_read (action: list/read/search).",
    "obtained from a previous call to email_list, email_search or email_read.",
  ],
  ["from a prior email_read call.", "from a prior email_list, email_search or email_read call."],
  ["list from action: read.", "list from email_read."],
  [
    "Apply a read/unread/flag/unflag action to one or more messages in a single call. " +
    "Use action 'read' or 'unread' to change read status, or 'flag'/'unflag' to add or " +
    "remove a star/follow-up flag.",
    "Mark one or more messages read or unread, or add or remove a star/follow-up flag, in " +
    "a single call. Set flag_action to 'read' or 'unread' to change read status, or to " +
    "'flag'/'unflag' to add or remove the flag.",
  ],
  ["SEPARATE from email_organize, and flagged", "SEPARATE from email_move and email_move_batch, and flagged"],
  [
    "use email_organize (action 'move' or 'move_batch') instead",
    "use email_move or email_move_batch instead",
  ],
  [
    "finish any remainder with email_organize (action 'move_batch')",
    "finish any remainder with email_move_batch",
  ],
  ["the same cap as email_read action: read_batch", "the same cap as email_read_batch"],
  [
    "as the 'folder' argument for email_read (action 'list'), and as source/destination " +
    "for email_organize (action 'move')",
    "as the 'folder' argument for email_list, and as source/destination for email_move",
  ],
  [
    "with the draft tool (action 'update', 'send' or 'delete')",
    "with draft_update, draft_send or draft_delete",
  ],
  ["Use the schedule tool (action 'cancel') with the returned `id`", "Use schedule_cancel with the returned `id`"],
  [
    "reference form is email_compose's, not this tool's",
    "reference form belongs to email_send, email_reply and email_forward, not to this tool",
  ],
  ["as returned by action 'list' or 'create'", "as returned by automation_list or automation_create"],
  ["paged like email_read action: search", "paged like email_search"],
];

/**
 * A deep copy of `value` with every string reworded for the per-operation
 * surface. Keys are left alone: only prose changes, never a schema keyword or
 * a property name.
 */
export function perOperationWording(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [from, to] of PER_OPERATION_REWORDINGS) text = text.split(from).join(to);
    return text;
  }
  if (Array.isArray(value)) return value.map(perOperationWording);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map((
        [key, entry],
      ) => [key, perOperationWording(entry)]),
    );
  }
  return value;
}
