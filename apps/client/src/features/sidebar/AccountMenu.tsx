import { Bell, Check, ChevronsUpDown, ExternalLink, LogOut, MessagesSquare } from "lucide-react";
import { planDisplayName } from "../../api/types";
import { signOutEverywhere, switchWorkspace } from "../../app/backend";
import { activeWorkspace, useAuthStore, useSessionStore } from "../../auth";
import { DASHBOARD_SETTINGS_URL } from "../../config";
import { cx } from "../../lib/cx";
import { selectConversationView, useUiStore } from "../../state/ui-store";
import { Avatar, Menu, MenuItem, MenuLabel, MenuSeparator } from "../../ui";
import s from "./Sidebar.module.css";

/* The account row of the sidebar footer (HTTP mode): who is signed in, which
 * workspace, and a menu to switch workspace, open the notification settings,
 * open the dashboard settings or sign out. */

export const ACCOUNT_MENU = "account";

/** The Notifications dialog (features/shell/NotificationSettings.tsx), by its ui-store menu id. */
const NOTIFICATIONS_MENU = "notifications";
const openNotifications = () => useUiStore.getState().setMenu(NOTIFICATIONS_MENU);

const openSettings = () => window.open(DASHBOARD_SETTINGS_URL, "_blank", "noopener,noreferrer");

export function AccountMenu({ rail }: { rail: boolean }) {
  const user = useAuthStore((a) => a.user);
  const session = useSessionStore((x) => x.session);
  const open = useUiStore((u) => u.menu === ACCOUNT_MENU);
  const conversationView = useUiStore(selectConversationView);
  const workspace = activeWorkspace(session);
  const workspaces = session?.workspaces ?? [];
  const name = session?.user.display_name || user?.name || user?.email || "Account";
  const email = user?.email || session?.user.email || "";
  const close = () => useUiStore.getState().setMenu(null);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const sub = workspace
    ? workspaces.length > 1
      ? `${workspace.display_name} · ${planDisplayName(workspace.plan)}`
      : `${planDisplayName(workspace.plan)} plan`
    : email;

  return (
    <div className={s.account}>
      <button
        type="button"
        className={cx(s.accountButton, open && s.accountOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={rail ? name : undefined}
        onClick={() => useUiStore.getState().toggleMenu(ACCOUNT_MENU)}
      >
        <Avatar name={name} email={email} size="sm" brand />
        {!rail ? (
          <>
            <span className={s.userText}>
              <span className={s.userName} title={name}>
                {name}
              </span>
              <span className={s.userPlan} title={sub}>
                {sub}
              </span>
            </span>
            <ChevronsUpDown size={14} aria-hidden="true" className={s.accountChevron} />
          </>
        ) : null}
      </button>

      <Menu open={open} onClose={close} label="Account" className={s.accountMenu}>
        <div className={s.accountHead}>
          <div className={s.userName}>{name}</div>
          {email && email !== name ? <div className={s.accountEmail}>{email}</div> : null}
        </div>
        {workspaces.length > 1 ? (
          <>
            <MenuSeparator />
            <MenuLabel>Workspace</MenuLabel>
            {workspaces.map((w) => (
              <MenuItem
                key={w.id}
                onSelect={run(() => void switchWorkspace(w.id))}
                sub={w.web_client_enabled ? planDisplayName(w.plan) : "Web client not enabled"}
                trailing={w.id === workspace?.id ? <Check size={14} aria-label="Current workspace" /> : undefined}
              >
                {w.display_name}
              </MenuItem>
            ))}
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem
          icon={<MessagesSquare size={15} aria-hidden="true" />}
          onSelect={run(() => useUiStore.getState().setSetting("conversationView", !conversationView))}
          sub={conversationView ? "On: replies are grouped with the email they answer" : "Off: every email is its own row"}
          trailing={conversationView ? <Check size={14} aria-label="On" /> : undefined}
        >
          Conversation view
        </MenuItem>
        <MenuItem icon={<Bell size={15} aria-hidden="true" />} onSelect={run(openNotifications)}>
          Notifications
        </MenuItem>
        <MenuItem icon={<ExternalLink size={15} aria-hidden="true" />} onSelect={run(openSettings)}>
          Dashboard settings
        </MenuItem>
        <MenuItem icon={<LogOut size={15} aria-hidden="true" />} onSelect={run(() => void signOutEverywhere())}>
          Sign out
        </MenuItem>
      </Menu>
    </div>
  );
}
