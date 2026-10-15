import { Inbox as InboxIcon, Lock, PlugZap, WifiOff } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import type { WorkspaceInfo } from "../../api/types";
import { loadSession, signOutEverywhere, switchWorkspace } from "../../app/backend";
import { useAuthStore, useSessionStore } from "../../auth";
import { DASHBOARD_URL } from "../../config";
import { Button, LogoMark } from "../../ui";
import s from "./Auth.module.css";

/* Full-page states of a signed-in account that cannot show mail (yet). Each
 * says what is going on, what to do about it, and who is signed in. */

interface FrameProps {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Other workspaces this account could switch to. */
  workspaces?: WorkspaceInfo[];
}

function Frame({ icon, title, children, actions, workspaces }: FrameProps) {
  const user = useAuthStore((a) => a.user);
  useEffect(() => {
    document.title = `${title} · mcpemails`;
  }, [title]);

  return (
    <div className={s.page}>
      <main className={s.center}>
        <div className={s.brand}>
          <img className={s.wordmark} src="/logo-wordmark.svg" alt="mcpemails" />
        </div>
        <div className={s.card}>
          <div className={s.noticeIcon}>{icon}</div>
          <h1 className={s.title}>{title}</h1>
          <p className={s.noticeText}>{children}</p>
          {actions ? <div className={s.actions}>{actions}</div> : null}
          {workspaces?.length ? (
            <ul className={s.workspaces} aria-label="Your other workspaces">
              <li className={s.workspacesLabel}>Open another workspace</li>
              {workspaces.map((w) => (
                <li key={w.id}>
                  <Button onClick={() => void switchWorkspace(w.id)}>{w.display_name}</Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {user ? (
          <p className={s.account}>
            Signed in as {user.email}.{" "}
            <Button variant="ghost" size="sm" onClick={() => void signOutEverywhere()}>
              Sign out
            </Button>
          </p>
        ) : null}
      </main>
    </div>
  );
}

const dashboardLink = (label: string) => (
  <a className={s.linkButton} href={DASHBOARD_URL} target="_blank" rel="noreferrer">
    {label}
  </a>
);

const retry = (
  <Button onClick={() => void loadSession()}>Check again</Button>
);

/** `web_client_disabled`: the workspace is not on the allow-list yet. */
export function WebClientDisabledNotice() {
  const session = useSessionStore((x) => x.session);
  const others = (session?.workspaces ?? []).filter((w) => w.id !== session?.workspace_id && w.web_client_enabled);
  const name = session?.workspaces.find((w) => w.id === session.workspace_id)?.display_name;
  return (
    <Frame
      icon={<Lock size={20} aria-hidden="true" />}
      title="The web client is not enabled here yet"
      workspaces={others}
      actions={
        <>
          {dashboardLink("Open the dashboard")}
          {retry}
        </>
      }
    >
      {name ? `${name} does` : "This workspace does"} not have access to the web client yet. Your mailboxes keep working
      everywhere else, and everything is managed in the dashboard as before.
    </Frame>
  );
}

/** A workspace with no connected mailbox. */
export function NoInboxesNotice() {
  return (
    <Frame
      icon={<InboxIcon size={20} aria-hidden="true" />}
      title="Connect a mailbox to get started"
      actions={
        <>
          {dashboardLink("Connect a mailbox")}
          {retry}
        </>
      }
    >
      This workspace has no mailbox connected yet. Connect Gmail, Outlook or any IMAP account in the dashboard, then come
      back here.
    </Frame>
  );
}

/** `/session` failed and there is nothing cached to show instead. */
export function SessionErrorNotice({ code }: { code: string | null }) {
  const offline = code === "offline" || code === "network";
  return (
    <Frame
      icon={offline ? <WifiOff size={20} aria-hidden="true" /> : <PlugZap size={20} aria-hidden="true" />}
      title={offline ? "You are offline" : "Could not load your account"}
      actions={<Button variant="primary" onClick={() => void loadSession()}>Try again</Button>}
    >
      {offline
        ? "There is no saved mail for this account on this device yet. Connect to the internet and try again."
        : code === "timeout"
          ? "The server took too long to answer. Nothing is wrong with your mail."
          : code === "forbidden"
            ? "This account does not have access to a workspace."
            : "Something went wrong on our side. Nothing is wrong with your mail."}
    </Frame>
  );
}

/** A production build without its Supabase settings. */
export function MisconfiguredNotice() {
  return (
    <div className={s.page}>
      <main className={s.center}>
        <div className={s.card}>
          <h1 className={s.title}>This build is not configured</h1>
          <p className={s.noticeText}>
            VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing. Set them (see .env.example), or set VITE_USE_MOCK=1
            to run on the demo mailbox.
          </p>
        </div>
      </main>
    </div>
  );
}

/** While the stored session is being checked. */
export function Splash() {
  return (
    <div className={s.splash} role="status" aria-label="Loading mcpemails">
      <LogoMark size={36} />
    </div>
  );
}
