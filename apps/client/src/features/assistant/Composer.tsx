import { ArrowUp, Mail, Maximize2, Plus, Square, X } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isAllowanceExhausted } from "../../api/types";
import { conversationMessages, findRow, useAssistantAllowance } from "../../data";
import { cx } from "../../lib/cx";
import { displayName, firstName } from "../../lib/format";
import { modKey } from "../../lib/platform";
import { useAssistantStore } from "../../state/assistant-store";
import { isInlineCompose, useComposeStore } from "../../state/compose-store";
import { useThreadStore } from "../../state/conversation-store";
import { useSelectionStore } from "../../state/selection-store";
import { useUiStore } from "../../state/ui-store";
import { Icon, Kbd, LogoMark, Spinner } from "../../ui";
import { ASSISTANT_INPUT_ATTR, useShell } from "../shell";
import s from "./Assistant.module.css";
import {
  type Suggestion,
  chipKeys,
  chipLabel,
  composerPlaceholder,
  fitSuggestions,
  inboxSuggestions,
  onScreenTarget,
  panelStatus,
  standardActions,
  threadSuggestions,
} from "./model";

/** The textarea grows to this many lines, then scrolls. */
const MAX_LINES = 6;

/* The composer: suggestions, standard actions, the context chip and the input.
 * On phone it is also the whole dock while the chat is not expanded. */
