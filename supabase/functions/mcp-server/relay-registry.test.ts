// ---------------------------------------------------------------------------
// The relay registry and the one relayed retry after a direct failure.
//
// What has to hold:
//
//   - Only failures a different egress address can fix earn the retry. A wrong
//     password retried through the relay is one more failed sign-in against
//     the customer's account and ends the same way.
//   - A host is relayed from then on only when the store ACCEPTS the learning.
//     The store refuses hosts that work directly, so one lucky retry cannot
//     move a big provider onto the relay.
//   - The edge copy and the web copy of the refusal patterns are the same, or a
//     host would be relayed when connected and not when read (or the reverse).
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  configureRelayRegistry,
  isLearnedRelayHost,
  isOriginRefusalText,
  learnRelayHost,
  noteRelayFallbackFailed,
  type RelayRegistryStore,
  refreshLearnedRelayHosts,
  resetRelayRegistryForTests,
} from "./relay-registry.ts";
import { relayRouteFor, resetRelayStateForTests } from "./smtp-relay.ts";
import { relayedTransport, shouldRetrySmtpThroughRelay, SmtpAuthError, SmtpNotSentError } from "./smtp-client.ts";
import { ImapAuthError, ImapConnectionLimitError, shouldRetryImapThroughRelay } from "./imap-client.ts";

async function withRelay<T>(body: () => Promise<T> | T): Promise<T> {
  const previous = { url: Deno.env.get("SMTP_RELAY_URL"), hosts: Deno.env.get("SMTP_RELAY_HOSTS") };
  resetRelayStateForTests();
  resetRelayRegistryForTests();
  Deno.env.set("SMTP_RELAY_URL", "http://user:pass@203.0.113.7:3128");
  Deno.env.delete("SMTP_RELAY_HOSTS");
  try {
    return await body();
  } finally {
    if (previous.url === undefined) Deno.env.delete("SMTP_RELAY_URL");
    else Deno.env.set("SMTP_RELAY_URL", previous.url);
    if (previous.hosts === undefined) Deno.env.delete("SMTP_RELAY_HOSTS");
    else Deno.env.set("SMTP_RELAY_HOSTS", previous.hosts);
    resetRelayStateForTests();
    resetRelayRegistryForTests();
  }
}

function fakeStore(options: { learned?: Array<{ host: string; protocol: "imap" | "smtp" }>; accept?: boolean } = {}) {
  const calls: string[] = [];
  const store: RelayRegistryStore = {
    loadLearned() {
      calls.push("load");
      return Promise.resolve(options.learned ?? []);
    },
    learn(host, protocol) {
      calls.push(`learn ${protocol} ${host}`);
      return Promise.resolve(options.accept ?? true);
    },
    record(event) {
      calls.push(`record ${event.route} ${event.outcome}`);
      return Promise.resolve();
    },
  };
  return { store, calls };
}

