// MAIL_RELAY_LOGINS: single mailbox logins carried by the relay whatever their
// host, for a provider that refuses one account's correct password from our
// address only (2026-11-09).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseRelayLogins, relayLoginListed, resetRelayStateForTests } from "./smtp-relay.ts";

async function withEnv<T>(env: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    resetRelayStateForTests();
  };
  apply(env);
  try {
    return await body();
  } finally {
    apply(previous);
  }
}

Deno.test("parseRelayLogins: commas or whitespace, trimmed, lower-cased, blanks dropped", () => {
  assertEquals([...parseRelayLogins(" A@Example.de, b@example.com\nc@example.net ,, ")], [
    "a@example.de",
    "b@example.com",
    "c@example.net",
  ]);
  assertEquals(parseRelayLogins(undefined).size, 0);
  assertEquals(parseRelayLogins("").size, 0);
});

Deno.test("relayLoginListed: only a listed login, compared without case or spaces", async () => {
  await withEnv(
    { SMTP_RELAY_URL: "http://user:pass@203.0.113.7:3128", SMTP_RELAY_HOSTS: undefined, MAIL_RELAY_LOGINS: "listed@example.de" },
    () => {
      assert(relayLoginListed("listed@example.de"));
      assert(relayLoginListed(" Listed@Example.DE "));
      assert(!relayLoginListed("other@example.de"), "every other mailbox keeps its direct route");
      assert(!relayLoginListed(""));
      assert(!relayLoginListed(null));
    },
  );
});

Deno.test("relayLoginListed: nothing is listed when the secret is unset or no relay is configured", async () => {
  await withEnv({ SMTP_RELAY_URL: "http://user:pass@203.0.113.7:3128", MAIL_RELAY_LOGINS: undefined }, () => {
    assert(!relayLoginListed("listed@example.de"));
  });
  await withEnv({ SMTP_RELAY_URL: undefined, MAIL_RELAY_LOGINS: "listed@example.de" }, () => {
    assert(!relayLoginListed("listed@example.de"), "no relay, nothing to route through");
  });
});
