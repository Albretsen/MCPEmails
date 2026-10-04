import { useEffect, useRef, useSyncExternalStore } from "react";
import { currentOverlay, popOverlay, pushOverlay, subscribeRoute } from "../../app/router";
import { FOLDER_ROLE_LABEL, folderRefId, isNameRef, isRoleRef } from "../../api/types";
import { useFolders, useInboxUnreadCounts } from "../../data/hooks";
import { getPlatform } from "../../platform";
import { describeConnection, useConnectionStore } from "../../state/connection-store";
import { useSelectionStore } from "../../state/selection-store";
import { useUiStore } from "../../state/ui-store";
import s from "./AppShell.module.css";
import { usePendingSequence } from "./shortcuts";

const APP_NAME = "mcpemails";
const CHAT_OVERLAY = "chat";

/** Document title: "Inbox (7) · mcpemails". */
function useDocumentTitle(): void {
  const scope = useSelectionStore((x) => x.scope);
  const folder = useSelectionStore((x) => x.folder);
  const query = useSelectionStore((x) => x.query);
  const { folders } = useFolders(scope);

  const item = folders.find((f) => f.id === folderRefId(folder));
  const label = query
    ? `Search: ${query}`
    : (item?.label ?? (isRoleRef(folder) ? FOLDER_ROLE_LABEL[folder.role] : isNameRef(folder) ? folder.name : "Mail"));
  // Unread is only meaningful where new mail lands: the inbox and custom folders.
  const countable = !query && item != null && (item.role === "inbox" || item.kind === "custom");
  const unread = countable ? (item.unread ?? 0) : 0;

  useEffect(() => {
    document.title = `${label}${unread > 0 ? ` (${unread})` : ""} · ${APP_NAME}`;
  }, [label, unread]);
}

/** App icon badge = unread in all inboxes. A no-op where the Badging API is missing. */
function useAppBadge(): void {
  const total = useInboxUnreadCounts().all ?? 0;
  useEffect(() => {
    void getPlatform().badge.set(total);
  }, [total]);
}

/** Phone: the full-screen chat gets a history entry, so the Back button or
 *  gesture closes it instead of leaving the screen underneath. */
function usePhoneChatHistory(): void {
  const phone = useUiStore((u) => u.viewport === "phone");
  const chatFull = useUiStore((u) => u.chatFull);
  const was = useRef(chatFull);

  // Opened or closed from the UI: add or drop the entry.
  useEffect(() => {
    const before = was.current;
    was.current = chatFull;
    if (!phone || before === chatFull) return;
    if (chatFull) pushOverlay(CHAT_OVERLAY);
    else popOverlay(CHAT_OVERLAY);
  }, [phone, chatFull]);

  // Back / Forward: the entry says whether the chat is showing. Also on load,
  // when the page was reloaded while the chat was open.
  useEffect(() => {
    const sync = () => {
      const ui = useUiStore.getState();
      if (ui.viewport === "phone") ui.setChatFull(currentOverlay() === CHAT_OVERLAY);
    };
    if (currentOverlay() === CHAT_OVERLAY) sync();
    return subscribeRoute((_route, cause) => {
      if (cause === "pop") sync();
    });
  }, []);
}

/** Side effects of the shell that subscribe to data. Its own component so the
 *  frame does not re-render when a folder count changes. Renders nothing. */
export function ShellEffects() {
  useDocumentTitle();
  useAppBadge();
  usePhoneChatHistory();
  return null;
}

/* ------------------------------------------------------------------ */

function subscribeOnline(cb: () => void): () => void {
  return getPlatform().network.subscribe(cb);
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => getPlatform().network.isOnline(),
    () => true,
  );
}

/** A small pill while the browser reports no connection. The live region is
 *  always mounted so going offline is announced; it never takes focus and
 *  never intercepts pointer events. */
export function OfflineIndicator() {
  const online = useOnline();
  // Diagnostics only (which transport is in use): a tooltip, never text.
  const connection = useConnectionStore();
  return (
    <div className={s.offlineHost} role="status" aria-live="polite" title={describeConnection(connection)}>
      {online ? null : <span className={s.offline}>Offline. Showing saved mail.</span>}
    </div>
  );
}

/** "g…" while a two-key sequence waits for its second key. Decorative. */
export function KeyHint() {
  const prefix = usePendingSequence();
  if (!prefix) return null;
  return (
    <div className={s.keyHint} aria-hidden="true">
      {prefix}…
    </div>
  );
}
