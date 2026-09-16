import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { DraftEditorData, Envelope, Provider } from "../contract";
import { formatBytes, formatDateTime, joinBody, splitBody, wordCount } from "../format";
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
 */
function signaturePreview(signature: string): string {
  const lines = signature.split("\n").filter((l) => l.trim().length > 0);
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

interface EditState {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** What is in the address inputs but not yet a chip. */
  typed: Record<Field, string>;
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const askedFullscreen = useRef(false);

  // The card MUST adopt every id the server returns (§8: on IMAP the id changes
  // on every save). This is where that happens: App replaces the envelope with
  // the response and the editor resyncs to it. Keyed on id + last_saved_at +
  // origin so an ERROR response, which by contract changes nothing, does NOT
  // resync and the user keeps the edits they were about to lose.
  const syncKey = [d.draft_id, d.last_saved_at ?? "", d.origin ?? ""].join(" ");
  useEffect(() => {
    update(server);
    setAddrWarning(null);
    setConfirmDiscard(false);
  }, [syncKey]);

  const patchFrom = (e: EditState): DraftPatch => {
    const p: DraftPatch = {};
    if (!sameList(e.to, server.to)) p.to = e.to;
    if (!sameList(e.cc, server.cc)) p.cc = e.cc;
    if (!sameList(e.bcc, server.bcc)) p.bcc = e.bcc;
    if (e.subject !== server.subject) p.subject = e.subject;
    if (e.bodyText !== server.bodyText) p.body_text = e.bodyText;
    return p;
  };

  const patch = patchFrom(edit);
  const dirty = Object.keys(patch).length > 0;
  const patchKey = JSON.stringify(patch);

  // Unsaved work at teardown. The host sends `ui/resource-teardown` before the
  // frame goes away and waits for the reply, so this is the last moment a
  // half-typed edit can be written. Registered only while there is something to
  // write, and re-registered as it changes so the snapshot is the current one.
  useEffect(() => {
    if (!dirty || !canEdit) {
      setTeardownSaver(null);
      return;
    }
    const snapshot = { ...patch };
    setTeardownSaver(() => actions.save(snapshot));
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
  const split = splitBody(edit.bodyText);

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
          onInput={(v) =>
            update({ bodyText: joinBody({ ...split, message: v }) })
          }
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
        ) : (
          <div class="sig" onClick={() => canEdit && setEditingSig(true)}>
            <span class="sig-text">{signaturePreview(split.signature)}</span>
            {canEdit && (
              <TextLink
                title="Edit the signature stored in this draft"
                onClick={() => setEditingSig(true)}
              >
                Edit
              </TextLink>
            )}
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
      {confirmDiscard ? (
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
