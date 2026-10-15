// ---------------------------------------------------------------------------
// What client-api knows about each inbox's health, without dialling it.
//
// Three sources, none of which opens a mailbox connection:
//
//   1. THE ROW. `inboxes.status` ('active' | 'error' | ...) and `last_error`,
//      loaded with the membership query every isolate already makes (store.ts).
//      Gmail and Outlook move a row to 'error' when the refresh token is
//      revoked; the dashboard's "Check connection" does it for a rejected
//      password; reconnecting sets it back to 'active' and clears `last_error`.
//   2. THE REFUSED-LOGIN MARKER, also on the row. When an IMAP server refuses
//      a login that client-api dialled, `last_error` is set to
//      `loginRefusedMarker(at)` and `status` is LEFT 'active'. Every isolate
//      that loads the row within REFUSAL_WINDOW_MS of that time answers
//      `reconnect_required` without dialling. This is what the per-isolate
//      memory in imap-pool.ts could not do: HTTP requests land on fresh
//      isolates, so a broken mailbox was dialled on every request, and mail
//      hosts answer repeated failed logins by locking the account.
//   3. THIS ISOLATE'S MEMORY of a refusal it saw itself (the write in 2 may
//      not have landed, or the row may not be reloaded for a minute).
//
// WHY THE MARKER AND NOT `status = 'error'`. A NO on LOGIN is not proof of a
// wrong password: a host that has locked an account, or an address range,
// refuses correct passwords too. `status = 'error'` hides the inbox from the
// MCP server (`resolveInbox`, `inbox_list`) until a person reconnects it, so a
// transient refusal seen by the web client would take a paying customer's
// mailbox away from their MCP connector. The marker is read by client-api
// only, expires by itself, and costs the mail host one login per window.
//
// THE WAY BACK TO HEALTHY, any of:
//   - the person reconnects the inbox (new stored password: the credential
//     fingerprint changes, and the reconnect routes clear `last_error`);
//   - "Check connection" in the dashboard succeeds (clears `last_error`);
//   - the window passes: the next request dials once; a login that works
//     clears the marker, one that is refused renews it.
// ---------------------------------------------------------------------------

/** The `/session` inbox field. See `InboxState`. */
export type InboxStatus = "ok" | "reconnect_required" | "error";

export type InboxStatusReason =
  /** The mail server refused the stored password or app password. */
  | "password_refused"
  /** Gmail / Outlook: the grant expired or was revoked. */
  | "access_revoked"
  /** Mail works; the Gmail grant lacks the scope that lists send-as addresses. */
  | "sender_identity"
  /** Outlook: the Microsoft account has no mailbox. Reconnecting does not help. */
  | "no_mailbox"
  /** The row is in a state this function does not know. */
  | "unavailable";

export interface InboxState {
  status: InboxStatus;
  /** null exactly when `status` is "ok". */
  status_reason: InboxStatusReason | null;
}

/** How long one refused login keeps every isolate from dialling that mailbox again. */
export const REFUSAL_WINDOW_MS = 10 * 60_000;
/** The window when rows are not being reloaded with `last_error` (the membership embed fell back). */
const LOCAL_ONLY_WINDOW_MS = 60_000;

const MARKER_HEAD = "The mail server refused this mailbox's password. Reconnect this inbox to restore access.";
const MARKER_RE = /^The mail server refused this mailbox's password\. Reconnect this inbox to restore access\. \(Checked ([0-9T:.Z-]{20,30})\)$/;

/** PostgREST `like` pattern matching every marker and nothing a person or another function wrote. */
export const LOGIN_REFUSED_LIKE = `${MARKER_HEAD} (Checked %)`;

/** `inboxes.last_error` for a login refused at `at`. Shown as is in the dashboard, so it is a sentence. */
export function loginRefusedMarker(at: number): string {
  return `${MARKER_HEAD} (Checked ${new Date(at).toISOString()})`;
}

/** When the marker in `lastError` was written (ms), or null when it is not a marker. */
export function loginRefusedAt(lastError: unknown): number | null {
  if (typeof lastError !== "string") return null;
  const match = MARKER_RE.exec(lastError);
  if (!match) return null;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) ? at : null;
}

/** Columns added to the tool layer's inbox projection for the membership embed. */
export function withHealthColumns(inboxColumns: string): string {
  return `${inboxColumns}, service, last_error`;
}

export function isOAuthProvider(provider: string | null | undefined): boolean {
  return provider === "gmail" || provider === "outlook";
}

/**
 * The sentence shown to the PERSON using the web client when a mailbox's
 * credentials were refused. The tool layer's own text for this is written for
 * an AI agent ("Ask the user to reconnect...", and it says "OAuth token" for a
 * password mailbox too); it stays what MCP callers get.
 */
export function reconnectMessage(provider: string | null | undefined): string {
  if (provider === null || provider === undefined || provider === "") {
    return "This mailbox needs to be reconnected. Reconnect it in the dashboard.";
  }
  return isOAuthProvider(provider)
    ? "Access to this mailbox has expired or was revoked. Reconnect it in the dashboard."
    : "This mailbox's password was refused by the mail server. Reconnect it in the dashboard.";
}

