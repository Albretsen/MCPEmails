import { Archive, Check, Mail, Paperclip, Star, Trash2 } from "lucide-react";
import { memo } from "react";
import type { MessageKey } from "../../api/types";
import { cx } from "../../lib/cx";
import { formatListTime } from "../../lib/format";
import {
  selectGhost,
  selectIsFresh,
  selectIsLeaving,
  selectIsLinked,
  selectLabel,
  selectTouch,
  selectTrace,
  useAssistantStore,
} from "../../state/assistant-store";
import { READ_ONLY_EXPLANATION } from "../../state/permissions";
import { useSelectionStore } from "../../state/selection-store";
import { Icon, LogoMark } from "../../ui";
import s from "./List.module.css";
import { folderRefLabel, rowAriaLabel, rowDecor } from "./model";

/** Primitive props only: with React.memo a row re-renders when one of ITS
 *  values changes, never because the list did. */
export interface RowProps {
  rowKey: MessageKey;
  who: string;
  /** Messages in the conversation this row stands for (1: a single email). */
  count?: number;
  subject: string;
  preview: string;
  /** ISO date. */
  date: string;
  unread: boolean;
  starred: boolean;
  canStar: boolean;
  /** Read-only workspace member: the star shows its state but cannot be changed. */
  readOnly?: boolean;
  /** Can ride along as assistant context (not mail the user wrote). */
  attachable: boolean;
  hasAttachment: boolean;
  /** Mailbox name for the third line (unified view), or "". */
  boxName: string;
  index: number;
  setSize: number;
  /** Virtual offset in px. */
  start: number;
  height: number;
  /** Rows are being ticked: every row shows its checkbox. */
  ticking: boolean;
  /** This row is the first (and so far only) ticked one. */
  anchored: boolean;
  /** Phone layout: no hover affordances, no "open" highlight, swipe backdrop. */
  touchUi: boolean;
}

export const rowDomId = (key: string) => `row-${key}`;

/** One message row. Purely presentational: every interaction is delegated to
 *  the list (see useListInteractions), and every piece of selection or
 *  assistant state is read through a selector keyed on this row. */
export const Row = memo(function Row(p: RowProps) {
  const key = p.rowKey;
  // Ticked rows are "selected" everywhere; the open row only where a reader sits beside the list.
  const inMulti = useSelectionStore((x) => x.multiSel.length > 1 && x.multiSel.includes(key));
  const isOpen = useSelectionStore((x) => !p.touchUi && x.multiSel.length < 2 && x.selectedKey === key);
  // What the next message to the assistant would carry along.
  const attached = useSelectionStore((x) =>
    x.multiSel.length > 1 ? x.multiSel.includes(key) : !p.touchUi && !x.ctxOff && x.selectedKey === key,
  );
  const touch = useAssistantStore(selectTouch(key));
  const trace = useAssistantStore(selectTrace(key));
  const ghost = useAssistantStore(selectGhost(key));
  const label = useAssistantStore(selectLabel(key));
  const fresh = useAssistantStore(selectIsFresh(key));
  const leaving = useAssistantStore(selectIsLeaving(key));
  const linked = useAssistantStore(selectIsLinked(key));

  const checked = inMulti || p.anchored;
  const selected = isOpen || checked;
  const decor = rowDecor({
    touch,
    hasTrace: !!trace,
    ghostTo: ghost ? folderRefLabel(ghost.to, "another folder") : null,
    label,
    attached: attached && p.attachable,
    fresh,
  });
  const time = formatListTime(p.date);

  return (
    <div
      id={rowDomId(key)}
      role="option"
      aria-selected={selected}
      aria-setsize={p.setSize}
      aria-posinset={p.index + 1}
      aria-label={rowAriaLabel({
        unread: p.unread,
        starred: p.starred,
        who: p.who,
        subject: p.subject,
        time,
        status: decor.tag?.text ?? decor.note,
        hasAttachment: p.hasAttachment,
        count: p.count,
      })}
      data-row={key}
      className={cx(
        s.row,
        p.unread && s.unread,
        selected && s.selected,
        linked && s.linked,
        decor.tone === "cobalt" && s.toneCobalt,
        decor.tone === "amber" && s.toneAmber,
        touch && s.touched,
        ghost && !touch && s.ghost,
        leaving && s.leaving,
        p.ticking && s.ticking,
      )}
      // Dynamic pixel values only (the virtual row's position).
      style={{ height: p.height, transform: `translateY(${p.start}px)` }}
    >
      {p.touchUi ? (
        <div className={s.swipeBg} aria-hidden="true">
          <Archive size={20} className={s.swipeArchive} />
          <Trash2 size={20} className={s.swipeTrash} />
        </div>
      ) : null}
      <div className={s.body} data-body="">
        <div className={s.line}>
          <span className={s.lead}>
            <span className={s.dot} />
            <span
              data-act="check"
              className={cx(s.check, checked && s.checked)}
              title="Select for the assistant (X)"
              aria-hidden="true"
            >
              {checked ? <Check size={11} /> : null}
            </span>
          </span>
          <span className={cx(s.from, p.count && p.count > 1 && s.fromCounted)}>{p.who}</span>
          {p.count && p.count > 1 ? (
            <span className={s.count} title={`${p.count} messages in this conversation`} aria-hidden="true">
              {p.count}
            </span>
          ) : null}
          {decor.tag ? (
            <span
              data-act="trace"
              className={cx(s.tag, decor.tag.amber && s.tagAmber)}
              title="Show what the assistant did"
              aria-hidden="true"
            >
              <Icon name={decor.tag.icon} size={11} />
              {decor.tag.text}
            </span>
          ) : null}
          {decor.note ? (
            <span className={s.note} aria-hidden="true">
              {decor.note}
            </span>
          ) : null}
          {decor.trace ? (
            <span
              data-act="trace"
              className={s.trace}
              title="The assistant touched this. Show what it did."
              aria-hidden="true"
            >
              <LogoMark size={15} />
            </span>
          ) : null}
          {decor.inChat ? (
            <span className={s.inChat} title="Attached to your next message to the assistant" aria-hidden="true">
              <Mail size={9} />
            </span>
          ) : null}
          <time className={s.time} dateTime={p.date} aria-hidden="true">
            {time}
          </time>
        </div>
        <div className={cx(s.line, s.indent)}>
          <span className={s.subject}>{p.subject}</span>
          {p.canStar ? (
            <span
              data-act="star"
              className={cx(s.star, p.starred && s.starOn, p.readOnly && s.starLocked)}
              title={p.readOnly ? READ_ONLY_EXPLANATION : p.starred ? "Remove star (S)" : "Star (S)"}
              aria-hidden="true"
            >
              <Star size={14} fill={p.starred ? "currentColor" : "none"} />
            </span>
          ) : null}
        </div>
        <div className={cx(s.line, s.indent)}>
          <span className={s.preview}>{p.preview}</span>
          {p.hasAttachment ? <Paperclip size={12} className={s.clip} aria-hidden="true" /> : null}
          {p.boxName ? <span className={s.box}>{p.boxName}</span> : null}
        </div>
      </div>
    </div>
  );
});
