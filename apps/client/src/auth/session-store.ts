import { create } from "zustand";
import type { SessionInfo, WorkspaceInfo } from "../api/types";
import { AUTH_STORAGE_KEY, type AuthUser } from "./backend";

/* The workspace session (`GET /session`): who, which workspaces, which
 * inboxes. Painted from the local cache first and replaced when the server
 * answers. Loading and applying it is done by app/backend.ts. */

export type SessionStatus = "idle" | "loading" | "ready" | "error";

export interface SessionState {
  session: SessionInfo | null;
  status: SessionStatus;
  /** True while `session` is the cached copy and the server has not answered. */
  fromCache: boolean;
  /** Error code of the last failed load (`web_client_disabled`, `network`...). */
  errorCode: string | null;
}

export const EMPTY_SESSION: SessionState = { session: null, status: "idle", fromCache: false, errorCode: null };

export const useSessionStore = create<SessionState>(() => EMPTY_SESSION);

export function activeWorkspace(s: SessionInfo | null): WorkspaceInfo | null {
  return s?.workspaces.find((w) => w.id === s.workspace_id) ?? null;
}

/* ---- identity hint ----
 * Which user and workspace this browser last showed. Lets a reload pick the
 * right cache namespace before the auth client has loaded. Holds no mail and
 * no token; removed at sign-out. */

const IDENTITY_KEY = "mc-identity";

export interface IdentityHint {
  user: AuthUser;
  workspace_id: string;
}

export function readIdentity(): IdentityHint | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<IdentityHint>) : null;
    if (!v?.user || typeof v.user.id !== "string" || typeof v.workspace_id !== "string") return null;
    return { user: { id: v.user.id, email: String(v.user.email ?? ""), name: v.user.name ?? null }, workspace_id: v.workspace_id };
  } catch {
    return null;
  }
}

export function writeIdentity(hint: IdentityHint): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(hint));
  } catch {
    /* private mode: the next load just starts cold */
  }
}

export function clearIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* ignore */
  }
}

/** A Supabase session is stored in this browser (it may still be expired). */
export function hasStoredAuthSession(): boolean {
  try {
    return !!localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return false;
  }
}
