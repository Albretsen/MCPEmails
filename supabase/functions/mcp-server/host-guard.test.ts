/**
 * host-guard.test.ts — Deno mirror of apps/web/src/lib/email/host-guard.test.ts.
 *
 * The corpus is deliberately the same corpus. Two implementations of one policy
 * are only worth having if they are held to one set of cases: if a range, an
 * encoding trick or a port ever passes here and fails there (or the reverse),
 * that is the bug, and this file is where it shows up.
 *
 * No test touches the network. Every hostname case goes through an injected
 * `lookup`, which is also the only honest way to test the rule that matters
 * most: a perfectly ordinary-looking name whose A record points inside. The
 * connect tests inject a fake `connect` as well.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  clearValidationCacheForTests,
  connectGuardedTcp,
  guardMailHost,
  guardMailHostCached,
  type HostLookup,
  isAllowedAddress,
  isAllowedMailPort,
  MailHostBlockedError,
  normalizeMailHost,
  parseIpv6,
  parseLooseIpv4,
} from "./host-guard.ts";

function lookupReturning(...addresses: string[]): HostLookup {
  return () =>
    Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

const lookupFails: HostLookup = () => Promise.reject(new Deno.errors.NotFound("no such host"));

/** Shorthand: a public A record, so only the host string is under test. */
const publicLookup = lookupReturning("142.250.74.101");

function guard(
  host: string,
  port = 993,
  protocol: "imap" | "smtp" = "imap",
  lookup: HostLookup = publicLookup,
) {
  return guardMailHost(host, { protocol, port, lookup });
}

/* ── IPv4 literals ──────────────────────────────────────────────────────── */

Deno.test("every blocked IPv4 range is refused as a literal", async () => {
  const blocked = [
    "0.0.0.0", // unspecified; a live alias for localhost on Linux
    "127.0.0.1", // loopback
    "127.1.2.3", // the whole /8, not just .0.0.1
    "169.254.169.254", // cloud instance metadata, the prize target
    "169.254.1.1", // the rest of link-local
    "10.0.0.7", // RFC 1918
    "172.16.0.1", // RFC 1918, low edge of the /12
    "172.31.255.254", // RFC 1918, high edge of the /12
    "192.168.1.1", // RFC 1918
    "100.64.0.1", // CGNAT
    "100.127.255.255", // CGNAT, high edge of the /10
    "224.0.0.1", // multicast
    "239.255.255.250", // multicast (SSDP)
    "255.255.255.255", // broadcast
    "240.0.0.1", // reserved
    "192.0.2.1", // TEST-NET-1
    "198.51.100.1", // TEST-NET-2
    "203.0.113.1", // TEST-NET-3
    "198.18.0.1", // benchmarking
    "192.88.99.1", // 6to4 relay anycast
    "192.0.0.1", // IETF protocol assignments
  ];
  for (const host of blocked) {
    const result = await guard(host);
    assertEquals(result.ok, false, `${host} must be refused`);
    assertEquals(result.ok === false && result.code, "host_not_allowed", host);
  }
});

Deno.test("the neighbours of each blocked range still pass", async () => {
  // 172.15/172.32 and 100.63/100.128 are the off-by-one mistakes a hand-rolled
  // mask check makes, and they are public address space.
  for (
    const host of [
      "172.15.0.1",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "11.0.0.1",
      "126.255.255.255",
      "128.0.0.1",
      "223.255.255.255",
    ]
  ) {
    const result = await guard(host);
    assertEquals(result.ok, true, `${host} is public and must pass`);
  }
});

Deno.test("IPv4 encoding tricks resolve to the same blocked address", async () => {
  // Each of these is 127.0.0.1 to the resolver. A guard that only understands
  // the dotted-quad form lets all of them through.
  for (const host of ["2130706433", "0177.0.0.1", "0x7f.0.0.1", "0x7f000001", "127.1", "127.0.1", "017700000001"]) {
    const result = await guard(host);
    assertEquals(result.ok, false, `${host} must be refused`);
    assertEquals(result.ok === false && result.code, "host_not_allowed", host);
  }
  // And the metadata address in decimal.
  const metadata = await guard("2852039166");
  assertEquals(metadata.ok, false);
  assertEquals(metadata.ok === false && metadata.code, "host_not_allowed");
});

Deno.test("a trailing dot does not smuggle a literal past the check", async () => {
  for (const host of ["127.0.0.1.", "169.254.169.254.", "10.0.0.1."]) {
    const result = await guard(host);
    assertEquals(result.ok, false, `${host} must be refused`);
    assertEquals(result.ok === false && result.code, "host_not_allowed", host);
  }
});

