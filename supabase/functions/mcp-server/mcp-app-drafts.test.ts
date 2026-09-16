// ---------------------------------------------------------------------------
// The draft-editor domain: the §8 envelope, the merge rule, and the four save
// rules.
//
// These target `mcp-app-drafts.ts` rather than `index.ts` for the usual reason:
// `index.ts` calls `Deno.serve` and builds a service-role Supabase client at
// module load, so a test cannot import it. Every dependency the module needs is
// injected, so the guards below run against fakes and no mailbox.
//
// WHAT IS WORTH PINNING HERE, and why each one is:
//
//   * the merge is a SUPERSET with DISJOINT keys — a collision would silently
//     drop one side, and §2a's equivalent test is what caught that risk the
//     first time;
//   * `content` is byte-identical to `jsonOk(payload)` — contract §8 promises
//     `content` is unchanged on every path, and the body must never reach it;
//   * a save on a draft with attachments REFUSES — the failure it prevents is
//     silent: the user sees a successful save and the file is gone from a
//     message they have not sent yet;
//   * a `body_text` save REGENERATES the HTML part — the 2026-09-09
//     `approval_update` bug, where the recipient read the sentence the reviewer
//     had replaced;
//   * omitted fields are KEPT — the whole reason this tool exists rather than
//     `draft{action:"update"}`, which requires `body`.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read mcp-app-drafts.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDraftEditorEnvelope,
  clipDraftBody,
  DRAFT_EDITOR_TOOL_DEFINITIONS,
  DRAFT_EDITOR_TOOL_NAMES,
  type DraftEditorCaller,
  type DraftEditorDeps,
  type DraftEditorProviderInbox,
  draftCardToolResult,
  draftIdIsStable,
  draftProviderBlock,
  draftReceiptEnvelope,
  isDraftEditorToolName,
  type NormalizedDraft,
  type ProviderDraft,
  type ProviderDraftParams,
  readStoredDraft,
  runDraftEditorSave,
  runDraftEditorTool,
  runDraftRead,
  runDraftEditorHide,
} from "./mcp-app-drafts.ts";

const APP_URL = "https://mcpemails.com";

const IMAP_INBOX: DraftEditorProviderInbox = {
  id: "8f1f2a3c-0000-4000-8000-000000000001",
  email_address: "you@example.com",
  display_name: "Asgeir",
  provider: "imap",
  service: null,
  signature_enabled: true,
  signature_text: "--\nAsgeir, MCP Emails",
};

const GMAIL_INBOX: DraftEditorProviderInbox = {
  ...IMAP_INBOX,
  id: "8f1f2a3c-0000-4000-8000-000000000002",
  provider: "gmail",
  signature_enabled: false,
  signature_text: null,
};

const OUTLOOK_INBOX: DraftEditorProviderInbox = {
  ...GMAIL_INBOX,
  id: "8f1f2a3c-0000-4000-8000-000000000003",
  provider: "outlook",
};

function caller(overrides: Partial<DraftEditorCaller> = {}): DraftEditorCaller {
  return {
    id: "key-1",
    workspace_id: "ws-1",
    scopes: ["manage:drafts", "read:email", "send:email"],
    inbox_ids: null,
    ...overrides,
  };
}

function normalized(overrides: Partial<NormalizedDraft> = {}): NormalizedDraft {
  return {
    draft_id: "Drafts:2",
    to: ["a@x.com"],
    cc: [],
    bcc: [],
    subject: "Quarterly numbers",
    body_text: "Here they are.",
    body_html: null,
    attachments: [],
    in_reply_to: null,
    signature_embedded: false,
    last_saved_at: "2026-09-16T10:04:00Z",
    ...overrides,
  };
}

