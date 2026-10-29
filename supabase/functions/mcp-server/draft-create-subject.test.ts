// ---------------------------------------------------------------------------
// draft-create-subject.test.ts — `draft{action:"create"}` with no subject
// (2026-10-17), through the real handler over the fake Gmail network.
//
// The draft card saves and sends a draft with an empty subject, and the model's
// create refused one ("arguments.subject is required"), so "draft this, I'll
// fill in the subject later" failed only on the model's side. Omitted and blank
// now both store an empty subject; a subject that is given still faces the
// header-line limit. The schema half is in argument-shape-audit.test.ts.
//
// Every mailbox and address here is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { API_KEY, executeCreateDraft, inboxRow, json, type ProviderCall, runTool } from "./provider-call-harness.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// deno-lint-ignore no-explicit-any
type Outcome = { result: any; logStatus: string; logErrorCode: string | null };

/** The raw MIME a Gmail drafts.create was handed. */
function storedRaw(call: ProviderCall): string {
  const raw = (JSON.parse(call.body!) as { message: { raw: string } }).message.raw;
  return atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
}

function createOn(args: Record<string, unknown>) {
  return async () => {
    const inbox = await inboxRow("gmail");
    return await runTool(inbox, (call) => {
      if (call.method === "POST" && call.url === `${GMAIL}/drafts`) return json({ id: "d1", message: { id: "m1" } });
      return json({}, 500);
    }, () => executeCreateDraft(args, API_KEY) as Promise<Outcome>);
  };
}

for (const [label, args] of [
  ["omitted", { to: ["kunde@example.com"], body: "Hallo" }],
  ["empty", { to: ["kunde@example.com"], subject: "", body: "Hallo" }],
  ["blank", { to: ["kunde@example.com"], subject: "   ", body: "Hallo" }],
] as const) {
  Deno.test(`draft_create with the subject ${label} stores a draft with an empty subject`, async () => {
    const { value, world } = await createOn(args)();
    assertEquals(value.logStatus, "success", JSON.stringify(value.result));
    assert(!value.result.isError, JSON.stringify(value.result));
    const create = world.calls.find((c) => c.method === "POST" && c.url === `${GMAIL}/drafts`);
    assert(create, "the draft was written");
    const headerLine = storedRaw(create).split("\r\n").find((l) => /^Subject:/i.test(l)) ?? "Subject:";
    assertEquals(headerLine.replace(/^Subject:\s*/i, ""), "", "no subject text stored");
  });
}

Deno.test("draft_create with a subject stores it, and an over-long one is still refused", async () => {
  const ok = await createOn({ subject: "Ihr Angebot", body: "Hallo" })();
  assertEquals(ok.value.logStatus, "success");
  assert(storedRaw(ok.world.calls.find((c) => c.method === "POST")!).includes("Subject: Ihr Angebot"));

  const long = await createOn({ subject: "x".repeat(2000), body: "Hallo" })();
  assertEquals(long.value.logStatus, "error");
  assert(String(long.value.result.content[0].text).includes("draft_create: subject must contain at most"));
  assertEquals(long.world.calls.filter((c) => c.method === "POST").length, 0, "nothing written");
});

Deno.test("draft_create still requires a body", async () => {
  const { value, world } = await createOn({ subject: "Ihr Angebot" })();
  assertEquals(value.logStatus, "error");
  assertEquals(value.result.content[0].text, "draft_create: body is required and must be a non-empty string.");
  assertEquals(world.calls.length, 0);
});
