import { CalendarClock, Clock, Paperclip, ShieldAlert, Trash2, X } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { SENDER_IDENTITY_HINT } from "../../api/inbox-health";
import { mailActions, useInboxHealth, useInboxes, useMailActions } from "../../data";
import { fromChoices, fromOptionLabel } from "./from";
import { attachmentProblem } from "../../data/mail-actions";
import { cx } from "../../lib/cx";
import { formatBytes } from "../../lib/format";
import { usePrefersReducedMotion } from "../../lib/hooks";
import { isTypingTarget, modKey } from "../../lib/platform";
import { revealAssistant, useAssistantStore } from "../../state/assistant-store";
import { type ComposeAttachment, type ComposeState, isAiDraftEdited, useComposeStore } from "../../state/compose-store";
import { READ_ONLY_EXPLANATION, canWrite, refuseWrite, useCanWrite } from "../../state/permissions";
import { showToast } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, Kbd, LogoMark, Menu, MenuItem, MenuLabel, MenuSeparator, Spinner } from "../../ui";
import { restoreFocusSoon } from "../reader/focus";
import { useShell } from "../shell";
import { useAutosaveStatus } from "./autosave";
import s from "./Compose.module.css";
import { RecipientField } from "./RecipientField";
import { defaultCustomTime, describeSchedule, parseLocalInputValue, scheduleOptions, toLocalInputValue } from "./schedule";
import { settleAutosave, useAutosave } from "./useAutosave";

export interface ComposeCardProps {
  /** Inline under the email it answers: no subject field for replies. */
  inline?: boolean;
}

export const UNDO_SEND_MS = 5000;

/** Closes the form the way Esc does: content is saved as a draft, an empty
 *  form just closes. Waits for an autosave in flight first, so the save uses
 *  the draft's current id. */
export async function closeCompose(opts: { silent?: boolean } = {}): Promise<void> {
  const c = useComposeStore.getState().compose;
  // The assistant is writing into it, or a send is held: closing means "stop".
  if (c && (c.streaming || c.held)) {
    useAssistantStore.getState().stop();
    return;
  }
  await settleAutosave();
  // A read-only member cannot save: the form just closes.
  if (canWrite()) await mailActions.saveDraft({ silent: opts.silent });
  else useComposeStore.getState().discard();
}

let attachmentSeq = 0;

/** The compose form: From / To / Cc / Bcc / Subject, the body (or the
 *  assistant's stream), and either the send row or the approval bar for a
 *  held send. */
