// ---------------------------------------------------------------------------
// The relay that carries submission for hosts which refuse our AWS egress.
//
// Two properties are worth pinning, and they pull in opposite directions:
//
//   - It must be USED, and only for the hosts named. A relay that quietly
//     stops routing domeneshop.no puts the customer back on the 550 [ACR04]
//     that made us build it; a relay that routes everything puts 200 working
//     inboxes behind a single VPS.
//   - It must be OPTIONAL at every step. Missing config, bad config, a dead
//     relay, a proxy that answers 407: none of those may fail a send that a
//     direct dial would have completed.
//
// The socket handling is covered through the `connect` seam with a fake
// connection, because the interesting failures (a refused CONNECT, a truncated
// head, an oversized head) are precisely the ones a live proxy will not
// produce on demand.
// ---------------------------------------------------------------------------

import {
  buildConnectRequest,
  connectThroughRelay,
  DEFAULT_RELAY_HOST_SUFFIXES,
  noteRelayFailure,
  noteRelaySuccess,
  parseConnectStatus,
  parseRelayConfig,
  type RelayConfig,
  relayFor,
  relaySuspended,
  RELAY_SUSPEND_MS,
  RelayUnavailableError,
  resetRelayStateForTests,
  shouldRelayHost,
} from "./smtp-relay.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Which hosts go through it
// ---------------------------------------------------------------------------

Deno.test("only the named hosts are relayed", () => {
  const suffixes = ["domeneshop.no"];
  assertEquals(shouldRelayHost("smtp.domeneshop.no", suffixes), true, "the host we have proof about");
  assertEquals(shouldRelayHost("domeneshop.no", suffixes), true, "the bare registration");
  assertEquals(shouldRelayHost("SMTP.DOMENESHOP.NO", suffixes), true, "hosts are case-insensitive");
  assertEquals(shouldRelayHost("smtp.gmail.com", suffixes), false, "everything else dials directly");
});

Deno.test("a suffix matches on label boundaries, never as a substring", () => {
  // notdomeneshop.no is a different registration. If a bare endsWith were used,
  // anyone who can point an inbox at a host they own could borrow the relay.
  assertEquals(shouldRelayHost("smtp.notdomeneshop.no", ["domeneshop.no"]), false, "different registration");
  assertEquals(shouldRelayHost("domeneshop.no.evil.test", ["domeneshop.no"]), false, "suffix in the middle");
});

// ---------------------------------------------------------------------------
// Configuration: every bad value degrades to "no relay", never to a failed send
// ---------------------------------------------------------------------------

Deno.test("no SMTP_RELAY_URL means no relay", () => {
  assertEquals(parseRelayConfig({}), null, "unset");
  assertEquals(parseRelayConfig({ SMTP_RELAY_URL: "   " }), null, "blank");
});

Deno.test("a relay URL parses into host, port, auth and host list", () => {
  const config = parseRelayConfig({ SMTP_RELAY_URL: "http://relay-user:s3cret@relay.example.net:3128" });
  assert(config !== null, "should parse");
  assertEquals(config!.host, "relay.example.net", "host");
  assertEquals(config!.port, 3128, "port");
  assertEquals(config!.authorization, `Basic ${btoa("relay-user:s3cret")}`, "proxy credentials");
  assertEquals(config!.hostSuffixes.join(","), DEFAULT_RELAY_HOST_SUFFIXES.join(","), "defaults to the known host");
});

Deno.test("a percent-escaped password is decoded before it is encoded", () => {
  // A generated secret containing ':' or '@' can only be written escaped, and
  // authenticating as the literal "p%40ss" would fail against a proxy that was
  // configured with "p@ss".
  const config = parseRelayConfig({ SMTP_RELAY_URL: "http://user:p%40ss%3Aword@relay.example.net:3128" });
  assertEquals(config!.authorization, `Basic ${btoa("user:p@ss:word")}`, "decoded credentials");
});

Deno.test("credentials are optional", () => {
  const config = parseRelayConfig({ SMTP_RELAY_URL: "http://relay.example.net:8888" });
  assertEquals(config!.authorization, null, "no Proxy-Authorization header");
  assertEquals(config!.port, 8888, "explicit port");
});

Deno.test("the port defaults when the URL omits it", () => {
  assertEquals(parseRelayConfig({ SMTP_RELAY_URL: "http://relay.example.net" })!.port, 3128, "squid's default");
});

Deno.test("an unusable relay URL disables relaying rather than breaking sends", () => {
  assertEquals(parseRelayConfig({ SMTP_RELAY_URL: "not a url" }), null, "unparseable");
  // https:// would need TLS inside TLS for the tunnelled session, which the
  // runtime cannot do; accepting it would fail every send to a relayed host.
  assertEquals(parseRelayConfig({ SMTP_RELAY_URL: "https://relay.example.net:443" }), null, "wrong scheme");
  assertEquals(parseRelayConfig({ SMTP_RELAY_URL: "http://relay.example.net:0" }), null, "invalid port");
});

