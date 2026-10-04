// ---------------------------------------------------------------------------
// What the watcher reads from a mailbox, and how.
//
// Three reads, all through the SAME machinery the web client's own requests
// use (the tool layer under `firstPartyContext`, the workspace's hidden key
// narrowed to read scopes, the IMAP pool), so the watcher cannot do anything
// to a mailbox that a read-only member of the workspace could not:
//
//   probe        the inbox folder's `status` fingerprint and counters. One
//                IMAP STATUS, or two small Gmail / Graph requests. Runs on
//                every check.
//   gmailAdded   Gmail only, and only after the fingerprint moved: the ids of
//                messages ADDED to the inbox since the stored historyId.
//   newest       only when a notification is about to be sent in "rich" mode:
//                the newest few rows of the inbox (sender, subject), with no
//                body bytes requested.
//
// Everything returned lives in memory for the length of one dispatch request.
// Nothing here writes to the database or logs what it read.
// ---------------------------------------------------------------------------

import { firstPartyContext } from "../../mcp-server/first-party.ts";
import { ApiError } from "../errors.ts";
import { ImapPool, type PoolableClient } from "../imap-pool.ts";
import { firstPartyFor, InboxRowCache, type MailEnv, type OpTimings, runMailOp } from "../mail/run.ts";
import { mailboxStatus } from "../mail/status.ts";
import type { ApiKeyRow, McpSeam } from "../seam.ts";
import type { NewMessage } from "./notify.ts";
import type { FolderCursor, LeasedWatch } from "./store.ts";

/** The slice of a leased row a mailbox read needs. */
export type WatchTarget = Pick<LeasedWatch, "inbox_id" | "workspace_id" | "provider">;

export interface ProbeResult {
  /** The mailbox's own display name or address, for the notification text. Never stored or logged. */
  label: string;
  cursor: FolderCursor;
}

export interface NewestRow extends NewMessage {
  unread: boolean;
}

export interface WatchMail {
  probe(watch: WatchTarget): Promise<ProbeResult>;
  /** Ids of unread messages added to the Gmail inbox since `startHistoryId`; null when that id is too old. */
  gmailAdded(watch: WatchTarget, startHistoryId: string): Promise<string[] | null>;
  /** The newest `limit` rows of the inbox, newest first. */
  newest(watch: WatchTarget, limit: number): Promise<NewestRow[]>;
  /** Close whatever connections the reads opened. */
  close(): Promise<void>;
}