Deno.test("parseLooseIpv4 reads inet_aton forms and rejects names", () => {
  assertEquals(parseLooseIpv4("127.0.0.1"), 2130706433);
  assertEquals(parseLooseIpv4("2130706433"), 2130706433);
  assertEquals(parseLooseIpv4("0177.0.0.1"), 2130706433);
  assertEquals(parseLooseIpv4("0x7f.0.0.1"), 2130706433);
  assertEquals(parseLooseIpv4("255.255.255.255"), 4294967295);
  assertEquals(parseLooseIpv4("imap.gmail.com"), null);
  assertEquals(parseLooseIpv4("256.0.0.1"), null);
  assertEquals(parseLooseIpv4("1.2.3.4.5"), null);
  assertEquals(parseLooseIpv4("0x100000000"), null);
  assertEquals(parseLooseIpv4("09.0.0.1"), null);
});

/* ── IPv6 literals ──────────────────────────────────────────────────────── */

Deno.test("every blocked IPv6 form is refused", async () => {
  const blocked = [
    "::1", // loopback
    "::", // unspecified
    "[::1]", // bracketed, as a pasted URL authority arrives
    "fe80::1", // link-local
    "fe80::1%eth0", // link-local with a zone id
    "febf::1", // still inside fe80::/10
    "fc00::1", // unique local
    "fd12:3456::1", // unique local, the half people actually use
    "ff02::1", // multicast
    "2001:db8::1", // documentation
    "2001:0:1234::1", // Teredo
    "::ffff:127.0.0.1", // IPv4-mapped loopback — the classic bypass
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:10.0.0.1", // IPv4-mapped RFC 1918
    "::127.0.0.1", // deprecated IPv4-compatible loopback
    "2002:7f00:1::1", // 6to4 wrapping 127.0.0.1, inside global unicast
    "2002:a9fe:a9fe::1", // 6to4 wrapping 169.254.169.254
    "64:ff9b::127.0.0.1", // NAT64 wrapping loopback
  ];
  for (const host of blocked) {
    const result = await guard(host);
    assertEquals(result.ok, false, `${host} must be refused`);
    assertEquals(result.ok === false && result.code, "host_not_allowed", host);
  }
});

Deno.test("public IPv6 and IPv4-mapped-public still pass, and mapped forms pin as IPv4", async () => {
  const global = await guard("2a00:1450:400f:80d::2005");
  assertEquals(global.ok, true);
  assertEquals(global.ok === true && global.family, 6);

  const mapped = await guard("::ffff:8.8.8.8");
  assertEquals(mapped.ok, true);
  // Rendered as the address it actually names, so the socket lands on the right
  // family and the pinned value is readable.
  assertEquals(mapped.ok === true && mapped.address, "8.8.8.8");
  assertEquals(mapped.ok === true && mapped.family, 4);
});

