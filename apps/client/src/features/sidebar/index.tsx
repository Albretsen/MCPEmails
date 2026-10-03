import { Columns3, FlaskConical, Folder, Layers, PenLine, Plus } from "lucide-react";
import { memo, startTransition } from "react";
import { type FolderRef, type MailboxScope, folderRefId, planDisplayName } from "../../api/types";
import { type FolderNavItem, mailActions, useAssistantAllowance, useFolders, useInboxUnreadCounts, useInboxes } from "../../data";
import { cx } from "../../lib/cx";
import { SCENES_ENABLED } from "../../dev";
import { useAssistantStore } from "../../state/assistant-store";
import { useSelectionStore } from "../../state/selection-store";
import { showToast } from "../../state/toast-store";
import { selectLayoutCustom, useUiStore } from "../../state/ui-store";
import { Avatar, FOLDER_ROLE_ICON, IconButton, Kbd, LogoMark, Skeleton } from "../../ui";
import { useShell } from "../shell";
import s from "./Sidebar.module.css";
import { allowanceView, countSuffix } from "./model";

/* The sidebar: compose, mailboxes, folders with counts, the assistant
 * allowance meter and the account row. Content of the <nav> landmark the
 * shell owns (desktop only). In rail mode (64 px) it is icons only. */

export function SidebarPane() {
  const { rail } = useShell();
  const scope = useSelectionStore((x) => x.scope);
  // No folder is "current" while search results are showing.
  const folderId = useSelectionStore((x) => (x.query ? "" : folderRefId(x.folder)));
  const { data: inboxes } = useInboxes();
  const { folders, isLoading } = useFolders(scope);
  const unread = useInboxUnreadCounts();
  const multi = (inboxes?.length ?? 0) > 1;

  return (
    <div className={cx(s.root, rail && s.rail)}>
      <div className={s.brand}>
        {rail ? <LogoMark size={28} alt="mcpemails" /> : <img className={s.wordmark} src="/logo-wordmark.svg" alt="mcpemails" />}
      </div>

      <button type="button" className={s.compose} onClick={newCompose} title="Compose (C)" aria-label="Compose" aria-keyshortcuts="C">
        <PenLine size={15} aria-hidden="true" />
        {!rail ? (
          <>
            <span className={s.composeLabel}>Compose</span>
            <Kbd variant="onBrand">C</Kbd>
          </>
        ) : null}
      </button>

      <h2 id="nav-mailboxes" className={rail ? "sr-only" : s.heading}>
        Mailboxes
      </h2>
      {rail ? <div className={s.railGap} /> : null}
      <ul className={s.group} aria-labelledby="nav-mailboxes">
        {multi ? (
          <MailboxItem id="all" name="All mailboxes" address="" count={unread.all ?? 0} active={scope === "all"} rail={rail} />
        ) : null}
        {(inboxes ?? []).map((inbox) => (
          <MailboxItem
            key={inbox.inbox_id}
            id={multi ? inbox.inbox_id : "all"}
            name={inbox.display_name || inbox.email_address}
            address={inbox.email_address}
            needsReconnect={inbox.sender_identity_status === "reconnect_required"}
            count={unread[inbox.inbox_id] ?? 0}
            active={multi && scope === inbox.inbox_id}
            rail={rail}
          />
        ))}
        {!inboxes ? <NavSkeleton rows={2} rail={rail} /> : null}
        {inboxes && !multi ? (
          <li>
            <button type="button" className={cx(s.item, s.connect)} title="Connect another mailbox" onClick={connectMailbox}>
              <span className={s.itemIcon}>
                <Plus size={16} aria-hidden="true" />
              </span>
              {rail ? <span className="sr-only">Connect a mailbox</span> : <span>Connect a mailbox</span>}
            </button>
          </li>
        ) : null}
      </ul>

      <h2 id="nav-folders" className={rail ? "sr-only" : s.heading}>
        Folders
      </h2>
      {rail ? <div className={s.railRule} /> : null}
      <ul className={s.group} aria-labelledby="nav-folders">
        {folders.map((f) => (
          <FolderItem key={f.id} item={f} active={folderId === f.id} rail={rail} />
        ))}
        {isLoading && !folders.some((f) => f.kind === "custom") ? <NavSkeleton rows={2} rail={rail} /> : null}
      </ul>

      <SidebarFoot rail={rail} />
    </div>
  );
}

const newCompose = () => mailActions.newCompose();
const connectMailbox = () => showToast("This opens the connect flow for Gmail, Outlook or IMAP.");
const openScope = (id: MailboxScope) => startTransition(() => useSelectionStore.getState().setScope(id));
const openFolder = (ref: FolderRef) => startTransition(() => useSelectionStore.getState().openFolder(ref));

function NavSkeleton({ rows, rail }: { rows: number; rail: boolean }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className={cx(s.item, s.skeletonItem)} aria-hidden="true">
          <Skeleton width={16} height={16} />
          {!rail ? <Skeleton width={`${60 - i * 15}%`} /> : null}
        </li>
      ))}
    </>
  );
}

