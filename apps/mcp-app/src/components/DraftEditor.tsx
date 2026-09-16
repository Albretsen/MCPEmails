import { useEffect, useRef, useState } from "preact/hooks";
import type { DraftEditorData, Envelope, Provider } from "../contract";
import { formatBytes, formatDateTime, wordCount } from "../format";
import { setTeardownSaver } from "../store";
import { Btn, Fields, HtmlBody, Notice, ProviderBlock, Segmented } from "./ui";

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

function identityLine(d: DraftEditorData): string {
  const name = d.identity?.display_name?.trim();
  const addr = d.identity?.email_address ?? "unknown sender";
  return name ? `${name} · ${addr}` : addr;
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
  const [showMore, setShowMore] = useState(
    server.cc.length + server.bcc.length > 0,
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [bodyMode, setBodyMode] = useState<"text" | "html">("text");
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

  const recipientRow = (field: Field) => (
    <div>
      <label class="field-label" for={`d-${field}`}>
        {FIELD_LABELS[field]}
      </label>
      {edit[field].length > 0 && (
        <ul class="chips" aria-label={`${FIELD_LABELS[field]} recipients`}>
          {edit[field].map((addr, i) => (
            <li class="chip" key={`${addr}-${i}`}>
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
            </li>
          ))}
        </ul>
      )}
      <input
        id={`d-${field}`}
        class="input"
        type="email"
        autocomplete="off"
        spellcheck={false}
        placeholder="name@example.com"
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
  );

  const refusal = attachmentRefusal(d);
  const err = errorNotice(env);
  const attachments = d.attachments ?? [];
  const hasHtml = !!d.body?.html;
  const canSend = d.can_send === true && canEdit;
  const saving = busy === "save";
  const sending = busy === "send";

  const savedLine = d.last_saved_at
    ? `Last saved ${formatDateTime(d.last_saved_at)}${
        d.last_saved_by === "user"
          ? " by you"
          : d.last_saved_by === "agent"
            ? " by the assistant"
            : ""
      }`
    : "Not saved yet";

  return (
    <>
      <div class="head">
        <div class="grow">
          <p class="eyebrow">
            <span class="status-dot" data-tone="warning" aria-hidden="true" />
            Draft · not sent
          </p>
        </div>
        {fullscreen ? (
          <Btn variant="quiet" onClick={() => actions.setFullscreen(false)}>
            Close editor
          </Btn>
        ) : props.canExpand ? (
          <Btn
            variant="quiet"
            onClick={() => actions.setFullscreen(true)}
            title="More room to write"
          >
            Expand
          </Btn>
        ) : null}
      </div>

      <Fields rows={[["From", identityLine(d)]]} />

      {d.in_reply_to && (
        <details class="reply-to">
          <summary>
            Replying to {d.in_reply_to.from || "an earlier message"}
          </summary>
          <Fields
            rows={[
              ["Subject", d.in_reply_to.subject || "(no subject)"],
              ...(d.in_reply_to.date
                ? ([["Date", formatDateTime(d.in_reply_to.date)]] as Array<
                    [string, string]
                  >)
                : []),
              ...(d.in_reply_to.message_id
                ? ([["Message", d.in_reply_to.message_id]] as Array<
                    [string, string]
                  >)
                : []),
            ]}
          />
        </details>
      )}

      <div class="stack">
        {recipientRow("to")}
        {showMore ? (
          <>
            {recipientRow("cc")}
            {recipientRow("bcc")}
          </>
        ) : (
          <div class="row">
            <Btn variant="quiet" onClick={() => setShowMore(true)}>
              Add Cc or Bcc
            </Btn>
          </div>
        )}

        <div>
          <label class="field-label" for="d-subject">
            Subject
          </label>
          <input
            id="d-subject"
            class="input"
            value={edit.subject}
            disabled={!canEdit}
            onInput={(e) =>
              update({ subject: (e.target as HTMLInputElement).value })
            }
          />
        </div>

        {hasHtml && (
          <Segmented
            label="Body format"
            value={bodyMode}
            onChange={(v) => setBodyMode(v as "text" | "html")}
            options={[
              { value: "text", label: "Plain text" },
              { value: "html", label: "Show formatting" },
            ]}
          />
        )}

        {bodyMode === "html" && hasHtml ? (
          <>
            <HtmlBody html={d.body?.html as string} />
            <p class="tiny">
              Read only. Switch to plain text to edit. Saving regenerates the
              formatted version from the text.
            </p>
          </>
        ) : (
          <div>
            <label class="field-label" for="d-body">
              Message
            </label>
            <textarea
              id="d-body"
              class="textarea"
              rows={fullscreen ? 20 : 8}
              value={edit.bodyText}
              disabled={!canEdit}
              onInput={(e) =>
                update({ bodyText: (e.target as HTMLTextAreaElement).value })
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
          </div>
        )}
      </div>

      {d.body?.truncated && (
        <Notice tone="warning">
          This draft was clipped for display. Saving would replace the stored
          body with what you see here.
        </Notice>
      )}

      {attachments.length > 0 && (
        <div class="stack">
          <span class="field-label">
            {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
          </span>
          <ul class="chips" aria-label="Attachments">
            {attachments.slice(0, fullscreen ? 20 : 3).map((a, i) => (
              <li class="chip" key={i}>
                <span class="name">{a.filename || "(unnamed)"}</span>
                <span class="tiny">{formatBytes(a.size_bytes)}</span>
              </li>
            ))}
            {!fullscreen && attachments.length > 3 && (
              <li class="chip">
                <span class="name">+{attachments.length - 3} more</span>
              </li>
            )}
          </ul>
        </div>
      )}

      {refusal && <Notice tone="warning">{refusal}</Notice>}

      {d.signature?.embedded === false && (
        <p class="tiny">
          Your signature is not part of this text. It is added when the draft is
          sent.
        </p>
      )}

      <ProviderBlock provider={provider} fullscreen={fullscreen} />

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
            <div class="actions">
              <Btn busy={busy === "refresh"} onClick={actions.refresh}>
                Refresh
              </Btn>
            </div>
          )}
        </Notice>
      )}

      {props.error && <Notice tone="danger">{props.error}</Notice>}

      <hr class="divider" />

      {confirmDiscard ? (
        <div class="stack">
          <Notice tone="danger">
            Discard this draft? It is deleted at your provider and cannot be
            brought back.
          </Notice>
          <div class="actions">
            <Btn onClick={() => setConfirmDiscard(false)}>Keep it</Btn>
            <Btn
              variant="danger"
              busy={busy === "discard"}
              onClick={() => {
                setConfirmDiscard(false);
                actions.discard();
              }}
            >
              Delete draft
            </Btn>
          </div>
        </div>
      ) : (
        <>
          <div class="actions">
            <Btn
              disabled={!canEdit || !dirty}
              busy={saving}
              onClick={() => void actions.save(patchFrom(flush()))}
            >
              {saving ? "Saving" : "Save changes"}
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
          <div class="actions">
            <Btn busy={busy === "refresh"} onClick={actions.refresh}>
              Refresh
            </Btn>
            <Btn
              variant="danger"
              disabled={!canEdit}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard draft
            </Btn>
          </div>
        </>
      )}

      <p class="tiny">
        {savedLine}
        {dirty ? " · unsaved changes" : ""} · {wordCount(edit.bodyText)} words
        {d.id_is_stable === false
          ? " · this provider gives the draft a new id on every save"
          : ""}
      </p>
    </>
  );
}
