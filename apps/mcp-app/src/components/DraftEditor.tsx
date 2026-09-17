import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DraftEditorData, Envelope, Provider } from "../contract";
import type { SplitBody } from "../format";
import {
  bodyTextChanged,
  formatBytes,
  formatDateTime,
  joinBody,
  splitBody,
  wordCount,
} from "../format";
import { setTeardownSaver } from "../store";
import {
  AutoTextarea,
  Btn,
  HtmlBody,
  Notice,
  ProviderLine,
  TextLink,
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
  send: (patch: DraftPatch | null) => void;
  discard: () => void;
  refresh: () => void;
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
const FULLSCREEN_BODY_ROWS = 40;

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

function errorNotice(env: Envelope): { text: string; offerRefresh: boolean } | null {
  if (env.state !== "error") return null;
  switch (env.receipt?.error_code) {
    case "draft_not_found":
      return {
        text: "This draft is no longer at that id. On IMAP every save writes a new draft and retires the old one, so refresh to load the current version.",
        offerRefresh: true,
      };
    case "draft_has_attachments":
      return {
        text: "Not saved. This draft has attachments, and saving here would rebuild the message without them. Nothing was changed.",
        offerRefresh: false,
      };
    case "invalid_recipients":
      return {
        text: "Not saved. One of the addresses was rejected. Nothing was changed. Fix the recipients and save again.",
        offerRefresh: false,
      };
    default:
      return {
        text:
          env.receipt?.headline?.trim() ||
          "That did not work. Nothing was changed.",
        offerRefresh: false,
      };
  }
}

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
 * the server's: `last_saved_at`, `origin` and `last_saved_by` describe the
 * RESPONSE, not the draft, and change when nothing has.
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

export function DraftEditor(props: Props) {
  const { env, draft: d, provider, fullscreen, busy, actions } = props;
  const canEdit = env.actor?.can_edit !== false;

  const server: EditState = {
    to: d.recipients?.to ?? [],
    cc: d.recipients?.cc ?? [],
    bcc: d.recipients?.bcc ?? [],
    subject: d.subject ?? "",
    bodyText: d.body?.text ?? "",
    typed: { to: "", cc: "", bcc: "" },
  };

  const [edit, setEdit] = useState<EditState>(server);
  // The ref, not the state, is the source of truth for the action handlers.
  // Clicking Save first blurs the address input, and that blur commits a typed
  // address; reading `edit` in the click handler would read whatever was
  // rendered before the blur and silently save without the address the user
  // just added.
  const editRef = useRef(edit);
  const update = (patch: Partial<EditState>) => {
    const next = { ...editRef.current, ...patch };
    editRef.current = next;
    setEdit(next);
  };

  const [addrWarning, setAddrWarning] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [editingSig, setEditingSig] = useState(false);
  const [sigPin, setSigPin] = useState<SigPin | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const askedFullscreen = useRef(false);

  // The card MUST adopt every id the server returns (§8: on IMAP the id changes
  // on every save). This is where that happens: App replaces the envelope with
  // the response and the editor resyncs to it.
  //
  // Keyed on the CONTENT version, not on id + last_saved_at + origin. That
  // triple was a proxy for "this is a different version of the draft" and it
  // was false in both directions. Too eager, which is what shipped: every
  // server path stamps `last_saved_at` with the clock at response time (see
  // contract.ts), so the key changed on every response and a refresh that
  // brought back a byte-identical draft still threw away whatever the user had
  // typed. And too lax, which is what it would have become the moment
  // `last_saved_at` started meaning what its name says: two responses agreeing
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
  useEffect(() => {
    editVersion.current = version;
    update(server);
    setAddrWarning(null);
    setConfirmDiscard(false);
    // A resync replaces the body wholesale, so a boundary pinned into the old
    // one describes nothing. Dropped rather than re-validated.
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
      const p = editorPatch(editVersion.current, now.version, editRef.current, now.server);
      if (Object.keys(p).length === 0) return Promise.resolve(false);
      return actions.save(p);
    });
    return () => setTeardownSaver(null);
  }, [patchKey, canEdit]);

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
    let bad: string | null = null;
    for (const field of FIELDS) {
      const raw = next.typed[field];
      if (!raw.trim()) continue;
      const parts = raw.split(/[,;]/).map(bareAddress).filter(Boolean);
      const invalid = parts.filter((p) => !ADDRESS.test(p));
      for (const p of parts) {
        if (ADDRESS.test(p) && !next[field].includes(p)) next[field].push(p);
      }
      if (invalid.length > 0) {
        bad =
          bad ??
          `${invalid[0]} does not look like an email address, so it was not added.`;
      } else {
        next.typed[field] = "";
      }
    }
    editRef.current = next;
    setEdit(next);
    setAddrWarning(bad);
    return next;
  };

  const commitField = (field: Field, raw: string) => {
    update({ typed: { ...editRef.current.typed, [field]: raw } });
    flush();
  };

  const onKey = (field: Field, e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    const el = e.target as HTMLInputElement;
    if (!el.value.trim()) return;
    e.preventDefault();
    commitField(field, el.value);
  };

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
    <div class="row">
      <label class="lbl" for={`d-${field}`}>
        {FIELD_LABELS[field]}
      </label>
      <div
        class="fld"
        onClick={(e) => {
          // The box looks like one field, so clicking the empty part of it must
          // put the caret in the input rather than do nothing.
          if (e.target === e.currentTarget) {
            (e.currentTarget as HTMLElement).querySelector("input")?.focus();
          }
        }}
      >
        {edit[field].map((addr, i) => (
          <span class="chip" key={`${addr}-${i}`}>
            <span class="name">{addr}</span>
            {canEdit && (
              <button
                type="button"
                class="chip-x"
                aria-label={`Remove ${addr}`}
                onClick={() => removeAt(field, i)}
              >
                &#215;
              </button>
            )}
          </span>
        ))}
        <input
          id={`d-${field}`}
          type="email"
          autocomplete="off"
          spellcheck={false}
          aria-label={`${FIELD_LABELS[field]} recipients`}
          // "name@example.com" reads as a value that is already there rather
          // than as an invitation to type one.
          placeholder={edit[field].length === 0 ? `Add ${FIELD_LABELS[field]}` : ""}
          value={edit.typed[field]}
          disabled={!canEdit}
          onInput={(e) =>
            update({
              typed: {
                ...editRef.current.typed,
                [field]: (e.target as HTMLInputElement).value,
              },
            })
          }
          onKeyDown={(e) => onKey(field, e as unknown as KeyboardEvent)}
          onBlur={(e) => {
            const el = e.target as HTMLInputElement;
            if (el.value.trim()) commitField(field, el.value);
          }}
        />
      </div>
      {trailing}
    </div>
  );

  const refusal = attachmentRefusal(d);
  const err = errorNotice(env);
  const hasHtml = !!d.body?.html;
  const canSend = d.can_send === true && canEdit;
  const saving = busy === "save";
  const sending = busy === "send";
  const attachLine = attachmentLine(d, fullscreen);
  // Which of Cc / Bcc are neither populated nor already revealed.
  const hiddenFields: Field[] = showMore
    ? []
    : (["cc", "bcc"] as Field[]).filter((f) => edit[f].length === 0);
  // Contract §5 caveats are server-authored and already say this on IMAP
  // ("stores a new copy on every save"), so the card only adds its own shorter
  // version when the provider did not supply one. Two sentences of the same
  // fact side by side is how the old provider box read.
  const idNote =
    d.id_is_stable === false &&
    !(provider?.caveats ?? []).some((c) => /new id/i.test(c))
      ? "saving gives the draft a new id"
      : null;

  const savedLine = d.last_saved_at
    ? `Saved ${formatDateTime(d.last_saved_at)}${
        d.last_saved_by === "user"
          ? " by you"
          : d.last_saved_by === "agent"
            ? " by the assistant"
            : ""
      }`
    : "Not saved yet";

  // Derived, never stored: `edit.bodyText` stays the single source of truth for
  // what will be saved, and this is only how it is presented.
  const split = pinnedSplit(edit.bodyText, sigPin) ?? splitBody(edit.bodyText);

  /** Open the signature box, holding the boundary where it is now. */
  const startEditingSig = () => {
    if (split.separator !== null) {
      setSigPin({ messageLen: split.message.length, separator: split.separator });
    }
    setEditingSig(true);
  };

  return (
    <>
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
            {dirty ? " · unsaved" : ""}
          </span>
        </div>
      </div>

      {d.in_reply_to && (
        <p class="line">
          Replying to {d.in_reply_to.from || "an earlier message"}
          {d.in_reply_to.subject ? ` · ${d.in_reply_to.subject}` : ""}
          {d.in_reply_to.date ? ` · ${formatDateTime(d.in_reply_to.date)}` : ""}
        </p>
      )}

      <div class="tight">
        {recipientRow(
          "to",
          // The Cc/Bcc affordance rides on the To row rather than taking a row
          // of its own: it is one word of chrome for fields most drafts never
          // use. A populated field is always shown, so this only ever offers
          // the ones that are actually empty.
          hiddenFields.length > 0 ? (
            <TextLink onClick={() => setShowMore(true)}>
              {hiddenFields.map((f) => FIELD_LABELS[f]).join(" ")}
            </TextLink>
          ) : undefined,
        )}
        {(showMore || edit.cc.length > 0) && recipientRow("cc")}
        {(showMore || edit.bcc.length > 0) && recipientRow("bcc")}

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

      {showHtml && hasHtml ? (
        <HtmlBody html={d.body?.html as string} />
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
          onFocus={() => {
            // CONCEPT §7: ask for a real compose surface the first time the
            // user starts writing, and only the first time, so someone who
            // went back to inline is not dragged out of it again.
            if (askedFullscreen.current || fullscreen || !props.canExpand) {
              return;
            }
            askedFullscreen.current = true;
            actions.setFullscreen(true);
          }}
        />
      )}

      {/* The signature, split out of the body box but still the same bytes.
          For a fourteen-word message the stored signature was four of eight
          lines, so the box was mostly boilerplate and the message was the
          smaller half of its own editor. Dimmed and collapsed by default,
          editable on request; `joinBody` puts it back verbatim, so what is
          saved is byte-identical to what was stored (contract §8: the card must
          save the text as-is or the signature doubles). */}
      {!showHtml && split.signature !== null && (
        editingSig ? (
          <div class="row">
            <label class="lbl" for="d-signature">
              Signature
            </label>
            <div class="grow">
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
            {canEdit && <TextLink onClick={startEditingSig}>Edit</TextLink>}
          </div>
        )
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

      {addrWarning && <Notice tone="warning">{addrWarning}</Notice>}

      {err && (
        <Notice tone="danger">
          {err.text}
          {err.offerRefresh && (
            <>
              {" "}
              <TextLink onClick={actions.refresh}>Refresh</TextLink>
            </>
          )}
        </Notice>
      )}

      {props.error && <Notice tone="danger">{props.error}</Notice>}

      {/* Inline confirm, never a modal: a dialog inside a sandboxed frame is
          clipped by the host's container and fights its z-index. */}
      {/* Hiding is offered at two grains because the card cannot guess which
          one is meant: one mailbox is "this account is noisy", all of them is
          "I do not want this feature". Inline, never a modal, for the same
          reason the discard confirm is inline: a dialog inside a sandboxed
          frame is clipped by the host's container and fights its z-index. */}
      {confirmHide ? (
        <div class="acts">
          <span class="line grow">Hide the draft editor card?</span>
          <Btn
            busy={busy === "hide"}
            title="Only for this mailbox"
            onClick={() => {
              setConfirmHide(false);
              actions.hide("inbox");
            }}
          >
            This inbox
          </Btn>
          <Btn
            busy={busy === "hide"}
            title="Every mailbox in this workspace"
            onClick={() => {
              setConfirmHide(false);
              actions.hide("workspace");
            }}
          >
            All inboxes
          </Btn>
          <Btn variant="quiet" onClick={() => setConfirmHide(false)}>
            Cancel
          </Btn>
        </div>
      ) : confirmDiscard ? (
        <div class="acts">
          <span class="line grow">
            Discard this draft? It is deleted at your provider.
          </span>
          <Btn
            variant="danger"
            busy={busy === "discard"}
            onClick={() => {
              setConfirmDiscard(false);
              actions.discard();
            }}
          >
            Yes, discard
          </Btn>
          <Btn variant="quiet" onClick={() => setConfirmDiscard(false)}>
            No
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
            {hasHtml && (
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
              disabled={busy === "refresh"}
              title="Re-read this draft from the mailbox"
              onClick={actions.refresh}
            >
              {busy === "refresh" ? "Refreshing" : "Refresh"}
            </TextLink>
            <TextLink
              tone="danger"
              disabled={!canEdit}
              title="Delete this draft at your provider"
              onClick={() => setConfirmDiscard(true)}
            >
              Discard
            </TextLink>
            {/* The opt-out sits where the annoyance is. A preference page is
                the authoritative control and exists too, but nobody goes
                looking for one to turn off a card they have just met. */}
            <TextLink
              title="Stop showing this card. Drafts keep working exactly as they do now."
              onClick={() => setConfirmHide(true)}
            >
              Hide
            </TextLink>
          </span>
          <Btn
            disabled={!canEdit || !dirty}
            busy={saving}
            onClick={() => void actions.save(patchFrom(flush()))}
          >
            {saving ? "Saving" : "Save"}
          </Btn>
          <Btn
            variant="primary"
            disabled={!canSend}
            busy={sending}
            title={
              canSend
                ? dirty
                  ? "Saves your changes first, then sends"
                  : "Sends this draft now"
                : "This draft needs a recipient, and the key needs send access"
            }
            onClick={() => {
              const p = patchFrom(flush());
              actions.send(Object.keys(p).length > 0 ? p : null);
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
        lead={`${wordCount(split.message)} words`}
        extra={idNote}
        // Inline, the provider label, the route and the new-id caveat all move
        // into the tooltip. See ProviderLine.
        compactSummary="Saved to Drafts"
      />
    </>
  );
}
