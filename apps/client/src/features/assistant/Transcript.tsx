import { ArrowDown, Check, Mail, Pause, ShieldAlert, X } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AssistantChip, AssistantToolCall } from "../../api/assistant-api";
import { FOLDER_ROLE_LABEL, type MessageKey, isNameRef, isRoleRef } from "../../api/types";
import { findRow, mailActions } from "../../data";
import { cx } from "../../lib/cx";
import { displayName } from "../../lib/format";
import { type AssistantCardView, type AssistantMessage, setAssistantPinned, useAssistantStore } from "../../state/assistant-store";
import { useSelectionStore } from "../../state/selection-store";
import { Button, Icon, LogoMark, Spinner } from "../../ui";
import { useShell } from "../shell";
import s from "./Assistant.module.css";
import { RECENT_TURNS, STEP_META_MIN_WIDTH, earlierLabel, visibleMessages } from "./model";

/** Distance from the bottom within which the transcript counts as pinned. */
const PIN_TOLERANCE = 32;
/** A row has to stay hovered this long before the transcript scrolls to its step. */
const LINK_DWELL_MS = 140;
const FLASH_MS = 1600;

const isActive = (c: AssistantToolCall) => c.state === "running" || c.state === "waiting" || c.state === "held";

export function Transcript() {
  const messages = useAssistantStore((a) => a.messages);
  const newBelow = useAssistantStore((a) => a.newBelow);
  const showEarlier = useAssistantStore((a) => a.showEarlier);
  const linkCall = useAssistantStore((a) => a.linkCall);
  const { assistantWidth } = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<string | null>(null);

  const { shown, turns, hidden } = visibleMessages(messages, showEarlier);
  const showMeta = assistantWidth >= STEP_META_MIN_WIDTH;

  useEffect(() => {
    setAssistantPinned(true);
    return () => setAssistantPinned(true);
  }, []);

  // Follow the stream only while the user is at the bottom.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, openSteps]);

  /* A row in the list points at one of the steps here: open the step list it
   * is in, scroll it into view and flash it. With reduced motion the flash is
   * a static highlight (the animation is switched off globally). */
  useEffect(() => {
    if (!linkCall) return;
    const dwell = setTimeout(() => {
      const all = useAssistantStore.getState().messages;
      const owner = all.find((m) => m.calls.some((c) => c.id === linkCall));
      if (!owner) return;
      const current = owner.calls.find(isActive) ?? owner.calls[owner.calls.length - 1];
      if (current?.id !== linkCall) setOpenSteps((o) => (o[owner.id] ? o : { ...o, [owner.id]: true }));
      if (!visibleMessages(all, useAssistantStore.getState().showEarlier).shown.includes(owner)) {
        useAssistantStore.getState().setShowEarlier(true);
      }
      setFlash(linkCall);
      // After the step list has rendered.
      requestAnimationFrame(() => {
        const el = ref.current?.querySelector<HTMLElement>(`[data-call="${CSS.escape(linkCall)}"]`);
        el?.scrollIntoView({ block: "nearest" });
      });
    }, LINK_DWELL_MS);
    return () => clearTimeout(dwell);
  }, [linkCall]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const p = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_TOLERANCE;
    if (p !== pinned.current) {
      pinned.current = p;
      setAssistantPinned(p);
    }
  };
  const jump = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setAssistantPinned(true);
  };
  const toggleSteps = useCallback((id: string) => setOpenSteps((o) => ({ ...o, [id]: !o[id] })), []);

  // Announced once per finished message, never per token.
  let announce = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.text && !m.streaming) {
      announce = m.text;
      break;
    }
  }

  return (
    <>
      <div ref={ref} className={s.chat} onScroll={onScroll} role="log" aria-live="off" aria-label="Conversation with the assistant" tabIndex={0}>
        {messages.length === 0 ? (
          <div className={s.intro}>
            <div className={s.introTitle}>What should I do with your mail?</div>
            <div className={s.introText}>
              I can read, search, draft and file. Every email I touch is highlighted in your list. I never send without your
              approval.
            </div>
          </div>
        ) : null}
        {turns > RECENT_TURNS ? (
          <button type="button" className={s.textButton} onClick={() => useAssistantStore.getState().setShowEarlier(!showEarlier)}>
            {earlierLabel(turns, showEarlier)}
            {hidden ? <span className="sr-only"> ({hidden} hidden)</span> : null}
          </button>
        ) : null}
        {shown.map((m, i) => (
          <Message
            key={m.id}
            m={m}
            first={m.role === "assistant" && shown[i - 1]?.role !== "assistant"}
            open={!!openSteps[m.id]}
            onToggle={toggleSteps}
            showMeta={showMeta}
            flash={flash && m.calls.some((c) => c.id === flash) ? flash : null}
          />
        ))}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      {newBelow ? (
        <div className={s.pillSlot}>
          <button type="button" className={s.pill} onClick={jump}>
            <ArrowDown size={13} aria-hidden="true" />
            New from the assistant
          </button>
        </div>
      ) : null}
    </>
  );
}