Deno.test("parseIpv6 places bytes correctly and rejects malformed literals", () => {
  assertEquals(Array.from(parseIpv6("::1") ?? []), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assertEquals(Array.from(parseIpv6("::ffff:127.0.0.1") ?? []).slice(10), [0xff, 0xff, 127, 0, 0, 1]);
  assertEquals(Array.from(parseIpv6("1:2:3:4:5:6:7:8") ?? []).slice(0, 4), [0, 1, 0, 2]);
  assertEquals(parseIpv6("1:2:3:4:5:6:7"), null);
  assertEquals(parseIpv6("1:2:3:4:5:6:7:8:9"), null);
  assertEquals(parseIpv6("1::2::3"), null);
  assertEquals(parseIpv6("1:2:3:4:5:6:7:8::"), null);
  assertEquals(parseIpv6("::gggg"), null);
  assertEquals(parseIpv6("::ffff:0177.0.0.1"), null);
  assertEquals(parseIpv6("imap.gmail.com"), null);
});

/* ── Hostnames ──────────────────────────────────────────────────────────── */

Deno.test("the mail hosts real customers use still pass", async () => {
  for (const host of ["imap.gmail.com", "imap.fastmail.com", "mail.domeneshop.no", "smtp.office365.com", "imappro.zoho.eu"]) {
    const result = await guard(host);
    assertEquals(result.ok, true, `${host} must pass`);
    assertEquals(result.ok === true && result.address, "142.250.74.101");
    assertEquals(result.ok === true && result.host, host, "the name survives for TLS SNI");
  }
});

Deno.test("a syntactically hostile host string never reaches DNS", async () => {
  // If any of these got as far as the resolver the injected lookup would answer
  // with a public address and the assertion below would fail.
  const hostile = [
    "localhost", // single label; only resolvable internally
    "imap.gmail.com:993", // a port smuggled into the host field
    "user@169.254.169.254", // userinfo
    "imap.gmail.com/../metadata", // a path
    "imap gmail com", // whitespace
    "imap.gmail.com\\@evil.example", // backslash confusion
    "-imap.gmail.com", // a label may not start with a hyphen
    "imap..gmail.com", // empty label
    "", // empty
    "imap.gmail.com#x", // fragment
  ];
  for (const host of hostile) {
    const result = await guard(host);
    assertEquals(result.ok, false, `${host} must be refused`);
    assertEquals(result.ok === false && result.code, "host_invalid", host);
  }
});

Deno.test("a public-looking name whose A record points inside is refused", async () => {
  // This is the actual attack, and the whole reason the edge function needs a
  // guard of its own: the string is a perfectly ordinary hostname that passed
  // validation when the mailbox was connected, and the only thing wrong with it
  // is the answer DNS gives today.
  for (const address of ["169.254.169.254", "127.0.0.1", "10.1.2.3", "192.168.0.5", "::1", "fd00::1"]) {
    const result = await guard("mail.attacker.example", 993, "imap", lookupReturning(address));
    assertEquals(result.ok, false, `A record ${address} must be refused`);
    assertEquals(result.ok === false && result.code, "host_not_allowed", address);
  }
});

Deno.test("one bad answer among good ones poisons the whole name", async () => {
  // A rebinding setup staged inside a single response.
  const result = await guard("mail.attacker.example", 993, "imap", lookupReturning("142.250.74.101", "127.0.0.1"));
  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.code, "host_not_allowed");
});

Deno.test("a name that does not resolve reports host_not_found, not a block", async () => {
  const failed = await guard("mail.nonexistent.example", 993, "imap", lookupFails);
  assertEquals(failed.ok, false);
  assertEquals(failed.ok === false && failed.code, "host_not_found");

  const empty = await guard("mail.nonexistent.example", 993, "imap", lookupReturning());
  assertEquals(empty.ok, false);
  assertEquals(empty.ok === false && empty.code, "host_not_found");
});

Deno.test("IPv4 is preferred when a dual-stack name offers both", async () => {
  const result = await guard("imap.gmail.com", 993, "imap", lookupReturning("2a00:1450:400f::2005", "142.250.74.101"));
  assertEquals(result.ok, true);
  assertEquals(result.ok === true && result.address, "142.250.74.101");
  assertEquals(result.ok === true && result.family, 4);
});

Deno.test("an IPv6-only name still pins its AAAA", async () => {
  const result = await guard("imap.example.com", 993, "imap", lookupReturning("2a00:1450:400f::2005"));
  assertEquals(result.ok, true);
  assertEquals(result.ok === true && result.family, 6);
});

/* ── Ports ──────────────────────────────────────────────────────────────── */

Deno.test("only the mail ports are allowed, per protocol", () => {
  assertEquals(isAllowedMailPort("imap", 993), true);
  assertEquals(isAllowedMailPort("imap", 143), true);
  assertEquals(isAllowedMailPort("smtp", 465), true);
  assertEquals(isAllowedMailPort("smtp", 587), true);
  assertEquals(isAllowedMailPort("smtp", 25), true);

  // Cross-protocol: an IMAP field must not accept a submission port and back.
  assertEquals(isAllowedMailPort("imap", 587), false);
  assertEquals(isAllowedMailPort("smtp", 993), false);

  // The scanning targets.
  for (const port of [22, 80, 443, 3306, 5432, 6379, 8080, 9200, 11211, 1, 65535]) {
    assertEquals(isAllowedMailPort("imap", port), false, `imap ${port}`);
    assertEquals(isAllowedMailPort("smtp", port), false, `smtp ${port}`);
  }
  assertEquals(isAllowedMailPort("imap", 993.5), false);
  assertEquals(isAllowedMailPort("imap", Number.NaN), false);
  assertEquals(isAllowedMailPort("imap", "993"), false);
});

