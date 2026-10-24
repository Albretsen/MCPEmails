// Which webhook URLs are dialled, and how: https only, ports 443 and 8443,
// the host-guard address policy at every send (a name re-resolved into a
// private range is refused even though it was public at creation), the
// approved ADDRESS is what is connected to, the peer is re-checked, the
// certificate is checked against the NAME, and a redirect is never followed.
// The resolver, the socket and TLS are all injected; no network.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { guardWebhookUrl, parseWebhookUrl } from "../webhooks/url-guard.ts";
import { createPinnedTransport, encodeRequest, parseStatusLine, type StreamConn } from "../webhooks/transport.ts";

const publicLookup = (address = "93.184.216.34") => () => Promise.resolve([{ address, family: 4 }]);

Deno.test("only https URLs on 443 or 8443, without credentials or a fragment", () => {
  const code = (raw: unknown) => {
    const parsed = parseWebhookUrl(raw);
    return parsed.ok ? "ok" : parsed.code;
  };
  assertEquals(code("https://hooks.example.com/in"), "ok");
  assertEquals(code("https://hooks.example.com:8443/in?x=1"), "ok");
  assertEquals(code("https://hooks.example.com:443/in"), "ok");
  assertEquals(code("http://hooks.example.com/in"), "url_not_https");
  assertEquals(code("ftp://hooks.example.com/in"), "url_not_https");
  assertEquals(code("https://hooks.example.com:8080/in"), "port_not_allowed");
  assertEquals(code("https://hooks.example.com:22/"), "port_not_allowed");
  assertEquals(code("https://user:pass@hooks.example.com/"), "url_credentials");
  assertEquals(code("https://hooks.example.com/#frag"), "url_invalid");
  assertEquals(code("https://hooks.example.com/a b"), "url_invalid");
  assertEquals(code(`https://hooks.example.com/${"a".repeat(2050)}`), "url_invalid");
  assertEquals(code(42), "url_invalid");
  assertEquals(code("not a url"), "url_invalid");
});

Deno.test("private, loopback, link-local, metadata and CGNAT literals are refused, in every encoding", async () => {
  for (
    const raw of [
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://0x7f.0.0.1/",
      "https://0177.0.0.1/",
      "https://10.0.0.5/",
      "https://192.168.1.1/",
      "https://172.16.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[fd00::1]/",
      "https://0.0.0.0/",
    ]
  ) {
    const verdict = await guardWebhookUrl(raw, { lookup: publicLookup() });
    assertEquals(verdict.ok ? "ok" : verdict.code, "host_not_allowed", raw);
  }
});

Deno.test("a name is resolved and every answer must be public", async () => {
  const ok = await guardWebhookUrl("https://hooks.example.com/in", { lookup: publicLookup() });
  assert(ok.ok);
  assertEquals(ok.address, "93.184.216.34");
  const rebound = await guardWebhookUrl("https://hooks.example.com/in", { lookup: publicLookup("10.1.2.3") });
  assertEquals(rebound.ok ? "ok" : rebound.code, "host_not_allowed");
  const mixed = await guardWebhookUrl("https://hooks.example.com/in", {
    lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]),
  });
  assertEquals(mixed.ok ? "ok" : mixed.code, "host_not_allowed");
  const missing = await guardWebhookUrl("https://nothing.example.com/", { lookup: () => Promise.reject(new Error("NXDOMAIN")) });
  assertEquals(missing.ok ? "ok" : missing.code, "host_not_found");
  const single = await guardWebhookUrl("https://intranet/", { lookup: publicLookup() });
  assertEquals(single.ok ? "ok" : single.code, "url_invalid", "a single-label name only resolves on a search domain");
});

/** A fake TLS stream that records what was written and answers with `reply`. */
function fakeStream(reply: string) {
  const written: Uint8Array[] = [];
  let served = false;
  let closed = false;
  const conn: StreamConn = {
    write(bytes) {
      written.push(bytes.slice());
      return Promise.resolve(bytes.length);
    },
    read(buffer) {
      if (served) return Promise.resolve(null);
      served = true;
      const bytes = new TextEncoder().encode(reply);
      buffer.set(bytes.subarray(0, buffer.length));
      return Promise.resolve(Math.min(bytes.length, buffer.length));
    },
    close() {
      closed = true;
    },
  };
  return { conn, written: () => new TextDecoder().decode(new Uint8Array(written.flatMap((w) => [...w]))), closed: () => closed };
}

Deno.test("the transport dials the approved address and checks the certificate against the name", async () => {
  const dialled: Array<{ hostname: string; port: number }> = [];
  const tlsNames: string[] = [];
  const stream = fakeStream("HTTP/1.1 204 No Content\r\nX: y\r\n\r\n");
  const transport = createPinnedTransport({
    lookup: publicLookup("93.184.216.34"),
    connect: (o) => {
      dialled.push(o);
      return Promise.resolve({ conn: stream.conn, peer: o.hostname });
    },
    startTls: (conn, hostname) => {
      tlsNames.push(hostname);
      return Promise.resolve(conn);
    },
  });
  const answer = await transport.post({
    url: "https://Hooks.Example.com:8443/in?x=1",
    headers: { "MCPEmails-Event-Id": "evt_1" },
    body: '{"a":1}',
  });
  assertEquals(answer, { kind: "response", status: 204 });
  assertEquals(dialled, [{ hostname: "93.184.216.34", port: 8443 }]);
  assertEquals(tlsNames, ["hooks.example.com"]);
  const request = stream.written();
  assert(request.startsWith("POST /in?x=1 HTTP/1.1\r\nHost: hooks.example.com:8443\r\n"), request);
  assert(request.includes("Content-Length: 7\r\n"));
  assert(request.includes("MCPEmails-Event-Id: evt_1\r\n"));
  assert(request.endsWith('\r\n\r\n{"a":1}'));
  assert(stream.closed());
});