/** A deps bundle with every call recorded, so a "changes nothing" claim is testable. */
function fakeDeps(options: {
  inbox?: DraftEditorProviderInbox;
  stored?: ProviderDraft | null;
  enabled?: boolean;
  resolveFails?: boolean;
  throwOnRead?: boolean;
  throwOnWrite?: string;
  throwOnHide?: string;
} = {}) {
  const writes: { draftId: string; params: ProviderDraftParams }[] = [];
  const hides: { scope: string; workspaceId: string; inboxId: string; hidden: boolean }[] = [];
  const inbox = options.inbox ?? IMAP_INBOX;
  let nextId = 3;
  const deps: DraftEditorDeps = {
    appUrl: APP_URL,
    workspaceEnabled: () => Promise.resolve(options.enabled !== false),
    resolveInbox: () =>
      Promise.resolve(
        options.resolveFails
          ? { ok: false as const, reason: "not_found" }
          : { ok: true as const, inbox },
      ),
    getDraft: () => {
      if (options.throwOnRead) return Promise.reject(new Error("imap_auth_failed"));
      return Promise.resolve(
        options.stored === undefined
          ? {
            subject: "Quarterly numbers",
            to: ["a@x.com"],
            cc: [],
            bcc: [],
            bodyText: "Here they are.",
            bodyHtml: null,
            attachments: [],
          }
          : options.stored,
      );
    },
    updateDraft: (_inbox, draftId, params) => {
      if (options.throwOnWrite) return Promise.reject(new Error(options.throwOnWrite));
      writes.push({ draftId, params });
      // Mirrors IMAP: a save appends a new message, so the id changes.
      return Promise.resolve({ draft_id: `Drafts:${nextId++}` });
    },
    isValidEmailAddress: (address: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address),
    setDraftEditorHidden: (scope, ids, hidden) => {
      if (options.throwOnHide) return Promise.reject(new Error(options.throwOnHide));
      hides.push({ scope, workspaceId: ids.workspaceId, inboxId: ids.inboxId, hidden });
      return Promise.resolve();
    },
    now: () => Date.parse("2026-09-16T10:04:00Z"),
  };
  return { deps, writes, hides };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The tool surface
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the module defines the §8 tools plus the opt-out", () => {
  // draft_read and draft_editor_save are contract §8; draft_editor_hide is the
  // card's own "hide this" affordance, added 2026-09-16.
  assertEquals(
    [...DRAFT_EDITOR_TOOL_NAMES],
    ["draft_read", "draft_editor_save", "draft_editor_hide"],
  );
  assertEquals(
    DRAFT_EDITOR_TOOL_DEFINITIONS.map((t) => t.name),
    ["draft_read", "draft_editor_save", "draft_editor_hide"],
  );
  for (const name of DRAFT_EDITOR_TOOL_NAMES) assert(isDraftEditorToolName(name), name);
  // Not actions of the consolidated `draft` tool, and not reachable under any
  // name that looks like one. `draft{action:"read"}` must stay unresolvable:
  // these return a whole message body and belong beside approval_review.
  for (const name of ["draft", "draft_update", "draft:read", "read", "Draft_Read", ""]) {
    assert(!isDraftEditorToolName(name), `${name} must not dispatch here`);
  }
  assertEquals(runDraftEditorTool("draft_update", fakeDeps().deps, caller(), {}), null);
});

Deno.test("every tool requires manage:drafts and refuses unknown arguments", () => {
  // `draft_editor_hide` is on the same scope as the other two on purpose: it
  // changes how a draft is DISPLAYED, and that cannot sensibly be harder to do
  // than rewriting the draft's entire body, which manage:drafts already allows.
  const REQUIRED: Record<string, string[]> = {
    draft_read: ["draft_id"],
    draft_editor_save: ["draft_id"],
    draft_editor_hide: ["scope"],
  };
  for (const definition of DRAFT_EDITOR_TOOL_DEFINITIONS) {
    assertEquals(definition.requiredScope, "manage:drafts", definition.name);
    // No altScopes: an OR here would be a way in for a key that holds neither.
    assertEquals(definition.altScopes, undefined, definition.name);
    const schema = definition.inputSchema as Record<string, unknown>;
    assertEquals(schema.additionalProperties, false, definition.name);
    assertEquals(schema.required, REQUIRED[definition.name], definition.name);
  }
  // There is deliberately NO body_html argument: the editor is a plain-text
  // surface, and a card that could write arbitrary HTML into outgoing mail is a
  // strictly larger thing than this feature needs to be.
  const save = DRAFT_EDITOR_TOOL_DEFINITIONS[1].inputSchema as {
    properties: Record<string, unknown>;
  };
  assert(!("body_html" in save.properties), "body_html must not be accepted");
  assert(!("include_signature" in save.properties), "a signature is never applied here");
});

Deno.test("draft_read is annotated read-only and neither tool is open-world", () => {
  const [read, save] = DRAFT_EDITOR_TOOL_DEFINITIONS;
  assertEquals(read.annotations?.readOnlyHint, true);
  assertEquals(read.annotations?.destructiveHint, false);
  assertEquals(read.annotations?.openWorldHint, false);
  assertEquals(save.annotations?.readOnlyHint, false);
  // It overwrites an unsent draft, which draft{action:"update"} already does,
  // and it transmits nothing.
  assertEquals(save.annotations?.destructiveHint, false);
  assertEquals(save.annotations?.openWorldHint, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The envelope (contract §8)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the envelope carries exactly the §8 top-level keys", () => {
  const envelope = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized(),
    inbox: IMAP_INBOX,
    origin: "read",
    lastSavedBy: "agent",
    canSend: true,
  });
  assertEquals(
    Object.keys(envelope).sort(),
    ["actor", "card", "dashboard_url", "draft", "provider", "schema_version", "state"],
  );
  assertEquals(envelope.schema_version, "review-card-v1");
  assertEquals(envelope.card, "draft_editor");
  assertEquals(envelope.state, "editing");
  // Absolute, always. `ui/open-link` requires it and the card must hold no
  // origin of its own — it ships inside the edge function.
  assertEquals(envelope.dashboard_url, "https://mcpemails.com/dashboard");
  assertEquals(envelope.actor, { can_edit: true, reason: null });
});

