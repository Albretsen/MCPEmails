// Tests for smtp-client.ts#relayOnlyTransport: a relay-only host is submitted
// on the one port the relay's own host lets out.

import { relayOnlyTransport, type SmtpConfig } from "./smtp-client.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const base: SmtpConfig = {
  host: "smtp.orange.fr",
  port: 465,
  security: "tls",
  email: "nom@orange.fr",
  password: "x",
};
const orangeOnly = (host: string) => host.endsWith("orange.fr");

Deno.test("a relay-only host stored on 465 is submitted on 587 with STARTTLS", () => {
  const out = relayOnlyTransport(base, orangeOnly);
  assertEquals([out.port, out.security], [587, "starttls"], "moved to the port the relay can carry");
  assertEquals([out.host, out.email], [base.host, base.email], "nothing else changes");
});

Deno.test("every other host and port is left exactly as stored", () => {
  const other = { ...base, host: "smtp.domeneshop.no" };
  assertEquals(relayOnlyTransport(other, orangeOnly), other, "a host with a direct fallback keeps 465");
  const already = { ...base, port: 587, security: "starttls" as const };
  assertEquals(relayOnlyTransport(already, orangeOnly), already, "587 is not touched");
  assertEquals(relayOnlyTransport(base, () => false), base, "with no relay configured nothing moves");
});
