// ---------------------------------------------------------------------------
// mcp-imap-pool.ts — warm IMAP connections for MCP tool calls.
//
// ── Why ────────────────────────────────────────────────────────────────────
// Every MCP tool call on an IMAP inbox dialled, negotiated TLS and logged in
// before its first useful command. From the tools/call log line on
// 2026-10-15: 1.75s on average for an INBOX-only search, about 38% of the
// mailbox time of that call, and 3.75s on Yahoo, where login alone is 2.2s and
// 28% of calls first ran into the 5-connection cap and slept in back-off.
// Agents call in bursts (search, then read, then read), so the connection the
// previous call just finished with is usually the one the next call wants.
//
// ── What it reuses ─────────────────────────────────────────────────────────
// client-api's pool (client-api/imap-pool.ts), whose safety rules are pinned
// by its own tests: a connection is only handed to the same scope and the
// same credentials, one lease at a time, dropped on any failed command, NOOP
// checked after idling, and inert once returned.
//
// ── What is deliberately different from client-api ─────────────────────────
// The goal here is the same answers, sooner. So every pool feature that could
// change an answer or add a wait is switched off:
//
//   waitMs 0        A call never queues behind another call on the same inbox.
//                   If the warm connection is in use it dials its own, exactly
//                   as before. Past `maxPerKey` it dials unpooled (below).
//   listTtlMs 0     Folder lists are always asked of the server, never served
//                   from memory, so a folder made elsewhere is seen at once.
//   authBackoffMs 0 A refused login is retried by the next call, as before.
//   maxLeaseMs      Long enough that no call still running is ever presumed
//                   leaked and has its connection taken away.
//
// It also does NOT open `firstPartyContext` (first-party.ts): that store
// switches on client-api behaviours, and opening it would change how an MCP
// login refusal is classified. This is its own store, read by
// ImapClient.connect only when the first-party hook is absent.
//
// Kill switch: MCP_IMAP_POOL=off in the function's secrets dials per call,
// exactly as before this module existed.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";
import { ImapPool, ImapPoolBusyError, type PoolableClient, poolKey } from "../client-api/imap-pool.ts";
import { currentImapTimings } from "./imap-timing.ts";

/** One MCP tool call, as the pool sees it. */
export interface McpImapPoolScope {
  /** The workspace the call runs in: connections are never shared across workspaces. */
  workspaceId: string;
  /** One object per tool call. Several connects inside one call never wait on each other. */
  flow: object;
}

/** Opened around each MCP tool call's executor (index.ts); absent everywhere else. */
export const mcpImapPoolStore = new AsyncLocalStorage<McpImapPoolScope>();

/** The options that make the pool answer-neutral for MCP. See the header. */
export const MCP_IMAP_POOL_OPTIONS = {
  idleTtlMs: 20_000,
  validateAfterIdleMs: 10_000,
  maxPerKey: 3,
  waitMs: 0,
  maxLeaseMs: 15 * 60_000,
  maxIdleTotal: 64,
  authBackoffMs: 0,
  listTtlMs: 0,
} as const;

let pool: ImapPool<PoolableClient> | null = null;

function enabled(): boolean {
  try {
    return (Deno.env.get("MCP_IMAP_POOL") ?? "").toLowerCase() !== "off";
  } catch {
    return true;
  }
}

/** For tests: close the isolate's pool, so its idle timers do not outlive the test. */
export async function resetMcpImapPoolForTests(): Promise<void> {
  const old = pool;
  pool = null;
  await old?.closeAll();
}

/**
 * The connect hook for the MCP path, or null when no MCP tool call is in
 * flight (automations, tests, client-api) or the kill switch is set.
 */
export function mcpPooledConnect(): (<C>(
  cfg: { host: string; port: number; email: string; password: string; security?: "tls" | "starttls" },
  dial: () => Promise<C>,
) => Promise<C>) | null {
  const scope = mcpImapPoolStore.getStore();
  if (!scope || !enabled()) return null;
  return async <C>(
    cfg: { host: string; port: number; email: string; password: string; security?: "tls" | "starttls" },
    dial: () => Promise<C>,
  ): Promise<C> => {
    pool ??= new ImapPool<PoolableClient>(MCP_IMAP_POOL_OPTIONS);
    const key = await poolKey(`mcp:${scope.workspaceId}`, cfg);
    let dialled = false;
    const counted = async () => {
      dialled = true;
      return await dial() as unknown as PoolableClient;
    };
    try {
      const client = await pool.checkout(key, scope.flow, counted);
      if (!dialled) {
        const timing = currentImapTimings();
        if (timing) timing.pooledReuses += 1;
      }
      return client as unknown as C;
    } catch (error) {
      // Every pooled and overflow slot for this inbox is in use. Dial an
      // ordinary connection, which is what every call did before the pool.
      if (error instanceof ImapPoolBusyError) return await dial();
      throw error;
    }
  };
}