Deno.test("the draft block carries every §8 field, bcc included", () => {
  const envelope = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized({ cc: ["c@x.com"], bcc: ["b@x.com"], signature_embedded: true }),
    inbox: IMAP_INBOX,
    origin: "save",
    lastSavedBy: "user",
    canSend: true,
  });
  const draft = envelope.draft as Record<string, unknown>;
  assertEquals(
    Object.keys(draft).sort(),
    [
      "attachments",
      "body",
      "can_send",
      "draft_id",
      "id_is_stable",
      "identity",
      "in_reply_to",
      "last_saved_at",
      "last_saved_by",
      "origin",
      "recipients",
      "signature",
      "subject",
    ],
  );
  // The FULL bcc list, unlike §2's bcc_count: this is the author's own compose
  // surface, and hiding their own bcc would make the editor lie about what it
  // is about to send.
  assertEquals(draft.recipients, { to: ["a@x.com"], cc: ["c@x.com"], bcc: ["b@x.com"] });
  assertEquals(draft.last_saved_by, "user");
  assertEquals(draft.origin, "save");
  assertEquals(draft.signature, { embedded: true });
  assertEquals(draft.identity, {
    inbox_id: IMAP_INBOX.id,
    email_address: "you@example.com",
    display_name: "Asgeir",
    provider: "imap",
    service: null,
  });
});

Deno.test("id_is_stable is false on IMAP and true on the two API providers", () => {
  assertEquals(draftIdIsStable("imap"), false);
  assertEquals(draftIdIsStable(null), false);
  assertEquals(draftIdIsStable("gmail"), true);
  assertEquals(draftIdIsStable("outlook"), true);
  // The most consequential field in the envelope: on IMAP a save APPENDs a new
  // message and expunges the old one, so the id the card was holding is dead
  // the moment it saves. Verified live on demo@ 2026-09-16.
  const imap = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized(),
    inbox: IMAP_INBOX,
    origin: "save",
    lastSavedBy: "user",
    canSend: false,
  });
  assertEquals((imap.draft as Record<string, unknown>).id_is_stable, false);
});

Deno.test("the provider block names the transport and the save route", () => {
  // The labels match sendProviderBlock's, so a user who sees both cards in one
  // conversation reads the same words for the same account. The ROUTES differ
  // on purpose: this block describes how a save lands, not how a send would.
  assertEquals(draftProviderBlock("imap").label, "IMAP + SMTP");
  assertEquals(draftProviderBlock("imap").route, "APPEND to Drafts");
  assertEquals(draftProviderBlock("gmail").label, "Gmail API");
  assertEquals(draftProviderBlock("gmail").route, "users.drafts.update");
  assertEquals(draftProviderBlock("outlook").label, "Microsoft Graph");
  assertEquals(draftProviderBlock("outlook").route, "PATCH /me/messages/{id}");
  // Only IMAP has something a person editing in the card can be surprised by.
  assertEquals(draftProviderBlock("gmail").caveats, []);
  assertEquals(draftProviderBlock("outlook").caveats, []);
  assertEquals(draftProviderBlock("imap").caveats.length, 1);
});

Deno.test("subjects, recipients and filenames are neutralised; the body is not", () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE in a filename is the headline case:
  // `invoice<U+202E>fdp.exe` renders as `invoiceexe.pdf`. A reply draft's
  // subject comes off a stranger's headers, so it gets the same treatment.
  // The body deliberately does NOT: bidi controls are legitimate in Hebrew,
  // Arabic, Persian and Urdu prose.
  const envelope = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized({
      subject: "Re: pay‮me",
      to: ["a‮b@x.com"],
      body_text: "שלום ‮ world",
      attachments: [{ filename: "invoice‮fdp.exe", size_bytes: 12, mime_type: "text/x" }],
    }),
    inbox: IMAP_INBOX,
    origin: "read",
    lastSavedBy: "agent",
    canSend: true,
  });
  const draft = envelope.draft as Record<string, any>;
  assert(!String(draft.subject).includes("‮"), "subject must be neutralised");
  assert(!String(draft.recipients.to[0]).includes("‮"), "recipients must be neutralised");
  assert(!String(draft.attachments[0].filename).includes("‮"), "filenames must be neutralised");
  assert(String(draft.body.text).includes("‮"), "the body must be left alone");
});

