import type { ReactNode } from "react";
import { activeWorkspace, useAuthStore, useSessionStore } from "../auth";
import { config } from "../config";
import { LoginScreen } from "../features/auth/Login";
import {
  MisconfiguredNotice,
  NoInboxesNotice,
  SessionErrorNotice,
  Splash,
  WebClientDisabledNotice,
} from "../features/auth/Notices";

/* HTTP mode: decides what the whole window shows.
 *
 *   not known yet        a neutral frame (local check, no network)
 *   signed out           the login screen
 *   workspace not allowed  a notice with a link to the dashboard
 *   no mailbox           a prompt to connect one
 *   otherwise            the mail app, painted from the cache while
 *                        `/session` is on its way (never a blocking spinner)
 */
export function Gate({ children }: { children: ReactNode }) {
  const status = useAuthStore((a) => a.status);
  const session = useSessionStore((x) => x.session);
  const sessionStatus = useSessionStore((x) => x.status);
  const fromCache = useSessionStore((x) => x.fromCache);
  const errorCode = useSessionStore((x) => x.errorCode);

  if (config.misconfigured) return <MisconfiguredNotice />;
  if (status === "loading") return <Splash />;
  if (status === "signed-out") return <LoginScreen />;

  const workspace = activeWorkspace(session);
  if (errorCode === "web_client_disabled" || (workspace && !workspace.web_client_enabled)) return <WebClientDisabledNotice />;
  // Nothing to show and no answer: say so, with a way to try again.
  if (!session && (sessionStatus === "error" || errorCode)) return <SessionErrorNotice code={errorCode} />;
  // Only on the server's word: a cached session may predate the first mailbox.
  if (session && !fromCache && session.inboxes.length === 0) return <NoInboxesNotice />;
  return <>{children}</>;
}