export function ComposeCard({ inline }: ComposeCardProps) {
  const c = useComposeStore((x) => x.compose);
  const mayWrite = useCanWrite();
  const opened = useComposeStore((x) => x.openSeq);
  const patch = useComposeStore((x) => x.patch);
  const scheduleOpen = useUiStore((u) => u.menu === "schedule");
  const { data: inboxes } = useInboxes();
  const boxes = useInboxHealth();
  const { phone } = useShell();
  const reduced = usePrefersReducedMotion();
  const actions = useMailActions();
  const saver = useAutosave();
  const status = useAutosaveStatus((x) => x.status);
  const [ccOpen, setCcOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [customTime, setCustomTime] = useState("");
  const [customError, setCustomError] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const ccRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const heldRef = useRef<HTMLDivElement>(null);
  const subjectId = useId();
  const fromId = useId();

  const ai = !!c?.ai;
  const streaming = c?.streaming ?? null;

  /** `goDraft` in the prototype: bring the draft to the top of the reader. */
  const reveal = (smooth: boolean) => {
    const card = cardRef.current;
    // Inline, the card's parent is the reader's scroller (its offset parent).
    const scroller = card?.parentElement;
    if (!inline || !card || !scroller) return;
    scroller.scrollTo({ top: Math.max(0, card.offsetTop - 24), behavior: smooth && !reduced ? "smooth" : "auto" });
  };

  // A form opened: show Cc/Bcc if they are in use, focus the first empty field
  // of a draft the USER started, and bring an inline draft into view. Motion
  // only when the assistant caused it; a keyboard reply jumps.
  useEffect(() => {
    const cur = useComposeStore.getState().compose;
    if (!cur) return;
    setCcOpen(!!cur.cc.trim() || !!cur.bcc.trim());
    setPicking(false);
    if (!cur.ai) (cur.to.trim() ? bodyRef : toRef).current?.focus({ preventScroll: true });
    reveal(!!cur.ai);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  // The assistant starts writing or editing: keep its work on screen.
  useEffect(() => {
    if (ai && streaming) reveal(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai, streaming]);

  // A send is now held: the approval bar is the one thing the user has to see,
  // and it sits at the bottom of the card, often below the fold. Scrolling
  // moves no focus, so an input the user is typing in keeps it.
  const isHeld = !!c?.held;
  useEffect(() => {
    if (!isHeld) return;
    heldRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHeld]);

  // The form is gone (sent, saved, discarded): never leave focus on <body>.
  useEffect(() => () => restoreFocusSoon(inline ? "reader" : "list"), [inline]);

  useEffect(() => {
    if (picking) customRef.current?.focus();
  }, [picking]);
  useEffect(() => {
    if (!scheduleOpen) setPicking(false);
  }, [scheduleOpen]);

  if (!c) return null;

  const held = c.held;
  const multi = (inboxes?.length ?? 0) > 1;
  const senders = fromChoices(boxes, c.inbox_id);
  const showSubject = !inline || c.mode === "forward";
  const banner =
    c.streaming === "writing"
      ? "Assistant is writing this reply…"
      : c.streaming === "editing"
        ? "Assistant is editing the draft…"
        : isAiDraftEdited(c)
          ? "Drafted by the assistant. You edited it."
          : "Drafted by the assistant. Edit anything before you send.";
  const external = held?.external ? " The email it replies to came from outside your organization." : "";
  const attachments = c.attachments ?? [];
  const sendHint = modKey("Enter");
  const sendGlyph = modKey("↵");

  /** A change made by the user: update the form and (re)start the autosave timer. */
  const edit = (p: Partial<ComposeState>) => {
    patch(p);
    saver.touch();
  };

  const closeMenu = () => useUiStore.getState().setMenu(null);
  const live = () => useComposeStore.getState().compose;

  // Send, schedule and discard read the draft id, which an autosave in flight
  // is about to replace: let it land first. Typing is never blocked by this.
  const sendNow = async () => {
    await settleAutosave();
    const cur = live();
    if (!cur || cur.streaming || refuseWrite()) return;
    if (cur.held) void useAssistantStore.getState().resolveApproval("approve");
    else actions.send(cur, { undoWindowMs: UNDO_SEND_MS });
  };
  const scheduleAt = async (at: Date) => {
    closeMenu();
    await settleAutosave();
    const cur = live();
    if (!cur || cur.streaming || refuseWrite()) return;
    void actions.schedule(cur, at.toISOString(), describeSchedule(at).full);
  };
  const discard = async () => {
    await settleAutosave();
    if (canWrite()) void actions.discardDraft();
    else useComposeStore.getState().discard();
  };
  const submitCustom = () => {
    const at = parseLocalInputValue(customTime);
    if (!at) {
      setCustomError(true);
      return;
    }
    void scheduleAt(at);
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = ""; // the same file can be picked again
    if (!files.length) return;
    const added: ComposeAttachment[] = files.map((file) => ({
      id: `att-${++attachmentSeq}`,
      name: file.name,
      size: file.size,
      type: file.type,
      file,
    }));
    const all = [...(live()?.attachments ?? []), ...added];
    patch({ attachments: all });
    // Said now, not when Send is pressed: the limit is on the whole message.
    const problem = attachmentProblem({ attachments: all });
    if (problem) showToast({ text: problem, kind: "error" });
  };
  const removeAttachment = (id: string) => patch({ attachments: attachments.filter((a) => a.id !== id) });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      // Handled here rather than by the global shortcut, so the send waits for
      // an autosave in flight.
      e.preventDefault();
      void sendNow();
      return;
    }
    if (e.key !== "Escape" || held) return;
    // The global handler owns these cases: an open menu, a running assistant.
    if (useUiStore.getState().menu || useAssistantStore.getState().busy) return;
    e.preventDefault();
    // First Esc leaves the field (focus stays on the form, not on <body>);
    // the next one closes the form and saves the draft.
    if (isTypingTarget(e.target)) cardRef.current?.focus({ preventScroll: true });
    else void closeCompose();
  };

  return (
    <div
      ref={cardRef}
      data-draft="yes"
      tabIndex={-1}
      role="group"
      aria-label={c.mode === "new" ? "New message" : c.mode === "forward" ? "Forward" : "Reply"}
      className={cx(s.card, held && s.cardHeld, phone && s.touch)}
      onKeyDown={onKeyDown}
    >
      {c.ai ? (
        <div className={s.banner}>
          {streaming ? <Spinner /> : <LogoMark size={17} />}
          <span className={s.bannerText} role="status">
            {banner}
          </span>
          {c.draftCall ? (
            <button
              type="button"
              className={s.linkButton}
              onClick={() => {
                if (!c.draftCall) return;
                revealAssistant();
                useAssistantStore.getState().setLinkCall(c.draftCall.call_id);
              }}
            >
              Show steps
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={s.fields}>
        <div className={s.field}>
          <label className={s.fieldLabel} htmlFor={fromId}>
            From
          </label>
          <select
            id={fromId}
            className={s.fieldInput}
            value={c.inbox_id}
            disabled={!!c.replyTo}
            title={senders.find((i) => i.inbox_id === c.inbox_id)?.health.senderHint ? SENDER_IDENTITY_HINT : undefined}
            onChange={(e) => edit({ inbox_id: e.target.value })}
          >
            {senders.map((i) => (
              <option key={i.inbox_id} value={i.inbox_id}>
                {fromOptionLabel(i, multi)}
              </option>
            ))}
          </select>
        </div>
        <RecipientField
          label="To"
          value={c.to}
          onChange={(to) => edit({ to })}
          inputRef={toRef}
          placeholder="name@company.com"
          trailing={
            ccOpen ? null : (
              <button
                type="button"
                className={s.ccToggle}
                aria-expanded={false}
                title="Add Cc and Bcc recipients"
                onClick={() => {
                  setCcOpen(true);
                  setTimeout(() => ccRef.current?.focus(), 0);
                }}
              >
                Cc Bcc
              </button>
            )
          }
        />
        {ccOpen ? (
          <>
            <RecipientField label="Cc" value={c.cc} onChange={(cc) => edit({ cc })} inputRef={ccRef} />
            <RecipientField label="Bcc" value={c.bcc} onChange={(bcc) => edit({ bcc })} />
          </>
        ) : null}
        {showSubject ? (
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor={subjectId}>
              Subject
            </label>
            <input
              id={subjectId}
              className={s.fieldInput}
              type="text"
              value={c.subject}
              onChange={(e) => edit({ subject: e.target.value })}
              placeholder="Subject"
            />
          </div>
        ) : null}
      </div>

      {streaming ? (
        // Not announced word by word: the banner says what is happening, and
        // the finished text is in the textarea once the stream ends.
        <div className={s.stream} aria-busy="true" aria-live="off" aria-label="Message, being written by the assistant">
          {streaming === "editing" && c.segments
            ? c.segments.map((g, i) => (
                <span key={i} className={g.k === "del" ? s.del : g.k === "ins" ? s.ins : undefined}>
                  {g.t}
                </span>
              ))
            : c.body}
          {streaming === "writing" ? <span className={s.caret} aria-hidden="true" /> : null}
        </div>
      ) : (
        // The textarea grows with its content: the hidden ::after of the
        // wrapper holds the same text and sets the height. No layout reads.
        <div className={s.grow} data-value={c.body}>
          <textarea
            ref={bodyRef}
            className={s.textarea}
            aria-label="Message"
            value={c.body}
            onChange={(e) => edit({ body: e.target.value })}
            placeholder="Write your message"
          />
        </div>
      )}

      {attachments.length ? (
        <ul className={s.attachments} aria-label="Attachments">
          {attachments.map((a) => (
            <li key={a.id} className={s.attachment}>
              <Paperclip size={13} aria-hidden="true" className={s.attachmentIcon} />
              <span className={s.attachmentName} title={a.name}>
                {a.name}
              </span>
              <span className={s.attachmentSize}>{formatBytes(a.size)}</span>
              <button type="button" className={s.chipRemove} aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {held ? (
        <div ref={heldRef} className={s.held} role="group" aria-label="Approval needed">
          <div className={s.heldText}>
            <ShieldAlert size={16} aria-hidden="true" className={s.heldIcon} />
            <span>
              <strong>Held for your approval.</strong> The assistant wants to send this to {c.to || "the sender"}.{external}
            </span>
          </div>
          <div className={s.heldActions}>
            <Button
              variant="primary"
              shortcut="Meta+Enter Control+Enter"
              disabled={!mayWrite}
              title={mayWrite ? `Approve and send (${sendHint})` : READ_ONLY_EXPLANATION}
              onClick={() => void useAssistantStore.getState().resolveApproval("approve")}
            >
              Approve and send
              {!phone ? <Kbd variant="bare">{sendGlyph}</Kbd> : null}
            </Button>
            <Button
              className={s.heldEdit}
              disabled={!mayWrite}
              title={mayWrite ? undefined : READ_ONLY_EXPLANATION}
              onClick={() => {
                void useAssistantStore.getState().resolveApproval("edit");
                setTimeout(() => bodyRef.current?.focus(), 40);
              }}
            >
              Edit first
            </Button>
            <Button variant="ghost" className={s.heldDeny} onClick={() => void useAssistantStore.getState().resolveApproval("reject")}>
              Don't send
            </Button>
          </div>
        </div>
      ) : (
        <div className={s.foot}>
          <Button
            variant="primary"
            disabled={!!streaming || !mayWrite}
            shortcut="Meta+Enter Control+Enter"
            title={mayWrite ? `Send (${sendHint})` : READ_ONLY_EXPLANATION}
            onClick={() => void sendNow()}
          >
            Send
            {!phone ? <Kbd variant="bare">{sendGlyph}</Kbd> : null}
          </Button>
          <IconButton
            label="Schedule send"
            className={s.scheduleButton}
            disabled={!!streaming || !mayWrite}
            title={mayWrite ? undefined : READ_ONLY_EXPLANATION}
            aria-haspopup="menu"
            aria-expanded={scheduleOpen}
            onClick={() => useUiStore.getState().toggleMenu("schedule")}
          >
            <Clock size={15} aria-hidden="true" />
          </IconButton>
          <Menu open={scheduleOpen && mayWrite} onClose={closeMenu} label="Schedule send" className={s.scheduleMenu}>
            <MenuLabel>Schedule send</MenuLabel>
            {picking ? (
              <form
                className={s.custom}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitCustom();
                }}
              >
                <input
                  ref={customRef}
                  className={s.customInput}
                  type="datetime-local"
                  aria-label="Date and time to send"
                  aria-invalid={customError || undefined}
                  min={toLocalInputValue(new Date())}
                  value={customTime}
                  onChange={(e) => {
                    setCustomTime(e.target.value);
                    setCustomError(false);
                  }}
                />
                {customError ? (
                  <span className={s.customError} role="alert">
                    Pick a time in the future.
                  </span>
                ) : null}
                <Button type="submit" variant="primary" size="sm">
                  Schedule
                </Button>
              </form>
            ) : (
              <>
                {scheduleOptions().map((o) => (
                  <MenuItem key={o.label} trailing={o.when} onSelect={() => void scheduleAt(o.at)}>
                    {o.label}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  icon={<CalendarClock size={14} />}
                  onSelect={() => {
                    setCustomTime(toLocalInputValue(defaultCustomTime()));
                    setCustomError(false);
                    setPicking(true);
                  }}
                >
                  Pick date and time
                </MenuItem>
              </>
            )}
          </Menu>
          <IconButton label="Attach files" size="sm" className={s.attachButton} onClick={() => fileRef.current?.click()}>
            <Paperclip size={16} aria-hidden="true" />
          </IconButton>
          <input ref={fileRef} type="file" multiple hidden tabIndex={-1} onChange={onFiles} />
          <span className={s.footSpacer} />
          {inline ? (
            <span className={s.status} aria-hidden={status === "idle"}>
              {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? "Not saved" : ""}
            </span>
          ) : null}
          <IconButton label="Discard draft" size="sm" danger className={s.discardButton} onClick={() => void discard()}>
            <Trash2 size={16} aria-hidden="true" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