Deno.test("bodies are clipped at 64 KB and the clip is flagged", () => {
  const short = clipDraftBody("hello");
  assertEquals(short, { value: "hello", truncated: false });
  assertEquals(clipDraftBody(""), { value: null, truncated: false });
  assertEquals(clipDraftBody(undefined), { value: null, truncated: false });

  const big = "é".repeat(64 * 1024); // 2 bytes each: comfortably over the cap.
  const clipped = clipDraftBody(big);
  assert(clipped.truncated, "an oversized body must be flagged");
  assert(new TextEncoder().encode(clipped.value!).length <= 64 * 1024, "clipped to 64 KB");
  // Never a replacement character: the clip lands mid-sequence and the trailing
  // partial character is dropped rather than rendered as U+FFFD.
  assert(!clipped.value!.endsWith("�"), "no replacement character at the clip");

  const envelope = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized({ body_text: big }),
    inbox: IMAP_INBOX,
    origin: "read",
    lastSavedBy: "agent",
    canSend: false,
  });
  assertEquals((envelope.draft as any).body.truncated, true);
});

Deno.test("a receipt is a §4 envelope, and a discard maps to state cancelled", () => {
  const sent = draftReceiptEnvelope({
    outcome: "sent",
    headline: "Sent.",
    detail: "Delivered.",
    affected_count: 1,
    dashboard_url: `${APP_URL}/dashboard`,
    error_code: null,
  });
  assertEquals(sent.card, "receipt");
  assertEquals(sent.state, "sent");
  // `can_decide`, not `can_edit`: this is the same receipt shape the outbound
  // and bulk cards already produce, and the card reads one field for all three.
  assertEquals(sent.actor, { can_decide: false, reason: null });

  const discarded = draftReceiptEnvelope({
    outcome: "discarded",
    headline: "Discarded.",
    detail: "Nothing was sent.",
    affected_count: 1,
    dashboard_url: `${APP_URL}/dashboard`,
    error_code: null,
  });
  // §1's `state` enum has no "discarded"; the finer word lives on the receipt.
  assertEquals(discarded.state, "cancelled");
  assertEquals((discarded.receipt as Record<string, unknown>).outcome, "discarded");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The merge (contract §8's create/reply/update rows, §2a's rule)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the merge is a superset and the two key sets are disjoint", () => {
  // A collision would silently drop one side. The draft payload's keys are a
  // published output contract that callers already read off structuredContent,
  // so neither side may grow into the other's namespace.
  const payload = {
    draft_id: "Drafts:2",
    subject: "Quarterly numbers",
    to: [{ name: "", email: "a@x.com" }],
    created_at: "2026-09-16T10:04:00Z",
    untrusted_content: true,
  };
  const envelope = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized(),
    inbox: IMAP_INBOX,
    origin: "create",
    lastSavedBy: "agent",
    canSend: true,
  });
  for (const key of Object.keys(payload)) {
    assert(!(key in envelope), `${key} collides: the envelope must not carry it`);
  }
  const merged = draftCardToolResult(payload, envelope).structuredContent;
  assertEquals(
    Object.keys(merged).length,
    Object.keys(payload).length + Object.keys(envelope).length,
    "the merged object must be exactly the sum of both key counts",
  );
  // And the published keys still read exactly where callers already find them.
  assertEquals(merged.draft_id, "Drafts:2");
  assertEquals(merged.untrusted_content, true);
});

Deno.test("a receipt merge over the send and delete payloads is disjoint too", () => {
  const receipt = draftReceiptEnvelope({
    outcome: "sent",
    headline: "Sent.",
    detail: "Delivered.",
    affected_count: 1,
    dashboard_url: `${APP_URL}/dashboard`,
    error_code: null,
  });
  for (
    const payload of [
      { draft_id: "Drafts:2", message_id: "m-1", sent_at: "2026-09-16T10:04:00Z" },
      { draft_id: "Drafts:2", deleted: true },
    ]
  ) {
    for (const key of Object.keys(payload)) {
      assert(!(key in receipt), `${key} collides with the receipt envelope`);
    }
    const merged = draftCardToolResult(payload, receipt).structuredContent;
    assertEquals(
      Object.keys(merged).length,
      Object.keys(payload).length + Object.keys(receipt).length,
    );
  }
});