Deno.test("a rejected port short-circuits before any resolution happens", async () => {
  let resolved = false;
  const spy: HostLookup = () => {
    resolved = true;
    return Promise.resolve([{ address: "142.250.74.101", family: 4 }]);
  };
  const result = await guardMailHost("imap.gmail.com", { protocol: "imap", port: 22, lookup: spy });
  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.code, "port_not_allowed");
  assertEquals(resolved, false, "a bad port must not spend a DNS round trip");
});

Deno.test("every port transport-autodetect can retry is allowed", () => {
  for (const port of [993, 143]) assertEquals(isAllowedMailPort("imap", port), true, `imap ${port}`);
  for (const port of [465, 587, 25]) assertEquals(isAllowedMailPort("smtp", port), true, `smtp ${port}`);
});

/* ── Normalization ──────────────────────────────────────────────────────── */

Deno.test("normalization is case-folding, trimming, unbracketing and root-dot stripping", () => {
  assertEquals(normalizeMailHost("  IMAP.Gmail.COM  "), "imap.gmail.com");
  assertEquals(normalizeMailHost("imap.gmail.com."), "imap.gmail.com");
  assertEquals(normalizeMailHost("imap.gmail.com..."), "imap.gmail.com");
  assertEquals(normalizeMailHost("[::1]"), "::1");
  assertEquals(normalizeMailHost(null), "");
  assertEquals(normalizeMailHost(1234), "");
});

/* ══════════════════════════════════════════════════════════════════════════
 * Deno-only surface: the cache and the pinned connect.
 * ══════════════════════════════════════════════════════════════════════════ */

Deno.test("isAllowedAddress judges a bare literal the same way the guard does", () => {
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assertEquals(isAllowedAddress(address), false, address);
  }
  for (const address of ["142.250.74.101", "8.8.8.8", "2a00:1450:400f::2005", "::ffff:8.8.8.8"]) {
    assertEquals(isAllowedAddress(address), true, address);
  }
  assertEquals(isAllowedAddress("not-an-address"), false);
});

Deno.test("a second connect to the same host inside the TTL costs no resolution", async () => {
  clearValidationCacheForTests();
  let calls = 0;
  const counting: HostLookup = () => {
    calls += 1;
    return Promise.resolve([{ address: "142.250.74.101", family: 4 }]);
  };
  const opts = { protocol: "imap" as const, port: 993, lookup: counting };
  const first = await guardMailHostCached("imap.cache-test.example", opts);
  const second = await guardMailHostCached("imap.cache-test.example", opts);
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  assertEquals(calls, 1, "the second call must be served from the memo");
  // Different port is a different verdict and must not be shared.
  await guardMailHostCached("imap.cache-test.example", { ...opts, port: 143 });
  assertEquals(calls, 2);
});

Deno.test("a memoised verdict expires, and a denial is memoised too", async () => {
  clearValidationCacheForTests();
  let calls = 0;
  let clock = 1_000_000;
  const counting: HostLookup = () => {
    calls += 1;
    return Promise.resolve([{ address: "10.0.0.5", family: 4 }]);
  };
  const opts = { protocol: "imap" as const, port: 993, lookup: counting, now: () => clock };

  const denied = await guardMailHostCached("imap.rebound.example", opts);
  assertEquals(denied.ok === false && denied.code, "host_not_allowed");
  await guardMailHostCached("imap.rebound.example", opts);
  assertEquals(calls, 1, "a denial is memoised so a hostile row cannot spin the resolver");

  clock += 60_001;
  await guardMailHostCached("imap.rebound.example", opts);
  assertEquals(calls, 2, "past the 60s TTL the verdict is recomputed");
});

Deno.test("host_not_found is never memoised, because it is usually transient", async () => {
  clearValidationCacheForTests();
  let calls = 0;
  const failing: HostLookup = () => {
    calls += 1;
    return Promise.reject(new Deno.errors.NotFound("SERVFAIL"));
  };
  const opts = { protocol: "imap" as const, port: 993, lookup: failing };
  await guardMailHostCached("imap.blip.example", opts);
  await guardMailHostCached("imap.blip.example", opts);
  assertEquals(calls, 2);
});

/* ── The production resolver's query strategy ───────────────────────────────
 *
 * These drive `Deno.resolveDns` for real, because the thing being tested IS the
 * real resolver's behaviour: on a host with A records and no AAAA it takes
 * ~30 seconds to answer the AAAA query, so a lookup that waits for both would
 * stall a mail operation past its budget. `--allow-net` and a working resolver
 * are required, so they are skipped when the network is unavailable.
 */
const NETWORK_TESTS = Deno.env.get("HOST_GUARD_SKIP_NETWORK_TESTS") !== "1";

