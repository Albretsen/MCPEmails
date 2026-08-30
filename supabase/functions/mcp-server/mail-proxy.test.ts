// ---------------------------------------------------------------------------
// The two ends of the tunnel are in different deployments.
//
// The client half ships inside the edge function; the server half runs on a
// machine that is updated by hand. Nothing forces them to be redeployed
// together, so a silent change to the control-line format would lock the whole
// fleet out of its own proxy, and the symptom would be every send failing at
// once. These tests hold that format still by checking the real client output
// against the real server's verification.
// ---------------------------------------------------------------------------

import { hmacHex } from "../../../mail-proxy/proxy.ts";
import {
  buildProxyControlLine,
  MAIL_PROXY_AUTH_TTL_S,
  MAIL_PROXY_PROTOCOL,
  readMailProxyConfig,
} from "./mail-proxy.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("the client's control line is what the server verifies", async () => {
  const now = 1_756_600_000_000;
  const line = await buildProxyControlLine("203.0.113.9", 465, "shared-secret", now);
  assert(line.endsWith("\n"), "the server reads up to a newline");

  const parts = line.trim().split(" ");
  assert(parts.length === 6, `server expects exactly 6 fields, got ${parts.length}`);
  const [protocol, verb, address, port, expiry, signature] = parts;
  assert(protocol === MAIL_PROXY_PROTOCOL, "protocol tag");
  assert(verb === "CONNECT", "verb");
  assert(address === "203.0.113.9", "destination address is passed through");
  assert(port === "465", "destination port is passed through");

  // The expiry the client stamps must land inside the window the server allows.
  const expected = Math.floor(now / 1000) + MAIL_PROXY_AUTH_TTL_S;
  assert(Number(expiry) === expected, `expiry ${expiry} should be ${expected}`);

  // The signature the server recomputes must be the one the client sent. This
  // is the assertion that actually catches drift: it runs the server's own
  // HMAC over the server's own view of the payload.
  const recomputed = await hmacHex("shared-secret", `${address} ${port} ${expiry}`);
  assert(recomputed === signature, "server-side HMAC must match the client's");
});

Deno.test("the signature is bound to the destination, not just to the secret", async () => {
  const now = 1_756_600_000_000;
  const toMailHost = await buildProxyControlLine("203.0.113.9", 465, "s", now);
  const toSomewhereElse = await buildProxyControlLine("203.0.113.10", 465, "s", now);
  const toAnotherPort = await buildProxyControlLine("203.0.113.9", 587, "s", now);

  const sig = (line: string) => line.trim().split(" ")[5];
  assert(sig(toMailHost) !== sig(toSomewhereElse), "a different host must not reuse a signature");
  assert(sig(toMailHost) !== sig(toAnotherPort), "a different port must not reuse a signature");
});

Deno.test("no proxy is configured unless it is fully configured", () => {
  const env = (values: Record<string, string>) => ({ get: (k: string) => values[k] });

  assert(readMailProxyConfig(env({})) === null, "nothing set means direct sending");
  assert(
    readMailProxyConfig(env({ MAIL_PROXY_HOST: "proxy.example.com" })) === null,
    "a host without a secret must not half-enable the proxy",
  );
  assert(
    readMailProxyConfig(env({ MAIL_PROXY_SECRET: "s" })) === null,
    "a secret without a host must not half-enable the proxy",
  );
  assert(
    readMailProxyConfig(env({ MAIL_PROXY_HOST: "p", MAIL_PROXY_SECRET: "s", MAIL_PROXY_PORT: "not-a-port" })) === null,
    "an unusable port is a misconfiguration, not a default",
  );

  const full = readMailProxyConfig(env({ MAIL_PROXY_HOST: "p", MAIL_PROXY_SECRET: "s" }));
  assert(full?.port === 8443, "the port defaults when the rest is present");
});
