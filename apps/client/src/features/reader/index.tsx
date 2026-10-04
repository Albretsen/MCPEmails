import {
  Archive,
  ChevronDown,
  ChevronLeft,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  Forward,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { describeError, getMailApi, isAbortError } from "../../api";
import { canGoBack, goBack } from "../../app/router";
import {
  type EmailAddressEntry,
  type FolderRef,
  FOLDER_ROLE_LABEL,
  type MessageDetail,
  type MessageKey,
  type ReadEmailAttachmentMeta,
  folderRefId,
  isRoleRef,
} from "../../api/types";
import { findRow, useFolders, useInboxes, useMailActions, useMessage, usePrefetchNeighbours } from "../../data";
import { cx } from "../../lib/cx";
import { saveBlob } from "../../lib/download";
import { displayName, formatBytes, formatFullTime } from "../../lib/format";
import { sanitizeEmailHtml } from "../../lib/sanitize-email-html";
import { useAssistantStore } from "../../state/assistant-store";
import { useComposeStore } from "../../state/compose-store";
import { READ_ONLY_EXPLANATION, canWrite, useCanWrite } from "../../state/permissions";
import { getVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { showToast } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { Avatar, Button, EmptyState, IconButton, Menu, MenuItem, MenuLabel, Skeleton } from "../../ui";
import { ComposeCard } from "../compose";
import { useShell } from "../shell";
import { EmailFrame } from "./EmailFrame";
import { restoreFocusSoon } from "./focus";
import s from "./Reader.module.css";

/* The reader: toolbar, header, body (plain text or sandboxed HTML),
 * attachments and the inline reply. Content of <main> (the shell owns it).
 *
 * The header and a first line of the body paint from the list row in the same
 * frame as the click; only the body waits for the network, and its skeleton
 * appears after 300 ms.
 */

export function ReaderPane() {
  const { phone, toolbarLabels } = useShell();
  const key = useSelectionStore((x) => x.selectedKey);
  const { message, showBodySkeleton, isBodyPending, error, refetch } = useMessage(key);
  const inlineCompose = useComposeStore((x) => !!x.compose && x.compose.replyTo != null && x.compose.replyTo === key);
  const actions = useMailActions();
  const scroller = useRef<HTMLElement>(null);
  const folderTitle = useFolderTitle();

  usePrefetchNeighbours(key);

  // Opening a message marks it read. A separate, quiet flag call: reading
  // itself never changes the flag. Runs when the open message CHANGES, so
  // "mark unread" on the open message sticks.
  useEffect(() => {
    // A read-only member reads without changing the flag: the server would refuse it.
    if (!key || !canWrite()) return;
    const row = findRow(key);
    if (row && !row.is_read && row.folder_role !== "drafts") void actions.markRead([key], true, { silent: true });
  }, [key, actions]);

  // A new message always starts at the top.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [key]);

  // Archive / delete / move on the last row (or on phone) closes the reader and
  // takes the focused toolbar button with it: hand focus to the list.
  const hadKey = useRef(!!key);
  useEffect(() => {
    if (hadKey.current && !key) restoreFocusSoon("list");
    hadKey.current = !!key;
  }, [key]);
  useEffect(() => () => restoreFocusSoon("list"), []);

  if (!key || !message) {
    return (
      <div className={cx(s.root, phone && s.phone)}>
        {phone ? (
          <div className={s.bar}>
            <BackButton label={folderTitle} />
          </div>
        ) : null}
        <EmptyState className={s.none} icon={<Mail size={20} aria-hidden="true" />}>
          No email selected.
          <span className={s.noneHint}>
            Open an email to read it. {phone ? "Ask the assistant below." : "Ask the assistant on the right."}
          </span>
        </EmptyState>
      </div>
    );
  }

  const toolbar = <Toolbar messageKey={key} labels={toolbarLabels} phone={phone} />;

  return (
    <div className={cx(s.root, phone && s.phone)}>
      {phone ? (
        <div className={s.bar}>
          <BackButton label={folderTitle} />
        </div>
      ) : (
        toolbar
      )}
      <article ref={scroller} className={s.body} aria-label={message.subject || "(no subject)"}>
        <Header message={message} showTime={toolbarLabels} showBadgeLabel={toolbarLabels} />
        <Body
          key={key}
          message={message}
          pending={isBodyPending}
          showSkeleton={showBodySkeleton}
          failed={!!error}
          refetch={refetch}
        />
        {inlineCompose ? <ComposeCard inline /> : null}
      </article>
      {phone ? toolbar : null}
    </div>
  );
}

/** The folder (or mailbox view) the reader was opened from: the phone Back label. */
function useFolderTitle(): string {
  const folder = useSelectionStore((x) => x.folder);
  const scope = useSelectionStore((x) => x.scope);
  const searching = useSelectionStore((x) => !!x.query);
  const { folders } = useFolders(scope);
  if (searching) return "Results";
  if (isRoleRef(folder)) return FOLDER_ROLE_LABEL[folder.role];
  const id = folderRefId(folder);
  return folders.find((f) => f.id === id)?.label ?? "Back";
}

function BackButton({ label }: { label: string }) {
  // Back is the browser's Back, so the list returns with its scroll position.
  const back = () => {
    if (canGoBack()) goBack();
    else useSelectionStore.getState().select(null);
  };
  return (
    <button type="button" className={s.back} onClick={back} aria-label={`Back to ${label}`}>
      <ChevronLeft size={20} aria-hidden="true" />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------
 * Toolbar
 * ------------------------------------------------------------------ */

interface ToolProps {
  label: string;
  /** Key shown in the tooltip: "R". */
  hint: string;
  /** aria-keyshortcuts value. */
  shortcut: string;
  icon: ReactNode;
  /** Show the text label next to the icon (wide toolbar only). */
  text?: boolean;
  onClick: () => void;
  expanded?: boolean;
  /** Read-only workspace member: shown, disabled, with the explanation. */
  readOnly?: boolean;
}

function Tool({ label, hint, shortcut, icon, text, onClick, expanded, readOnly }: ToolProps) {
  if (readOnly) {
    // Disabled rather than hidden, so the toolbar keeps its shape and says why.
    if (text) {
      return (
        <Button variant="ghost" className={s.barButton} title={READ_ONLY_EXPLANATION} disabled>
          {icon}
          {label}
        </Button>
      );
    }
    return (
      <IconButton label={label} title={READ_ONLY_EXPLANATION} className={s.tool} disabled>
        {icon}
      </IconButton>
    );
  }
  if (text) {
    return (
      <Button variant="ghost" className={s.barButton} title={`${label} (${hint})`} shortcut={shortcut} onClick={onClick}>
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <IconButton
      label={label}
      hint={hint}
      shortcut={shortcut}
      className={s.tool}
      onClick={onClick}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
    >
      {icon}
    </IconButton>
  );
}

function Toolbar({ messageKey, labels, phone }: { messageKey: MessageKey; labels: boolean; phone: boolean }) {
  const moveOpen = useUiStore((u) => u.menu === "move");
  const scope = useSelectionStore((x) => x.scope);
  const currentFolder = useSelectionStore((x) => folderRefId(x.folder));
  const { folders } = useFolders(scope);
  const actions = useMailActions();
  const readOnly = !useCanWrite();
  const keys = [messageKey];

  const list = getVisibleKeys();
  const pos = list.indexOf(messageKey);

  const targets = folders.filter(
    (f) => (f.kind === "custom" || f.role === "inbox" || f.role === "archive") && f.id !== currentFolder,
  );
  const closeMenu = () => useUiStore.getState().setMenu(null);
  const moveTo = (ref: FolderRef) => {
    closeMenu();
    if (isRoleRef(ref) && ref.role === "archive") void actions.archive(keys);
    else void actions.move(keys, ref);
  };

  return (
    <div
      className={cx(s.bar, phone && s.actions)}
      role="toolbar"
      aria-label={readOnly ? `Email actions. ${READ_ONLY_EXPLANATION}` : "Email actions"}
    >
      <Tool readOnly={readOnly} label="Reply" hint="R" shortcut="R" text={labels} icon={<Reply size={15} aria-hidden="true" />} onClick={() => actions.startReply(messageKey, "reply")} />
      <Tool readOnly={readOnly} label="Reply all" hint="A" shortcut="A" icon={<ReplyAll size={15} aria-hidden="true" />} onClick={() => actions.startReply(messageKey, "reply_all")} />
      <Tool readOnly={readOnly} label="Forward" hint="F" shortcut="F" text={labels} icon={<Forward size={15} aria-hidden="true" />} onClick={() => actions.startReply(messageKey, "forward")} />
      {phone ? null : <span className={s.divider} aria-hidden="true" />}
      <Tool readOnly={readOnly} label="Archive" hint="E" shortcut="E" icon={<Archive size={15} aria-hidden="true" />} onClick={() => void actions.archive(keys)} />
      <Tool
        readOnly={readOnly}
        label="Move to folder"
        hint="V"
        shortcut="V"
        icon={<FolderInput size={15} aria-hidden="true" />}
        expanded={moveOpen}
        onClick={() => useUiStore.getState().toggleMenu("move")}
      />
      <Tool readOnly={readOnly} label="Delete" hint="#" shortcut="#" icon={<Trash2 size={15} aria-hidden="true" />} onClick={() => void actions.trash(keys)} />
      <Tool readOnly={readOnly} label="Mark unread" hint="U" shortcut="U" icon={<MailOpen size={15} aria-hidden="true" />} onClick={() => void actions.markRead(keys, false)} />
      <Menu open={moveOpen && !readOnly} onClose={closeMenu} label="Move to" className={s.moveMenu}>
        <MenuLabel>Move to</MenuLabel>
        {targets.map((t) => (
          <MenuItem
            key={t.id}
            icon={t.role === "inbox" ? <InboxIcon size={14} /> : t.role === "archive" ? <Archive size={14} /> : <Folder size={14} />}
            onSelect={() => moveTo(t.ref)}
          >
            {t.label}
          </MenuItem>
        ))}
      </Menu>
      {labels && !phone && pos >= 0 ? (
        <span className={s.position} aria-label={`Email ${pos + 1} of ${list.length}`}>
          {pos + 1} of {list.length}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------
 * Header
 * ------------------------------------------------------------------ */

const detailDate = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function formatAddresses(list: EmailAddressEntry[]): string {
  return list.map((a) => (a.name.trim() ? `${a.name.trim()} <${a.email}>` : a.email)).join(", ");
}

function Header({ message, showTime, showBadgeLabel }: { message: MessageDetail; showTime: boolean; showBadgeLabel: boolean }) {
  const { data: inboxes } = useInboxes();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const key = message.key;
  const viewedIn = useFolderTitle();
  const viewedByRole = useSelectionStore((x) => isRoleRef(x.folder));

  // Collapsed again for every message.
  useEffect(() => setOpen(false), [key]);

  const inbox = inboxes?.find((i) => i.inbox_id === message.inbox_id);
  const multi = (inboxes?.length ?? 0) > 1;
  const outgoing = !!inbox && message.from.email === inbox.email_address;
  const folderName = message.folder_role
    ? message.folder_role === "inbox"
      ? ""
      : FOLDER_ROLE_LABEL[message.folder_role]
    : viewedByRole
      ? ""
      : viewedIn;
  const folderNote = folderName ? ` · in ${folderName}` : "";
  const meta = outgoing
    ? `to ${message.to.map((a) => a.email).join(", ")}${inbox ? ` · from ${inbox.display_name}` : ""}`
    : `to ${inbox?.email_address ?? message.to[0]?.email ?? ""}${multi && inbox ? ` · ${inbox.display_name}` : ""}${folderNote}`;

  // The same rule as the assistant's context chip: this email rides along with
  // the next message unless the chip was removed, it is a draft, or it is ours.
  const attachable = !outgoing && message.folder_role !== "drafts" && message.folder_role !== "sent";
  const inChat = useSelectionStore((x) =>
    x.multiSel.length > 1 ? x.multiSel.includes(key) : x.selectedKey === key && !x.ctxOff && attachable,
  );
  const date = Date.parse(message.date);

  return (
    <>
      <div className={s.titleRow}>
        <h1 className={s.subject}>{message.subject || "(no subject)"}</h1>
        {inChat ? (
          <span className={s.inChat} title="Attached to your next message to the assistant" aria-label="In chat">
            <span className={s.inChatIcon}>
              <Mail size={11} aria-hidden="true" />
            </span>
            {showBadgeLabel ? "In chat" : null}
          </span>
        ) : null}
      </div>
      <div className={s.sender}>
        <Avatar name={message.from.name} email={message.from.email} />
        <div className={s.senderText}>
          <div className={s.senderName}>
            {displayName(message.from)}{" "}
            {message.from.name ? <span className={s.senderAddr}>&lt;{message.from.email}&gt;</span> : null}
          </div>
          <div className={s.senderMetaRow}>
            <span className={s.senderMeta}>{meta}</span>
            <button
              type="button"
              className={s.detailsToggle}
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={open ? "Hide details" : "Show details"}
              title={open ? "Hide details" : "Show details"}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown size={14} aria-hidden="true" className={cx(s.chevron, open && s.chevronOpen)} />
            </button>
          </div>
        </div>
        {showTime ? (
          <time className={s.time} dateTime={message.date}>
            {formatFullTime(message.date)}
          </time>
        ) : null}
      </div>
      {open ? (
        <dl id={detailsId} className={s.details}>
          <dt>From</dt>
          <dd>{formatAddresses([message.from])}</dd>
          <dt>To</dt>
          <dd>{formatAddresses(message.to) || "(none)"}</dd>
          {message.cc.length ? (
            <>
              <dt>Cc</dt>
              <dd>{formatAddresses(message.cc)}</dd>
            </>
          ) : null}
          <dt>Date</dt>
          <dd>{Number.isNaN(date) ? message.date : detailDate.format(date)}</dd>
          {inbox ? (
            <>
              <dt>Mailbox</dt>
              <dd>
                {inbox.display_name} · {inbox.email_address}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------
 * Body
 * ------------------------------------------------------------------ */

interface BodyProps {
  message: MessageDetail;
  pending: boolean;
  showSkeleton: boolean;
  failed: boolean;
  refetch: () => void;
}

function Body({ message, pending, showSkeleton, failed, refetch }: BodyProps) {
  const key = message.key;
  const linked = useAssistantStore((a) => a.hoverKeys.includes(key));
  const html = useMemo(() => (message.body_html ? sanitizeEmailHtml(message.body_html) : null), [message.body_html]);
  const paragraphs = useMemo(() => (message.body_text ?? "").split(/\n{2,}/).filter(Boolean), [message.body_text]);
  // The list row's preview: something to read in the first frame.
  const preview = pending ? (findRow(key)?.preview ?? "") : "";
  const useHtml = !!html && html.html.trim() !== "";

  let content: ReactNode;
  if (pending) {
    content = (
      <>
        {preview ? <p className={s.preview}>{preview}</p> : null}
        {showSkeleton ? (
          <>
            <Skeleton width="92%" />
            <Skeleton width="78%" />
            <Skeleton width="85%" />
            <Skeleton width="40%" />
          </>
        ) : null}
      </>
    );
  } else if (failed) {
    content = (
      <>
        <p>This email could not be loaded.</p>
        <div>
          <Button size="sm" onClick={refetch}>
            Try again
          </Button>
        </div>
      </>
    );
  } else if (useHtml && html) {
    content = <EmailFrame html={html.html} title={`Email: ${message.subject || "(no subject)"}`} />;
  } else if (paragraphs.length) {
    content = paragraphs.map((p, i) => <p key={i}>{p}</p>);
  } else {
    content = <p>(This email has no text content.)</p>;
  }

  const blocked = useHtml && html ? html.remoteImages : 0;

  return (
    <>
      <div className={cx(s.card, linked && s.cardLinked, pending && s.bodyPending)} aria-busy={pending || undefined}>
        {content}
        {useHtml && html?.truncated && !pending ? <p className={s.preview}>This email is very long. The end was left out.</p> : null}
      </div>

      {message.attachments.length ? <Attachments messageKey={message.key} list={message.attachments} /> : null}

      <div className={s.safety}>
        <ShieldCheck size={13} aria-hidden="true" className={s.safetyIcon} />
        <span>Rendered in a sandbox. Remote images blocked.</span>
        {blocked > 0 ? (
          <button
            type="button"
            className={s.showImages}
            onClick={() => showToast("Image proxy is not connected yet")}
            title={`${blocked} remote ${blocked === 1 ? "image was" : "images were"} not loaded`}
          >
            Show images
          </button>
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------
 * Attachments
 * ------------------------------------------------------------------ */

function attachmentIcon(a: ReadEmailAttachmentMeta): ReactNode {
  const type = a.mime_type.toLowerCase();
  const ext = a.filename.toLowerCase().split(".").pop() ?? "";
  const props = { size: 15, "aria-hidden": true } as const;
  if (type.startsWith("image/")) return <FileImage {...props} />;
  if (type.includes("spreadsheet") || type.includes("excel") || ext === "csv" || ext === "xlsx") return <FileSpreadsheet {...props} />;
  if (type.includes("zip") || type.includes("compressed") || ext === "gz" || ext === "tar") return <FileArchive {...props} />;
  if (type === "application/pdf" || type.startsWith("text/") || type.includes("word") || type.includes("document")) return <FileText {...props} />;
  return <File {...props} />;
}

function Attachments({ messageKey, list }: { messageKey: MessageKey; list: ReadEmailAttachmentMeta[] }) {
  /** Index of the attachment being downloaded. One at a time per message. */
  const [busy, setBusy] = useState<number | null>(null);

  const download = async (a: ReadEmailAttachmentMeta, index: number) => {
    if (busy != null) return;
    setBusy(index);
    try {
      const file = await getMailApi().downloadAttachment(messageKey, index);
      // The name the message gave it wins: the server's header is a fallback.
      saveBlob(file.blob, a.filename || file.filename);
    } catch (err) {
      if (!isAbortError(err)) {
        showToast({
          text: describeError(err, `Could not download ${a.filename || "that attachment"}.`),
          kind: "error",
          action: { label: "Retry", run: () => void download(a, index) },
        });
      }
    }
    setBusy(null);
  };

  return (
    <ul className={s.attachments} aria-label={list.length === 1 ? "1 attachment" : `${list.length} attachments`}>
      {list.map((a, i) => (
        <li key={a.attachment_index ?? i}>
          <button
            type="button"
            className={s.attachment}
            title={`Download ${a.filename}`}
            aria-busy={busy === (a.attachment_index ?? i) || undefined}
            disabled={busy != null}
            onClick={() => void download(a, a.attachment_index ?? i)}
          >
            <span className={s.attachmentIcon}>{attachmentIcon(a)}</span>
            <span className={s.attachmentName}>{a.filename}</span>
            <span className={s.attachmentSize}>{formatBytes(a.size_bytes)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default ReaderPane;
