// ---------------------------------------------------------------------------
// A held draft send is approved AS a recorded copy, and the approved send goes
// out only while the draft still matches it (draft-send-snapshot.ts).
//
// Security review 2026-10-16:
//   F-04-03 the agent queued a draft send, rewrote the draft, and the approved
//           re-run sent the rewritten draft;
//   F-04-04 the approver never saw a draft's body, so data written into it
//           left unseen.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  checkApprovedDraft,
  DRAFT_DIGEST_KEY,
  DRAFT_SNAPSHOT_KEY,
  draftDigest,
  type DraftReadForSnapshot,
  draftSnapshotOf,
  splitApprovedDraftPayload,
  approvedDraftSnapshotFrom,
} from "./draft-send-snapshot.ts";
import { approvedSendRefusalDetail } from "./draft-send-plan.ts";

function draft(overrides: Partial<DraftReadForSnapshot> = {}): DraftReadForSnapshot {
  return {
    subject: "Q3 notes",
    to: ["Partner <partner@example.com>"],
    cc: [],
    bcc: [],
    bodyText: "See you Thursday.",
    bodyHtml: "<p>See you Thursday.</p>",
    attachments: [{ filename: "notes.pdf", size_bytes: 2048, mime_type: "application/pdf" }],
    ...overrides,
  };
}

function carrying(data: string) {
  return { encode: () => [{ filename: "notes.pdf", mime_type: "application/pdf", data }] };
}

Deno.test("the digest is stable for an untouched draft", async () => {
  assertEquals(await draftDigest(draft()), await draftDigest(draft()));
  assert(/^[0-9a-f]{64}$/.test(await draftDigest(draft())));
});

Deno.test("every change an agent could make after queueing changes the digest", async () => {
  const base = await draftDigest(draft());
  const edits: Partial<DraftReadForSnapshot>[] = [
    { bcc: ["drop@evil.example"] },
    { to: ["Partner <partner@example.com>", "drop@evil.example"] },
    { cc: ["drop@evil.example"] },
    { subject: "Q3 notes (updated)" },
    { bodyText: "See you Thursday. Harvested: 4111 1111 1111 1111" },
    { bodyHtml: "<p>See you Thursday.</p><img src=https://evil.example/x>" },
    { attachments: [{ filename: "notes.pdf", size_bytes: 4096, mime_type: "application/pdf" }] },
    { attachments: [] },
    { subjectAbsent: true },
  ];
  for (const edit of edits) {
    assert(await draftDigest(draft(edit)) !== base, `not caught: ${JSON.stringify(edit)}`);
  }
});

Deno.test("a file swapped for one with the same name and size is caught where the bytes are known", async () => {
  const a = await draftDigest(draft({ carried: carrying("AAAA") }));
  const b = await draftDigest(draft({ carried: carrying("BBBB") }));
  assert(a !== b);
});

Deno.test("checkApprovedDraft: only an exact match sends", async () => {
  const digest = await draftDigest(draft());
  assertEquals(checkApprovedDraft(digest, digest), "match");
  assertEquals(checkApprovedDraft(digest, await draftDigest(draft({ bcc: ["x@evil.example"] }))), "changed");
  assertEquals(checkApprovedDraft(digest, null), "changed");
  // An approval with no recorded copy (queued before this check, or forged) is never sent.
  for (const missing of [undefined, null, "", "not-a-digest", 42, "A".repeat(64)]) {
    assertEquals(checkApprovedDraft(missing, digest), "unverified", String(missing));
  }
});

Deno.test("the snapshot carries what the reviewer must see, Bcc and body included", () => {
  const snap = draftSnapshotOf(draft({ bcc: ["drop@evil.example"] }));
  assertEquals(snap.bcc, ["drop@evil.example"]);
  assertEquals(snap.body_text, "See you Thursday.");
  assertEquals(snap.body_html, "<p>See you Thursday.</p>");
  assertEquals(snap.subject, "Q3 notes");
  assertEquals(snap.attachments, [{ filename: "notes.pdf", size_bytes: 2048, mime_type: "application/pdf" }]);
  assertEquals(snap.body_truncated, false);
  // A missing subject is shown as none, not as the "(no subject)" placeholder.
  assertEquals(draftSnapshotOf(draft({ subject: "(no subject)", subjectAbsent: true })).subject, "");
});

Deno.test("a huge body is clipped in the snapshot and flagged, while the digest covers all of it", async () => {
  const long = "x".repeat(70 * 1024);
  const snap = draftSnapshotOf(draft({ bodyText: long }));
  assertEquals(snap.body_truncated, true);
  assert(snap.body_text!.length <= 64 * 1024);
  // Changing only the clipped-off tail still changes the digest.
  assert(await draftDigest(draft({ bodyText: long })) !== await draftDigest(draft({ bodyText: long + "tail" })));
});

Deno.test("the dispatcher hands the tool its arguments and the digest, never the snapshot", () => {
  const payload = {
    action: "send",
    draft_id: "g1",
    inbox_id: "inbox-1",
    base_revision: 0,
    [DRAFT_SNAPSHOT_KEY]: draftSnapshotOf(draft()),
    [DRAFT_DIGEST_KEY]: "b".repeat(64),
  };
  const { args, digest } = splitApprovedDraftPayload(payload);
  assertEquals(args, { action: "send", draft_id: "g1", inbox_id: "inbox-1", base_revision: 0 });
  assertEquals(digest, "b".repeat(64));
  assertEquals(splitApprovedDraftPayload({ draft_id: "g1" }).digest, null);
  assertEquals(approvedDraftSnapshotFrom(payload)?.subject, "Q3 notes");
  assertEquals(approvedDraftSnapshotFrom({ draft_id: "g1" }), null);
});

