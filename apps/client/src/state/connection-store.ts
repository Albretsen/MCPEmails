import { create } from "zustand";
import type { SocketDiagnostics } from "../api/http/socket";

/* How requests are travelling right now: over the socket (`live`), or over
 * HTTP while the socket is opening (`connecting`) or unavailable
 * (`fallback-http`). DIAGNOSTICS ONLY: nothing in the UI may depend on it or
 * show it as a state of the app (both transports serve the app fully). It is
 * readable as the `title` of the offline-indicator host. */

export const useConnectionStore = create<SocketDiagnostics>(() => ({
  state: "fallback-http",
  connectMs: null,
  lastRoundTripMs: null,
  connects: 0,
  lastCloseCode: null,
}));

/* Mailboxes whose last mail call was refused with `reconnect_required` (the
 * provider no longer accepts the stored credentials). `/session` does not
 * always say so (its `sender_identity_status` is about sender identities), so
 * the sidebar badge follows what the mail calls themselves answered. Cleared
 * for a mailbox as soon as one of its calls succeeds. */
export const useReconnectStore = create<{ inboxes: Record<string, true> }>(() => ({ inboxes: {} }));

export function markInboxAuth(inbox_id: string, needsReconnect: boolean): void {
  const cur = useReconnectStore.getState().inboxes;
  if (!!cur[inbox_id] === needsReconnect) return;
  const next = { ...cur };
  if (needsReconnect) next[inbox_id] = true;
  else delete next[inbox_id];
  useReconnectStore.setState({ inboxes: next });
}

export function describeConnection(d: SocketDiagnostics): string {
  const parts: string[] = [`transport: ${d.state}`];
  if (d.connectMs != null) parts.push(`connected in ${d.connectMs} ms`);
  if (d.lastRoundTripMs != null) parts.push(`last round trip ${d.lastRoundTripMs} ms`);
  parts.push(`sockets opened: ${d.connects}`);
  if (d.lastCloseCode != null) parts.push(`last close ${d.lastCloseCode}`);
  return parts.join(" · ");
}
