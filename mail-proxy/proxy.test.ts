// ---------------------------------------------------------------------------
// The proxy's job is to be boring and hard to misuse.
//
// Everything tested here is a way the box could be turned into something it
// must not be: an open forwarder, a route into its own network, or a service
// that honours a control line someone copied off the wire. The forwarding
// itself is not the risk; the admission check is.
// ---------------------------------------------------------------------------

import { ALLOWED_PORTS, constantTimeEquals, handle, hmacHex, isPublicAddress, PROTOCOL } from "./proxy.ts";

const SECRET = "test-secret-not-a-real-one";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("only submission and IMAP ports may be dialled", () => {
  for (const port of [465, 587, 993, 143]) {
    assert(ALLOWED_PORTS.has(port), `${port} should be reachable`);
  }
  // 25 is the one that would make this box worth stealing.
  assert(!ALLOWED_PORTS.has(25), "port 25 must stay closed");
  for (const port of [22, 80, 443, 3306, 5432, 6379, 8443]) {
    assert(!ALLOWED_PORTS.has(port), `${port} must not be reachable`);
  }
});

Deno.test("private and metadata addresses are refused", () => {
  const blocked = [
    "127.0.0.1", "10.0.0.30", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "169.254.169.254",           // cloud metadata, the classic target
    "100.64.0.1",                // CGNAT
    "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1",          // v4-mapped loopback must not slip through
    "::ffff:10.0.0.30",
  ];
  for (const address of blocked) {
    assert(!isPublicAddress(address), `${address} must be refused`);
  }

  const allowed = ["1.1.1.1", "88.91.160.182", "172.15.0.1", "172.32.0.1", "2a05:d014:61b:270a::1"];
  for (const address of allowed) {
    assert(isPublicAddress(address), `${address} should be allowed`);
  }
});

Deno.test("signature comparison does not short-circuit on content", () => {
  assert(constantTimeEquals("abc", "abc"), "equal strings match");
  assert(!constantTimeEquals("abc", "abd"), "differing last byte fails");
  assert(!constantTimeEquals("abc", "abcd"), "differing length fails");
});

/** Drive one real connection against the handler and collect its reply. */
async function askProxy(line: string): Promise<string> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const served = (async () => {
    for await (const conn of listener) {
      await handle(conn, SECRET);
      break;
    }
  })();

  const client = await Deno.connect({ hostname: "127.0.0.1", port });
  await client.write(new TextEncoder().encode(line));
  const buf = new Uint8Array(256);
  const n = await client.read(buf);
  const reply = n ? new TextDecoder().decode(buf.subarray(0, n)).trim() : "(closed)";
  try { client.close(); } catch { /* handler may have closed it */ }
  // The loop above already dropped the listener when it broke; closing a second
  // time is what "Bad resource ID" means here, not a real failure.
  try { listener.close(); } catch { /* already released */ }
  await served;
  return reply;
}

async function signedLine(
  address: string,
  port: number,
  offsetS = 60,
  secret = SECRET,
): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + offsetS;
  const payload = `${address} ${port} ${expiry}`;
  return `${PROTOCOL} CONNECT ${payload} ${await hmacHex(secret, payload)}\n`;
}

Deno.test("a control line signed with the wrong secret is refused", async () => {
  const reply = await askProxy(await signedLine("1.1.1.1", 465, 60, "wrong-secret"));
  assert(reply === "ERR unauthorized", `expected unauthorized, got ${reply}`);
});

Deno.test("an unsigned or malformed control line is refused", async () => {
  assert(await askProxy("CONNECT 1.1.1.1 465\n") === "ERR bad_control_line", "no protocol tag");
  assert(await askProxy("GET / HTTP/1.1\n") === "ERR bad_control_line", "a stray HTTP probe");
});

Deno.test("a captured control line stops working once it expires", async () => {
  // Correctly signed, but for a moment that has passed: replaying what someone
  // read off the wire must not open a tunnel.
  const reply = await askProxy(await signedLine("1.1.1.1", 465, -1));
  assert(reply === "ERR expired", `expected expired, got ${reply}`);
});

Deno.test("a valid signature cannot reach a forbidden port or a private address", async () => {
  // These lines are properly authenticated. Holding the secret is not enough.
  assert(await askProxy(await signedLine("1.1.1.1", 25)) === "ERR port_not_allowed", "port 25 via a good signature");
  assert(await askProxy(await signedLine("1.1.1.1", 22)) === "ERR port_not_allowed", "SSH via a good signature");
  assert(
    await askProxy(await signedLine("169.254.169.254", 465)) === "ERR address_not_allowed",
    "cloud metadata via a good signature",
  );
  assert(
    await askProxy(await signedLine("127.0.0.1", 465)) === "ERR address_not_allowed",
    "loopback via a good signature",
  );
});