Deno.test("an empty host list disables relaying", () => {
  const config = parseRelayConfig({
    SMTP_RELAY_URL: "http://relay.example.net:3128",
    SMTP_RELAY_HOSTS: " , ",
  });
  assertEquals(config, null, "nothing to relay means no relay");
});

Deno.test("SMTP_RELAY_HOSTS replaces the default list", () => {
  const config = parseRelayConfig({
    SMTP_RELAY_URL: "http://relay.example.net:3128",
    SMTP_RELAY_HOSTS: "domeneshop.no, .example.coop ,MAIL.TEST",
  });
  assertEquals(config!.hostSuffixes.join("|"), "domeneshop.no|example.coop|mail.test", "trimmed and normalised");
});

// ---------------------------------------------------------------------------
// The CONNECT exchange
// ---------------------------------------------------------------------------

Deno.test("the CONNECT request names the mail host and carries the credential", () => {
  const request = buildConnectRequest({ host: "smtp.domeneshop.no", port: 465 }, "Basic abc");
  assert(request.startsWith("CONNECT smtp.domeneshop.no:465 HTTP/1.1\r\n"), "request line");
  assert(request.includes("\r\nHost: smtp.domeneshop.no:465\r\n"), "host header");
  assert(request.includes("\r\nProxy-Authorization: Basic abc\r\n"), "credential");
  assert(request.endsWith("\r\n\r\n"), "head is terminated");
});

Deno.test("an open relay gets no Proxy-Authorization", () => {
  const request = buildConnectRequest({ host: "smtp.domeneshop.no", port: 465 }, null);
  assertEquals(request.includes("Proxy-Authorization"), false, "no empty credential");
});

Deno.test("CONNECT status lines are read for the code and the reason", () => {
  assertEquals(parseConnectStatus("HTTP/1.1 200 Connection established\r\n\r\n")!.code, 200, "success");
  const denied = parseConnectStatus("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")!;
  assertEquals(denied.code, 407, "code");
  // The reason is what turns "the relay failed" into a five-minute fix.
  assertEquals(denied.reason, "Proxy Authentication Required", "reason");
  assertEquals(parseConnectStatus("220 smtp.domeneshop.no ESMTP\r\n"), null, "not an HTTP response");
});

// ---------------------------------------------------------------------------
// Tunnelling, and the failures that must fall back
// ---------------------------------------------------------------------------

const RELAY: RelayConfig = {
  host: "relay.example.net",
  port: 3128,
  authorization: "Basic abc",
  hostSuffixes: ["domeneshop.no"],
};

const TARGET = { host: "smtp.domeneshop.no", port: 465 };

/** A connection that replays `script` and records what was written to it. */
// 51.15.0.10 is an ordinary public address: the documentation ranges
// (192.0.2/24, 198.51.100/24, 203.0.113/24) are blocked by the host guard,
// which would fail these tests for the wrong reason.
function fakeConn(script: string, peer = "51.15.0.10") {
  const outgoing = new TextEncoder().encode(script);
  let offset = 0;
  const state = { closed: false, written: "" };
  const conn = {
    remoteAddr: { transport: "tcp", hostname: peer, port: 3128 },
    read(buffer: Uint8Array): Promise<number | null> {
      if (offset >= outgoing.length) return Promise.resolve(null);
      const count = Math.min(buffer.length, outgoing.length - offset);
      buffer.set(outgoing.subarray(offset, offset + count));
      offset += count;
      return Promise.resolve(count);
    },
    write(buffer: Uint8Array): Promise<number> {
      state.written += new TextDecoder().decode(buffer);
      return Promise.resolve(buffer.length);
    },
    close() {
      state.closed = true;
    },
  };
  return { conn: conn as unknown as Deno.TcpConn, state, unread: () => outgoing.length - offset };
}

Deno.test("a 200 hands back the socket with the tunnel open", async () => {
  const fake = fakeConn("HTTP/1.1 200 Connection established\r\n\r\n");
  const conn = await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.resolve(fake.conn) });
  assertEquals(conn, fake.conn, "the caller speaks SMTP on this socket");
  assertEquals(fake.state.closed, false, "still open");
  assert(fake.state.written.startsWith("CONNECT smtp.domeneshop.no:465"), "asked for the right tunnel");
});

Deno.test("the response head is read to the blank line and no further", async () => {
  // The mail host's first bytes can share a segment with the proxy's answer.
  // Anything over-read here is consumed from the stream startTls is about to
  // use, and the handshake would fail naming neither the relay nor the cause.
  const fake = fakeConn("HTTP/1.1 200 Connection established\r\n\r\nTLS-HELLO");
  await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.resolve(fake.conn) });
  assertEquals(fake.unread(), "TLS-HELLO".length, "the server's bytes are left for TLS");
});

Deno.test("a refused CONNECT is a relay failure, and the socket is closed", async () => {
  const fake = fakeConn("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  let thrown: unknown;
  try {
    await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.resolve(fake.conn) });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof RelayUnavailableError, "callers key the fallback off this class");
  assert((thrown as Error).message.includes("407"), "the status survives into the log");
  assertEquals(fake.state.closed, true, "no leaked socket");
});