Deno.test("content is byte-identical to jsonOk's, and never carries the body", () => {
  // Contract §8: `content` is unchanged on every path. This is what makes §7's
  // claim that no new information reaches the model literally true rather than
  // approximately true, so it is compared as bytes.
  const payload = { draft_id: "Drafts:2", subject: "Quarterly numbers", untrusted_content: true };
  const envelope = buildDraftEditorEnvelope({
    appUrl: APP_URL,
    draft: normalized({ body_text: "SECRET-BODY-TEXT" }),
    inbox: IMAP_INBOX,
    origin: "update",
    lastSavedBy: "agent",
    canSend: true,
  });
  const withCard = draftCardToolResult(payload, envelope);
  const without = draftCardToolResult(payload, null);
  assertEquals(withCard.content[0].text, JSON.stringify(payload), "compact, exactly as jsonOk");
  assertEquals(withCard.content[0].text, without.content[0].text, "the card changes no bytes");
  assert(!withCard.content[0].text.includes("SECRET-BODY-TEXT"), "the body must not reach content");
  // The failure rule: a null envelope degrades to exactly the old payload.
  assertEquals(without.structuredContent, payload);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. readStoredDraft
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("readStoredDraft normalises a provider draft and reports nothing extra", async () => {
  const { deps } = fakeDeps({
    stored: {
      subject: "Quarterly numbers",
      to: ["a@x.com"],
      cc: ["c@x.com"],
      bcc: ["b@x.com"],
      bodyText: "Here they are.\n--\nAsgeir, MCP Emails",
      bodyHtml: "<p>Here they are.</p>",
      attachments: [{ filename: "q3.pdf", size_bytes: 184320, mime_type: "application/pdf" }],
      inReplyTo: "<abc@mail>",
      references: "<abc@mail>",
      threadId: "t-1",
    },
  });
  const draft = await readStoredDraft(deps, IMAP_INBOX, "Drafts:2");
  assertEquals(draft!.subject, "Quarterly numbers");
  assertEquals(draft!.bcc, ["b@x.com"]);
  assertEquals(draft!.attachments.length, 1);
  // The signature heuristic: the stored text carries the inbox's signature, so
  // the card can say so and nothing re-applies one.
  assertEquals(draft!.signature_embedded, true);
  // A stored draft carries only the RFC In-Reply-To header, which is not a
  // server message id, and §8 specifies this field as one ("INBOX:42"). Null
  // rather than something the card would offer as openable and could not open.
  assertEquals(draft!.in_reply_to, null);
  // The headers are still carried, so a save keeps the reply in its thread.
  assertEquals(draft!.in_reply_to_header, "<abc@mail>");
  assertEquals(draft!.thread_id, "t-1");
});

Deno.test("readStoredDraft returns null for a draft the provider does not have", async () => {
  const { deps } = fakeDeps({ stored: null });
  assertEquals(await readStoredDraft(deps, IMAP_INBOX, "Drafts:99"), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Guards
// ═══════════════════════════════════════════════════════════════════════════

/** Every failure is an envelope the card can render, never a JSON-RPC error. */
function failureCode(result: { result: { structuredContent?: Record<string, unknown> } }): string {
  const envelope = result.result.structuredContent as Record<string, any>;
  assertEquals(envelope.schema_version, "review-card-v1");
  assertEquals(envelope.card, "receipt");
  return String(envelope.receipt.error_code);
}

Deno.test("draft_read needs read:email as well as manage:drafts", async () => {
  const { deps } = fakeDeps();
  const denied = await runDraftRead(deps, caller({ scopes: ["manage:drafts"] }), {
    draft_id: "Drafts:2",
  });
  assertEquals(failureCode(denied), "insufficient_scope");
  assertEquals(denied.result.isError, true);
  assertEquals(denied.logErrorCode, "scope_denied");

  // The save does NOT need it: it writes a body the caller supplied rather than
  // returning one it read.
  const { deps: saveDeps, writes } = fakeDeps();
  const ok = await runDraftEditorSave(saveDeps, caller({ scopes: ["manage:drafts"] }), {
    draft_id: "Drafts:2",
    subject: "New subject",
  });
  assertEquals(ok.result.isError, false);
  assertEquals(writes.length, 1);
});

Deno.test("a workspace without the flag is refused, and nothing is written", async () => {
  const { deps, writes } = fakeDeps({ enabled: false });
  assertEquals(
    failureCode(await runDraftRead(deps, caller(), { draft_id: "Drafts:2" })),
    "draft_editor_disabled",
  );
  const save = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    subject: "New subject",
  });
  assertEquals(failureCode(save), "draft_editor_disabled");
  assertEquals(writes.length, 0, "a closed gate must write nothing");
});

Deno.test("an inbox this key cannot reach fails exactly like a missing one", async () => {
  // Byte-identical, so neither tool can be used as an existence oracle for
  // inboxes or workspaces the caller cannot reach.
  const { deps, writes } = fakeDeps({ resolveFails: true });
  const read = await runDraftRead(deps, caller({ inbox_ids: [] }), { draft_id: "Drafts:2" });
  assertEquals(failureCode(read), "inbox_not_found");
  const save = await runDraftEditorSave(deps, caller({ inbox_ids: [] }), {
    draft_id: "Drafts:2",
    subject: "x",
  });
  assertEquals(failureCode(save), "inbox_not_found");
  assertEquals(
    JSON.stringify(read.result.structuredContent),
    JSON.stringify(save.result.structuredContent),
  );
  assertEquals(writes.length, 0);
});

Deno.test("a missing draft returns draft_not_found rather than a protocol error", async () => {
  const { deps, writes } = fakeDeps({ stored: null });
  assertEquals(
    failureCode(await runDraftRead(deps, caller(), { draft_id: "Drafts:99" })),
    "draft_not_found",
  );
  assertEquals(
    failureCode(
      await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:99", subject: "x" }),
    ),
    "draft_not_found",
  );
  assertEquals(writes.length, 0);
});

Deno.test("a provider failure on the read leaves the draft untouched", async () => {
  const { deps, writes } = fakeDeps({ throwOnRead: true });
  assertEquals(
    failureCode(await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", subject: "x" })),
    "provider_error",
  );
  assertEquals(writes.length, 0);
});

Deno.test("draft_read's content line states facts and never the body", async () => {
  const { deps } = fakeDeps({
    stored: {
      subject: "Quarterly numbers",
      to: ["a@x.com"],
      cc: [],
      bcc: [],
      bodyText: "SECRET-BODY-TEXT here",
      bodyHtml: null,
      attachments: [],
    },
  });
  const result = await runDraftRead(deps, caller(), { draft_id: "Drafts:2" });
  const text = result.result.content[0].text;
  assert(!text.includes("SECRET-BODY-TEXT"), "the body must not reach model context");
  assert(text.includes("Body 2 words"), `word count expected, got: ${text}`);
  // No directive: nothing in this server's tool output tells a model what to do.
  assert(!/\byou (should|must)\b/i.test(text), "no model directives in tool output");
  assertEquals((result.result.structuredContent as any).draft.origin, "read");
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The four save rules
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("RULE: omitted fields are kept, unlike draft{action:\"update\"}", async () => {
  // The whole reason this tool exists. Verified live 2026-09-16: an update with
  // only `subject` is refused with "arguments.body is required", so the editor
  // could not fix a subject line without re-sending the body.
  const { deps, writes } = fakeDeps({
    stored: {
      subject: "Old subject",
      to: ["a@x.com"],
      cc: ["c@x.com"],
      bcc: ["b@x.com"],
      bodyText: "The stored body.",
      bodyHtml: null,
      attachments: [],
    },
  });
  const result = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    subject: "New subject",
  });
  assertEquals(result.result.isError, false);
  assertEquals(writes[0].params.subject, "New subject");
  assertEquals(writes[0].params.body, "The stored body.", "the body must survive a subject edit");
  assertEquals(writes[0].params.to, ["a@x.com"]);
  assertEquals(writes[0].params.cc, ["c@x.com"]);
  assertEquals(writes[0].params.bcc, ["b@x.com"], "an omitted bcc must not be blanked");

  // An explicit empty array still clears, which is the only way to say "remove
  // the Cc" and must not be confused with omission.
  const { deps: d2, writes: w2 } = fakeDeps();
  await runDraftEditorSave(d2, caller(), { draft_id: "Drafts:2", cc: [] });
  assertEquals(w2[0].params.cc, []);
});

Deno.test("RULE: a body_text save regenerates the HTML part from the new text", async () => {
  // The 2026-09-09 approval_update bug, pre-empted: writing the two parts
  // independently left the HTML part carrying the pre-edit wording, most
  // clients render the HTML part, and the recipient read the sentence that had
  // been replaced.
  const { deps, writes } = fakeDeps({
    stored: {
      subject: "s",
      to: ["a@x.com"],
      cc: [],
      bcc: [],
      bodyText: "The old wording.",
      bodyHtml: "<p>The <b>old</b> wording.</p>",
      attachments: [],
    },
  });
  await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "The new wording.\nSecond line & <tag>.",
  });
  const html = writes[0].params.htmlBody!;
  assert(html.includes("The new wording."), "the HTML part must say what the text says");
  assert(!html.includes("old"), "the pre-edit wording must not survive in the HTML part");
  // Escaped, not sanitised: body_text becomes markup only by being escaped, so
  // there is no sanitizer step to get wrong.
  assert(html.includes("&amp;"), "the text must be escaped into the HTML part");
  assert(html.includes("&lt;tag&gt;"), "markup in the text must not become markup");
  assert(html.includes("<br>"), "newlines become <br>");
});

Deno.test("RULE: a text-only draft gains no HTML part, and an HTML-only edit keeps it", async () => {
  // No HTML part stored: a subject or recipient edit must not invent one.
  const { deps, writes } = fakeDeps({
    stored: {
      subject: "s",
      to: ["a@x.com"],
      cc: [],
      bcc: [],
      bodyText: "Plain text only.",
      bodyHtml: null,
      attachments: [],
    },
  });
  await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", body_text: "Still plain." });
  assertEquals(writes[0].params.htmlBody, undefined, "no HTML part may be invented");

  // An HTML part stored and the text untouched: the stored HTML is carried
  // through unchanged, because nothing said it should say something else.
  const { deps: d2, writes: w2 } = fakeDeps({
    stored: {
      subject: "s",
      to: ["a@x.com"],
      cc: [],
      bcc: [],
      bodyText: "Body.",
      bodyHtml: "<p>Rich <b>body</b>.</p>",
      attachments: [],
    },
  });
  await runDraftEditorSave(d2, caller(), { draft_id: "Drafts:2", subject: "New subject" });
  assertEquals(w2[0].params.htmlBody, "<p>Rich <b>body</b>.</p>");
});

Deno.test("RULE: no signature is ever applied", async () => {
  // The text being written is the text the user was shown, and that already
  // carries whatever signature is going out (create and update embed it). A
  // signature applied here would double it in the stored draft, and
  // draft{action:"send"} transmits the stored body verbatim, so it would double
  // it in the delivered mail too.
  const { deps, writes } = fakeDeps({
    inbox: IMAP_INBOX, // signature_enabled: true, with signature text
    stored: {
      subject: "s",
      to: ["a@x.com"],
      cc: [],
      bcc: [],
      bodyText: "Body.\n--\nAsgeir, MCP Emails",
      bodyHtml: null,
      attachments: [],
    },
  });
  const edited = "Edited body.\n--\nAsgeir, MCP Emails";
  await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", body_text: edited });
  assertEquals(writes[0].params.body, edited, "the text is written exactly as given");
  assertEquals(
    writes[0].params.body.split("Asgeir, MCP Emails").length - 1,
    1,
    "the signature must appear exactly once",
  );
});

Deno.test("RULE: a draft with attachments is refused on IMAP and Gmail, allowed on Outlook", async () => {
  // imapUpdateDraft and gmailUpdateDraft rebuild the MIME from parameters and
  // carry no attachment parts, so a save would silently delete the file from a
  // message the user has not sent yet. Outlook's PATCH touches named fields
  // only and leaves attachments alone.
  const stored: ProviderDraft = {
    subject: "s",
    to: ["a@x.com"],
    cc: [],
    bcc: [],
    bodyText: "Body.",
    bodyHtml: null,
    attachments: [{ filename: "q3.pdf", size_bytes: 184320, mime_type: "application/pdf" }],
  };
  for (const inbox of [IMAP_INBOX, GMAIL_INBOX]) {
    const { deps, writes } = fakeDeps({ inbox, stored });
    const refused = await runDraftEditorSave(deps, caller(), {
      draft_id: "Drafts:2",
      body_text: "Edited.",
    });
    assertEquals(failureCode(refused), "draft_has_attachments", String(inbox.provider));
    assertEquals(refused.result.isError, true);
    assertEquals(writes.length, 0, "a refusal must change nothing");
  }

  const { deps, writes } = fakeDeps({ inbox: OUTLOOK_INBOX, stored });
  const allowed = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Edited.",
  });
  assertEquals(allowed.result.isError, false, "Outlook's PATCH preserves attachments");
  assertEquals(writes.length, 1);
});