const READ_SCOPES = ["read:email", "search:email"];
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface WatchMailDeps {
  mcp: McpSeam;
  /** The workspace's hidden key row (../store.ts `ensureWebClientKey`). */
  workspaceKey(workspaceId: string): Promise<ApiKeyRow>;
  /** An IMAP server refused a login the watcher dialled: mark the row (mail/health.ts). */
  onLoginRefused?(inboxId: string, workspaceId: string): void;
  /** Tests only: stands in for the IMAP socket dial. */
  imapDial?: MailEnv["imapDial"];
  pool?: ImapPool<PoolableClient>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A list row's `from` ({ name, email }, or a plain string) as one display string: the name, else the address. */
function displaySender(from: unknown): string {
  if (typeof from === "string") return from;
  if (!from || typeof from !== "object") return "";
  const { name, email } = from as { name?: unknown; email?: unknown };
  if (typeof name === "string" && name.trim()) return name;
  return typeof email === "string" ? email : "";
}

function timings(): OpTimings {
  return { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
}

export function createWatchMail(deps: WatchMailDeps): WatchMail {
  // Its own pool, for this dispatch only: one connection per mailbox, reused
  // by `probe` and `newest`, logged out in `close`.
  const pool = deps.pool ?? new ImapPool<PoolableClient>({ idleTtlMs: 60_000 });
  const inboxes = new InboxRowCache();
  const envs = new Map<string, Promise<MailEnv>>();
  const doFetch: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init);

  const envFor = (workspaceId: string): Promise<MailEnv> => {
    let env = envs.get(workspaceId);
    if (!env) {
      env = deps.workspaceKey(workspaceId).then((row): MailEnv => {
        if (row.workspace_id !== workspaceId) throw new Error("web_client_key_workspace_mismatch");
        return {
          mcp: deps.mcp,
          pool,
          inboxes,
          // Read scopes only, and never the human marker: the watcher is not a person.
          apiKey: { ...row, scopes: row.scopes.filter((s) => READ_SCOPES.includes(s)), inbox_ids: null },
          canWrite: false,
          imapDial: deps.imapDial,
          onLoginRefused: (inboxId) => deps.onLoginRefused?.(inboxId, workspaceId),
          now: deps.now,
        };
      });
      env.catch(() => envs.delete(workspaceId));
      envs.set(workspaceId, env);
    }
    return env;
  };

  const inContext = async <T>(watch: WatchTarget, work: (env: MailEnv) => Promise<T>): Promise<T> => {
    const env = await envFor(watch.workspace_id);
    const context = firstPartyFor(env, { scope: watch.inbox_id, flow: {}, priority: "background", timings: timings() });
    return await firstPartyContext.run(context, () => work(env));
  };

  return {
    async probe(watch) {
      return await inContext(watch, async (env) => {
        const status = await mailboxStatus(env.mcp, env.apiKey, watch.inbox_id, ["inbox"], { flagsDigest: false });
        const folder = status.folders[0];
        if (!folder || folder.fingerprint === null) {
          throw new ApiError(502, "provider_error", "The inbox folder could not be read.", { retryable: true });
        }
        // Served from the row `mailboxStatus` just loaded.
        const row = await env.mcp.resolveInbox(watch.inbox_id, env.apiKey);
        const label = (row?.display_name as string | null | undefined) || row?.email_address || "";
        return { label, cursor: { fingerprint: folder.fingerprint, total: folder.total, unread: folder.unread } };
      });
    },

    async gmailAdded(watch, startHistoryId) {
      if (!/^\d{1,24}$/.test(startHistoryId)) return null;
      return await inContext(watch, async (env) => {
        const row = await env.mcp.resolveInbox(watch.inbox_id, env.apiKey);
        if (!row) throw new ApiError(404, "inbox_not_found", "Inbox not found.");
        const token = await env.mcp.withFreshGmailToken(row);
        const query = `startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX&maxResults=100`;
        const response = await doFetch(`${GMAIL_BASE}/history?${query}`, { headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 404) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new ApiError(
            response.status === 401 ? 409 : 502,
            response.status === 401 ? "reconnect_required" : "provider_error",
            "The Gmail history request failed.",
            { retryable: response.status !== 401 },
          );
        }
        const body = await response.json() as {
          history?: Array<{ messagesAdded?: Array<{ message?: { id?: string; labelIds?: string[] } }> }>;
        };
        const ids = new Set<string>();
        for (const entry of body.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            const message = added.message;
            const labels = message?.labelIds ?? [];
            if (typeof message?.id !== "string") continue;
            // In the inbox and unread when it was added; not the person's own
            // sent copy or a draft being saved.
            if (!labels.includes("INBOX") || !labels.includes("UNREAD")) continue;
            if (labels.includes("SENT") || labels.includes("DRAFT")) continue;
            ids.add(message.id);
          }
        }
        return [...ids];
      });
    },

    async newest(watch, limit) {
      const env = await envFor(watch.workspace_id);
      const outcome = await runMailOp(env, {
        op: "list",
        inbox_id: watch.inbox_id,
        // No preview: no body bytes are fetched for a notification.
        args: { folder: "inbox", limit: Math.max(1, Math.min(limit, 20)), preview: false },
      });
      if (outcome.type !== "json") return [];
      const messages = (outcome.result as { messages?: unknown })?.messages;
      if (!Array.isArray(messages)) return [];
      const rows: NewestRow[] = [];
      for (const raw of messages as Array<Record<string, unknown>>) {
        if (typeof raw?.id !== "string") continue;
        rows.push({
          id: raw.id,
          from: displaySender(raw.from),
          subject: typeof raw.subject === "string" ? raw.subject : "",
          unread: raw.is_read === false,
        });
      }
      return rows;
    },

    async close() {
      await pool.closeAll().catch(() => {});
    },
  };
}