export function Composer({ phone, compact }: { phone: boolean; compact: boolean }) {
  const [text, setText] = useState("");
  const { assistantWidth } = useShell();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const busy = useAssistantStore((a) => a.busy);
  const status = useAssistantStore((a) => a.status);
  const progress = useAssistantStore((a) => a.progress);
  const empty = useAssistantStore((a) => a.messages.length === 0);
  const pushPending = useAssistantStore((a) => !!a.push?.approval_id);
  // The request in flight came with no email attached: it is about all mail.
  const inboxRun = useAssistantStore((a) => {
    if (!a.busy) return false;
    const asked = a.messages.find((m) => m.turn === a.turn && m.role === "user");
    return !asked?.context?.keys.length;
  });
  const selectedKey = useSelectionStore((x) => x.selectedKey);
  const multiSel = useSelectionStore((x) => x.multiSel);
  const ctxOff = useSelectionStore((x) => x.ctxOff);
  const ctxConversation = useSelectionStore((x) => x.ctxConversation);
  // The focused message of the open thread: the chip follows it.
  const focusedKey = useThreadStore((t) => (selectedKey && t.order.length > 1 && t.order.includes(selectedKey) ? t.focused : null));
  const threadSize = useThreadStore((t) => (selectedKey && t.order.includes(selectedKey) ? t.order.length : 0));
  const compose = useComposeStore((x) => x.compose);
  const act = useAssistantStore((a) => (selectedKey ? a.lastAct[selectedKey] : undefined));
  const lastQuestion = useAssistantStore((a) => {
    if (!selectedKey) return undefined;
    for (let i = a.messages.length - 1; i >= 0; i--) {
      const m = a.messages[i];
      if (m && m.role === "user" && m.context?.keys.includes(selectedKey)) return m.text;
    }
    return undefined;
  });
  const allowance = useAssistantAllowance().data;
  const firstRun = allowance?.plan === "free";
  const blocked = useAssistantStore((a) => a.allowanceBlocked);
  // Used up: say so here, with the date it comes back. Nothing is retried.
  const exhausted = !!allowance && (blocked || isAllowanceExhausted(allowance)) && allowance.cap != null;

  // Phone: the per-message actions and the chip exist only while the reader is
  // the screen showing (model.ts `onScreenTarget`). The selection itself stays.
  const screen = useUiStore((u) => u.screen);
  const target = onScreenTarget(selectedKey ? findRow(focusedKey ?? selectedKey) : undefined, { phone, screen });
  const reader = !!target;
  // Every message of the open conversation, the person's own replies
  // included (they are half of it). `threadSize` is read so this follows
  // messages the thread finds later.
  const conversation = useMemo(
    () =>
      selectedKey && threadSize > 1
        ? conversationMessages(selectedKey)
            .filter((r) => r.folder_role !== "drafts" && r.folder_role !== "scheduled")
            .map((r) => r.key)
        : [],
    [selectedKey, threadSize],
  );
  const canWiden = reader && conversation.length > 1 && multiSel.length < 2;
  const whole = ctxConversation && canWiden;
  const inline = isInlineCompose(compose, selectedKey);
  const held = !!compose?.held || pushPending;
  const aiDraftReady = inline && !!compose?.ai && !compose.held && !compose.streaming;
  const keys = chipKeys({ inboxRun, multiSel, target, ctxOff, conversation: whole ? conversation : null });
  const label = chipLabel(keys, target, whole);
  const who = target ? firstName(displayName(target.from)) : "";

  const std = standardActions({ target, inline });
  const stdBusy = busy || !!compose?.streaming;
  const suggestions: Suggestion[] = reader
    ? threadSuggestions({ busy, target, act, inline, aiDraftReady, lastQuestion })
    : inboxSuggestions({ busy, empty, firstRun });
  const fitted = fitSuggestions(suggestions, assistantWidth);
  const showSuggestions = suggestions.length > 0 && (!phone || !compact || !(reader && std.length > 0));
  const showStd = std.length > 0 && !busy;

  // Grow with the text, up to MAX_LINES.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 20;
    const pad = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
    const max = line * MAX_LINES + pad;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max + 1 ? "auto" : "hidden";
  }, [text, assistantWidth, phone]);

  const run = (t: string, sg?: Suggestion) => {
    const a = useAssistantStore.getState();
    if (a.busy) return;
    if (sg && target) {
      // A suggestion about the open email always carries that email.
      void a.run(t, { intent: sg.intent, keys: [target.key], contextLabel: chipLabel([target.key], target), free: sg.free });
    } else {
      void a.run(t, { intent: sg?.intent, keys, contextLabel: label, free: sg?.free });
    }
  };
  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    run(t);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a new line. Never while an IME is composing.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };
  const removeChip = () => {
    const sel = useSelectionStore.getState();
    if (sel.multiSel.length > 1) sel.clearMulti();
    else sel.setCtxOff(true);
    useAssistantStore.getState().setHoverKeys([]);
    inputRef.current?.focus();
  };
  const hover = (on: boolean) => useAssistantStore.getState().setHoverKeys(on ? keys : []);

  const placeholder = composerPlaceholder({ busy, keys, target, aiDraftInline: inline && !!compose?.ai });
  const canAttach = !inboxRun && reader && ctxOff && multiSel.length < 2;
  const sub = panelStatus({ held, busy, status, progress });

  return (
    <div className={cx(s.composer, compact && s.compact, phone && s.phone)}>
      {compact && busy ? (
        <div className={s.compactBusy} role="status">
          <Spinner />
          <span className={s.compactStatus}>{sub.text}</span>
          <button type="button" className={s.compactStop} onClick={() => useAssistantStore.getState().stop()}>
            Stop
          </button>
        </div>
      ) : null}

      {exhausted && allowance ? (
        <div className={s.exhausted} role="status">
          You have used all {(allowance.cap ?? 0).toLocaleString("en-US")} assistant requests for this month. The allowance
          resets on {formatResetDate(allowance.resets_at)}.
        </div>
      ) : null}

      {showSuggestions ? (
        <div className={s.suggRow}>
          <span className={s.suggLabel}>
            <LogoMark size={13} />
            Suggested
          </span>
          {fitted.map((sg) => (
            <button key={sg.label} type="button" className={s.sugg} title={sg.label} onClick={() => run(sg.label, sg)}>
              {sg.label}
            </button>
          ))}
        </div>
      ) : null}

      {showStd ? (
        <div className={s.stdRow}>
          {std.map((a) => (
            <button key={a.intent} type="button" className={s.std} title={a.title} disabled={stdBusy} onClick={() => run(a.label, a)}>
              <Icon name={a.icon} size={15} className={s.stdIcon} />
              {a.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className={s.box}>
        {keys.length ? (
          <div className={s.chipLine}>
            <span
              className={s.ctx}
              role="group"
              aria-label={`Goes with your message: ${label}`}
              tabIndex={0}
              title={`Goes with your message: ${label}`}
              onPointerEnter={() => hover(true)}
              onPointerLeave={() => hover(false)}
              onFocus={() => hover(true)}
              onBlur={() => hover(false)}
            >
              <span className={s.ctxIcon}>
                <Mail size={11} aria-hidden="true" />
              </span>
              <span className={s.ctxLabel}>{label}</span>
              <button
                type="button"
                className={s.ctxRemove}
                onClick={removeChip}
                aria-label="Remove. Ask about all your mail instead."
                title="Remove. Ask about all your mail instead."
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          </div>
        ) : null}
        {/* A thread is open: the chip carries its focused message; this widens it to all of them. */}
        {keys.length && canWiden && !inboxRun ? (
          <div className={s.chipLine}>
            <button
              type="button"
              className={s.ctxAdd}
              aria-pressed={whole}
              title={whole ? "Attach only the focused message" : `Attach all ${conversation.length} messages of this conversation`}
              onClick={() => useSelectionStore.getState().setCtxConversation(!whole)}
            >
              {whole ? "Only the focused message" : `The whole conversation (${conversation.length})`}
            </button>
          </div>
        ) : null}
        {canAttach && !keys.length ? (
          <div className={s.chipLine}>
            <button type="button" className={s.ctxAdd} onClick={() => useSelectionStore.getState().setCtxOff(false)}>
              <Plus size={13} aria-hidden="true" />
              Add {who}'s email
            </button>
          </div>
        ) : null}
        <div className={s.inputRow}>
          <textarea
            ref={inputRef}
            {...{ [ASSISTANT_INPUT_ATTR]: "" }}
            className={s.input}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Message the assistant"
            aria-keyshortcuts="Meta+J Control+J"
            placeholder={placeholder}
            enterKeyHint="send"
          />
          {!phone ? <Kbd variant="bare">{modKey("J")}</Kbd> : null}
          {compact ? (
            <button
              type="button"
              className={s.expand}
              aria-label="Full-screen chat"
              title="Full-screen chat"
              onClick={() => useUiStore.getState().setChatFull(true)}
            >
              <Maximize2 size={17} aria-hidden="true" />
            </button>
          ) : null}
          {busy ? (
            <button
              type="button"
              className={cx(s.send, s.stop)}
              onClick={() => useAssistantStore.getState().stop()}
              aria-label="Stop the assistant"
              aria-keyshortcuts="Escape"
              title="Stop (Esc)"
            >
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className={s.send}
              onClick={submit}
              aria-disabled={!text.trim()}
              aria-label="Send to assistant"
              title="Send to assistant (Enter)"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the first of next month";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}
