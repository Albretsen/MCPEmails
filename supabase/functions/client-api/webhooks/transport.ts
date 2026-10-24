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
  /** Deno.TlsConn: completes the TLS handshake (certificate check) explicitly. */
  handshake?(): Promise<unknown>;
}

export interface PinnedTransportOptions {
  lookup?: HostLookup;
  /** Tests: stands in for Deno.connect. Returns the peer address it reached. */
  connect?: (options: { hostname: string; port: number }) => Promise<{ conn: StreamConn; peer: string }>;
  /** Tests: stands in for Deno.startTls. */
  startTls?: (conn: StreamConn, hostname: string) => Promise<StreamConn>;
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

async function readStatus(conn: StreamConn, onBytes: () => void = () => {}): Promise<number | null> {
  const buffer = new Uint8Array(1024);
  let text = "";
  while (text.length < MAX_STATUS_BYTES) {
    const n = await conn.read(buffer);
    if (n === null) break;
    onBytes();
    text += new TextDecoder().decode(buffer.subarray(0, n));
    const end = text.indexOf("\r\n");
    if (end >= 0) return parseStatusLine(text.slice(0, end));
  }
  return text.length > 0 && !text.includes("\r\n") ? parseStatusLine(text) : null;
}

/** Does this error come from the TLS layer (certificate, handshake, alert) rather than the socket? */
export function isTlsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "InvalidData") return true;
  return /certificate|handshake|tls|ssl|alert|peer sent|unknown ca|not valid for name/i.test(error.message);
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
      // Set when the deadline fires. Every step re-checks it after its await,
      // and whatever was opened late (a connect or an upgrade that completed
      // after the deadline) is closed at once instead of being used.
      let aborted = false;
      const opened = new Set<StreamConn>();
      const closeAll = () => {
        for (const conn of opened) {
          try {
            conn.close();
          } catch {
            // already closed
          }
        }
        opened.clear();
      };
      const track = (conn: StreamConn): StreamConn => {
        opened.add(conn);
        if (aborted) closeAll();
        return conn;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<WebhookResponse>((resolve) => {
        timer = setTimeout(() => {
          aborted = true;
          closeAll();
          resolve({ kind: "error", code: "timeout" });
        }, timeoutMs);
      });
      const timedOut = (): WebhookResponse => ({ kind: "error", code: "timeout" });

      const attempt = (async (): Promise<WebhookResponse> => {
        const verdict = await guardWebhookUrl(request.url, { lookup: options.lookup });
        if (aborted) return timedOut();
        if (!verdict.ok) return { kind: "error", code: verdict.code };

        let tcp: { conn: StreamConn; peer: string };
        try {
          tcp = await connect({ hostname: verdict.address, port: verdict.url.port });
        } catch {
          return aborted ? timedOut() : { kind: "error", code: "connect_failed" };
        }
        track(tcp.conn);
        if (aborted) return timedOut();
        if (!isAllowedAddress(tcp.peer)) {
          closeAll();
          return { kind: "error", code: "host_not_allowed" };
        }

        let tls: StreamConn;
        try {
          tls = track(await startTls(tcp.conn, verdict.url.host));
          if (aborted) return timedOut();
          // Deno upgrades lazily: without this the certificate is checked on
          // the first write, and its failure would look like a socket error.
          if (tls.handshake) await tls.handshake();
        } catch {
          closeAll();
          return aborted ? timedOut() : { kind: "error", code: "tls_failed" };
        }
        if (aborted) return timedOut();

        let wroteAll = false;
        let readAny = false;
        try {
          const bytes = encodeRequest(verdict.url.hostHeader, verdict.url.path, request.headers, request.body);
          let written = 0;
          while (written < bytes.length) {
            written += await tls.write(bytes.subarray(written));
            if (aborted) return timedOut();
          }
          wroteAll = true;
          const status = await readStatus(tls, () => {
            readAny = true;
          });
          if (aborted) return timedOut();
          return status === null ? { kind: "error", code: "protocol_error" } : { kind: "response", status };
        } catch (error) {
          if (aborted) return timedOut();
          // A handshake that fails lazily surfaces on the first write or read.
          if ((!wroteAll || !readAny) && isTlsError(error)) return { kind: "error", code: "tls_failed" };
          return { kind: "error", code: "connect_failed" };
        } finally {
          closeAll();
        }
      })();
      attempt.catch(() => {});
      try {
        return await Promise.race([attempt, deadline]);
      } catch {
        return timedOut();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
