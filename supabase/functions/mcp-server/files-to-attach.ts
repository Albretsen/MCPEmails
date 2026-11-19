// ---------------------------------------------------------------------------
// files-to-attach.ts - the draft card asks the user for files (2026-11-19).
//
// A file the user has on their own device reached a draft one way from the
// chat: the model wrote it out as base64 in `attachments[].data`. That costs
// about 4/3 of the file in output tokens (a 355 KB PDF came to ~150k), risks
// corrupt bytes, and models rightly warned users about it. The card already
// had a better route, its "Attach file" button (card -> draft_editor_save,
// no model tokens, apps/mcp-app/src/attachments.ts), but no tool description
// said so, so models never offered it.
//
// So the draft tools take `files_to_attach`: short names of files the user
// should add ("signed contract", "invoice.pdf"). The card shows each one as an
// Attach button beside the draft's files. Nothing is stored: the names ride on
// this result's envelope as `files_wanted`, and the card works out which are
// still open from the files the draft has (DraftEditor.tsx#openFileSlots).
//
// Stamped once at the end of dispatch, like card-tool-surface.ts, so every
// draft path (create, reply, update, the body-less update, Outlook) gets it
// without threading it through six builders. When no card is on the result,
// the model is told in one line, so it does not tell the user to look for a
// button that is not there.
// ---------------------------------------------------------------------------

import { cardEnvelopeIn } from "./card-diagnostics.ts";
import { neutralizeText } from "./text-safety.ts";

export const FILES_TO_ATTACH_MAX_ITEMS = 5;
export const FILES_TO_ATTACH_MAX_LENGTH = 80;
/** The envelope field the card reads (apps/mcp-app/src/contract.ts). */
export const FILES_WANTED_FIELD = "files_wanted";

/** The advertised property, on draft create, reply and update. */
export const FILES_TO_ATTACH_PROPERTY = {
  type: "array",
  items: { type: "string", maxLength: FILES_TO_ATTACH_MAX_LENGTH },
  maxItems: FILES_TO_ATTACH_MAX_ITEMS,
  description:
    "Short names of files the user will add to this draft, e.g. 'signed contract'. " +
    "The draft card shows each as an Attach button, so the file goes from the " +
    "user's device to the draft without passing through this conversation.",
} as const;

/** The tool names (and `draft` actions) a draft card can carry the slots on. */
const DRAFT_WRITE_TOOLS: ReadonlySet<string> = new Set(["draft_create", "draft_reply", "draft_update"]);
const DRAFT_WRITE_ACTIONS: ReadonlySet<string> = new Set(["create", "reply", "update"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The names a call asked for: trimmed, neutralised, clipped, de-duplicated,
 * at most five. Lenient on purpose: this is a display hint, and a malformed
 * one must never fail a draft write that already happened.
 */
export function parseFilesToAttach(raw: unknown): string[] {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const name = neutralizeText(entry).replace(/\s+/g, " ").trim().slice(0, FILES_TO_ATTACH_MAX_LENGTH);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
    if (names.length === FILES_TO_ATTACH_MAX_ITEMS) break;
  }
  return names;
}

/** True for a call that writes a draft: a draft_* write tool, or `draft` with one of those actions. */
export function isDraftWriteCall(toolName: string, args: unknown): boolean {
  if (DRAFT_WRITE_TOOLS.has(toolName)) return true;
  if (toolName !== "draft" || !isRecord(args)) return false;
  return typeof args.action === "string" && DRAFT_WRITE_ACTIONS.has(args.action);
}

/** What the model is told when it asked for files and no card shows them. */
export function noCardForFilesNote(names: readonly string[]): string {
  return (
    `files_to_attach: no draft card is shown here, so the user was not asked for ` +
    `${names.join(", ")}. They can add the files to the draft in their mail app.`
  );
}

/**
 * Put the asked-for names on a successful draft result's card. Returns the
 * note for the model when the call asked for files and there is no card to
 * ask in, and null otherwise (including when it asked for none).
 */
export function stampFilesWanted(
  result: { structuredContent?: unknown; isError?: unknown } | undefined,
  toolName: string,
  args: unknown,
): string | null {
  if (!result || result.isError === true) return null;
  if (!isDraftWriteCall(toolName, args) || !isRecord(args)) return null;
  const names = parseFilesToAttach(args.files_to_attach);
  if (names.length === 0) return null;
  const envelope = cardEnvelopeIn(result.structuredContent);
  if (envelope && envelope.card === "draft_editor") {
    envelope[FILES_WANTED_FIELD] = names;
    return null;
  }
  return noCardForFilesNote(names);
}