/** Let fire-and-forget registry work settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

Deno.test("origin refusal text: the measured cases match, the ordinary refusals do not", () => {
  for (
    const text of [
      "NO [ALERT] Authentication failed.",
      "SMTP RCPT TO <a@b.no> rejected: 550 [ACR04] Amazon AWS IP 44.195.26.28 may not use this server.",
      "535 5.7.0 Authentication disabled due to threshold limitation",
      "550 Service refused, please try later. OFR105_103",
      "554 5.7.1 Client host rejected: listed at zen.spamhaus.org",
    ]
  ) assert(isOriginRefusalText(text), text);
  for (
    const text of [
      "NO [AUTHENTICATIONFAILED] Authentication failed.",
      "535 5.7.8 Error: authentication failed:",
      "NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
      "SMTP RCPT TO <x@sis.uz> rejected: 550 The account or domain may not exist, they may be blacklisted, or missing the proper dns entries.",
    ]
  ) assert(!isOriginRefusalText(text), text);
});

Deno.test("the web connect form and this runtime use the same refusal patterns", async () => {
  const edge = await Deno.readTextFile(new URL("./relay-registry.ts", import.meta.url));
  const web = await Deno.readTextFile(
    new URL("../../../apps/web/src/lib/email/relay-fallback.ts", import.meta.url),
  );
  const patterns = (source: string) => {
    const start = source.indexOf("const ORIGIN_REFUSAL_PATTERN = new RegExp(");
    const end = source.indexOf("].join(", start);
    assert(start >= 0 && end > start, "ORIGIN_REFUSAL_PATTERN not found");
    return source.slice(start, end).replace(/'/g, '"').replace(/\s+/g, "");
  };
  const alert = (source: string) => /\/\\\[ALERT\\\]\/i\.test\(value\) && !\/[^\n]+\/i\.test\(value\)/.exec(source)?.[0];
  assertEquals(patterns(web), patterns(edge));
  assertEquals(alert(web), alert(edge));
});

Deno.test("a learned host is relayed only once the store accepts it", async () => {
  await withRelay(async () => {
    const refused = fakeStore({ accept: false });
    configureRelayRegistry(refused.store);
    learnRelayHost("imap.mail.yahoo.com", "imap", "network blip");
    await settle();
    assertEquals(isLearnedRelayHost("imap.mail.yahoo.com", "imap"), false);
    assertEquals(relayRouteFor("imap.mail.yahoo.com", "imap"), null);

    const accepted = fakeStore({ accept: true });
    configureRelayRegistry(accepted.store);
    learnRelayHost("SMTP.Telstra.com.", "smtp", "SMTP connect timeout");
    await settle();
    assertEquals(accepted.calls, ["learn smtp smtp.telstra.com"]);
    assertEquals(isLearnedRelayHost("smtp.telstra.com", "smtp"), true);
    assertEquals(isLearnedRelayHost("smtp.telstra.com", "imap"), false, "learned per protocol");
    assertEquals(relayRouteFor("smtp.telstra.com", "smtp"), "learned");
  });
});

Deno.test("the learned list is read at most once per refresh interval", async () => {
  await withRelay(async () => {
    const { store, calls } = fakeStore({ learned: [{ host: "mail.allsimple.net", protocol: "imap" }] });
    configureRelayRegistry(store);
    await refreshLearnedRelayHosts(10_000_000);
    await refreshLearnedRelayHosts(10_000_001);
    assertEquals(calls, ["load"]);
    assertEquals(relayRouteFor("mail.allsimple.net", "imap"), "learned");
  });
});

Deno.test("a store that throws leaves the relay working on its lists", async () => {
  await withRelay(async () => {
    configureRelayRegistry({
      loadLearned: () => Promise.reject(new Error("relation does not exist")),
      learn: () => Promise.reject(new Error("nope")),
      record: () => Promise.reject(new Error("nope")),
    });
    await refreshLearnedRelayHosts(10_000_000);
    learnRelayHost("smtp.telstra.com", "smtp", "x");
    await settle();
    assertEquals(relayRouteFor("smtp.telstra.com", "smtp"), null);
    assertEquals(relayRouteFor("smtp.domeneshop.no", "smtp"), "listed");
    assertEquals(relayRouteFor("imap.orange.fr", "imap"), "listed");
  });
});

Deno.test("smtp: what earns the relay retry", async () => {
  await withRelay(() => {
    const host = "smtp.telstra.com";
    const timeout = new SmtpNotSentError("SMTP connect timeout — smtp.telstra.com:465 did not respond", true);
    assert(shouldRetrySmtpThroughRelay(host, timeout), "a submission port that never answered");
    assert(
      shouldRetrySmtpThroughRelay(
        host,
        new SmtpNotSentError("SMTP RCPT TO <a@b.no> rejected: 550 [ACR04] Amazon AWS IP 1.2.3.4 may not use this server", true),
      ),
      "an envelope refusal that names our address",
    );
    assert(
      shouldRetrySmtpThroughRelay(host, new SmtpAuthError("SMTP authentication failed: 535 5.7.0 Authentication disabled due to threshold limitation")),
      "Telenor's refusal after IMAP accepted the same password",
    );

    assert(
      !shouldRetrySmtpThroughRelay(host, new SmtpNotSentError("SMTP RCPT TO <nobody@b.no> rejected: 550 5.1.1 no such user", false)),
      "a recipient that does not exist",
    );
    assert(
      !shouldRetrySmtpThroughRelay(host, new SmtpNotSentError("SMTP RCPT TO <x@y.z> rejected: 452 4.2.2 mailbox full", true)),
      "an envelope refusal that does not name our address",
    );
    assert(!shouldRetrySmtpThroughRelay(host, new SmtpAuthError("SMTP authentication failed: 535 5.7.8 bad")), "a wrong password");
    assert(!shouldRetrySmtpThroughRelay(host, new Error("after DATA: connection reset")), "possibly delivered");
    assert(
      !shouldRetrySmtpThroughRelay(host, new SmtpNotSentError("invalid peer certificate: Expired", true)),
      "a certificate problem the tunnel would reach unchanged",
    );
    assert(!shouldRetrySmtpThroughRelay("smtp.domeneshop.no", timeout), "already relayed: the failure came through it");

    noteRelayFallbackFailed(host, "smtp");
    assert(!shouldRetrySmtpThroughRelay(host, timeout), "a host whose relay retry just failed is left alone");
  });
});

Deno.test("smtp: no relay configured means no retry through it", () => {
  const previous = Deno.env.get("SMTP_RELAY_URL");
  resetRelayStateForTests();
  Deno.env.delete("SMTP_RELAY_URL");
  try {
    assert(!shouldRetrySmtpThroughRelay("smtp.telstra.com", new SmtpNotSentError("SMTP connect timeout", true)));
  } finally {
    if (previous !== undefined) Deno.env.set("SMTP_RELAY_URL", previous);
    resetRelayStateForTests();
  }
});

Deno.test("smtp: a relayed 465 row is submitted on 587, everything else is untouched", () => {
  const base = { host: "smtp.telstra.com", email: "a@b", password: "p" };
  assertEquals(relayedTransport({ ...base, port: 465, security: "tls" }), { ...base, port: 587, security: "starttls" });
  assertEquals(relayedTransport({ ...base, port: 587, security: "starttls" }), { ...base, port: 587, security: "starttls" });
});

Deno.test("imap: what earns the relay retry", async () => {
  await withRelay(() => {
    const host = "mail.allsimple.net";
    assert(shouldRetryImapThroughRelay(host, new Error("IMAP response timeout")), "a server that went quiet");
    assert(shouldRetryImapThroughRelay(host, new Error("Connection refused (os error 61)")), "a refused connection");
    assert(
      shouldRetryImapThroughRelay(host, new ImapAuthError("IMAP authentication failed: NO [ALERT] Authentication failed.")),
      "Orange's refusal of a correct password",
    );

    assert(
      !shouldRetryImapThroughRelay(host, new ImapAuthError("IMAP authentication failed: NO [AUTHENTICATIONFAILED] Authentication failed.")),
      "a wrong password",
    );
    assert(!shouldRetryImapThroughRelay(host, new ImapConnectionLimitError("too many connections")), "the account's own sessions");
    assert(!shouldRetryImapThroughRelay(host, new Error("dns error: failed to lookup address information")), "a name that does not resolve");
    assert(!shouldRetryImapThroughRelay(host, new Error("invalid peer certificate: UnknownIssuer")), "a certificate problem");
    assert(!shouldRetryImapThroughRelay("imap.orange.fr", new Error("IMAP response timeout")), "already relayed");
  });
});
