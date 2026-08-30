// ---------------------------------------------------------------------------
// mail-proxy: a deliberately stupid TCP forwarder with a fixed IP address.
//
// Runs on a small machine that is NOT in a cloud range mail hosts blocklist.
// The edge function asks it to open a socket to a mail server and then speaks
// TLS through it, so this process forwards ciphertext and can read none of it.
// It never sees a mailbox password and never sees a message.
//
// Read supabase/functions/mcp-server/mail-proxy.ts for why this exists at all.
// The control-line format is defined there and parsed here; the two must agree.
//
//   client -> MCPEPROXY/1 CONNECT <ip> <port> <expiry-unix> <hmac-hex>\n
//   server -> OK\n                      (then raw bidirectional forwarding)
//   server -> ERR <reason>\n            (then close)
//
// The HMAC covers "<ip> <port> <expiry>", so a captured line cannot be aimed
// somewhere else and stops working within the window. That matters because the
// control line crosses the internet in the clear: it is the one hop that is not
// inside the end-to-end TLS session, and it deliberately carries nothing but a
// destination.
//
// Run:  deno run --allow-net --allow-env proxy.ts
// Env:  MAIL_PROXY_SECRET (required), MAIL_PROXY_LISTEN_PORT (default 8443)
// ---------------------------------------------------------------------------

export const PROTOCOL = "MCPEPROXY/1";
export const AUTH_TTL_S = 120;

/**
 * Submission and IMAP only.
 *
 * An open forwarder is a gift to a spammer, and the thing that stops this one
 * being general purpose is that it will not dial anything else. Port 25 is
 * excluded on purpose: server-to-server delivery is not what we do, and it is
 * the port that would make this box worth stealing.
 */
export const ALLOWED_PORTS = new Set([465, 587, 993, 143]);

/** Bound on sockets held open at once, so one caller cannot exhaust the box. */
const MAX_TUNNELS = 200;

/** How long to wait for the control line before hanging up on a stranger. */
const CONTROL_TIMEOUT_MS = 10_000;

let active = 0;

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison, so a wrong signature leaks no timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Public unicast addresses only.
 *
 * The client already resolved and validated the destination before naming it,
 * but that check protects the client's network. This one protects this box:
 * without it, anyone holding the secret could use the proxy to reach whatever
 * sits on its own LAN or its cloud metadata endpoint.
 */
export function isPublicAddress(address: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const parts = address.split(".").map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;            // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;  // CGNAT
    if (a >= 224) return false;                          // multicast + reserved
    return true;
  }
  const v6 = address.toLowerCase().split("%")[0];
  if (!/^[0-9a-f:.]+$/.test(v6) || !v6.includes(":")) return false;
  if (v6 === "::" || v6 === "::1") return false;
  if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return false;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return false;  // unique local
  if (v6.startsWith("ff")) return false;                          // multicast
  if (v6.startsWith("::ffff:")) return isPublicAddress(v6.slice(7));
  return true;
}

/** Read the control line byte by byte, leaving every later byte untouched. */
async function readControlLine(conn: Deno.Conn): Promise<string | null> {
  const byte = new Uint8Array(1);
  let line = "";
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  while (line.length < 512) {
    if (Date.now() > deadline) return null;
    const n = await conn.read(byte);
    if (n === null) return null;
    const ch = String.fromCharCode(byte[0]);
    if (ch === "\n") return line.trim();
    line += ch;
  }
  return null;
}

async function refuse(conn: Deno.Conn, reason: string): Promise<void> {
  try {
    await conn.write(new TextEncoder().encode(`ERR ${reason}\n`));
  } catch { /* the caller may already be gone */ }
  try {
    conn.close();
  } catch { /* already closed */ }
}

/** Copy until one side ends, then close both. */
async function pump(from: Deno.Conn, to: Deno.Conn): Promise<void> {
  const buf = new Uint8Array(16384);
  try {
    while (true) {
      const n = await from.read(buf);
      if (n === null) break;
      await to.write(buf.subarray(0, n));
    }
  } catch { /* either side may vanish; the finally below is the whole cleanup */ }
}

export async function handle(conn: Deno.Conn, secret: string): Promise<void> {
  const peer = (conn.remoteAddr as Deno.NetAddr).hostname;
  if (active >= MAX_TUNNELS) return await refuse(conn, "busy");
  active++;
  let upstream: Deno.Conn | null = null;
  try {
    const line = await readControlLine(conn);
    if (!line) return await refuse(conn, "no_control_line");

    const parts = line.split(/\s+/);
    if (parts.length !== 6 || parts[0] !== PROTOCOL || parts[1] !== "CONNECT") {
      return await refuse(conn, "bad_control_line");
    }
    const [, , address, portRaw, expiryRaw, signature] = parts;

    const expiry = Number(expiryRaw);
    const nowS = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(expiry) || expiry < nowS || expiry > nowS + AUTH_TTL_S + 60) {
      return await refuse(conn, "expired");
    }
    const expected = await hmacHex(secret, `${address} ${portRaw} ${expiryRaw}`);
    if (!constantTimeEquals(expected, signature.toLowerCase())) {
      console.warn(`[mail-proxy] bad signature from ${peer}`);
      return await refuse(conn, "unauthorized");
    }

    const port = Number(portRaw);
    if (!ALLOWED_PORTS.has(port)) return await refuse(conn, "port_not_allowed");
    if (!isPublicAddress(address)) return await refuse(conn, "address_not_allowed");

    try {
      upstream = await Deno.connect({ hostname: address, port });
    } catch (err) {
      console.warn(`[mail-proxy] dial ${address}:${port} failed: ${err instanceof Error ? err.message : err}`);
      return await refuse(conn, "upstream_unreachable");
    }

    await conn.write(new TextEncoder().encode("OK\n"));
    console.log(`[mail-proxy] tunnel ${peer} -> ${address}:${port} (active=${active})`);
    await Promise.race([pump(conn, upstream), pump(upstream, conn)]);
  } catch (err) {
    console.warn(`[mail-proxy] ${peer}: ${err instanceof Error ? err.message : err}`);
  } finally {
    active--;
    for (const c of [conn, upstream]) {
      try {
        c?.close();
      } catch { /* already closed */ }
    }
  }
}

/** Entry point. Guarded so the helpers above stay importable from tests. */
if (import.meta.main) {
  const secret = Deno.env.get("MAIL_PROXY_SECRET")?.trim();
  if (!secret) {
    console.error("MAIL_PROXY_SECRET is not set. Refusing to start.");
    Deno.exit(1);
  }
  const port = Number(Deno.env.get("MAIL_PROXY_LISTEN_PORT") ?? "8443");
  console.log(`[mail-proxy] listening on :${port}, forwarding to ${[...ALLOWED_PORTS].join(", ")}`);
  for await (const conn of Deno.listen({ port })) {
    handle(conn, secret);
  }
}
