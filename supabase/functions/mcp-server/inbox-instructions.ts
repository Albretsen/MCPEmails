// ---------------------------------------------------------------------------
// Per-inbox instructions (Pro feature `inbox_instructions`): the rules.
//
// The workspace writes standing instructions once per inbox in the dashboard
// ("This is the support inbox. Sign as the Support Team. Never reply to
// invoices; move them to Finance."), stored in inboxes.ai_instructions
// (migration 20261024235300). Every AI client then sees them:
//
//   inbox_list            each inbox carries `owner_instructions`
//   drafting / sending    draft create and reply, email_compose send, reply and
//                         forward: the result gets one labelled note
//
// Nothing else carries them: reads and searches stay as they are, so the text
// is paid for only where it changes what the model writes.
//
// Served only when the Pro gate ALLOWS (pro-features.ts). Not visible, or
// visible on a lower plan: the output is byte for byte what it was before the
// feature existed. That is also why `owner_instructions` is not declared in
// inbox_list's outputSchema: declaring it would change tools/list for every
// customer before launch, and the inbox item schema is additionalProperties:
// true, so a strict client accepts the field undeclared. The drafting note
// goes through `notes`, which every outputSchema already declares.
//
// Pure, dependency free: the web route imports normalizeInboxInstructionsInput
// from here, so the dashboard and the server apply one rule.
// ---------------------------------------------------------------------------

/** Longest instructions text stored or served, in characters. */
export const INBOX_INSTRUCTIONS_MAX_CHARS = 2000;

/** The label on the drafting/sending note. Kept short: it rides on every such result. */
export const INBOX_INSTRUCTIONS_NOTE_LABEL = "Inbox instructions from the owner:";

/** The inbox_list field. */
export const INBOX_INSTRUCTIONS_LIST_FIELD = "owner_instructions";

/**
 * The dispatch (legacy per-operation) names whose successful result carries
 * the note: draft create/reply and email_compose's send/reply/forward. Reads,
 * searches, organizing and draft update/send do not.
 */
export const INBOX_INSTRUCTIONS_NOTE_TOOLS: ReadonlySet<string> = new Set([
  "draft_create",
  "draft_reply",
  "email_send",
  "email_reply",
  "email_forward",
]);

// Trim only whitespace a person would not mean (spaces, tabs, line breaks);
// the database CHECK trims the same set.
function trimInstructions(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

/**
 * A stored value as it is served: trimmed, capped, or null when absent or
 * empty. Defensive, because the column could in principle hold anything a
 * service-role writer put there.
 */
export function normalizeStoredInboxInstructions(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = trimInstructions(raw);
  if (trimmed === "") return null;
  return trimmed.length > INBOX_INSTRUCTIONS_MAX_CHARS
    ? trimInstructions(trimmed.slice(0, INBOX_INSTRUCTIONS_MAX_CHARS))
    : trimmed;
}

export type InboxInstructionsInput =
  | { ok: true; value: string | null }
  | { ok: false; error: "invalid_instructions" | "too_long" };

/**
 * What a writer sends, as it is stored. `null` or an empty / whitespace-only
 * string clears the instructions. Text longer than the cap after trimming is
 * refused rather than cut: silently dropping the end of someone's rules would
 * serve rules they did not write.
 */
export function normalizeInboxInstructionsInput(raw: unknown): InboxInstructionsInput {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "invalid_instructions" };
  const trimmed = trimInstructions(raw);
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > INBOX_INSTRUCTIONS_MAX_CHARS) return { ok: false, error: "too_long" };
  return { ok: true, value: trimmed };
}

/** The note a drafting/sending result carries. */
export function inboxInstructionsNote(instructions: string): string {
  return `${INBOX_INSTRUCTIONS_NOTE_LABEL}\n${instructions}`;
}

/** Whether a dispatch name's successful result carries the note. */
export function carriesInboxInstructionsNote(dispatchName: string): boolean {
  return INBOX_INSTRUCTIONS_NOTE_TOOLS.has(dispatchName);
}

/**
 * Add `owner_instructions` to the inbox_list entries that have instructions.
 * Returns the entries untouched (same objects, same key order) when the map is
 * null, which is the not-allowed case, so the listing stays byte-identical.
 */
export function withOwnerInstructions<T extends { inbox_id: string }>(
  inboxes: T[],
  instructions: ReadonlyMap<string, string> | null,
): Array<T | (T & { owner_instructions: string })> {
  if (!instructions || instructions.size === 0) return inboxes;
  return inboxes.map((inbox) => {
    const text = instructions.get(inbox.inbox_id);
    return text ? { ...inbox, [INBOX_INSTRUCTIONS_LIST_FIELD]: text } as T & { owner_instructions: string } : inbox;
  });
}

/** Rows from `select id, ai_instructions` as a map of inbox id to served text. */
export function instructionsByInbox(
  rows: ReadonlyArray<{ id?: unknown; ai_instructions?: unknown }> | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows ?? []) {
    if (typeof row.id !== "string") continue;
    const text = normalizeStoredInboxInstructions(row.ai_instructions);
    if (text) map.set(row.id, text);
  }
  return map;
}