Deno.test("RULE: an invalid recipient is refused and nothing is written", async () => {
  const { deps, writes } = fakeDeps();
  for (
    const bad of [
      { to: ["not-an-address"] },
      { cc: ["a@x.com", "also bad"] },
      { bcc: [42] },
    ]
  ) {
    const result = await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", ...bad });
    assertEquals(failureCode(result), "invalid_recipients", JSON.stringify(bad));
  }
  assertEquals(writes.length, 0, "an invalid address must change nothing");
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The save's own result
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a save returns the NEW draft_id and says a person wrote it", async () => {
  const { deps } = fakeDeps();
  const result = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Edited.",
  });
  const draft = (result.result.structuredContent as any).draft;
  // On IMAP the save appended a new message; the card must adopt this id.
  assertEquals(draft.draft_id, "Drafts:3");
  assertEquals(draft.id_is_stable, false);
  assertEquals(draft.origin, "save");
  // The tool name is the only signal that a person typed this. Phase 0 Q2 means
  // it is a hint at the same trust level as `visibility`, not a control.
  assertEquals(draft.last_saved_by, "user");
  assertEquals(result.logStatus, "success");
});

Deno.test("can_send needs both send:email and a recipient", async () => {
  const withRecipient: ProviderDraft = {
    subject: "s",
    to: ["a@x.com"],
    cc: [],
    bcc: [],
    bodyText: "b",
    bodyHtml: null,
    attachments: [],
  };
  const { deps } = fakeDeps({ stored: withRecipient });
  const sendable = await runDraftRead(deps, caller(), { draft_id: "Drafts:2" });
  assertEquals((sendable.result.structuredContent as any).draft.can_send, true);

  const noScope = await runDraftRead(
    deps,
    caller({ scopes: ["manage:drafts", "read:email"] }),
    { draft_id: "Drafts:2" },
  );
  assertEquals((noScope.result.structuredContent as any).draft.can_send, false);

  const { deps: empty } = fakeDeps({
    stored: { subject: "s", to: [], cc: [], bcc: [], bodyText: "b", bodyHtml: null, attachments: [] },
  });
  const noRecipient = await runDraftRead(empty, caller(), { draft_id: "Drafts:2" });
  assertEquals((noRecipient.result.structuredContent as any).draft.can_send, false);
});

