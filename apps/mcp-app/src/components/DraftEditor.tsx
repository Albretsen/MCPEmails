import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DraftEditorData, Envelope, Provider } from "../contract";
import type { SplitBody } from "../format";
import {
  bodyTextChanged,
  formatBytes,
  formatClockSeconds,
  formatDateTime,
  formatWhen,
  joinBody,
  normalizeEol,
  splitBody,
  wordCount,
} from "../format";
import { editsNotice, failureNotice, type DraftFailure } from "../draft-failure";
import { setTeardownSaver, type DraftCheck } from "../store";
import {
  clearUnsaved,
  fingerprint,
  loadUnsaved,
  saveUnsaved,
  type Unsaved,
  type UnsavedField,
} from "../unsaved";
import { RecipientField } from "./Recipients";
import type { EndedField, OnScreen } from "../ended";
import {
  AutoTextarea,
  Btn,
  copyLabel,
  FLASH_MS,
  HtmlBody,
  Notice,
  ProviderLine,
  TextLink,
  useCopy,
} from "./ui";

/** Only the fields the user actually changed are sent (§8: omitted means keep). */
export interface DraftPatch {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
}

export interface DraftActions {
  /** Resolves true when the server stored the change. */
  save: (patch: DraftPatch) => Promise<boolean>;
  /** A non-null patch means save first, and send only if that save worked. */
  send: (patch: DraftPatch | null) => void | Promise<void>;
  /**
   * The person checked their Sent folder after a send whose answer was lost and
   * wants Send back. See `sendDoubt`. Optional so a host of this component that
   * never loses a send need not provide it.
   */
  allowSend?: () => void;
  /**
   * `onScreen` is the draft as the person sees it, unsaved changes included,
   * so the line the card ends on can show it again ("Show"). Never sent.
   */
  discard: (onScreen?: OnScreen) => void;
  refresh: () => void;
  /**
   * Re-read the draft and resolve true when the mailbox's current copy is now
   * the one on screen. "Use the newer version" waits on it, so what it loads is
   * what the mailbox holds and never an older copy this card was mounted with.
   */
  loadCurrent?: () => Promise<boolean>;
  /** Turn the card off, for this inbox or for every inbox in the workspace. */
  hide: (scope: "inbox" | "workspace") => void;
  setFullscreen: (on: boolean) => void;
}

interface Props {
  env: Envelope;
  draft: DraftEditorData;
  provider?: Provider;
  fullscreen: boolean;
  canExpand: boolean;
  busy: string | null;
  error: string | null;
  /**
   * The editor's own last action failing without an envelope to say so: the
   * call threw, or the answer was unreadable. A failure the server DID describe
   * arrives on `env` instead (`state: "error"` and a receipt). Never raw text.
   */
  failure?: DraftFailure | null;
  /** Whether `draft` is known to be current. Absent means trusted. */
  check?: DraftCheck;
  /** A newer id this card held for the same draft. See store.ts#draftIdHint. */
  idHint?: string | null;
  /**
   * The identity of the tool call this card was mounted for
   * (`persist.ts#cardKey`). Unsaved edits are stashed under it, so a reload of
   * this card gets them back and another card on the same draft does not.
   */
  scope?: string | null;
  /**
   * A send from this card lost its answer, so it may have gone out. Send stays
   * off, whatever a re-read finds, until the person turns it back on.
   */
  sendDoubt?: boolean;
  /**
   * The assistant wrote a newer version of this draft after this card last saw
   * it, so a newer card exists (store.ts#supersededBy). The editor folds to one
   * line unless it holds unsaved edits.
   */
  superseded?: boolean;
  actions: DraftActions;
}

type Field = "to" | "cc" | "bcc";

const FIELDS: Field[] = ["to", "cc", "bcc"];
const FIELD_LABELS: Record<Field, string> = { to: "To", cc: "Cc", bcc: "Bcc" };

/**
 * How many lines the message box grows to before it starts scrolling itself.
 * Inline it is a cap (an inline card must auto-fit without moving the
 * conversation's own scroll); in fullscreen the surface is the point, so the
 * cap is effectively lifted.
 */
const INLINE_BODY_ROWS = 14;

/** How tall the signature box grows to once it is being edited. */
const SIGNATURE_ROWS = 6;

/**
 * The signature as one line: its first non-empty line, and a count of the rest.
 * Enough to recognise which signature it is without spending the room the
 * signature was taking in the first place.
 *
 * Split on EVERY line ending, not just LF. Until `splitBody` learned the CRLF
 * and CR separator forms this could only ever be handed an LF signature, so
 * `split("\n")` was enough; now that a signature from a real mail client
 * reaches it, splitting on LF alone welded a stray `\r` onto the first line
 * (CRLF) and, on a bare-CR signature, returned the WHOLE signature as one
 * "line" — the collapsed row then rendered every line of it, which is the
 * layout the split exists to protect.
 */
export function signaturePreview(signature: string): string {
  const lines = signature.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "Signature";
  const rest = lines.length - 1;
  return rest > 0 ? `${lines[0]} + ${rest} more line${rest === 1 ? "" : "s"}` : lines[0];
}
/**
 * Fullscreen lifts the cap altogether. It used to be 40 rows, so a long body
 * scrolled inside the box while the frame scrolled too: two nested scrollbars,
 * with Save and Send pushed off the bottom (QA, 2026-10-13). Now the box grows
 * with its text, the frame is the one thing that scrolls, and the action row
 * is sticky (styles.css).
 */
const FULLSCREEN_BODY_ROWS = 100_000;

/**
 * Deliberately loose. This is a typo catcher in front of a server that does the
 * real validation (§8: an invalid address is refused with `invalid_recipients`
 * and nothing is changed), not an RFC 5322 parser. It catches the mistakes
 * people actually make — no @, no dot in the domain, a stray space — and lets
 * anything else through to the server rather than blocking an address the
 * provider would have accepted.
 */
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>".]+(\.[^\s@,;<>".]+)+$/;

/** `Dana <dana@x.example>` -> `dana@x.example`. */
function bareAddress(input: string): string {
  const angled = /<([^>]+)>/.exec(input);
  return (angled ? angled[1] : input).trim();
}

/** Compare addresses the way a mailbox does: the bare address, any case. */
export function addressKey(input: string): string {
  return bareAddress(input).toLowerCase();
}

/**
 * Typed text cut at the commas and semicolons that separate addresses, and at
 * no others: not inside a quoted name (`"Doe, Jane" <jane@x.example>`) and not
 * inside angle brackets.
 */
