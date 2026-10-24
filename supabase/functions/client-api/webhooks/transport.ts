// ---------------------------------------------------------------------------
// One webhook POST, dialled at the address the SSRF guard approved.
//
// Why not `fetch`: fetch resolves the name itself, so a check-then-fetch
// leaves a rebinding window between the two lookups, and it follows
// redirects unless told not to. Here the request is written by hand over a
// socket opened to the APPROVED ADDRESS, upgraded with
// `Deno.startTls(conn, { hostname })` so the certificate is still checked
// against the NAME (the split host-guard.ts's `connectGuardedTcp` documents
// and verified against a live host). The peer address is re-checked after
// connect. Only the status line is read; a 3xx is a failure and its Location
// is never looked at.
//
// One deadline covers resolve, connect, TLS, write and the status line.
// ---------------------------------------------------------------------------

import { type HostLookup, isAllowedAddress } from "../../mcp-server/host-guard.ts";
import { guardWebhookUrl, type WebhookUrlCode } from "./url-guard.ts";

export const SEND_TIMEOUT_MS = 10_000;
/** A status line longer than this is not HTTP. */
const MAX_STATUS_BYTES = 8 * 1024;
const USER_AGENT = "MCPEmails-Webhooks/1.0 (+https://mcpemails.com/docs)";

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}

export type WebhookErrorCode =
  | WebhookUrlCode
  | "timeout"
  | "connect_failed"
  | "tls_failed"
  | "protocol_error";

export type WebhookResponse =
  | { kind: "response"; status: number }
  | { kind: "error"; code: WebhookErrorCode };

export interface WebhookTransport {
  post(request: WebhookRequest): Promise<WebhookResponse>;
}

/** A connected stream: what `Deno.TlsConn` offers that this module uses. */
export interface StreamConn {
  write(bytes: Uint8Array): Promise<number>;
  read(buffer: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface PinnedTransportOptions {
  lookup?: HostLookup;
  /** Tests: stands in for Deno.connect. Returns the peer address it reached. */
  connect?: (options: { hostname: string; port: number }) => Promise<{ conn: StreamConn; peer: string }>;
  /** Tests: stands in for Deno.startTls. */
  startTls?: (conn: StreamConn, hostname: string) => Promise<StreamConn>;
}

class Deadline extends Error {
  constructor() {
    super("webhook_deadline");
    this.name = "TimeoutError";
  }
}

/** `HTTP/1.1 204 No Content` -> 204. */
export function parseStatusLine(line: string): number | null {
  const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(line);
  return match ? Number(match[1]) : null;
}

/** The request bytes. Header values are already validated by the caller; CR and LF are stripped regardless. */
export function encodeRequest(hostHeader: string, path: string, headers: Record<string, string>, body: string): Uint8Array {
  const bodyBytes = new TextEncoder().encode(body);
  const clean = (v: string) => v.replace(/[\r\n]/g, "");
  const lines = [
    `POST ${clean(path)} HTTP/1.1`,
    `Host: ${clean(hostHeader)}`,
    `User-Agent: ${USER_AGENT}`,
    "Content-Type: application/json",
    `Content-Length: ${bodyBytes.length}`,
    "Connection: close",
    ...Object.entries(headers).map(([k, v]) => `${clean(k)}: ${clean(v)}`),
  ];
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  const out = new Uint8Array(head.length + bodyBytes.length);
  out.set(head, 0);
  out.set(bodyBytes, head.length);
  return out;
}

async function readStatus(conn: StreamConn): Promise<number | null> {
  const buffer = new Uint8Array(1024);
  let text = "";
  while (text.length < MAX_STATUS_BYTES) {
    const n = await conn.read(buffer);
    if (n === null) break;
    text += new TextDecoder().decode(buffer.subarray(0, n));
    const end = text.indexOf("\r\n");
    if (end >= 0) return parseStatusLine(text.slice(0, end));
  }
  return text.length > 0 && !text.includes("\r\n") ? parseStatusLine(text) : null;
}

export function createPinnedTransport(options: PinnedTransportOptions = {}): WebhookTransport {
  const connect = options.connect ?? (async ({ hostname, port }) => {
    const conn = await Deno.connect({ hostname, port });
    return { conn, peer: (conn.remoteAddr as Deno.NetAddr).hostname };
  });
  const startTls = options.startTls ??
    ((conn: StreamConn, hostname: string) => Deno.startTls(conn as Deno.TcpConn, { hostname }));

  return {
    async post(request) {
      const timeoutMs = request.timeoutMs ?? SEND_TIMEOUT_MS;
      let open: StreamConn | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            open?.close();
          } catch {
            // already closed
          }
          reject(new Deadline());
        }, timeoutMs);
      });
      const attempt = (async (): Promise<WebhookResponse> => {
        const verdict = await guardWebhookUrl(request.url, { lookup: options.lookup });
        if (!verdict.ok) return { kind: "error", code: verdict.code };
        let tcp: { conn: StreamConn; peer: string };
        try {
          tcp = await connect({ hostname: verdict.address, port: verdict.url.port });
        } catch {
          return { kind: "error", code: "connect_failed" };
        }
        open = tcp.conn;
        if (!isAllowedAddress(tcp.peer)) {
          tcp.conn.close();
          open = null;
          return { kind: "error", code: "host_not_allowed" };
        }
        let tls: StreamConn;
        try {
          tls = await startTls(tcp.conn, verdict.url.host);
        } catch {
          try {
            tcp.conn.close();
          } catch {
            // nothing written yet
          }
          open = null;
          return { kind: "error", code: "tls_failed" };
        }
        open = tls;
        try {
          const bytes = encodeRequest(verdict.url.hostHeader, verdict.url.path, request.headers, request.body);
          let written = 0;
          while (written < bytes.length) written += await tls.write(bytes.subarray(written));
          const status = await readStatus(tls);
          return status === null ? { kind: "error", code: "protocol_error" } : { kind: "response", status };
        } catch (error) {
          if (error instanceof Deadline) throw error;
          return { kind: "error", code: "connect_failed" };
        } finally {
          try {
            tls.close();
          } catch {
            // already closed
          }
          open = null;
        }
      })();
      attempt.catch(() => {});
      try {
        return await Promise.race([attempt, deadline]);
      } catch {
        return { kind: "error", code: "timeout" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
