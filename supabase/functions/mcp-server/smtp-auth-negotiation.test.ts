import {
  advertisedMechanisms,
  isMechanismRejection,
  mechanismOrder,
  type SmtpReply,
} from "./smtp-client.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** The EHLO capability lines as readReply exposes them: "NNN-" already stripped. */
const EXCHANGE = [
  "ex4.mail.ovh.net Hello [203.0.113.7]",
  "SIZE 104857600",
  "AUTH GSSAPI NTLM LOGIN",
  "8BITMIME",
];

function reply(code: number, text: string): SmtpReply {
  return { code, text, lines: [text] };
}

Deno.test("advertisedMechanisms reads both AUTH syntaxes", () => {
  const exchange = advertisedMechanisms(EXCHANGE);
  assertEquals(exchange.has("LOGIN"), true, "Exchange offers LOGIN");
  assertEquals(exchange.has("PLAIN"), false, "Exchange does not offer PLAIN");
  assertEquals(exchange.has("NTLM"), true, "unusable mechanisms are still listed");

  // Some hosts emit the pre-standard "AUTH=" form alongside the RFC 4954 one.
  const legacy = advertisedMechanisms(["AUTH LOGIN PLAIN", "AUTH=LOGIN PLAIN"]);
  assertEquals(legacy.has("PLAIN"), true, "AUTH= form parsed");
  assertEquals(legacy.size, 2, "the two syntaxes collapse to one set");

  assertEquals(advertisedMechanisms(["SIZE 100", "8BITMIME"]).size, 0, "no AUTH line");
  assertEquals(advertisedMechanisms(["AUTH login"]).has("LOGIN"), true, "case-insensitive");
});

Deno.test("mechanismOrder picks what the server will actually take", () => {
  assertEquals(mechanismOrder(advertisedMechanisms(EXCHANGE)).join(","), "LOGIN", "Exchange: LOGIN only");
  assertEquals(
    mechanismOrder(advertisedMechanisms(["AUTH PLAIN LOGIN"])).join(","),
    "PLAIN,LOGIN",
    "PLAIN first when both are offered: one round trip",
  );
  assertEquals(mechanismOrder(advertisedMechanisms(["AUTH PLAIN"])).join(","), "PLAIN", "PLAIN only");
  assertEquals(
    mechanismOrder(advertisedMechanisms(["SIZE 100"])).join(","),
    "PLAIN,LOGIN",
    "no AUTH line: the list is advisory, so try both",
  );
  assertEquals(
    mechanismOrder(advertisedMechanisms(["AUTH GSSAPI NTLM"])).join(","),
    "PLAIN,LOGIN",
    "nothing usable advertised: still worth trying both before giving up",
  );
});

Deno.test("isMechanismRejection separates a refused mechanism from a bad password", () => {
  // What Exchange answers to AUTH PLAIN, and the whole reason for the fallback.
  assertEquals(
    isMechanismRejection(reply(504, "5.7.4 Unrecognized authentication type")),
    true,
    "504 is a refused mechanism",
  );
  assertEquals(isMechanismRejection(reply(534, "5.7.9 mechanism too weak")), true, "534 is a refused mechanism");
  assertEquals(
    isMechanismRejection(reply(535, "5.7.4 Unrecognized authentication type")),
    true,
    "535 carrying 5.7.4 is still about the mechanism",
  );
  // A wrong password must never trigger a second attempt: that would spend two
  // failed logins per connect against the provider's lockout counter.
  assertEquals(
    isMechanismRejection(reply(535, "5.7.3 Authentication unsuccessful")),
    false,
    "535 is a rejected credential",
  );
  assertEquals(isMechanismRejection(reply(235, "2.7.0 ok")), false, "success is not a rejection");
});