Deno.test("the approver is told in plain words why an approved draft did not go", () => {
  const changed = approvedSendRefusalDetail("draft_send", "approved_draft_changed")!;
  assert(/changed after this send was approved/.test(changed));
  assert(/Not sent/.test(changed));
  const unverified = approvedSendRefusalDetail("draft_send", "approved_draft_unverified")!;
  assert(/Not sent/.test(unverified));
  assert(!/approved_draft|digest/.test(changed + unverified));
});

Deno.test("index.ts records the snapshot at queue time and checks it before an approved send", async () => {
  // index.ts cannot be imported by a test (it serves on load), so this pins
  // that the helpers tested above are the ones it runs, in the right order.
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const send = src.slice(src.indexOf("async function executeSendDraft("), src.indexOf("async function executeDeleteDraft("));
  const check = send.indexOf("checkApprovedDraft(approved?.draftDigest, await draftDigest(current))");
  const record = send.indexOf("[DRAFT_DIGEST_KEY]: await draftDigest(read)");
  const queue = send.indexOf("{ ...approvalArgs, inbox_id: inbox.id, ...approvalRecord }");
  const providerSend = send.indexOf("sendResult = await gmailSendDraft(inbox, draftId)");
  assert(check > 0 && record > 0 && queue > 0 && providerSend > 0, "all four steps are present");
  assert(check < providerSend, "the approved-content check runs before the provider send");
  assert(record < queue, "the snapshot is recorded before the approval is queued");
  assert(send.includes("if (apiKey.internalApprovalDispatch === true) {"), "the check is keyed on the dispatcher's marker");
  // The digest reaches the re-run from the approval row, never as an argument.
  // The dispatcher re-runs approved operations through its injectable deps
  // (scheduled-send tenancy fix); production uses DEFAULT_SCHEDULED_DISPATCH_DEPS,
  // so the split and the digest-carrying call must live in that default, and
  // the dispatcher must default to it and call it.
  const depsStart = src.indexOf("const DEFAULT_SCHEDULED_DISPATCH_DEPS: ScheduledDispatchDeps = {");
  const deps = src.slice(depsStart, src.indexOf("async function handleScheduledDispatch(", depsStart));
  assert(depsStart > 0 && deps.length > 0, "the default dispatch deps are present");
  const draftBranch = deps.slice(deps.indexOf('if (operation === "draft_send") {'));
  assert(draftBranch.length > 0, "the default re-run has a draft_send branch");
  assert(draftBranch.includes("const { args: draftArgs, digest } = splitApprovedDraftPayload(original);"));
  assert(draftBranch.includes("return executeSendDraft(draftArgs, internalKey, { draftDigest: digest });"));
  const dispatcher = src.slice(src.indexOf("async function handleScheduledDispatch("));
  assert(dispatcher.includes("deps: ScheduledDispatchDeps = DEFAULT_SCHEDULED_DISPATCH_DEPS,"), "production dispatch uses the default deps");
  assert(dispatcher.includes("await deps.runApprovedOperation("), "the approved re-run goes through deps");
  assert(!/approved\s*=\s*\{[^}]*args\[/.test(send), "the digest is never read from the arguments");
});

Deno.test("From, Reply-To and threading headers are in the digest; their folding and file order are not", async () => {
  const threaded = draft({
    headerFrom: ["Owner <owner@example.com>"],
    headerReplyTo: [],
    inReplyTo: "<a@example.com>",
    references: "<root@example.com> <a@example.com>",
    attachments: [
      { filename: "b.pdf", size_bytes: 10, mime_type: "application/pdf" },
      { filename: "a.pdf", size_bytes: 20, mime_type: "application/pdf" },
    ],
  });
  const base = await draftDigest(threaded);
  for (
    const edit of [
      { headerReplyTo: ["drop@evil.example"] },
      { headerFrom: ["Else <else@example.com>"] },
      { inReplyTo: "<b@example.com>" },
      { references: "<root@example.com>" },
    ]
  ) {
    assert(await draftDigest({ ...threaded, ...edit }) !== base, `not caught: ${JSON.stringify(edit)}`);
  }
  assertEquals(await draftDigest({ ...threaded, references: "<root@example.com>\r\n\t<a@example.com>" }), base);
  assertEquals(
    await draftDigest({ ...threaded, attachments: [...threaded.attachments!].reverse() }),
    base,
    "listing order is not a change",
  );
  const files = (order: string[]) => ({
    encode: () => order.map((data) => ({ filename: "f", mime_type: "text/plain", data })),
  });
  assertEquals(
    await draftDigest({ ...threaded, carried: files(["AAAA", "BBBB"]) }),
    await draftDigest({ ...threaded, carried: files(["BBBB", "AAAA"]) }),
  );
  assertEquals(draftSnapshotOf({ ...threaded, headerReplyTo: ["Desk <desk@example.com>"] }).reply_to, ["Desk <desk@example.com>"]);
});
