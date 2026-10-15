import { useSessionStore } from "../auth/session-store";
import { showToast } from "./toast-store";

/* What the signed-in person may do in the active workspace.
 *
 * The server is the authority: it refuses every write and send for a `viewer`
 * with 403 `forbidden`. This module only keeps the client from offering what
 * the server will refuse. The role comes from the workspace session
 * (`GET /session`, auth/session-store).
 *
 * Rule: writing is allowed unless the role is exactly "viewer". With no
 * session (mock mode, or before the session has loaded) writing is allowed:
 * the mock has no roles.
 */

export const READ_ONLY_LABEL = "Read-only";
export const READ_ONLY_EXPLANATION = "You have read-only access to this workspace.";

function roleAllowsWrite(role: string | null | undefined): boolean {
  return role !== "viewer";
}

/** For non-React callers (the keyboard handler, the palette). */
export function canWrite(): boolean {
  return roleAllowsWrite(useSessionStore.getState().session?.role);
}

export function useCanWrite(): boolean {
  return useSessionStore((s) => roleAllowsWrite(s.session?.role));
}

/** Tells a read-only member why nothing happened. Returns true when the
 *  caller must stop: `if (refuseWrite()) return;`. */
export function refuseWrite(): boolean {
  if (canWrite()) return false;
  showToast(READ_ONLY_EXPLANATION);
  return true;
}

/** Wraps an action so a read-only member gets the explanation instead. */
export function guardWrite<A extends unknown[]>(run: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    if (refuseWrite()) return;
    run(...args);
  };
}