interface MessageProps {
  m: AssistantMessage;
  first: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  showMeta: boolean;
  flash: string | null;
}

const Message = memo(function Message({ m, first, open, onToggle, showMeta, flash }: MessageProps) {
  if (m.role === "user") {
    return (
      <div className={s.msg}>
        <div className={s.user}>
          {m.context?.keys.length ? <SentChip keys={m.context.keys} label={m.context.label} /> : null}
          <div className={s.userText}>{m.text}</div>
        </div>
      </div>
    );
  }
  const expanded = open && m.calls.length > 1;
  const current = m.calls.find(isActive) ?? m.calls[m.calls.length - 1];
  return (
    <div className={s.msg}>
      <div className={s.asst}>
        <span className={s.mark}>{first ? <LogoMark size={22} alt="Assistant" /> : null}</span>
        <div className={s.asstBody}>
          {m.text || m.streaming ? (
            <div className={s.text}>
              {m.text}
              {m.streaming ? <span className={s.cursor} aria-hidden="true" /> : null}
            </div>
          ) : null}
          {m.retryable ? (
            <button type="button" className={s.textButton} onClick={() => void useAssistantStore.getState().retry()}>
              Try again
            </button>
          ) : null}
          {current && !expanded ? (
            <div className={s.stepRow}>
              <Step call={current} showMeta={showMeta} flash={flash === current.id} variant="line" />
              {m.calls.length > 1 ? (
                <button type="button" className={s.textButton} aria-expanded={false} onClick={() => onToggle(m.id)}>
                  {m.calls.length} steps
                </button>
              ) : null}
            </div>
          ) : null}
          {expanded ? (
            <div className={s.stepList}>
              <div className={s.calls}>
                {m.calls.map((c) => (
                  <Step key={c.id} call={c} showMeta={showMeta} flash={flash === c.id} variant="row" />
                ))}
              </div>
              <button type="button" className={s.textButton} aria-expanded onClick={() => onToggle(m.id)}>
                Hide steps
              </button>
            </div>
          ) : null}
          {m.cards.length ? (
            <div className={s.stack}>
              {m.cards.map((k) => (
                <Card key={k.id} card={k} messageId={m.id} />
              ))}
            </div>
          ) : null}
          {m.chips.length ? (
            <div className={s.stack}>
              {m.chips.map((ch, i) => (
                <Chip key={i} chip={ch} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function StateIcon({ call }: { call: AssistantToolCall }) {
  switch (call.state) {
    case "running":
      // No label: a labelled spinner is a live region and would speak per step.
      return <Spinner />;
    case "done":
      return <Check size={14} className={s.done} aria-label="Done" />;
    case "waiting":
      return <ShieldAlert size={14} className={s.waiting} aria-label="Needs your approval" />;
    case "held":
      return <Pause size={13} className={s.held} aria-label="Paused" />;
    default:
      return <X size={14} className={s.cancelled} aria-label="Stopped" />;
  }
}

/** One tool call. `line` is the single collapsed step, `row` an entry of the
 *  expanded list. Hover or focus highlights the email it touched; a click
 *  opens that email (or folder). */
function Step({ call, showMeta, flash, variant }: { call: AssistantToolCall; showMeta: boolean; flash: boolean; variant: "line" | "row" }) {
  const lit = useAssistantStore((a) => a.linkCall === call.id);
  const key = call.keys[0];
  const linkable = !!key || !!call.folder;
  const active = isActive(call);
  const className = cx(
    variant === "line" ? s.step : s.callRow,
    linkable && s.linkable,
    active && s.stepActive,
    call.state === "waiting" && s.stepWaiting,
    (lit || flash) && s.stepLit,
    flash && s.stepFlash,
  );
  const link = (on: boolean) => {
    const a = useAssistantStore.getState();
    if (call.keys.length > 1) a.setHoverKeys(on ? call.keys : []);
    else a.setLinkEmail(on && key ? key : null);
  };
  const open = () => {
    if (key) mailActions.openEmailFromChat(key);
    else if (call.folder) useSelectionStore.getState().openFolder(call.folder);
  };
  const content = (
    <>
      <span className={s.stepState}>
        <StateIcon call={call} />
      </span>
      <span className={s.stepLabel}>{call.human}</span>
      {showMeta && call.meta ? <span className={s.stepMeta}>{call.meta}</span> : null}
    </>
  );
  const title = `Tool: ${call.tool}${call.action ? ` (${call.action})` : ""}`;
  if (!linkable) {
    return (
      <div data-call={call.id} className={className} title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-call={call.id}
      className={className}
      title={title}
      onClick={open}
      onPointerEnter={() => link(true)}
      onPointerLeave={() => link(false)}
      onFocus={() => link(true)}
      onBlur={() => link(false)}
    >
      {content}
    </button>
  );
}

function Card({ card, messageId }: { card: AssistantCardView; messageId: string }) {
  const busy = useAssistantStore((a) => a.busy);
  const press = () => {
    const a = useAssistantStore.getState();
    if (a.busy) return;
    a.markCardDone(messageId, card.id);
    void a.run(card.prompt, { intent: card.intent, free: card.free });
  };
  return (
    <div className={s.card}>
      <span className={s.cardIcon}>
        <Icon name={card.icon} size={16} />
      </span>
      <div className={s.cardBody}>
        <div>
          <div className={s.cardTitle}>{card.title}</div>
          <div className={s.cardSub}>{card.sub}</div>
        </div>
        {card.done ? (
          <span className={s.cardDone}>
            <Check size={14} className={s.done} aria-hidden="true" />
            Started
          </span>
        ) : (
          <Button variant="primary" className={s.cardButton} disabled={busy} onClick={press}>
            {card.action}
          </Button>
        )}
      </div>
    </div>
  );
}

function Chip({ chip }: { chip: AssistantChip }) {
  if (chip.kind === "draft") {
    const go = () => document.querySelector("[data-draft]")?.scrollIntoView({ block: "nearest" });
    return (
      <button type="button" className={s.chip} onClick={go}>
        <ArrowDown size={14} className={s.chipIcon} aria-hidden="true" />
        <span className={s.chipText}>
          <span className={s.chipLabel}>{chip.label ?? "Go to the draft"}</span>
          <span className={s.chipSub}>{chip.sub ?? "Under the email"}</span>
        </span>
      </button>
    );
  }
  if (chip.kind === "folder") {
    const f = chip.folder;
    const name = chip.label ?? (isRoleRef(f) ? FOLDER_ROLE_LABEL[f.role] : isNameRef(f) ? f.name : f.folder_id);
    return (
      <button type="button" className={s.chip} onClick={() => useSelectionStore.getState().openFolder(f)}>
        <Icon name={isRoleRef(f) && f.role === "archive" ? "archive" : "folder"} size={14} className={s.chipIcon} />
        <span className={s.chipText}>
          <span className={s.chipLabel}>{name}</span>
          {chip.sub ? <span className={s.chipSub}>{chip.sub}</span> : null}
        </span>
      </button>
    );
  }
  const row = findRow(chip.key);
  const label = chip.label ?? (row ? `${displayName(row.from)} · ${row.subject}` : "Email");
  const link = (k: MessageKey | null) => useAssistantStore.getState().setLinkEmail(k);
  return (
    <button
      type="button"
      className={s.chip}
      onClick={() => mailActions.openEmailFromChat(chip.key)}
      onPointerEnter={() => link(chip.key)}
      onPointerLeave={() => link(null)}
      onFocus={() => link(chip.key)}
      onBlur={() => link(null)}
    >
      <Mail size={14} className={s.chipIcon} aria-hidden="true" />
      <span className={s.chipText}>
        <span className={s.chipLabel}>{label}</span>
        <span className={s.chipSub}>{chip.sub ?? row?.preview ?? ""}</span>
      </span>
    </button>
  );
}

/** The chip on a message the user sent: what went with it. Opens that email. */
function SentChip({ keys, label }: { keys: MessageKey[]; label: string }) {
  const hover = (on: boolean) => useAssistantStore.getState().setHoverKeys(on ? keys : []);
  const single = keys.length === 1 ? keys[0] : undefined;
  const open = () => single && mailActions.openEmailFromChat(single);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
  return (
    <span
      className={s.sentChip}
      role="button"
      tabIndex={0}
      title={label}
      onClick={open}
      onKeyDown={onKeyDown}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      onFocus={() => hover(true)}
      onBlur={() => hover(false)}
    >
      <span className={s.sentChipIcon}>
        <Mail size={9} aria-hidden="true" />
      </span>
      <span className={s.sentChipLabel}>{label}</span>
    </span>
  );
}