Deno.test("a relay that will not accept a connection is a relay failure", async () => {
  let thrown: unknown;
  try {
    await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.reject(new Error("Connection refused")) });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof RelayUnavailableError, "fell back rather than failing the send");
});

Deno.test("a relay that hangs up mid-head is a relay failure", async () => {
  const fake = fakeConn("HTTP/1.1 200 Conn");
  let thrown: unknown;
  try {
    await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.resolve(fake.conn) });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof RelayUnavailableError, "truncated head");
  assertEquals(fake.state.closed, true, "no leaked socket");
});

Deno.test("something that is not an HTTP proxy is a relay failure", async () => {
  const fake = fakeConn("220 smtp.example.net ESMTP ready\r\n\r\n");
  let thrown: unknown;
  try {
    await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.resolve(fake.conn) });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof RelayUnavailableError, "not a CONNECT answer");
});

Deno.test("a relay resolving to a private address is refused", async () => {
  // The relay is operator config rather than user data, so this is a backstop
  // against a typo or a hijacked answer, not the SSRF guard on the mail host.
  const fake = fakeConn("HTTP/1.1 200 Connection established\r\n\r\n", "10.0.0.5");
  let thrown: unknown;
  try {
    await connectThroughRelay(RELAY, TARGET, { connect: () => Promise.resolve(fake.conn) });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof RelayUnavailableError, "refused");
  assertEquals(fake.state.closed, true, "closed before a byte was written");
  assertEquals(fake.state.written, "", "nothing was sent to it");
});

Deno.test("a relay that never answers gives up inside its own budget", async () => {
  const started = Date.now();
  let thrown: unknown;
  try {
    await connectThroughRelay(RELAY, TARGET, {
      connect: () => new Promise<Deno.TcpConn>(() => {}),
      timeoutMs: 40,
    });
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof RelayUnavailableError, "timed out into the fallback");
  // The point of the short budget: the direct dial still has time to run.
  assert(Date.now() - started < 1_000, "gave up promptly");
});

// ---------------------------------------------------------------------------
// The breaker: a dead relay is paid for once, not on every send
// ---------------------------------------------------------------------------

Deno.test("a failure suspends the relay, and the suspension expires", () => {
  resetRelayStateForTests();
  const now = 1_000_000;
  assertEquals(relaySuspended(now), false, "starts available");
  noteRelayFailure(now);
  assertEquals(relaySuspended(now + 1), true, "skipped right after a failure");
  assertEquals(relaySuspended(now + RELAY_SUSPEND_MS - 1), true, "still skipped inside the window");
  assertEquals(relaySuspended(now + RELAY_SUSPEND_MS), false, "tried again once it lapses");
  resetRelayStateForTests();
});

Deno.test("a success clears an earlier suspension", () => {
  resetRelayStateForTests();
  noteRelayFailure(1_000_000);
  noteRelaySuccess();
  assertEquals(relaySuspended(1_000_001), false, "a working relay is not held out");
  resetRelayStateForTests();
});

// ---------------------------------------------------------------------------
// relayFor: the routing decision the send path actually calls
// ---------------------------------------------------------------------------

function withRelayEnv<T>(url: string | null, hosts: string | null, body: () => T): T {
  const previous = {
    url: Deno.env.get("SMTP_RELAY_URL"),
    hosts: Deno.env.get("SMTP_RELAY_HOSTS"),
  };
  resetRelayStateForTests();
  if (url === null) Deno.env.delete("SMTP_RELAY_URL");
  else Deno.env.set("SMTP_RELAY_URL", url);
  if (hosts === null) Deno.env.delete("SMTP_RELAY_HOSTS");
  else Deno.env.set("SMTP_RELAY_HOSTS", hosts);
  try {
    return body();
  } finally {
    if (previous.url === undefined) Deno.env.delete("SMTP_RELAY_URL");
    else Deno.env.set("SMTP_RELAY_URL", previous.url);
    if (previous.hosts === undefined) Deno.env.delete("SMTP_RELAY_HOSTS");
    else Deno.env.set("SMTP_RELAY_HOSTS", previous.hosts);
    resetRelayStateForTests();
  }
}

Deno.test("with no relay configured every host dials directly", () => {
  withRelayEnv(null, null, () => {
    assertEquals(relayFor("smtp.domeneshop.no"), null, "the default posture is unchanged");
  });
});

Deno.test("a configured relay carries the listed host and nothing else", () => {
  withRelayEnv("http://user:pw@relay.example.net:3128", null, () => {
    assertEquals(relayFor("smtp.domeneshop.no")?.host, "relay.example.net", "the host we built this for");
    assertEquals(relayFor("smtp.gmail.com"), null, "everyone else is untouched");
  });
});

Deno.test("a suspended relay routes directly until the window lapses", () => {
  withRelayEnv("http://user:pw@relay.example.net:3128", null, () => {
    const now = 5_000_000;
    noteRelayFailure(now);
    assertEquals(relayFor("smtp.domeneshop.no", now + 1), null, "skipped while suspended, so the send still goes");
    assertEquals(
      relayFor("smtp.domeneshop.no", now + RELAY_SUSPEND_MS)?.host,
      "relay.example.net",
      "picked up again without a deploy",
    );
  });
});