interface MailboxItemProps {
  id: MailboxScope;
  name: string;
  /** Empty for "All mailboxes". */
  address: string;
  needsReconnect?: boolean;
  count: number;
  active: boolean;
  rail: boolean;
}

const MailboxItem = memo(function MailboxItem({ id, name, address, needsReconnect, count, active, rail }: MailboxItemProps) {
  const isBox = address !== "";
  return (
    <li>
      <button
        type="button"
        className={cx(s.item, active && s.active)}
        title={isBox ? (needsReconnect ? `${address} (needs reconnecting)` : address) : name}
        aria-current={active ? "page" : undefined}
        onClick={() => openScope(id)}
      >
        <span className={s.itemIcon}>
          {isBox ? <span className={cx(s.liveDot, needsReconnect && s.warnDot)} /> : <Layers size={16} aria-hidden="true" />}
        </span>
        {!rail ? (
          <>
            <span className={s.itemText}>
              <span className={s.itemName}>{name}</span>
              {isBox ? <span className={s.itemAddr}>{address}</span> : null}
            </span>
            {count > 0 ? (
              <span className={s.count} aria-hidden="true">
                {count}
              </span>
            ) : null}
          </>
        ) : (
          <span className="sr-only">{name}</span>
        )}
        <span className="sr-only">{countSuffix(count, "unread")}</span>
      </button>
    </li>
  );
});

const FolderItem = memo(function FolderItem({ item, active, rail }: { item: FolderNavItem; active: boolean; rail: boolean }) {
  // Granular: only this folder re-renders when its bump changes.
  const bump = useAssistantStore((a) => a.folderBump[item.id] ?? 0);
  const IconCmp = (item.role && FOLDER_ROLE_ICON[item.role]) || Folder;
  return (
    <li>
      <button
        type="button"
        className={cx(s.item, active && s.active, bump > 0 && s.bumped)}
        title={item.label}
        aria-current={active ? "page" : undefined}
        onClick={() => openFolder(item.ref)}
      >
        <span className={s.itemIcon}>
          <IconCmp size={16} aria-hidden="true" />
        </span>
        {!rail ? (
          <>
            <span className={s.itemLabel}>{item.label}</span>
            {bump > 0 ? (
              <span className={s.bump} aria-hidden="true">
                +{bump}
              </span>
            ) : null}
            {item.count > 0 ? (
              <span className={s.count} aria-hidden="true">
                {item.count}
              </span>
            ) : null}
          </>
        ) : (
          <span className="sr-only">{item.label}</span>
        )}
        <span className="sr-only">{countSuffix(item.count, item.role === "inbox" ? "unread" : "total")}</span>
      </button>
    </li>
  );
});

function SidebarFoot({ rail }: { rail: boolean }) {
  const { data: allowance } = useAssistantAllowance();
  const { data: inboxes } = useInboxes();
  const layoutCustom = useUiStore(selectLayoutCustom);
  const first = inboxes?.[0];
  const identity = first?.sender_identities.find((i) => i.is_default) ?? first?.sender_identities[0];
  const name = identity?.display_name || first?.email_address || "Account";
  const view = allowance ? allowanceView(allowance) : null;

  return (
    <div className={s.foot}>
      {!rail && view ? (
        <>
          <div className={s.allowanceRow}>
            <span>AI allowance</span>
            {/* Never a null cap as a number: "312 / 1,000" or "312 used". */}
            <span className={s.allowanceValue}>{view.text}</span>
          </div>
          {view.fraction != null ? (
            <div
              className={s.meter}
              role="meter"
              aria-label="Assistant allowance used this month"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={view.fraction}
              aria-valuetext={view.valueText}
            >
              {/* Dynamic value only: the fill is scaled, not resized (transform-only motion). */}
              <div className={cx(s.meterFill, view.tone === "warn" && s.meterWarn)} style={{ transform: `scaleX(${view.fraction})` }} />
            </div>
          ) : null}
        </>
      ) : null}
      <div className={s.userRow}>
        <span title={rail ? name : undefined}>
          <Avatar name={name} size="sm" brand />
        </span>
        {!rail ? (
          <div className={s.userText}>
            <div className={s.userName} title={name}>
              {name}
            </div>
            <div className={s.userPlan}>{allowance ? `${planDisplayName(allowance.plan)} plan` : " "}</div>
          </div>
        ) : null}
        {layoutCustom ? (
          <IconButton label="Reset layout to default" size="sm" onClick={() => useUiStore.getState().resetLayout()}>
            <Columns3 size={15} aria-hidden="true" />
          </IconButton>
        ) : null}
        {SCENES_ENABLED ? (
          <IconButton label="Prototype scenes" size="sm" onClick={() => useUiStore.getState().toggleMenu("scenes")}>
            <FlaskConical size={15} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

export default SidebarPane;