function topLevelPieces(raw: string): string[] {
  const pieces: string[] = [];
  let cur = "";
  let quoted = false;
  let angled = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if ((ch === "," || ch === ";") && !quoted && !angled) {
      pieces.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  pieces.push(cur);
  return pieces;
}

/** `"Doe, Jane" <jane@x.example>` -> `Doe, Jane`. Null when there is none. */
function displayName(piece: string): string | null {
  const at = piece.indexOf("<");
  if (at <= 0) return null;
  const name = piece.slice(0, at).trim().replace(/^"(.*)"$/, "$1").trim();
  // Outlook writes `dana@x.example <dana@x.example>` when it has no name.
  return name && addressKey(name) !== addressKey(piece) ? name : null;
}

/**
 * One comma-separated piece cut further at whitespace, when that is safe:
 * `a@x.example b@x.example` is two addresses (QA, 2026-10-13), and so is
 * whatever follows a closing `>`. A piece with a name in it is left whole,
 * because a name has spaces of its own: only a run in which EVERY word is a
 * plain address is split.
 */
function spacePieces(piece: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  const push = () => {
    const words = cur.trim().split(/\s+/);
    const plain = !/[<"]/.test(cur) && words.length > 1 && words.every((w) => ADDRESS.test(w));
    out.push(...(plain ? words : [cur]));
    cur = "";
  };
  for (const ch of piece) {
    cur += ch;
    if (ch === '"') quoted = !quoted;
    else if (ch === ">" && !quoted) push();
  }
  if (cur.trim() || out.length === 0) push();
  return out;
}

/** One typed recipient: the bare address, and the display name it came with. */
export interface TypedRecipient {
  address: string;
  name: string | null;
}

/**
 * The recipients in what was typed, in order.
 *
 * A piece with no `@` that is followed by a `Name <address>` piece is the first
 * half of an unquoted display name with a comma in it, the way people write
 * `Doe, Jane <jane@x.example>`, and is glued back on. Splitting it used to
 * raise "Doe does not look like an email address" (QA, 2026-10-13).
 */
export function parseRecipients(raw: string): TypedRecipient[] {
  const pieces = topLevelPieces(raw);
  const out: string[] = [];
  let carry = "";
  for (let i = 0; i < pieces.length; i++) {
    const piece = carry ? `${carry},${pieces[i]}` : pieces[i];
    carry = "";
    const next = pieces[i + 1];
    if (!piece.includes("@") && piece.trim() && next !== undefined && next.includes("<")) {
      carry = piece;
      continue;
    }
    out.push(...spacePieces(piece));
  }
  return out
    .map((piece) => ({ address: bareAddress(piece), name: displayName(piece) }))
    .filter((r) => r.address);
}

/** The addresses in what was typed, bare, in order. See `parseRecipients`. */
export function splitAddresses(raw: string): string[] {
  return parseRecipients(raw).map((r) => r.address);
}

/**
 * Whether a comma typed at the end of `value` ends an address, as opposed to
 * being part of a name still being written (`Doe,` on the way to
 * `Doe, Jane <jane@x.example>`, or a comma inside quotes).
 */
export function commaEndsAddress(value: string): boolean {
  if ((value.match(/"/g) ?? []).length % 2 === 1) return false;
  if (value.lastIndexOf("<") > value.lastIndexOf(">")) return false;
  const pieces = topLevelPieces(value);
  return pieces[pieces.length - 1].includes("@");
}

/**
 * Whether `key`, typed at the end of `value`, finishes an address. Enter always
 * does. A comma does unless it is part of a name. A space does only after one
 * complete plain address, so `Dana Smith <dana@x.example>` can still be typed.
 */
export function keyEndsAddress(key: string, value: string): boolean {
  if (!value.trim()) return false;
  if (key === "Enter") return true;
  if (key === ",") return commaEndsAddress(value);
  if (key === " ") return ADDRESS.test(value.trim());
  return false;
}

/** The first piece of `raw` that is not an address, or null. */
function firstInvalid(raw: string): string | null {
  return splitAddresses(raw).find((p) => !ADDRESS.test(p)) ?? null;
}

/**
 * What to say about addresses that were typed and are fine but did not land as
 * typed: ones already in the field, and ones whose display name was left out.
 * The draft contract carries bare addresses only (contract.md, editor_save), so
 * a name cannot be kept; saying so beats dropping it without a word.
 */
function addressNote(
  field: Field,
  dupes: string[],
  named: string[],
): { field: Field; text: string } | null {
  const said: string[] = [];
  if (dupes.length === 1) said.push(`${dupes[0]} is already in ${FIELD_LABELS[field]}.`);
  else if (dupes.length > 1) said.push(`${dupes.length} of those are already in ${FIELD_LABELS[field]}.`);
  if (named.length > 0) {
    said.push(
      `${named.length === 1 ? `Added as ${named[0]}.` : "Added."} A draft keeps the address, not the name.`,
    );
  }
  return said.length > 0 ? { field, text: said.join(" ") } : null;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The From line in the header. The address alone, not "Name · address": the
 * header is one line shared with the status and the expand control, and the
 * display name is the half that can be reconstructed from the address.
 */
function fromAddress(d: DraftEditorData): string {
  return d.identity?.email_address ?? "unknown sender";
}

/**
 * The provider-level reason a save will be refused while attachments are
 * present. §8: `imapUpdateDraft` and `gmailUpdateDraft` rebuild the MIME from
 * parameters, so the server refuses rather than silently dropping the parts.
 * Outlook is a PATCH and may proceed, so it gets no warning.
 */
function attachmentRefusal(d: DraftEditorData): string | null {
  if ((d.attachments?.length ?? 0) === 0) return null;
  const provider = d.identity?.provider;
  if (provider !== "imap" && provider !== "gmail") return null;
  return "Saving is refused while this draft has attachments, because saving rebuilds the message and would drop them. Edit it in your mail client instead.";
}

/**
 * The failure to show, if any. The latest action's own failure first, because
 * it is the more recent fact; otherwise whatever the server last refused.
 * Mapped to the card's own sentences either way (draft-failure.ts).
 */
function currentFailure(env: Envelope, failure: DraftFailure | null | undefined): DraftFailure | null {
  if (failure) return failure;
  if (env.state !== "error") return null;
  // A failure that arrived without the card having asked (a pushed result).
  return {
    action: "save",
    code: String(env.receipt?.error_code ?? ""),
    headline: env.receipt?.headline ?? null,
  };
}

/**
 * How long after an inline confirm closes Save and Send ignore activation.
 * The confirm's buttons sit where those two reappear, so the second half of a
 * double click, or a held Enter, would otherwise land on them.
 */
export const CONFIRM_GUARD_MS = 500;

/** How long the editor waits after a keystroke before stashing unsaved edits. */
export const UNSAVED_DEBOUNCE_MS = 300;

/** How long a save or send runs before the card says it is still working. */
export const SLOW_WRITE_MS = 4_000;

/** Who the wait is on, for the still-working hint. */
function providerName(d: DraftEditorData): string {
  const p = d.identity?.provider;
  return p === "gmail" ? "Gmail" : p === "outlook" ? "Outlook" : "Your mail provider";
}

/** How long a note about a typed address stays under its field. */
export const ADDR_NOTE_MS = 5000;

/** How long "Copied" and the word after a Refresh stay before reverting. */
export { FLASH_MS };

/** Attachments, collapsed to one muted line. The card cannot edit them. */
function attachmentLine(d: DraftEditorData, fullscreen: boolean): string | null {
  const all = d.attachments ?? [];
  if (all.length === 0) return null;
  const shown = all.slice(0, fullscreen ? 8 : 3);
  const names = shown
    .map((a) => `${a.filename || "(unnamed)"} ${formatBytes(a.size_bytes)}`)
    .join(", ");
  const rest = all.length - shown.length;
  return `${all.length} attachment${all.length === 1 ? "" : "s"}: ${names}${
    rest > 0 ? `, +${rest} more` : ""
  }`;
}

/** Where the signature box has pinned the boundary. See `pinnedSplit`. */
interface SigPin {
  messageLen: number;
  separator: string;
}

/**
 * The split, held still while the signature box is open.
 *
 * `splitBody` picks the LAST separator in the text. That is the right rule for
 * text that arrived from a mailbox, but it makes the boundary move under the
 * user's cursor: type `\n-- \n` into the signature field and the separator plus
 * everything above it visibly jumps up into the message box on the next render.
 * Nothing is lost (the bytes are the same either way, which is why this was
 * never more than a wart), but it looks like the card ate half the signature.
 *
 * So while that box is open the boundary is remembered rather than re-derived.
 * It is re-validated against the live text every render and abandoned the moment
 * it no longer describes it, so the worst case is falling back to `splitBody` —
 * and either way `message + separator + signature` is still the same string,
 * which is the only property that reaches the server.
 */
export function pinnedSplit(text: string, pin: SigPin | null): SplitBody | null {
  if (!pin) return null;
  const end = pin.messageLen + pin.separator.length;
  if (end > text.length) return null;
  if (text.slice(pin.messageLen, end) !== pin.separator) return null;
  return {
    message: text.slice(0, pin.messageLen),
    separator: pin.separator,
    signature: text.slice(end),
  };
}

/**
 * One keystroke in the MESSAGE box: the new body text, and what becomes of the
 * pin.
 *
 * Pure and exported so the pin rule can be tested without a DOM. `split` is the
 * boundary this render drew (`pinnedSplit(...) ?? splitBody(...)`), which is the
 * one the user is looking at, so the join is against that and not against a
 * boundary re-derived from text they have already changed.
 *
 * The pin is carried forward ONLY when it is the boundary that render used.
 * This used to be an unconditional `if (pin) setSigPin({ ...pin, messageLen })`,
 * which kept maintaining a pin `pinnedSplit` had already rejected for this very
 * text. Today that state is unreachable — a pin is only ever created from a live
 * split, and neither box can invalidate one (the message box moves `messageLen`
 * by exactly the change in length, the signature box touches only the bytes
 * after the separator) — so this changes nothing a user can see. It is written
 * this way because the harmlessness is an accident of there being exactly two
 * body mutators, and because a rejected pin carried forward is NOT inert in
 * general: `{ messageLen: 5, separator: "\r\n--\r" }` is dead against
 * `"aa\r\n--\r\nsig"`, but retype the message down to one character and it
 * validates again at a boundary one byte short of the real separator, putting a
 * leading blank line into the signature box that `splitBody` would never draw.
 * Nothing is ever lost (the bytes still `joinBody` back byte-exactly), but it is
 * a wrong boundary revived from state the code had already discarded. Dropping
 * it just falls back to `splitBody`, which is the worst case the pin was
 * designed around anyway.
 */
export function applyMessageEdit(
  split: SplitBody,
  pin: SigPin | null,
  nextMessage: string,
): { bodyText: string; pin: SigPin | null } {
  const bodyText = joinBody({ ...split, message: nextMessage });
  // "The render used this pin" — which also covers the case where the pin was
  // rejected but `splitBody` independently landed on the same boundary, because
  // then the two are the same split and the pin is live either way.
  const live =
    pin !== null &&
    split.separator !== null &&
    pin.separator === split.separator &&
    pin.messageLen === split.message.length;
  // Editing the message moves the boundary by exactly the change in its length.
  // Without this the pin would stop matching on the next keystroke and the
  // boundary would snap back, which is the jump the pin exists to prevent.
  return {
    bodyText,
    pin: live ? { messageLen: nextMessage.length, separator: split.separator! } : null,
  };
}

export interface EditState {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** What is in the address inputs but not yet a chip. */
  typed: Record<Field, string>;
}

/**
 * What to send for `edited` given what the server holds in `stored`. Only the
 * fields that actually differ (§8: an omitted field means keep).
 *
 * Pure, and exported, because this is the function that decides whether a draft
 * is rewritten. It used to compare the body byte for byte, which is wrong in one
 * specific and very common way: the stored body is CRLF (a real mail client
 * wrote it) and the value a `<textarea>` hands back is LF, so every line read as
 * an edit the moment the user pressed any key. `dirty` could then never go back
 * to false, Save stayed enabled, the teardown saver stayed armed, and the patch
 * that went out carried the WHOLE body — which on a draft with a rich HTML part
 * made the server regenerate that part from the plain text and threw the
 * formatting away. See `bodyTextChanged`.
 *
 * What gets SENT when the body genuinely did change is `edited.bodyText`
 * verbatim, LF and all, NOT re-CRLF'd.
 *
 * ── AND NOTHING DOWNSTREAM PUTS THE CRLF BACK ──────────────────────────────
 * An earlier version of this comment claimed the server owns the wire format
 * and canonicalises on write. It does not, and it is worth being exact about
 * why, because the claim reads plausible: `draft{action:"editor_save"}` passes
 * `body_text` through to `updateDraft` as `body:` unchanged
 * (supabase/functions/mcp-server/mcp-app-drafts.ts), and the MIME builder
 * base64-encodes it verbatim — `encodeTextAsBase64Lines` runs
 * `new TextEncoder().encode(text)` on the body as given, and the `\r\n` it then
 * inserts wraps the BASE64 at 76 columns (RFC 2045). It is the encoding's line
 * ending, not the body's. Decode that part and the body's own endings are
 * exactly the bytes this function sent.
 *
 * So what actually happens, both reproduced in a browser:
 *
 *   - one character typed into a separator-less CRLF draft rewrites the WHOLE
 *     stored body to LF;
 *   - editing only the signature leaves a MIXED body: CRLF above the
 *     separator, LF below it.
 *
 * No user content is lost either way, and RFC 5322's CRLF requirement is one
 * most clients tolerate, so this is a correctness nicety rather than a live bug.
 * It is left alone on purpose rather than papered over here: whichever layer
 * ends up owning it (see the round-2 report), the card silently re-encoding
 * line endings it was never handed is not obviously the right answer, because
 *
 *   - it would save bytes nobody typed, and
 *   - a part-CRLF/part-LF body cannot be "restored" anyway: once the textarea
 *     has touched it the original endings are gone from the value, so the card
 *     can only impose one convention on the whole body, not recover the old one.
 *
 * The fix this function exists for is not about normalising what we send. It is
 * about never sending an unedited body at all.
 */
export function draftPatch(edited: EditState, stored: EditState): DraftPatch {
  const p: DraftPatch = {};
  if (!sameList(edited.to, stored.to)) p.to = edited.to;
  if (!sameList(edited.cc, stored.cc)) p.cc = edited.cc;
  if (!sameList(edited.bcc, stored.bcc)) p.bcc = edited.bcc;
  if (edited.subject !== stored.subject) p.subject = edited.subject;
  if (bodyTextChanged(edited.bodyText, stored.bodyText)) p.body_text = edited.bodyText;
  return p;
}

// ---------------------------------------------------------------------------
// Which version of the draft is on screen
// ---------------------------------------------------------------------------

/**
 * The version marker for one envelope's draft.
 *
 * Normally the server's (`mcp-app-drafts.ts#draftContentVersion`). The fallback
 * is for an envelope that predates the field — one restored from this browser's
 * storage, or one from an older edge function — and is the card's own content
 * SERIALISED rather than hashed. Exact, and impossible to drift from the
 * server's hash because it is not trying to match it: the two are never
 * compared for equality across sources, only against themselves, and a card
 * that meets both in one session simply resyncs once on the changeover. Hashing
 * it here would duplicate an algorithm for no benefit; the server hashes only
 * because it has to put the result on a wire and a 64 KB body does not fit.
 *
 * Everything volatile is left out for the reason `last_saved_at` is left out of
 * the server's: `last_saved_at`, `origin` and `last_saved_by` describe how the
 * draft was reached (and, before 2026-10-13, when the response was made), not
 * its content, and can change when the content has not.
 */
export function draftVersion(d: DraftEditorData): string {
  if (typeof d.version === "string" && d.version.length > 0) return d.version;
  return "c1:" + JSON.stringify([
    d.draft_id,
    d.recipients?.to ?? [],
    d.recipients?.cc ?? [],
    d.recipients?.bcc ?? [],
    d.subject ?? "",
    d.body?.text ?? null,
    d.body?.html ?? null,
    d.body?.truncated === true,
    (d.attachments ?? []).map((a) => [a.filename, a.size_bytes, a.mime_type]),
  ]);
}

/**
 * The patch, and the one rule that makes it safe: a patch is only ever computed
 * between an editor state and the server content it was DERIVED FROM.
 *
 * ── WHAT THIS REPLACED, AND WHY IT IS A FUNCTION ──────────────────────────
 * The editor keeps `edit` in state and recomputes `server` from props on every
 * render, and those two move at different times: props change in the render
 * itself, `edit` only once the resync effect has run. Between the two there is
 * a commit where `patch` is the OLD editor state diffed against the NEW server
 * content — a patch that describes a change nobody made. Both ways that patch
 * could escape were real:
 *
 *   - the teardown saver armed with it (`ui/resource-teardown` lands as its own
 *     task, so "one render" was long enough), writing the pre-refresh contents
 *     over the newer body;
 *   - Send, which computes its own patch in the click handler and is not gated
 *     on `dirty`.
 *
 * Both are closed here rather than at either call site, because the fix is not
 * "order the effects better" — it is that a patch across two different versions
 * is not a patch at all, and the only correct value for it is empty.
 *
 * Out of sync lasts from the render that first carries a new envelope until the
 * resync effect flushes, which is a frame rather than a render. Through it the
 * card reads as clean and Save is disabled, which is correct rather than a
 * compromise: at that instant the card knows of no edit relative to what the
 * server now has. The user's text is still on screen and still in `editRef`
 * either way; what is withheld is only the claim that it is a change.
 *
 * `editVersion` is null only if a caller never recorded one.
 */
export function editorPatch(
  editVersion: string | null,
  serverVersion: string,
  edited: EditState,
  stored: EditState,
): DraftPatch {
  if (editVersion !== serverVersion) return {};
  return draftPatch(edited, stored);
}

// ---------------------------------------------------------------------------
// Keeping the user's edits when the server copy moves under them
// ---------------------------------------------------------------------------

type ContentKey = "to" | "cc" | "bcc" | "subject" | "bodyText";
const CONTENT_KEYS: ContentKey[] = ["to", "cc", "bcc", "subject", "bodyText"];

/** The unsaved.ts name of a field. */
const STASH_FIELD: Record<ContentKey, UnsavedField> = {
  to: "to",
  cc: "cc",
  bcc: "bcc",
  subject: "subject",
  bodyText: "body_text",
};

/** Fingerprints of a server copy's fields, keyed the way `rebaseEdit` compares them. */
export type BasePrints = Partial<Record<ContentKey, string>>;

/** One field of a copy, fingerprinted under the same equality `differs` uses. */
export function fieldPrint(k: ContentKey, state: EditState): string {
  if (k === "subject") return fingerprint(state.subject);
  if (k === "bodyText") return fingerprint(normalizeEol(state.bodyText));
  return fingerprint(JSON.stringify(state[k]));
}

function differs(k: ContentKey, a: EditState, b: EditState): boolean {
  if (k === "subject") return a.subject !== b.subject;
  // The same rule `draftPatch` uses, so "held" and "dirty" cannot disagree.
  if (k === "bodyText") return bodyTextChanged(a.bodyText, b.bodyText);
  return !sameList(a[k], b[k]);
}

export interface Rebased {
  next: EditState;
  /** Fields still carrying the user's edit, i.e. still unsaved. */
  held: ContentKey[];
  /** Held fields the server ALSO changed: saving them overwrites that change. */
  conflicts: ContentKey[];
}

/**
 * Move the editor onto a new server copy WITHOUT dropping what the user typed.
 *
 * Field by field: a field the user changed since `base` keeps their value, and
 * every other field takes the server's. `base` is the content the editor state
 * was last derived from, so "changed since base" is exactly "the user's edit".
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * The resync used to be `edit = server`, wholesale. That was right for the one
 * case it was written for (adopt the id and content a save returned) and wrong
 * for every other arrival: a Refresh, a re-read after a lost response, the
 * verification of a re-mounted card. Each of those discarded unsaved typing the
 * moment the server copy differed at all, and the recovery from a failed save
 * IS such a read, so the fix for "the error took my text" would have taken the
 * text one step later.
 *
 * A save's own response still adopts the server's values for what was sent,
 * because the caller passes the SENT snapshot as `base`: those fields then read
 * as unchanged and take the server's (possibly normalised) copy, while anything
 * typed during the round trip differs from the snapshot and is kept.
 *
 * `keep` forces fields to be treated as the user's even when they equal
 * `base`. Edits restored from storage need it: they are relative to a server
 * copy this mount never saw, so they can coincide with a stale base.
 *
 * Uncommitted address text is never content the server has, so it is always
 * kept.
 */
export function rebaseEdit(
  cur: EditState,
  base: EditState,
  server: EditState,
  keep: readonly ContentKey[] = [],
  keepBases: BasePrints = {},
): Rebased {
  const next: EditState = { ...server, typed: cur.typed };
  const held: ContentKey[] = [];
  const conflicts: ContentKey[] = [];
  for (const k of CONTENT_KEYS) {
    const forced = keep.includes(k);
    if (!(forced || differs(k, cur, base)) || !differs(k, cur, server)) continue;
    (next as unknown as Record<string, unknown>)[k] = cur[k];
    held.push(k);
    // A restored field is not compared with `base` (this mount never saw the
    // copy it was made against) but with that copy's fingerprint, kept with
    // the edit: the server has changed the field since the person typed over
    // it exactly when the two differ (review 2 of 2026-10-13).
    if (forced) {
      const was = keepBases[k];
      if (was !== undefined && was !== fieldPrint(k, server)) conflicts.push(k);
    } else if (differs(k, base, server)) {
      conflicts.push(k);
    }
  }
  return { next, held, conflicts };
}

/**
 * Lay stored unsaved edits over a server copy. Returns which fields took, the
 * fingerprints of the copy each was made against, and which of them the
 * server has changed since (`conflicts`), so a restore over a draft that moved
 * says so the way a live edit does.
 */
export function restoreUnsaved(
  server: EditState,
  stored: Unsaved | null,
): {
  edit: EditState;
  keys: ContentKey[];
  any: boolean;
  bases: BasePrints;
  conflicts: ContentKey[];
} {
  const none = { edit: server, keys: [], any: false, bases: {}, conflicts: [] };
  if (!stored) return none;
  const edit: EditState = {
    ...server,
    to: stored.to ?? server.to,
    cc: stored.cc ?? server.cc,
    bcc: stored.bcc ?? server.bcc,
    subject: stored.subject ?? server.subject,
    bodyText: stored.body_text ?? server.bodyText,
    typed: {
      to: stored.typed?.to ?? "",
      cc: stored.typed?.cc ?? "",
      bcc: stored.typed?.bcc ?? "",
    },
  };
  const keys = CONTENT_KEYS.filter((k) => differs(k, edit, server));
  const any = keys.length > 0 || FIELDS.some((f) => edit.typed[f].trim().length > 0);
  if (!any) return none;
  const bases: BasePrints = {};
  for (const k of keys) {
    const was = stored.bases?.[STASH_FIELD[k]];
    if (was !== undefined) bases[k] = was;
  }
  const conflicts = keys.filter((k) => bases[k] !== undefined && bases[k] !== fieldPrint(k, server));
  return { edit, keys, any, bases, conflicts };
}

export function DraftEditor(props: Props) {
  const { env, draft: d, provider, fullscreen, busy, actions } = props;
  const canEdit = env.actor?.can_edit !== false;
  const inboxId = d.identity?.inbox_id ?? null;
  const check: DraftCheck = props.check ?? "trusted";
  /** The stash scope (unsaved.ts). Once known it stays: it names this card. */
  const scope = useRef<string | null>(props.scope ?? null);
  if (scope.current === null && props.scope) scope.current = props.scope;

  // Every id this editor has held for the draft, oldest first. It is the key
  // unsaved edits are stored under (unsaved.ts), and the first entry is the id
  // a replayed mount will come back with.
  const lineage = useRef<string[]>([]);
  for (const id of [d.draft_id, props.idHint]) {
    if (id && !lineage.current.includes(id)) lineage.current.push(id);
  }

  const server: EditState = {
    to: d.recipients?.to ?? [],
    cc: d.recipients?.cc ?? [],
    bcc: d.recipients?.bcc ?? [],
    subject: d.subject ?? "",
    bodyText: d.body?.text ?? "",
    typed: { to: "", cc: "", bcc: "" },
  };

  // Unsaved edits a previous mount of this draft left behind, laid over the
  // server copy before the first paint. Read once: after that the editor state
  // is the truth and storage follows it.
  const boot = useRef<ReturnType<typeof restoreUnsaved> | null>(null);
  if (boot.current === null) {
    boot.current = restoreUnsaved(
      server,
      canEdit ? loadUnsaved(inboxId, lineage.current, scope.current) : null,
    );
  }
  const [edit, setEdit] = useState<EditState>(boot.current.edit);
  // Shown until the user saves or drops them, so a restore is never mistaken
  // for what the mailbox holds.
  const [restored, setRestored] = useState(boot.current.any);
  /** Restored fields still held. Forced through `rebaseEdit` as the user's. */
  const restoredKeys = useRef<ContentKey[]>(boot.current.keys);
  /** What each restored field was made against. See `rebaseEdit`. */
  const restoredBases = useRef<BasePrints>(boot.current.bases);
  /**
   * The server changed a field the user is also editing. See `rebaseEdit`.
   * Starts true when restored edits were made against a copy the server has
   * since changed.
   */
  const [conflict, setConflict] = useState(boot.current.conflicts.length > 0);
  // The ref, not the state, is the source of truth for the action handlers.
  // Clicking Save first blurs the address input, and that blur commits a typed
  // address; reading `edit` in the click handler would read whatever was
  // rendered before the blur and silently save without the address the user
  // just added.
  const editRef = useRef(edit);
  /** The person chose to edit here although a newer card exists. */
  const [openAnyway, setOpenAnyway] = useState(false);
  const update = (patch: Partial<EditState>) => {
    const next = { ...editRef.current, ...patch };
    editRef.current = next;
    setEdit(next);
    // Edited while a newer card exists: it stays an editor from here on,
    // rather than folding the moment the edit is undone.
    if (props.superseded) setOpenAnyway(true);
  };

  /**
   * A recipient problem, and the field it is about. Drawn directly under that
   * field (it used to sit below the whole editor, far from the text it was
   * about), and re-checked as the person types a correction.
   */
  const [addrWarning, setAddrWarning] = useState<{ field: Field; text: string } | null>(null);
  /**
   * A short word about an address that was typed and is fine: it was already
   * in the field, or it came with a name the draft cannot keep. Both used to
   * happen silently (QA, 2026-10-13). Under the field, and gone after a moment.
   */
  const [addrNote, setAddrNote] = useState<{ field: Field; text: string } | null>(null);
  useEffect(() => {
    if (!addrNote) return;
    const timer = setTimeout(() => setAddrNote(null), ADDR_NOTE_MS);
    return () => clearTimeout(timer);
  }, [addrNote]);
  /**
   * Where focus goes after the next render. Several controls remove themselves
   * when used ("Cc Bcc", the signature's Edit, a chip's remove button), and a
   * focused element that leaves the DOM drops focus to the document, so the
   * next Tab starts over from the top of the frame (QA, 2026-10-13).
   */
  const focusNext = useRef<string | (() => HTMLElement | null | undefined) | null>(null);
  useLayoutEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const el = typeof f === "string" ? document.getElementById(f) : f();
    el?.focus();
  });
  const [showMore, setShowMore] = useState(false);
  const [editingSig, setEditingSig] = useState(false);
  const [sigPin, setSigPin] = useState<SigPin | null>(null);
  const [showHtml, setShowHtml] = useState(false);
  // "Copied" reverts, "Selected" stays (ui.tsx#useCopy).
  const { copied, copy } = useCopy();
  /** The signature as it was when its box opened, for Cancel. */
  const sigBefore = useRef<string | null>(null);
  const sigEditLink = useRef<HTMLButtonElement>(null);

  // ---- inline confirms, and where focus goes around them -------------------
  //
  // One at a time, so one piece of state. Three rules, all from the same QA
  // finding (2026-10-13: Discard, then "No" with Enter, left the focus ring on
  // "Save and send"):
  //
  //   1. Opening a confirm moves focus INTO it, onto the choice that changes
  //      nothing. That button is also first in the row, so the first Tab stop
  //      is never the destructive one.
  //   2. Closing one, by either answer or by Escape, puts focus back on the
  //      link that opened it. Left alone, the browser drops focus when the
  //      focused button is removed and the next Tab or Enter lands wherever
  //      the removed button used to be, which is the Send button.
  //   3. Save and Send ignore activation for `CONFIRM_GUARD_MS` after a
  //      confirm closes, for the pointer's version of the same accident.
  //
  // Nothing in this component ever calls focus() on Send.
  const [confirm, setConfirmState] = useState<null | "discard" | "off">(null);
  const confirmNow = useRef<null | "discard" | "off">(null);
  const returnTo = useRef<null | "discard" | "off">(null);
  const guardUntil = useRef(0);
  const discardLink = useRef<HTMLButtonElement>(null);
  /** The header's "⋯" button. Turning cards off is reached through it. */
  const menuButton = useRef<HTMLButtonElement>(null);
  const safeChoice = useRef<HTMLButtonElement>(null);
  const openConfirm = (which: "discard" | "off") => {
    confirmNow.current = which;
    setConfirmState(which);
  };
  const closeConfirm = () => {
    if (confirmNow.current === null) return;
    returnTo.current = confirmNow.current;
    confirmNow.current = null;
    guardUntil.current = Date.now() + CONFIRM_GUARD_MS;
    setConfirmState(null);
  };
  useLayoutEffect(() => {
    if (confirm) {
      safeChoice.current?.focus();
    } else if (returnTo.current) {
      (returnTo.current === "discard" ? discardLink : menuButton).current?.focus();
      returnTo.current = null;
    }
  }, [confirm]);
  const onConfirmKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    closeConfirm();
  };

  // ---- Hide and Show, and the "⋯" menu ---------------------------------------
  //
  // Hide folds THIS card to its header line and nothing else: no server call,
  // no preference, the draft and any unsaved edits stay exactly where they
  // were (the editor's state lives in this component, which stays mounted),
  // and Show puts it back. Until 2026-10-15 Hide was the permanent opt-out,
  // which is not what anyone clicking "Hide" on one card means. Turning the
  // card off for good now sits behind the header's "⋯" menu, one deliberate
  // step further away, with its own confirm (`confirm === "off"`).
  const [folded, setFolded] = useState(false);
  const toggleLink = useRef<HTMLButtonElement>(null);
  const refocusToggle = useRef(false);
  useLayoutEffect(() => {
    if (!refocusToggle.current) return;
    refocusToggle.current = false;
    toggleLink.current?.focus();
  }, [folded]);
  const toggleFold = () => {
    refocusToggle.current = true;
    // One line on an empty fullscreen page is not a place to be left.
    if (!folded && fullscreen) actions.setFullscreen(false);
    setFolded(!folded);
  };

  // The menu is a short in-flow panel under the header, never a popover: a
  // sandboxed frame clips anything positioned outside its own height, and an
  // inline card is only as tall as its content.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItem = useRef<HTMLButtonElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);
  const closeMenu = (refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) menuButton.current?.focus();
  };
  useLayoutEffect(() => {
    if (menuOpen) menuItem.current?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (menuWrap.current?.contains(t) || menuButton.current?.contains(t))) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menuOpen]);

  // The card MUST adopt every id the server returns (§8: on IMAP the id changes
  // on every save). This is where that happens: App replaces the envelope with
  // the response and the editor resyncs to it.
  //
  // Keyed on the CONTENT version, not on id + last_saved_at + origin. That
  // triple was a proxy for "this is a different version of the draft" and it
  // was false in both directions. Too eager, which is what shipped: every
  // server path stamped `last_saved_at` with the clock at response time (until
  // 2026-10-13; see contract.ts), so the key changed on every response and a refresh that
  // brought back a byte-identical draft still threw away whatever the user had
  // typed. And too lax, which is what it became the moment `last_saved_at`
  // started meaning what its name says (it now does): two responses agreeing
  // on the triple while the content had moved would leave `edit` describing the
  // old body, and Save would write it over the new one.
  //
  // `version` answers the question directly, so neither failure is available.
  // An error response still does not resync — it carries no `draft`, App keeps
  // the current one (see its callDraft), so the version does not move and the
  // user keeps the edits they were about to lose.
  const version = draftVersion(d);
  // The version `edit` was derived from. Written in the same effect that
  // replaces `edit`, and read by `editorPatch` below, which is what stops the
  // two from ever describing different versions.
  const editVersion = useRef(version);
  /** The server content `edit` was last derived from. `rebaseEdit`'s base. */
  const baseState = useRef(server);
  /**
   * What the last Save or Send put on the wire, and the version it was taken
   * against. Consumed by the resync below so a save's own response adopts the
   * server's copy of the fields that were sent. Ignored unless it was taken
   * against the version being left, and cleared when the call fails, so a
   * snapshot can never be mistaken for the base of some later arrival.
   */
  const sent = useRef<{ version: string; edit: EditState } | null>(null);
  /** `conflict`, readable from the teardown saver's closure. */
  const conflictNow = useRef(boot.current.conflicts.length > 0);
  /** `check`, readable from the teardown saver's closure. */
  const checkNow = useRef(check);
  checkNow.current = check;
  useEffect(() => {
    // Mount: `edit` was derived from this very version, restored edits and
    // all, so there is nothing to rebase and replacing it would undo a restore.
    if (editVersion.current === version) return;
    const snap = sent.current;
    sent.current = null;
    const base = snap && snap.version === editVersion.current
      ? snap.edit
      : baseState.current;
    const r = rebaseEdit(editRef.current, base, server, restoredKeys.current, restoredBases.current);
    editVersion.current = version;
    baseState.current = server;
    editRef.current = r.next;
    setEdit(r.next);
    restoredKeys.current = restoredKeys.current.filter((k) => r.held.includes(k));
    if (r.held.length === 0 && !FIELDS.some((f) => r.next.typed[f].trim())) {
      setRestored(false);
    }
    setConflict(r.conflicts.length > 0);
    conflictNow.current = r.conflicts.length > 0;
    if (!FIELDS.some((f) => r.next.typed[f].trim())) setAddrWarning(null);
    closeConfirm();
    // A boundary pinned into the old body may describe nothing in the new one.
    // Dropped rather than re-validated.
    setSigPin(null);
    setEditingSig(false);
  }, [version]);

  // Every patch taken during a render goes through here: this render's
  // `dirty`, Save and Send. The teardown saver calls `editorPatch` itself, for
  // the reason its own comment gives — it needs the LIVE envelope, not this
  // render's. See `editorPatch` for why the guard is inside the function rather
  // than at any of the call sites.
  const patchFrom = (e: EditState): DraftPatch =>
    editorPatch(editVersion.current, version, e, server);

  const patch = patchFrom(edit);
  const dirty = Object.keys(patch).length > 0;
  // Text in an address field that is not a chip yet. Not part of the patch
  // (it is not an address until it is committed), but it IS unsaved work, and
  // Save must be pressable for it so that pressing it either commits it or says
  // why it cannot (`readyToWrite`), instead of doing nothing.
  const typedPending = FIELDS.some((f) => edit.typed[f].trim().length > 0);
  const patchKey = JSON.stringify(patch);

  // The server content and version of the LATEST render, readable from a
  // closure that was made during an earlier one. Assigned during render on
  // purpose: the teardown saver below is the one thing in the card that fires
  // at a moment nothing else controls, and it has to see the current envelope,
  // not the one that was current when it was armed.
  const live = useRef({ version, server });
  live.current = { version, server };

  // Unsaved work at teardown. The host sends `ui/resource-teardown` before the
  // frame goes away and waits for the reply, so this is the last moment a
  // half-typed edit can be written. Registered only while there is something to
  // write.
  //
  // ── WHY THE PATCH IS RE-DERIVED AT FIRE TIME ──────────────────────────────
  // It used to be frozen at arm time, and a frozen patch is stale from the
  // instant the envelope moves. Arming and disarming both happen in effects,
  // which flush a frame after the render that triggered them, whereas
  // `ui/resource-teardown` arrives as its own task: a teardown between a new
  // envelope landing and this effect re-running fired a saver armed against the
  // PREVIOUS version and wrote the pre-refresh editor contents over the newer
  // body. Re-deriving closes that whole class rather than narrowing it, because
  // the answer is then computed from the live editor state and the live
  // envelope at the only moment that matters, and `editorPatch` returns nothing
  // at all when those two describe different versions.
  //
  // It is also what the frozen snapshot was reaching for: "the current one"
  // read from `editRef` at fire time is more current than any re-arming can be.
  useEffect(() => {
    // `dirty` is derived from exactly these keys, so this test is redundant
    // with the one inside the saver. It is written out anyway because the
    // failure it guards is the expensive one: an empty patch reaching the
    // server is a whole-body rewrite of a draft the user only looked at, and
    // teardown fires with no one watching. Nothing goes out unless a field
    // actually differs.
    if (!canEdit || !dirty) {
      setTeardownSaver(null);
      return;
    }
    setTeardownSaver(() => {
      const now = live.current;
      // Not while the edits are in doubt. A teardown save happens with nobody
      // watching, and both of these are states the card is asking the user to
      // look at first: edits put back from storage over a draft that may have
      // moved, and an edit to a field the server has since changed. They are
      // not lost by waiting; unsaved.ts still holds them for the next mount.
      //
      // Nor while the draft itself is in doubt (`check` other than trusted): a
      // replay not yet verified, or a write whose answer was lost. The patch is
      // relative to a copy that may no longer be what the mailbox holds.
      if (
        conflictNow.current || restoredKeys.current.length > 0 ||
        checkNow.current !== "trusted"
      ) {
        return Promise.resolve(false);
      }
      const p = editorPatch(editVersion.current, now.version, editRef.current, now.server);
      if (Object.keys(p).length === 0) return Promise.resolve(false);
      return Promise.resolve(actions.save(p)).then((ok) => {
        // Written, so there is nothing left at risk for a reload to restore.
        if (ok) clearUnsaved(inboxId, lineage.current, scope.current);
        return ok;
      });
    });
    return () => setTeardownSaver(null);
  }, [patchKey, canEdit]);

  // ---- unsaved edits survive a reload --------------------------------------
  //
  // Debounced on every change, and written at once when the page is going
  // away: `pagehide` is the last event a reloading frame gets, and
  // sessionStorage is synchronous, which a tool call is not. A clean editor
  // removes its entry, so storage only ever holds work that is at risk.
  // Leaving the screen for good (sent, discarded, hidden) removes it too: that
  // is the unmount below, which a reload never runs.
  const stashNow = useRef<() => void>(() => {});
  stashNow.current = () => {
    if (!canEdit) return;
    const now = live.current;
    // Mid-resync the diff would be across two versions. Skip; the effect that
    // settles it changes `stashKey` and comes back through here.
    if (editVersion.current !== now.version) return;
    const cur = editRef.current;
    const p = draftPatch(cur, now.server);
    if (Object.keys(p).length > 0 || FIELDS.some((f) => cur.typed[f].trim())) {
      // What each edited field was made against: the copy restored edits were
      // laid over keeps its own (the person's edit predates this mount), every
      // other field is relative to the server copy on screen.
      const bases: Partial<Record<UnsavedField, string>> = {};
      for (const k of CONTENT_KEYS) {
        if (!(STASH_FIELD[k] in p)) continue;
        bases[STASH_FIELD[k]] = restoredKeys.current.includes(k) && restoredBases.current[k] !== undefined
          ? restoredBases.current[k]!
          : fieldPrint(k, now.server);
      }
      saveUnsaved(inboxId, lineage.current, { ...p, typed: cur.typed, bases }, scope.current);
    } else {
      clearUnsaved(inboxId, lineage.current, scope.current);
    }
  };
  const stashKey = JSON.stringify([patch, edit.typed, d.draft_id]);
  useEffect(() => {
    const timer = setTimeout(() => stashNow.current(), UNSAVED_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [stashKey]);
  useEffect(() => {
    const flushOut = () => stashNow.current();
    window.addEventListener("pagehide", flushOut);
    document.addEventListener("visibilitychange", flushOut);
    return () => {
      window.removeEventListener("pagehide", flushOut);
      document.removeEventListener("visibilitychange", flushOut);
      clearUnsaved(inboxId, lineage.current, scope.current);
    };
  }, []);

  // ---- a word after a Refresh that worked ----------------------------------
  //
  // A re-read that finds nothing new changes nothing on screen, which read as
  // the link doing nothing (QA, 2026-10-13). So the link itself answers for a
  // moment, the way it already says "Refreshing": no new line, no layout jump.
  // A re-read that failed says so in its own notice and gets no word here, and
  // neither does one the card started itself to check a draft it did not yet
  // trust: that one ends with its own line going away.
  const [refreshed, setRefreshed] = useState<null | "same" | "updated">(null);
  const refreshFrom = useRef<string | null>(null);
  const refreshOk = !currentFailure(env, props.failure) && check === "trusted";
  useEffect(() => {
    if (busy === "refresh") {
      refreshFrom.current = check === "trusted" ? version : null;
      setRefreshed(null);
      return;
    }
    const from = refreshFrom.current;
    refreshFrom.current = null;
    if (from === null || busy !== null || !refreshOk) return;
    setRefreshed(from === version ? "same" : "updated");
  }, [busy]);
  useEffect(() => {
    if (!refreshed) return;
    const timer = setTimeout(() => setRefreshed(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [refreshed]);

  /** Drop every local edit and show what the mailbox holds. */
  const useStored = () => {
    const now = live.current;
    restoredKeys.current = [];
    conflictNow.current = false;
    editRef.current = now.server;
    setEdit(now.server);
    setRestored(false);
    setConflict(false);
    setAddrWarning(null);
    setSigPin(null);
  };

  // "Use the newer version" reads the draft again FIRST. `useStored` alone
  // adopts whatever copy this render holds, and on a remounted card that can
  // be the result the card was first mounted with: QA (2026-10-13) clicked it
  // and got the assistant's original draft, the oldest version there was. The
  // edits are dropped only once a read has come back, in the effect, which
  // runs after the render (and the resync above) that carries that read.
  const [takeStored, setTakeStored] = useState(0);
  const useNewer = () => {
    const load = actions.loadCurrent;
    if (!load) return useStored();
    void load().then((ok) => {
      if (ok) setTakeStored((n) => n + 1);
    });
  };
  useEffect(() => {
    if (takeStored > 0) useStored();
  }, [takeStored]);

  // A save or send that is taking a while says so, in the line under the
  // buttons that is always there, so nothing moves.
  const writing = busy === "save" || busy === "send";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!writing) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_WRITE_MS);
    return () => clearTimeout(timer);
  }, [writing]);

  /**
   * Turn whatever is still in the address inputs into chips, synchronously,
   * and return the resulting state. Invalid addresses are kept in the input
   * and reported, never dropped and never thrown.
   */
  const flush = (): EditState => {
    const cur = editRef.current;
    const next: EditState = {
      ...cur,
      to: [...cur.to],
      cc: [...cur.cc],
      bcc: [...cur.bcc],
      typed: { ...cur.typed },
    };
    let bad: { field: Field; text: string } | null = null;
    let note: { field: Field; text: string } | null = null;
    for (const field of FIELDS) {
      const raw = next.typed[field];
      if (!raw.trim()) continue;
      const typed = parseRecipients(raw);
      const parts = typed.map((r) => r.address);
      const invalid = parts.filter((p) => !ADDRESS.test(p));
      // Case-insensitive, like the mailbox: `Dana@X.example` next to
      // `dana@x.example` is the same recipient twice (QA, 2026-10-13).
      const have = new Set(next[field].map(addressKey));
      const dupes: string[] = [];
      const named: string[] = [];
      for (const { address: p, name } of typed) {
        if (!ADDRESS.test(p)) continue;
        if (have.has(addressKey(p))) {
          dupes.push(p);
          continue;
        }
        have.add(addressKey(p));
        next[field].push(p);
        if (name) named.push(p);
      }
      note = note ?? addressNote(field, dupes, named);
      // Only what could NOT be added stays in the input, so the field shows
      // exactly the text that needs fixing.
      next.typed[field] = invalid.join(", ");
      if (invalid.length > 0) {
        bad = bad ?? {
          field,
          text: `${invalid[0]} does not look like an email address, so it was not added.`,
        };
      }
    }
    editRef.current = next;
    setEdit(next);
    setAddrWarning(bad);
    setAddrNote(note);
    return next;
  };

  /**
   * The editor state to write, or null when it must not be written yet.
   *
   * Save and Send both come through here. Text left in an address field is
   * either a chip-to-be (and `flush` just made it one) or not an address, and
   * the second kind used to be saved AROUND: the write went out without it, the
   * resync cleared the field, and a mistyped recipient was simply left off the
   * mail with nothing on screen to say so (QA, 2026-10-13). Now it blocks, the
   * caret goes to it, and the warning says what to do.
   *
   * Also refuses during the one frame in which the editor state and the server
   * copy describe different versions (`editorPatch`), and for a moment after an
   * inline confirm closes (`CONFIRM_GUARD_MS`). In both the honest answer to
   * "what would this send" is "not what you are looking at".
   */
  const readyToWrite = (): EditState | null => {
    if (busy !== null || Date.now() < guardUntil.current) return null;
    if (editVersion.current !== version) return null;
    const next = flush();
    const bad = FIELDS.find((f) => next.typed[f].trim().length > 0);
    if (!bad) return next;
    setAddrWarning({
      field: bad,
      text: `"${next.typed[bad].trim()}" in ${FIELD_LABELS[bad]} is not a complete email address. Fix it or remove it, then try again. Nothing was saved or sent.`,
    });
    document.getElementById(`d-${bad}`)?.focus();
    return null;
  };

  /** Put the subject and message on the clipboard, or at least select them. */
  const copyText = () => {
    const cur = editRef.current;
    const text = cur.subject ? `${cur.subject}\n\n${cur.bodyText}` : cur.bodyText;
    copy(text, () => {
      // Selecting the message leaves the user one keystroke from the same result.
      const ta = document.getElementById("d-body") as HTMLTextAreaElement | null;
      ta?.focus();
      ta?.select();
    });
  };

  /**
   * The draft as it is on screen, for the line Discard ends on. Text left in
   * an address field counts as what the person had, and every field that
   * differs from the stored copy is named, so the view can say it was never
   * saved.
   */
  const onScreen = (): OnScreen => {
    const cur = editRef.current;
    const p = draftPatch(cur, live.current.server);
    const unsaved: EndedField[] = [];
    const list = (f: Field) => {
      const typed = cur.typed[f].trim();
      if (f in p || typed) unsaved.push(f);
      return typed ? [...cur[f], typed] : [...cur[f]];
    };
    const to = list("to");
    const cc = list("cc");
    const bcc = list("bcc");
    if ("subject" in p) unsaved.push("subject");
    if ("body_text" in p) unsaved.push("body");
    return { to, cc, bcc, subject: cur.subject, body_text: cur.bodyText, unsaved };
  };

  const commitField = (field: Field, raw: string) => {
    update({ typed: { ...editRef.current.typed, [field]: raw } });
    flush();
  };

  /** Typing in an address field: keep the warning about it current. */
  const onAddrInput = (field: Field, value: string) => {
    update({ typed: { ...editRef.current.typed, [field]: value } });
    setAddrNote(null);
    setAddrWarning((w) => {
      if (!w || w.field !== field) return w;
      const bad = value.trim() ? firstInvalid(value) : null;
      if (!bad) return null;
      return { field, text: `${bad} is not a complete email address yet.` };
    });
  };

  /** Focus after a removal is the field's own business (Recipients.tsx). */
  const removeAt = (field: Field, i: number) => {
    const kept = editRef.current[field].filter((_, n) => n !== i);
    update(
      field === "to" ? { to: kept } : field === "cc" ? { cc: kept } : { bcc: kept },
    );
  };

  /**
   * One recipient row: a 32px label and ONE bordered box that holds both the
   * chips and the input. They used to be a label, a chip list and a separate
   * full-width input stacked into three rows per field, which is where most of
   * the card's height went.
   */
  const recipientRow = (field: Field, trailing?: ComponentChildren) => (
    <RecipientField
      id={`d-${field}`}
      label={FIELD_LABELS[field]}
      items={edit[field]}
      typed={edit.typed[field]}
      canEdit={canEdit}
      invalid={addrWarning?.field === field}
      describedBy={addrWarning?.field === field ? `d-${field}-warn` : undefined}
      endsAddress={keyEndsAddress}
      onType={(v) => onAddrInput(field, v)}
      onCommit={(v) => commitField(field, v)}
      onRemove={(i) => removeAt(field, i)}
      trailing={trailing}
    />
  );

  /** A recipient row, with its own warning directly under it. */
  const recipientBlock = (field: Field, trailing?: ComponentChildren) => (
    <>
      {recipientRow(field, trailing)}
      {addrWarning?.field === field && (
        <div class="notice fld-note" data-tone="warning" role="status" id={`d-${field}-warn`}>
          {addrWarning.text}
        </div>
      )}
      {addrNote?.field === field && (
        <div class="line fld-note" role="status" id={`d-${field}-note`}>
          {addrNote.text}
        </div>
      )}
    </>
  );

  const refusal = attachmentRefusal(d);
  const failed = currentFailure(env, props.failure);
  const err = failed ? failureNotice(failed) : null;
  const hasHtml = !!d.body?.html;
  // A draft that is not known to be current is neither saved nor sent from.
  // See store.ts#DraftCheck.
  const verified = check === "trusted";
  const sendDoubt = props.sendDoubt === true;
  // Send follows what is on screen NOW, not what the server last stored: with
  // every recipient removed it used to stay on until that was saved (QA,
  // 2026-10-13). `can_send` is "the key may send AND the stored draft has a
  // recipient", so false over a stored draft with nobody on it says nothing
  // about the key; the server still refuses a send the key may not make.
  const storedHasRecipient = FIELDS.some((f) => server[f].length > 0);
  const keyMaySend = d.can_send === true || !storedHasRecipient;
  // Text still in an address field: a recipient if it is one, a blocker if not.
  const pendingBad = FIELDS.find(
    (f) => edit.typed[f].trim().length > 0 && firstInvalid(edit.typed[f]) !== null,
  );
  const hasRecipient = FIELDS.some(
    (f) => edit[f].length > 0 || splitAddresses(edit.typed[f]).length > 0,
  );
  const canSend = keyMaySend && hasRecipient && !pendingBad && canEdit && verified && !sendDoubt;
  /** The one notice about the person's own edits, if any (draft-failure.ts). */
  const editsNote = editsNotice({ canEdit, check, restored, conflict });
  const saving = busy === "save";
  const sending = busy === "send";
  const attachLine = attachmentLine(d, fullscreen);
  // Which of Cc / Bcc are neither populated nor already revealed.
  const hiddenFields: Field[] = showMore
    ? []
    : (["cc", "bcc"] as Field[]).filter((f) => edit[f].length === 0);
  // No "saving gives the draft a new id" note any more. It was the card's own
  // fallback for when the provider caveats did not say it, and it is no longer
  // true in the way that mattered: an old id keeps working through the server's
  // draft lineage, and `provider.caveats` is now empty on IMAP too.

  // A draft on screen is in Drafts, so it HAS been saved, even when nobody
  // recorded when (`last_saved_at: null` on a read of a draft with no lineage
  // and no provider date). "Not saved yet" was false there.
  const savedBy =
    d.last_saved_by === "user" ? " by you" : d.last_saved_by === "agent" ? " by the assistant" : "";
  const savedLine = d.last_saved_at
    ? `Saved ${formatWhen(d.last_saved_at)}${savedBy}`
    : `Saved earlier${savedBy}`;

  // Derived, never stored: `edit.bodyText` stays the single source of truth for
  // what will be saved, and this is only how it is presented.
  const split = pinnedSplit(edit.bodyText, sigPin) ?? splitBody(edit.bodyText);

  // ---- the signature's formatting ------------------------------------------
  //
  // `signature.rich`: the stored HTML part carries the inbox's formatted
  // signature (logo, links, a layout table). A body-only edit keeps it; editing
  // the signature LINES replaces it with plain text, which QA found happening
  // with no warning (2026-10-13). So the card warns as soon as the signature box
  // opens, and once the signature differs locally the old formatted preview is
  // no longer offered: it would show a signature that saving is about to drop.
  const storedSplit = splitBody(server.bodyText);
  const sigEdited =
    storedSplit.signature !== null &&
    (split.signature === null ||
      normalizeEol(split.signature) !== normalizeEol(storedSplit.signature));
  const richSig = d.signature?.rich === true;
  const formattingAtRisk = richSig && sigEdited;
  const canPreview = hasHtml && !formattingAtRisk;
  /** Put the stored signature back, keeping the message as typed. */
  const undoSignature = () => {
    if (split.separator === null || storedSplit.signature === null) return;
    update({ bodyText: joinBody({ ...split, signature: storedSplit.signature }) });
  };

  /** Save: also what "Try again" in a failure notice runs. */
  const onSave = () => {
    if (!canEdit || !verified) return;
    const next = readyToWrite();
    if (!next) return;
    const p = patchFrom(next);
    if (Object.keys(p).length === 0) return;
    sent.current = { version, edit: next };
    void actions.save(p).then((ok) => {
      if (ok) {
        // Saved on purpose, so they are no longer "put back" edits.
        restoredKeys.current = [];
        setRestored(false);
      } else if (sent.current?.edit === next) sent.current = null;
    });
  };

  /** Open the signature box, holding the boundary where it is now. */
  const startEditingSig = () => {
    if (split.separator !== null) {
      setSigPin({ messageLen: split.message.length, separator: split.separator });
    }
    sigBefore.current = split.signature;
    setEditingSig(true);
    // The Edit link (or the row) that was activated is replaced by the box.
    focusNext.current = "d-signature";
  };

  /**
   * Close the signature box and put the signature back as it was when the box
   * opened. The message keeps whatever was typed into it meanwhile. Focus
   * returns to Edit, which is what opened the box.
   */
  const cancelSig = () => {
    if (split.separator !== null && sigBefore.current !== null) {
      update({ bodyText: joinBody({ ...split, signature: sigBefore.current }) });
    }
    setSigPin(null);
    setEditingSig(false);
    focusNext.current = () => sigEditLink.current;
  };

  // ---- a newer card exists ---------------------------------------------------
  //
  // One line instead of a second full editor over the same draft. Never while
  // this card holds unsaved work, and never during the frame in which the
  // editor state has not caught up with the envelope (`editorPatch`), when
  // `dirty` cannot be believed. "Edit here anyway" is the way back: the
  // detection is an inference from the draft's history, not a host signal.
  if (
    props.superseded === true && !openAnyway && !dirty && !typedPending && !restored &&
    editVersion.current === version && busy === null
  ) {
    return <Superseded fullscreen={fullscreen} actions={actions} onOpen={() => setOpenAnyway(true)} />;
  }

  const foldLink = (
    <TextLink
      btnRef={toggleLink}
      expanded={!folded}
      title={folded ? "Show the draft again" : "Fold this card to one line. Nothing is changed."}
      onClick={toggleFold}
    >
      {folded ? "Show" : "Hide"}
    </TextLink>
  );

  const menuToggle = (
    <button
      type="button"
      class="link menu-btn"
      ref={menuButton}
      aria-label="More options"
      title="More options"
      aria-haspopup="menu"
      aria-expanded={menuOpen ? "true" : "false"}
      onClick={() => (menuOpen ? closeMenu(false) : setMenuOpen(true))}
    >
      ⋯
    </button>
  );

  // The menu, or the turn-off confirm it leads to, directly under the header
  // in both the open and the folded card. The confirm is offered at two
  // grains because the card cannot guess which one is meant: one mailbox is
  // "this account is noisy", all of them is "I do not want this feature".
  const menuPanel = confirm === "off" ? (
    // The choice that changes nothing comes FIRST and takes focus.
    <div class="acts menu-confirm" onKeyDown={(e) => onConfirmKey(e as unknown as KeyboardEvent)}>
      <span class="line grow">
        Turn off draft cards? Drafts keep working, the assistant just describes
        them in text. To turn the cards back on, use "Show the draft editor
        card" in the MCP Emails dashboard.
      </span>
      <Btn soft variant="quiet" btnRef={safeChoice} onClick={closeConfirm}>
        Cancel
      </Btn>
      <Btn
        soft
        busy={busy !== null}
        title="Only for this mailbox"
        onClick={() => {
          closeConfirm();
          actions.hide("inbox");
        }}
      >
        This inbox
      </Btn>
      <Btn
        soft
        busy={busy !== null}
        title="Every mailbox in this workspace"
        onClick={() => {
          closeConfirm();
          actions.hide("workspace");
        }}
      >
        All inboxes
      </Btn>
    </div>
  ) : menuOpen ? (
    <div
      class="menu"
      role="menu"
      aria-label="More options"
      ref={menuWrap}
      onKeyDown={(e) => {
        if (e.key !== "Escape" && e.key !== "Tab") return;
        if (e.key === "Escape") e.preventDefault();
        closeMenu(e.key === "Escape");
      }}
    >
      <button
        type="button"
        role="menuitem"
        class="menu-item"
        ref={menuItem}
        onClick={() => {
          setMenuOpen(false);
          openConfirm("off");
        }}
      >
        Turn off draft cards…
      </button>
    </div>
  ) : null;

  // ---- folded: one line, Show brings the editor back as it was ---------------
  if (folded) {
    return (
      <>
        <div class="hdr">
          <div class="hdr-l">
            <b>Draft</b>
            <span class="muted">{edit.subject.trim() || "No subject"}</span>
          </div>
          <div class="hdr-r">
            {(dirty || typedPending) && <span class="muted">Unsaved changes</span>}
            {foldLink}
            {menuToggle}
          </div>
        </div>
        {menuPanel}
      </>
    );
  }

  return (
    <>
      {/* Everything above the action row. Inline it is not a box at all
          (`display: contents`); in fullscreen it is the one thing that scrolls,
          so the action row sits under it instead of over it (styles.css). Its
          children are deliberately not indented a level further. */}
      <div class="ed-main">
      <div class="hdr">
        <div class="hdr-l">
          {/* No status dot here. The other cards use one to carry a state the
              words do not (sent, rejected, expired); this card's state is the
              word "Draft" immediately beside it, so the dot was an amber signal
              with nothing to signal and no legend to read it by. */}
          <b>Draft</b>
          <span class="muted">{fromAddress(d)}</span>
        </div>
        <div class="hdr-r">
          {fullscreen ? (
            <TextLink onClick={() => actions.setFullscreen(false)}>
              Collapse
            </TextLink>
          ) : props.canExpand ? (
            <TextLink
              onClick={() => actions.setFullscreen(true)}
              title="More room to write"
            >
              Expand
            </TextLink>
          ) : null}
          <span class="muted">
            {savedLine}
            {dirty || typedPending ? " · Unsaved changes" : ""}
          </span>
          {foldLink}
          {menuToggle}
        </div>
      </div>
      {menuPanel}

      {d.in_reply_to && (
        <p class="line">
          Replying to {d.in_reply_to.from || "an earlier message"}
          {d.in_reply_to.subject ? ` · ${d.in_reply_to.subject}` : ""}
          {d.in_reply_to.date ? ` · ${formatDateTime(d.in_reply_to.date)}` : ""}
        </p>
      )}

      <div class="tight">
        {recipientBlock(
          "to",
          // The Cc/Bcc affordance rides on the To row rather than taking a row
          // of its own: it is one word of chrome for fields most drafts never
          // use. A populated field is always shown, so this only ever offers
          // the ones that are actually empty.
          hiddenFields.length > 0 ? (
            <TextLink
              title={`Add ${hiddenFields.map((f) => FIELD_LABELS[f]).join(" or ")} recipients`}
              onClick={() => {
                setShowMore(true);
                // The link goes away; the first field it revealed takes over.
                focusNext.current = `d-${hiddenFields[0]}`;
              }}
            >
              {hiddenFields.map((f) => FIELD_LABELS[f]).join(" ")}
            </TextLink>
          ) : undefined,
        )}
        {(showMore || edit.cc.length > 0) && recipientBlock("cc")}
        {(showMore || edit.bcc.length > 0) && recipientBlock("bcc")}

        <div class="row">
          {/* Labelled like the rows above it. It used to be the one unlabelled
              field, which left it reading as an orphan under Bcc rather than as
              the last of a set. */}
          <label class="lbl" for="d-subject">
            Subject
          </label>
          <input
            id="d-subject"
            class="subj grow"
            aria-label="Subject"
            placeholder="No subject"
            value={edit.subject}
            disabled={!canEdit}
            onInput={(e) =>
              update({ subject: (e.target as HTMLInputElement).value })
            }
          />
        </div>
      </div>

      {showHtml && canPreview ? (
        // Read only, and has to look it: it used to be indistinguishable from
        // the editable box (QA, 2026-10-13). It is also the version AS LAST
        // SAVED, which is what it shows until the next save.
        <section class="html-preview" aria-label="Formatted version, read only">
          <p class="html-preview-lbl">Formatted version, as last saved. Read only.</p>
          <HtmlBody html={d.body?.html as string} preview />
        </section>
      ) : (
        <AutoTextarea
          id="d-body"
          ariaLabel="Message"
          value={split.signature === null ? edit.bodyText : split.message}
          disabled={!canEdit}
          maxRows={fullscreen ? FULLSCREEN_BODY_ROWS : INLINE_BODY_ROWS}
          onInput={(v) => {
            const next = applyMessageEdit(split, sigPin, v);
            update({ bodyText: next.bodyText });
            // Assigned rather than guarded on `sigPin`: a pin the split no
            // longer describes is dropped, not carried. See `applyMessageEdit`.
            setSigPin(next.pin);
          }}
          // No fullscreen on focus. CONCEPT §7 had the card ask for it the
          // first time the box was focused, and QA (2026-10-13) found that
          // simply TABBING through the box threw the card into fullscreen.
          // Expand is one click away and says what it does.
        />
      )}

      {/* The signature, split out of the body box but still the same bytes.
          For a fourteen-word message the stored signature was four of eight
          lines, so the box was mostly boilerplate and the message was the
          smaller half of its own editor. Dimmed and collapsed by default,
          editable on request; `joinBody` puts it back verbatim, so what is
          saved is byte-identical to what was stored (contract §8: the card must
          save the text as-is or the signature doubles). */}
      {!(showHtml && canPreview) && split.signature !== null && (
        editingSig ? (
          <div class="row">
            <label class="lbl" for="d-signature">
              Signature
            </label>
            <div
              class="grow"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                cancelSig();
              }}
            >
              <AutoTextarea
                id="d-signature"
                ariaLabel="Signature"
                value={split.signature}
                disabled={!canEdit}
                maxRows={fullscreen ? FULLSCREEN_BODY_ROWS : SIGNATURE_ROWS}
                onInput={(v) =>
                  update({ bodyText: joinBody({ ...split, signature: v }) })
                }
              />
              {richSig && !sigEdited && (
                <p class="line">
                  This signature has formatting, such as a logo or links. Changing
                  it here saves it as plain text.
                </p>
              )}
              <p class="line sig-acts">
                <TextLink onClick={cancelSig} title="Close and put the signature back as it was">
                  Cancel
                </TextLink>
              </p>
            </div>
          </div>
        ) : (
          // Labelled in the same gutter as To / Cc / Bcc / Subject. Collapsed,
          // it was just the first line of the signature and a count, which
          // read as a stray fragment of the message rather than as a field:
          // you had to already know what it was to recognise it.
          <div
            class="row sig"
            title="The signature stored in this draft. Click to edit it."
            onClick={() => canEdit && startEditingSig()}
          >
            <span class="lbl">Signature</span>
            <span class="sig-text">{signaturePreview(split.signature)}</span>
            {canEdit && (
              <TextLink
                btnRef={sigEditLink}
                onClick={startEditingSig}
                title={
                  richSig
                    ? "Changing the signature here saves it as plain text, without its formatting"
                    : undefined
                }
              >
                Edit
              </TextLink>
            )}
          </div>
        )
      )}

      {formattingAtRisk && (
        <Notice tone="warning">
          Saving will replace the signature's formatting (logo, links, layout)
          with plain text. The message itself keeps its formatting.{" "}
          {split.separator !== null && (
            <TextLink onClick={undoSignature}>Undo signature changes</TextLink>
          )}
        </Notice>
      )}

      {d.body?.formatting_removed === true && !hasHtml && (
        <p class="line">
          That save removed this draft's formatting, so it is plain text now.
        </p>
      )}

      {d.body?.truncated && (
        <Notice tone="warning">
          This draft was clipped for display. Saving would replace the stored
          body with what you see here.
        </Notice>
      )}

      {attachLine && <p class="line">{attachLine}</p>}

      {refusal && <Notice tone="warning">{refusal}</Notice>}

      {d.signature?.embedded === false && (
        <p class="line">
          Your signature is not part of this text. It is added when the draft is
          sent.
        </p>
      )}

      {env.actor?.can_edit === false && (
        <Notice tone="warning">
          {env.actor?.reason === "viewer_role"
            ? "Your role can view this draft but not change it."
            : "This draft cannot be edited from here."}
        </Notice>
      )}


      {(check === "pending" || check === "checking") && (
        <p class="line" role="status">
          Checking for a newer version&#8230;
        </p>
      )}

      {editsNote === "restored" && (
        <Notice tone="warning">
          Your unsaved edits from earlier were put back. They are not saved yet.{" "}
          <TextLink onClick={useStored}>Discard these edits</TextLink>
        </Notice>
      )}

      {editsNote === "conflict" && (
        <Notice tone="warning">
          {restored ? "Your unsaved edits from earlier were put back. " : ""}
          This draft was changed somewhere else. Your unsaved edits are still
          here, and saving will replace the newer version.{" "}
          <TextLink soft disabled={busy !== null} onClick={useNewer}>
            Use the newer version
          </TextLink>
        </Notice>
      )}

      {err ? (
        <Notice tone={err.tone}>
          {err.text}
          {failed?.action === "refresh" && failed.at !== undefined && (
            <> Last checked {formatClockSeconds(failed.at)}.</>
          )}
          {err.retry && canEdit && verified && (dirty || typedPending) && (
            <>
              {" "}
              <TextLink soft disabled={busy !== null} onClick={onSave}>
                Try again
              </TextLink>
            </>
          )}
          {err.recheck && (
            <>
              {" "}
              <TextLink soft disabled={busy !== null} onClick={actions.refresh}>
                Check again
              </TextLink>
            </>
          )}
          {err.load && (
            <>
              {" "}
              <TextLink soft disabled={busy !== null} onClick={actions.refresh}>
                Load the newer version
              </TextLink>
            </>
          )}
          {err.copy && (
            <>
              {" "}
              <TextLink onClick={copyText}>{copyLabel(copied)}</TextLink>
            </>
          )}
        </Notice>
      ) : (
        check === "unverified" && (
          <Notice tone="danger">
            Could not confirm this is the latest version of the draft, so saving
            and sending are off for now. Your text is still here.{" "}
            <TextLink soft disabled={busy !== null} onClick={actions.refresh}>
              Check again
            </TextLink>
          </Notice>
        )
      )}

      {err && check === "unverified" && failed?.code !== "draft_not_found" && (
        <p class="line">Saving and sending are off until this draft has been checked.</p>
      )}

      {/* After a send whose answer was lost. Not folded into the failure
          notice: that one is replaced by the next action's (a Save, a
          Refresh), and this has to outlive them. */}
      {sendDoubt && (
        <Notice tone="warning">
          We could not confirm whether this draft was sent, so sending is off.
          Check your Sent folder first.{" "}
          <TextLink soft disabled={busy !== null} onClick={() => actions.allowSend?.()}>
            It was not sent, turn sending back on
          </TextLink>
        </Notice>
      )}

      </div>

      {/* Inline confirm, never a modal: a dialog inside a sandboxed frame is
          clipped by the host's container and fights its z-index. */}
      {confirm === "discard" ? (
        <div class="acts" onKeyDown={(e) => onConfirmKey(e as unknown as KeyboardEvent)}>
          <span class="line grow">
            Discard this draft? It is deleted at your provider.
          </span>
          <Btn soft variant="quiet" btnRef={safeChoice} onClick={closeConfirm}>
            No
          </Btn>
          <Btn
            soft
            variant="danger"
            busy={busy !== null}
            onClick={() => {
              closeConfirm();
              actions.discard(onScreen());
            }}
          >
            Yes, discard
          </Btn>
        </div>
      ) : (
        <div class="acts">
          {/* ── Two weights, not four ──────────────────────────────────────
              This row used to be Discard · Refresh · Save · Send as four
              equal buttons. Three problems: a destructive action and a
              maintenance action carried the same weight as the one that sends
              mail; Discard sat immediately beside the primary, which is where
              a misclick costs the most; and "Show formatting" hung on its own
              left-aligned line above a right-aligned row, so the footer had no
              structure to read.

              Now: the two things that change the draft are buttons on the
              right, and everything else is a text link on the left, in the
              same row. Discard keeps its danger tone and still goes through
              the inline confirm below. */}
          <span class="acts-l">
            {canPreview && (
              <TextLink
                onClick={() => setShowHtml(!showHtml)}
                title={
                  showHtml
                    ? "Edit the plain-text version"
                    : "Preview the HTML version, read only"
                }
              >
                {showHtml ? "Edit plain text" : "Show formatting"}
              </TextLink>
            )}
            <TextLink
              soft
              disabled={busy !== null}
              title="Re-read this draft from the mailbox"
              onClick={actions.refresh}
            >
              {busy === "refresh"
                ? "Refreshing"
                : refreshed === "same"
                  ? "Up to date"
                  : refreshed === "updated"
                    ? "Updated"
                    : "Refresh"}
            </TextLink>
            <span class="sr-only" role="status">
              {refreshed === "same"
                ? "This draft is up to date."
                : refreshed === "updated"
                  ? "Updated from your Drafts folder."
                  : ""}
            </span>
            <TextLink
              tone="danger"
              disabled={!canEdit}
              title="Delete this draft at your provider"
              btnRef={discardLink}
              onClick={() => openConfirm("discard")}
            >
              Discard
            </TextLink>
          </span>
          {/* Both `soft`: they change availability while focused (busy, then
              clean), and a real `disabled` would hand the next Tab to Send. */}
          <Btn
            soft
            disabled={!canEdit || !(dirty || typedPending) || !verified}
            busy={saving}
            onClick={onSave}
          >
            {saving ? "Saving" : "Save"}
          </Btn>
          <Btn
            soft
            variant="primary"
            disabled={!canSend}
            busy={sending}
            title={
              canSend
                ? dirty
                  ? "Saves your changes first, then sends"
                  : "Sends this draft now"
                : sendDoubt
                  ? "Sending is off until you have checked whether the last send went out"
                  : !verified
                  ? "Sending is off until this draft has been checked against the mailbox"
                  : !canEdit
                  ? "This draft cannot be sent from here"
                  : pendingBad
                  ? `Fix or remove the incomplete address in ${FIELD_LABELS[pendingBad]} first`
                  : !hasRecipient
                  ? "Add a recipient to send this draft"
                  : "This connection is not allowed to send"
            }
            onClick={() => {
              const next = readyToWrite();
              if (!next) return;
              const p = patchFrom(next);
              sent.current = { version, edit: next };
              void Promise.resolve(
                actions.send(Object.keys(p).length > 0 ? p : null),
              ).finally(() => {
                if (sent.current?.edit === next) sent.current = null;
              });
            }}
          >
            {sending ? "Sending" : dirty ? "Save and send" : "Send"}
          </Btn>
        </div>
      )}

      <ProviderLine
        provider={provider}
        fullscreen={fullscreen}
        // The message, not the message plus the signature. The signature is
        // constant boilerplate the user did not write and can now see is
        // separate, so counting it answers a question nobody asked and makes a
        // three-word note read as thirty.
        lead={slow
          ? `${saving ? "Still saving" : "Still working"}. ${providerName(d)} can take a moment.`
          : `${wordCount(split.message)} words`}
        // Inline, the provider label and the route move into the tooltip.
        // See ProviderLine.
        compactSummary="Saved to Drafts"
      />
    </>
  );
}

/**
 * The whole of an older card once a newer one exists for the same draft. One
 * line, in the shape of the card's other one-liners, so the frame is never
 * empty (contract §1). Leaves fullscreen: one line on an empty page is not a
 * place to be left.
 */
function Superseded(props: { fullscreen: boolean; actions: DraftActions; onOpen: () => void }) {
  useEffect(() => {
    if (props.fullscreen) props.actions.setFullscreen(false);
  }, []);
  return (
    <div class="hdr">
      <div class="hdr-l">
        <span class="dot" data-tone="neutral" aria-hidden="true" />
        <b>A newer version of this draft is below.</b>
      </div>
      <div class="hdr-r">
        <TextLink onClick={props.onOpen} title="Open the current version of the draft in this card">
          Edit here anyway
        </TextLink>
      </div>
    </div>
  );
}