Deno.test({
  name: "an A-only host resolves fast, without waiting on its absent AAAA",
  ignore: !NETWORK_TESTS,
  fn: async () => {
    clearValidationCacheForTests();
    // imap.fastmail.com is a real customer host with A records and no AAAA.
    // Before the A-first ordering this call took 30 seconds.
    const started = performance.now();
    const result = await guardMailHostCached("imap.fastmail.com", { protocol: "imap", port: 993 });
    const elapsed = performance.now() - started;
    assertEquals(result.ok, true);
    assertEquals(result.ok === true && result.family, 4);
    assert(elapsed < 5_000, `resolution took ${Math.round(elapsed)}ms; the AAAA query is being waited on`);
  },
});

Deno.test({
  name: "a dual-stack host still pins its IPv4, and the warm path costs nothing",
  ignore: !NETWORK_TESTS,
  fn: async () => {
    clearValidationCacheForTests();
    const first = await guardMailHostCached("imap.gmail.com", { protocol: "imap", port: 993 });
    assertEquals(first.ok, true);
    assertEquals(first.ok === true && first.family, 4, "our egress is IPv4");

    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      await guardMailHostCached("imap.gmail.com", { protocol: "imap", port: 993 });
    }
    const perCall = (performance.now() - started) / 1000;
    assert(perCall < 1, `a cache hit cost ${perCall.toFixed(3)}ms; it must be a Map lookup`);
  },
});

/**
 * A `Deno.TcpConn` stand-in. Only `remoteAddr` and `close()` are ever touched by
 * `connectGuardedTcp`, so the cast is narrow and the test never opens a socket.
 */
interface FakeConn {
  closed: boolean;
  conn: Deno.TcpConn;
}
function fakeConn(peer: string, port: number): FakeConn {
  const stub = {
    closed: false,
    remoteAddr: { transport: "tcp", hostname: peer, port },
    close() {
      stub.closed = true;
    },
  };
  return { get closed() { return stub.closed; }, set closed(v: boolean) { stub.closed = v; }, conn: stub as unknown as Deno.TcpConn };
}

Deno.test("connectGuardedTcp dials the APPROVED ADDRESS, not the name", async () => {
  clearValidationCacheForTests();
  let dialled = "";
  const conn = await connectGuardedTcp({
    host: "imap.pin-test.example",
    port: 993,
    protocol: "imap",
    lookup: lookupReturning("142.250.74.101"),
    connect: (o) => {
      dialled = o.hostname;
      return Promise.resolve(fakeConn("142.250.74.101", o.port).conn);
    },
  });
  // Rule 3: handing the NAME to connect would re-resolve it, which is exactly
  // the window DNS rebinding exists to exploit.
  assertEquals(dialled, "142.250.74.101");
  assert(conn !== null);
});

Deno.test("connectGuardedTcp refuses a blocked host before opening any socket", async () => {
  clearValidationCacheForTests();
  let attempted = false;
  const err = await assertRejects(
    () =>
      connectGuardedTcp({
        host: "mail.attacker.example",
        port: 993,
        protocol: "imap",
        lookup: lookupReturning("169.254.169.254"),
        connect: () => {
          attempted = true;
          return Promise.resolve(fakeConn("169.254.169.254", 993).conn);
        },
      }),
    MailHostBlockedError,
  );
  assertEquals(attempted, false, "not even a TCP SYN may reach a blocked address");
  assertEquals((err as MailHostBlockedError).code, "host_not_allowed");
  // The thrown message is what the model and the user actually read, because
  // every connect site in index.ts reports it verbatim under provider_error.
  assert(err.message.includes("private or internal network"), err.message);
  assert(err.message.includes("retrying will not help"), err.message);
});

Deno.test("a refused port never opens a socket either", async () => {
  clearValidationCacheForTests();
  const err = await assertRejects(
    () =>
      connectGuardedTcp({
        host: "imap.gmail.com",
        port: 22,
        protocol: "imap",
        lookup: publicLookup,
        connect: () => Promise.reject(new Error("must not be reached")),
      }),
    MailHostBlockedError,
  );
  assertEquals((err as MailHostBlockedError).code, "port_not_allowed");
});