Deno.test("a redirect is reported as its status and never followed", async () => {
  let connects = 0;
  const transport = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) => {
      connects++;
      return Promise.resolve({ conn: fakeStream("HTTP/1.1 302 Found\r\nLocation: https://169.254.169.254/\r\n\r\n").conn, peer: o.hostname });
    },
    startTls: (conn) => Promise.resolve(conn),
  });
  assertEquals(await transport.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "response", status: 302 });
  assertEquals(connects, 1);
});

Deno.test("refused at send time: http, a private address after rebinding, a private peer", async () => {
  let connects = 0;
  const connect = (o: { hostname: string; port: number }) => {
    connects++;
    return Promise.resolve({ conn: fakeStream("HTTP/1.1 200 OK\r\n\r\n").conn, peer: o.hostname });
  };
  const http = createPinnedTransport({ lookup: publicLookup(), connect, startTls: (c) => Promise.resolve(c) });
  assertEquals(await http.post({ url: "http://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "url_not_https" });

  const rebound = createPinnedTransport({ lookup: publicLookup("192.168.0.10"), connect, startTls: (c) => Promise.resolve(c) });
  assertEquals(await rebound.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "host_not_allowed" });
  assertEquals(connects, 0, "nothing was dialled");

  // The kernel reached somewhere other than the approved literal: closed before a byte is written.
  const stream = fakeStream("HTTP/1.1 200 OK\r\n\r\n");
  const peer = createPinnedTransport({
    lookup: publicLookup(),
    connect: () => Promise.resolve({ conn: stream.conn, peer: "127.0.0.1" }),
    startTls: (c) => Promise.resolve(c),
  });
  assertEquals(await peer.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "host_not_allowed" });
  assertEquals(stream.written(), "");
});

Deno.test("timeouts, refused connections and TLS failures are codes", async () => {
  const hang = createPinnedTransport({
    lookup: publicLookup(),
    connect: () => new Promise(() => {}),
  });
  assertEquals(await hang.post({ url: "https://hooks.example.com/", headers: {}, body: "{}", timeoutMs: 20 }), { kind: "error", code: "timeout" });

  const refused = createPinnedTransport({ lookup: publicLookup(), connect: () => Promise.reject(new Error("ECONNREFUSED")) });
  assertEquals(await refused.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "connect_failed" });

  const badTls = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) => Promise.resolve({ conn: fakeStream("").conn, peer: o.hostname }),
    startTls: () => Promise.reject(new Error("invalid peer certificate")),
  });
  assertEquals(await badTls.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "tls_failed" });

  const garbage = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) => Promise.resolve({ conn: fakeStream("SSH-2.0-OpenSSH\r\n").conn, peer: o.hostname }),
    startTls: (c) => Promise.resolve(c),
  });
  assertEquals(await garbage.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "protocol_error" });
});

Deno.test("header injection: CR and LF never reach the wire", () => {
  const bytes = new TextDecoder().decode(encodeRequest("h.example.com", "/x", { "X-A": "1\r\nX-Evil: 2" }, ""));
  assert(!bytes.includes("\r\nX-Evil"));
  assertEquals(parseStatusLine("HTTP/1.1 200 OK"), 200);
  assertEquals(parseStatusLine("HTTP/1.0 404"), 404);
  assertEquals(parseStatusLine("HTTP/2 200"), null);
});

Deno.test("the deadline aborts an attempt still connecting, and a connection that opens late is closed unused", async () => {
  const late = fakeStream("HTTP/1.1 200 OK\r\n\r\n");
  let finishConnect: (() => void) | null = null;
  const transport = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) =>
      new Promise((resolve) => {
        finishConnect = () => resolve({ conn: late.conn, peer: o.hostname });
      }),
    startTls: (conn) => Promise.resolve(conn),
  });
  const answer = await transport.post({ url: "https://hooks.example.com/", headers: {}, body: "{}", timeoutMs: 15 });
  assertEquals(answer, { kind: "error", code: "timeout" });
  finishConnect!();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(late.closed(), "the late connection was closed");
  assertEquals(late.written(), "", "and nothing was written to it");
});

Deno.test("a TLS handshake failure is tls_failed, whether it surfaces in handshake() or on the first write", async () => {
  const explicit = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) => Promise.resolve({ conn: fakeStream("").conn, peer: o.hostname }),
    startTls: (conn) => Promise.resolve({ ...conn, handshake: () => Promise.reject(new Error("invalid peer certificate: UnknownIssuer")) }),
  });
  assertEquals(await explicit.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "tls_failed" });

  const lazy = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) => Promise.resolve({ conn: fakeStream("").conn, peer: o.hostname }),
    startTls: (conn) => Promise.resolve({ ...conn, write: () => Promise.reject(new Error("received fatal alert: HandshakeFailure")) }),
  });
  assertEquals(await lazy.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "tls_failed" });

  const reset = createPinnedTransport({
    lookup: publicLookup(),
    connect: (o) => Promise.resolve({ conn: fakeStream("").conn, peer: o.hostname }),
    startTls: (conn) => Promise.resolve({ ...conn, write: () => Promise.reject(new Error("connection reset")) }),
  });
  assertEquals(await reset.post({ url: "https://hooks.example.com/", headers: {}, body: "{}" }), { kind: "error", code: "connect_failed" });
});
