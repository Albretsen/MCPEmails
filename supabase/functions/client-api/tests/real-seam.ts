// Test rig for the tests that run the REAL tool layer.
//
// `provider-call-harness.ts` (mcp-server) replaces `fetch` with a fake that
// answers PostgREST and records every Gmail / Graph request, and imports
// `index.ts` with MCP_SERVER_NO_LISTEN=1. This file adds what client-api
// needs on top: an app built on that real module, a session token, and an
// IMAP pool whose "dial" hands out clients of the scripted fake IMAP server
// (no socket is ever opened; the CI job withholds --allow-net).

import type { ImapClient } from "../../mcp-server/imap-client.ts";
import { FakeImapServer, type FakeMailbox } from "../../mcp-server/imap-fake-server.ts";
import * as harness from "../../mcp-server/provider-call-harness.ts";
import { createApp } from "../app.ts";
import { JwtVerifier, WorkspaceGate } from "../auth.ts";
import { ImapPool, type LeaseOptions, type PoolableClient } from "../imap-pool.ts";
import type { ThreadMemory } from "../mail/thread.ts";
import { RateLimiter } from "../rate-limit.ts";
import type { McpSeam } from "../seam.ts";
import { fakeStore, type FakeStore, JWT_SECRET, membership, mintHs256, request, SUPABASE_URL } from "./helpers.ts";

// The harness has already imported index.ts with the listener off; this is
// the same module instance.
export const mcp = await import("../../mcp-server/index.ts") as unknown as McpSeam & {
  handleToolsCall: (req: unknown, id: number, apiKey: unknown, ctx: unknown) => Promise<{ result?: unknown; error?: unknown }>;
};

export { harness };
export const INBOX_ID = harness.INBOX_ID;
export const WORKSPACE = harness.WORKSPACE;

/**
 * A real pool whose connections come from scripted fake servers instead of
 * sockets. `connects` counts how often the tool layer asked for a connection;
 * `servers` is one entry per connection actually "dialled".
 */
export class FakeDialPool extends ImapPool<PoolableClient> {
  readonly servers: FakeImapServer[] = [];
  connects = 0;
  constructor(private readonly makeServer: () => FakeImapServer & { advertised?: string[] }, options = {}) {
    super(options);
  }
  override checkout(key: string, flow: object, dial: () => Promise<PoolableClient>, lease?: LeaseOptions): Promise<PoolableClient> {
    this.connects++;
    return super.checkout(key, flow, dial, lease);
  }
  /** Pass as `imapDial`: what the pool calls when it needs a new connection. */
  readonly dial = (): Promise<PoolableClient> => {
    const server = this.makeServer();
    this.servers.push(server);
    const client = server.client();
    // `client()` skips the login exchange, which is where a real connection
    // learns the server's capabilities.
    (client as unknown as { capabilities: Set<string> }).capabilities = new Set(server.advertised ?? ["IMAP4REV1"]);
    return Promise.resolve(client as unknown as ImapClient);
  };
}

export function imapServer(mailboxes: FakeMailbox[]): () => FakeImapServer & { advertised: string[] } {
  // One mailbox state shared by every connection, as on a real server.
  const condstore = mailboxes.some((box) => box.modSeq !== undefined);
  const advertised = condstore ? ["IMAP4REV1", "CONDSTORE"] : ["IMAP4REV1"];
  return () => Object.assign(new FakeImapServer({ mailboxes, capabilities: advertised }), { advertised });
}

export async function imapInbox(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await harness.inboxRow("gmail", {
    provider: "imap",
    email_address: "owner@example.com",
    oauth_access_token: null,
    oauth_refresh_token: null,
    oauth_token_expires_at: null,
    imap_host: "imap.fake-server.example",
    imap_port: 993,
    imap_security: "tls",
    imap_username: null,
    imap_password: await harness.encryptToken("app-password-invented"),
    smtp_host: "smtp.fake-server.example",
    smtp_port: 465,
    ...overrides,
  });
}

export interface RealApp {
  handle: (req: Request) => Promise<Response>;
  store: FakeStore;
  pool: ImapPool<PoolableClient>;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  token: string;
  /** POST /mail and parse the JSON. */
  mail: (op: string, args?: Record<string, unknown>, inboxId?: string | null) => Promise<{ status: number; body: any; response: Response }>;
}

