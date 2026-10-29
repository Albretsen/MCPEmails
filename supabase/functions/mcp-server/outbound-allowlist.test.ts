import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  assertOutboundRecipientsAllowed,
  disallowedRecipients,
  OUTBOUND_RECIPIENT_NOT_ALLOWED,
  OutboundRecipientRefusedError,
  parseOutboundAllowlist,
} from "./outbound-allowlist.ts";
import { MessageBuildError, PreTransmissionError } from "./send-stages.ts";
import { graphSendDraft } from "./outlook-graph.ts";
import { sendViaSmtp } from "./smtp-client.ts";

const ENV = "OUTBOUND_RECIPIENT_ALLOWLIST";

async function withAllowlist<T>(value: string | undefined, run: () => Promise<T> | T): Promise<T> {
  const before = Deno.env.get(ENV);
  if (value === undefined) Deno.env.delete(ENV);
  else Deno.env.set(ENV, value);
  try {
    return await run();
  } finally {
    if (before === undefined) Deno.env.delete(ENV);
    else Deno.env.set(ENV, before);
  }
}

Deno.test("allowlist: unset or blank allows every recipient (production)", () => {
  assertEquals(parseOutboundAllowlist(undefined), null);
  assertEquals(parseOutboundAllowlist("  , "), null);
  assertEquals(disallowedRecipients(null, ["anyone@example.com"]), []);
  assertOutboundRecipientsAllowed(["anyone@example.com"], null);
});

Deno.test("allowlist: exact addresses and @domain entries, case-insensitive", () => {
  const list = parseOutboundAllowlist("Staging-A@mcpemails.com, @Example.test");
  assertEquals(
    disallowedRecipients(list, [
      "staging-a@MCPEMAILS.com",
      "Tester <qa@example.test>",
      "staging-b@mcpemails.com",
      "x@sub.example.test",
      "real.customer@gmail.com",
    ]),
    ["staging-b@mcpemails.com", "x@sub.example.test", "real.customer@gmail.com"],
  );
});

Deno.test("allowlist: an address hidden in a display name is checked too, and an unparseable recipient is refused", () => {
  const list = parseOutboundAllowlist("@example.test");
  assertEquals(disallowedRecipients(list, ['"boss@corp.com" <qa@example.test>']), ["boss@corp.com"]);
  assertEquals(disallowedRecipients(list, ["undisclosed-recipients"]), ["undisclosed-recipients"]);
});

Deno.test("allowlist: a refusal is a not-sent MessageBuildError with a clear message", () => {
  const list = parseOutboundAllowlist("@example.test");
  const err = assertThrows(
    () => assertOutboundRecipientsAllowed(["qa@example.test", "cc@gmail.com"], list),
    OutboundRecipientRefusedError,
  );
  assert(err instanceof MessageBuildError && err instanceof PreTransmissionError);
  assert(err.message.startsWith(OUTBOUND_RECIPIENT_NOT_ALLOWED));
  assert(err.message.includes("cc@gmail.com"));
  assert(err.message.includes("OUTBOUND_RECIPIENT_ALLOWLIST"));
  assertEquals(err.refused, ["cc@gmail.com"]);
});

Deno.test("allowlist: SMTP refuses before any connection when a recipient is outside it", async () => {
  await withAllowlist("@example.test", async () => {
    await assertRejects(
      () =>
        sendViaSmtp(
          { host: "127.0.0.1", port: 1, security: "tls", email: "a@example.test", password: "x" },
          { from: "a@example.test", recipients: ["a@example.test", "bcc@gmail.com"], rawMessage: "x" },
        ),
      OutboundRecipientRefusedError,
    );
  });
});

Deno.test("allowlist: Graph reads the draft's recipients and refuses before /send", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(
      JSON.stringify({
        toRecipients: [{ emailAddress: { address: "qa@example.test" } }],
        ccRecipients: [],
        bccRecipients: [{ emailAddress: { address: "hidden@gmail.com" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await withAllowlist("@example.test", async () => {
      await assertRejects(() => graphSendDraft("token", "draft-1"), OutboundRecipientRefusedError, "hidden@gmail.com");
    });
    assertEquals(calls.length, 1);
    assert(calls[0].startsWith("GET ") && !calls[0].includes("/send"));
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("allowlist: unset, Graph /send is the only request (no behaviour change)", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input instanceof Request ? input.url : input)}`);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    await withAllowlist(undefined, async () => {
      const resp = await graphSendDraft("token", "draft-1");
      assertEquals(resp.status, 202);
    });
    assertEquals(calls.length, 1);
    assert(calls[0].startsWith("POST ") && calls[0].endsWith("/send"));
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("allowlist: every Gmail send call in index.ts checks the allowlist first (source scan)", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const functions = source.split(/\n(?=(?:export )?(?:async )?function )/);
  const senders = functions.filter((body) => /"https:\/\/gmail\.googleapis\.com\/[^"]*\/(?:messages|drafts)\/send/.test(body));
  assert(senders.length >= 4, `expected the Gmail send functions, found ${senders.length}`);
  for (const body of senders) {
    const name = /function (\w+)/.exec(body)?.[1];
    const sendAt = body.search(/gmail\.googleapis\.com\/[^"]*\/(?:messages|drafts)\/send/);
    const checkAt = body.indexOf("assertOutboundRecipientsAllowed(");
    assert(checkAt >= 0 && checkAt < sendAt, `${name} sends through Gmail without checking OUTBOUND_RECIPIENT_ALLOWLIST first`);
  }
});