Deno.test("the post-connect backstop closes a socket that landed somewhere blocked", async () => {
  clearValidationCacheForTests();
  // The verdict says one thing and the kernel did another. Cannot happen with a
  // pinned literal; it is the safety net for the degraded resolver path, and it
  // must close the socket without speaking on it.
  const landed = fakeConn("169.254.169.254", 993);
  const err = await assertRejects(
    () =>
      connectGuardedTcp({
        host: "imap.liar.example",
        port: 993,
        protocol: "imap",
        lookup: lookupReturning("142.250.74.101"),
        connect: () => Promise.resolve(landed.conn),
      }),
    MailHostBlockedError,
  );
  assertEquals((err as MailHostBlockedError).code, "host_not_allowed");
  assertEquals(landed.closed, true, "the socket must be closed, not leaked");
});

Deno.test("a failed dial drops the memo so the retry re-resolves", async () => {
  clearValidationCacheForTests();
  let calls = 0;
  const counting: HostLookup = () => {
    calls += 1;
    return Promise.resolve([{ address: "142.250.74.101", family: 4 }]);
  };
  const attempt = () =>
    connectGuardedTcp({
      host: "imap.stale.example",
      port: 993,
      protocol: "imap",
      lookup: counting,
      connect: () => Promise.reject(new Error("ECONNREFUSED")),
    });
  await assertRejects(attempt, Error, "ECONNREFUSED");
  await assertRejects(attempt, Error, "ECONNREFUSED");
  assertEquals(calls, 2, "a pinned address that will not connect may be stale");
});

/* ── The degraded-resolver path ────────────────────────────────────────────
 *
 * If `Deno.resolveDns` is missing from the runtime, or the resolver cannot
 * answer for a reason that is not NXDOMAIN, denying every host would convert a
 * resolver hiccup into a total outage of a paid mail product. The chosen trade
 * is to dial the NAME and let the post-connect check judge the address we
 * actually reached, so nothing is ever SPOKEN to an internal address even
 * though a bare TCP SYN may reach one. These two tests are the whole reason
 * that branch can be trusted.
 */
const resolverDown: HostLookup = () => Promise.reject(new Error("Deno.resolveDns is unavailable in this runtime"));

Deno.test("a dead resolver falls back to dialling the name rather than downing the fleet", async () => {
  clearValidationCacheForTests();
  let dialled = "";
  await connectGuardedTcp({
    host: "imap.gmail.com",
    port: 993,
    protocol: "imap",
    lookup: resolverDown,
    resolverState: { unavailable: true },
    connect: (o) => {
      dialled = o.hostname;
      return Promise.resolve(fakeConn("142.250.74.101", o.port).conn);
    },
  });
  assertEquals(dialled, "imap.gmail.com", "with no resolver there is no address to pin");
});

Deno.test("the degraded path still refuses an internal address, without speaking on it", async () => {
  clearValidationCacheForTests();
  const landed = fakeConn("169.254.169.254", 993);
  const err = await assertRejects(
    () =>
      connectGuardedTcp({
        host: "mail.attacker.example",
        port: 993,
        protocol: "imap",
        lookup: resolverDown,
        resolverState: { unavailable: true },
        connect: () => Promise.resolve(landed.conn),
      }),
    MailHostBlockedError,
  );
  assertEquals((err as MailHostBlockedError).code, "host_not_allowed");
  assertEquals(landed.closed, true, "the socket must be closed before a byte is written");
});

Deno.test("a genuine NXDOMAIN is still a refusal, never a fallback dial", async () => {
  clearValidationCacheForTests();
  // The difference between the two branches is `unavailable`, and getting it
  // backwards would turn every typo'd host into an unresolved-name dial.
  await assertRejects(
    () =>
      connectGuardedTcp({
        host: "mail.nonexistent.example",
        port: 993,
        protocol: "imap",
        lookup: lookupFails,
        resolverState: { unavailable: false },
        connect: () => Promise.reject(new Error("must not be reached")),
      }),
    MailHostBlockedError,
  );
});

Deno.test("an IPv6-only host is pinned and dialled as a bare v6 literal", async () => {
  clearValidationCacheForTests();
  let dialled = "";
  await connectGuardedTcp({
    host: "imap.v6only.example",
    port: 993,
    protocol: "imap",
    lookup: lookupReturning("2a00:1450:400f:80d::2005"),
    connect: (o) => {
      dialled = o.hostname;
      return Promise.resolve(fakeConn(o.hostname, o.port).conn);
    },
  });
  // Uncompressed but unbracketed: Deno.connect takes a bare v6 literal, and the
  // backstop has to be able to read back what we dialled.
  assertEquals(dialled, "2a00:1450:400f:80d:0:0:0:2005");
});