export async function realApp(
  options: { pool?: ImapPool<PoolableClient>; role?: "owner" | "viewer"; threads?: ThreadMemory; now?: () => number } = {},
): Promise<RealApp> {
  const imapDial = options.pool instanceof FakeDialPool ? options.pool.dial : undefined;
  const store = fakeStore([membership({ workspace_id: WORKSPACE, role: options.role ?? "owner" })]);
  const pool = options.pool ?? new ImapPool<PoolableClient>();
  const logs: RealApp["logs"] = [];
  const handle = createApp({
    mcp,
    store,
    verifier: new JwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    gate: new WorkspaceGate(store),
    limiter: new RateLimiter(),
    pool,
    imapDial,
    threads: options.threads,
    now: options.now,
    env: () => undefined,
    log: (event, fields) => logs.push({ event, fields }),
  });
  const token = await mintHs256();
  return {
    handle,
    store,
    pool,
    logs,
    token,
    async mail(op, args = {}, inboxId = INBOX_ID) {
      const response = await handle(request("/mail", { token, body: { op, inbox_id: inboxId ?? undefined, args } }));
      const type = response.headers.get("content-type") ?? "";
      const body = type.includes("application/json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
      return { status: response.status, body, response };
    },
  };
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailWorld {
  messages: harness.FakeGmailMessage[];
  historyId: string;
  sent: Array<{ raw: string }>;
  modified: unknown[];
}

/** A small Gmail: list, metadata/full gets, labels, profile, send, modify. */
export function gmailHandler(world: GmailWorld): harness.ProviderHandler {
  return async (call) => {
    const url = new URL(call.url);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (call.method === "GET" && path === "/profile") {
      return harness.json({ emailAddress: "owner@gmail-harness.example", historyId: world.historyId });
    }
    if (call.method === "GET" && path === "/labels") {
      return harness.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "STARRED", name: "STARRED", type: "system" }] });
    }
    if (call.method === "GET" && path.startsWith("/labels/")) {
      const id = decodeURIComponent(path.slice("/labels/".length));
      const inLabel = world.messages.filter((m) => (m.labelIds ?? ["INBOX"]).includes(id));
      return harness.json({
        id,
        name: id,
        messagesTotal: inLabel.length,
        messagesUnread: inLabel.filter((m) => (m.labelIds ?? []).includes("UNREAD")).length,
      });
    }
    if (call.method === "GET" && path === "/settings/sendAs") {
      return harness.json({ sendAs: [{ sendAsEmail: "owner@gmail-harness.example", isPrimary: true, isDefault: true }] });
    }
    if (call.method === "GET" && path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const labelIds = url.searchParams.getAll("labelIds");
      let hits = world.messages;
      if (labelIds.length > 0) hits = hits.filter((m) => labelIds.every((l) => (m.labelIds ?? ["INBOX"]).includes(l)));
      if (/is:starred/.test(q)) hits = hits.filter((m) => (m.labelIds ?? []).includes("STARRED"));
      return harness.json({ messages: hits.map((m) => ({ id: m.id, threadId: `thread-${m.id}` })), resultSizeEstimate: hits.length });
    }
    if (call.method === "GET" && path.startsWith("/messages/")) {
      const id = harness.messageIdOf(call);
      const message = world.messages.find((m) => m.id === id);
      if (!message) return harness.json({ error: { code: 404, message: "Not Found" } }, 404);
      return harness.json(url.searchParams.get("format") === "metadata" ? harness.gmailMeta(message) : harness.gmailFull(message));
    }
    if (call.method === "POST" && path === "/messages/send") {
      const body = call.body ? JSON.parse(call.body) as { raw: string } : { raw: "" };
      world.sent.push(body);
      return harness.json({ id: `sent-${world.sent.length}`, threadId: `thread-sent-${world.sent.length}`, labelIds: ["SENT"] });
    }
    if (call.method === "POST" && (path === "/messages/batchModify" || path.endsWith("/modify"))) {
      world.modified.push(call.body ? JSON.parse(call.body) : null);
      return path.endsWith("/modify") ? harness.json({ id: harness.messageIdOf(call) }) : new Response(null, { status: 204 });
    }
    await Promise.resolve();
    return harness.json({ error: { code: 404, message: `unscripted ${call.method} ${call.url.replace(GMAIL, "")}` } }, 404);
  };
}

function decodeBase64Text(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)));
}

/**
 * A Gmail `raw` message as readable text: the headers, then every base64
 * MIME part decoded in place.
 */
export function decodeRaw(raw: string): string {
  const message = decodeBase64Text(raw.replace(/-/g, "+").replace(/_/g, "/")).replace(/\r\n/g, "\n");
  return message.replace(
    /(Content-Transfer-Encoding: base64\n\n)([A-Za-z0-9+/=\n]+?)(\n\n--|\n*$)/g,
    (_all, head: string, body: string, tail: string) => `${head}${decodeBase64Text(body.replace(/\n/g, ""))}${tail}`,
  );
}