Deno.test("a save with no editable field is refused before anything is read", async () => {
  const { deps, writes } = fakeDeps();
  const result = await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2" });
  assertEquals(failureCode(result), "invalid_arguments");
  assertEquals(writes.length, 0);

  const noId = await runDraftEditorSave(deps, caller(), { subject: "x" });
  assertEquals(failureCode(noId), "invalid_arguments");
  assertEquals(writes.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// draft_editor_hide — the card's own opt-out
// ═══════════════════════════════════════════════════════════════════════════

const HIDE_CALLER = { id: "k1", workspace_id: "w1", scopes: ["manage:drafts"], inbox_ids: null };

Deno.test("hiding for one inbox writes the inbox, never the workspace", () => {
  return (async () => {
    const { deps, hides } = fakeDeps();
    const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox" });
    assertEquals(out.logStatus, "success");
    assertEquals(out.result.isError, false);
    assertEquals(hides.length, 1, "exactly one write");
    assertEquals(hides[0].scope, "inbox");
    assertEquals(hides[0].hidden, true, "defaults to hiding");
    assertEquals(hides[0].workspaceId, "w1");
  })();
});

Deno.test("hiding for the workspace writes the workspace", async () => {
  const { deps, hides } = fakeDeps();
  await runDraftEditorHide(deps, HIDE_CALLER, { scope: "workspace" });
  assertEquals(hides[0].scope, "workspace");
  assertEquals(hides[0].hidden, true);
});

Deno.test("the same tool turns it back on", async () => {
  // The reversal lives on the surface that did the hiding. A one-way door
  // whose only exit is a settings page nobody knows about is a trap.
  const { deps, hides } = fakeDeps();
  await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox", hidden: false });
  assertEquals(hides[0].hidden, false);
});

Deno.test("scope is required and has no default", async () => {
  // "Hide this" is ambiguous between this mailbox and all of them, and the two
  // are different wishes. The card asks rather than guessing.
  const { deps, hides } = fakeDeps();
  for (const args of [{}, { scope: "everything" }, { scope: "" }, { scope: 1 }]) {
    const out = await runDraftEditorHide(deps, HIDE_CALLER, args);
    assertEquals(out.result.isError, true, JSON.stringify(args));
  }
  assertEquals(hides.length, 0, "nothing written on a bad scope");
});

Deno.test("a non-boolean hidden is refused before anything is written", async () => {
  const { deps, hides } = fakeDeps();
  const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox", hidden: "yes" });
  assertEquals(out.result.isError, true);
  assertEquals(hides.length, 0, "changes nothing");
});

Deno.test("a key that cannot reach the inbox changes nothing", async () => {
  // Same gate as every other draft tool: workspace ownership and the key's
  // inbox allowlist, resolved through resolveInbox.
  const { deps, hides } = fakeDeps({ resolveFails: true });
  const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox" });
  assertEquals(out.result.isError, true);
  assertEquals(hides.length, 0, "no write for an unreachable inbox");
});

Deno.test("a failed write reports failure rather than claiming success", async () => {
  // Reporting success for a write that did not happen would hide the card on
  // screen and show it again on the next turn, which reads as a broken toggle.
  const { deps } = fakeDeps({ throwOnHide: "db down" });
  const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox" });
  assertEquals(out.result.isError, true);
  const env = out.result.structuredContent as Record<string, unknown>;
  assertEquals((env.receipt as Record<string, unknown>).error_code, "provider_error");
});

Deno.test("the result carries no draft body and names where it applied", async () => {
  const { deps } = fakeDeps();
  const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox" });
  const text = (out.result.content as Array<{ text: string }>)[0].text;
  assert(text.includes("hidden"), "says what happened");
  assert(!text.includes("Here they are."), "never echoes a draft body");
  const env = out.result.structuredContent as Record<string, unknown>;
  assertEquals(env.card, "receipt", "the editor is going away, so: a receipt");
});