/** The slice of an `inboxes` row this module reads. `last_error` is absent on rows the tool layer loaded. */
export interface HealthRow {
  id: string;
  workspace_id: string;
  provider: string;
  status: string;
  email_address?: string;
  display_name?: string | null;
  service?: string | null;
  last_error?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_username?: string | null;
  imap_password?: string | null;
}

interface Known {
  row: HealthRow;
  fingerprint: string;
  /** `last_error` carried a refusal marker when the row was last loaded with that column. */
  marked: boolean;
}

/** Changes whenever the stored IMAP credentials do. Held in memory only; never logged. */
function fingerprint(row: HealthRow): string {
  return [row.imap_host ?? "", row.imap_port ?? "", row.imap_username ?? "", row.imap_password ?? ""].join("\u0000");
}

export class InboxHealth {
  readonly #known = new Map<string, Known>();
  readonly #refused = new Map<string, { fingerprint: string; until: number }>();
  #rowsCarryLastError = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs = REFUSAL_WINDOW_MS,
    private readonly max = 5000,
  ) {}

  /** Every row this isolate loads, whatever its status. */
  observe(row: HealthRow): void {
    if (!row || typeof row.id !== "string") return;
    if (this.#known.size >= this.max) this.#known.clear();
    const print = fingerprint(row);
    const hasLastError = Object.hasOwn(row, "last_error");
    const before = this.#known.get(row.id);
    const refusal = this.#refused.get(row.id);
    if (refusal && refusal.fingerprint !== print) this.#refused.delete(row.id); // reconnected
    let marked = before?.marked ?? false;
    if (hasLastError) {
      this.#rowsCarryLastError = true;
      const at = loginRefusedAt(row.last_error);
      marked = at !== null;
      if (at !== null && row.status === "active") {
        const until = at + this.windowMs;
        if (until > this.now()) {
          if (this.#refused.size >= this.max) this.#refused.clear();
          this.#refused.set(row.id, { fingerprint: print, until });
        }
      } else if (at === null && before?.marked === true) {
        // The marker this isolate had seen is gone: someone verified the mailbox.
        this.#refused.delete(row.id);
      }
    }
    this.#known.set(row.id, { row, fingerprint: print, marked });
  }

  row(inboxId: string, workspaceId: string): HealthRow | null {
    const known = this.#known.get(inboxId);
    return known && known.row.workspace_id === workspaceId ? known.row : null;
  }

  provider(inboxId: string, workspaceId: string): string | null {
    return this.row(inboxId, workspaceId)?.provider ?? null;
  }

  /** This isolate dialled the mailbox and the server refused the login. */
  noteRefused(inboxId: string): void {
    const known = this.#known.get(inboxId);
    if (!known) return;
    if (this.#refused.size >= this.max) this.#refused.clear();
    const window = this.#rowsCarryLastError ? this.windowMs : Math.min(this.windowMs, LOCAL_ONLY_WINDOW_MS);
    this.#refused.set(inboxId, { fingerprint: known.fingerprint, until: this.now() + window });
    known.marked = true;
  }

  /** This isolate dialled the mailbox and logged in. True when a marker should be cleared from the row. */
  noteAccepted(inboxId: string): boolean {
    const known = this.#known.get(inboxId);
    const had = this.#refused.delete(inboxId) || known?.marked === true;
    if (known) known.marked = false;
    return had;
  }

  /** Is a refused login for the credentials this inbox has NOW still inside its window. */
  refused(inboxId: string): boolean {
    const refusal = this.#refused.get(inboxId);
    if (!refusal) return false;
    if (refusal.until <= this.now()) {
      this.#refused.delete(inboxId);
      return false;
    }
    const known = this.#known.get(inboxId);
    return known !== undefined && known.fingerprint === refusal.fingerprint;
  }

  /**
   * The inbox's state as far as it can be known without contacting the
   * provider. `senderIdentityStatus` is the tool layer's own field from
   * `inbox_list`, when the caller has it.
   */
  state(inboxId: string, workspaceId: string, senderIdentityStatus?: string): InboxState {
    const row = this.row(inboxId, workspaceId);
    if (row && row.status !== "active") {
      if (row.status !== "error") return { status: "error", status_reason: "unavailable" };
      if (row.provider === "outlook" && /has no Outlook/i.test(row.last_error ?? "")) {
        return { status: "error", status_reason: "no_mailbox" };
      }
      return {
        status: "reconnect_required",
        status_reason: isOAuthProvider(row.provider) ? "access_revoked" : "password_refused",
      };
    }
    // Only for a row of THIS workspace: another workspace's inbox id must keep
    // answering "not found", whatever this isolate knows about it.
    if (row && this.refused(inboxId)) return { status: "reconnect_required", status_reason: "password_refused" };
    if (senderIdentityStatus === "reconnect_required") {
      return { status: "reconnect_required", status_reason: "sender_identity" };
    }
    return { status: "ok", status_reason: null };
  }
}
