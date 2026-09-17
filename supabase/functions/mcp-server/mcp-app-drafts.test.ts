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
  normalizeLineEndings,
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
    user_id: "user-owner",
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
  /** `workspaces.draft_editor_enabled` — our rollout gate. */
  enabled?: boolean;
  /** `workspaces.draft_editor_hidden` — the workspace-wide opt-out. */
  workspaceHidden?: boolean;
  /** `inboxes.draft_editor_hidden` — the per-inbox opt-out. */
  inboxHidden?: boolean;
  /** The workspace role of the human the key belongs to. */
  role?: string | null;
  resolveFails?: boolean;
  throwOnRead?: boolean;
  throwOnWrite?: string;
  throwOnHide?: string;
} = {}) {
  const writes: { draftId: string; params: ProviderDraftParams }[] = [];
  const hides: { scope: string; workspaceId: string; inboxId: string; hidden: boolean }[] = [];
  // Every gate read is recorded, so "the un-hide path does not consult the flag
  // it is clearing" is a testable claim rather than a comment.
  const gateReads: string[] = [];
  const inbox = options.inbox ?? IMAP_INBOX;
  let nextId = 3;
  const deps: DraftEditorDeps = {
    appUrl: APP_URL,
    workspaceGate: () => {
      gateReads.push("workspace");
      return Promise.resolve({
        rolledOut: options.enabled !== false,
        hidden: options.workspaceHidden === true,
      });
    },
    inboxHidden: () => {
      gateReads.push("inbox");
      return Promise.resolve(options.inboxHidden === true);
    },
    workspaceRole: () => {
      gateReads.push("role");
      return Promise.resolve(options.role === undefined ? "owner" : options.role);
    },
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
  return { deps, writes, hides, gateReads };
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

const HIDE_CALLER: DraftEditorCaller = {
  id: "k1",
  workspace_id: "w1",
  scopes: ["manage:drafts"],
  inbox_ids: null,
  user_id: "user-owner",
};

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

// ═══════════════════════════════════════════════════════════════════════════
// NOTHING USER-VISIBLE PROMISES A DASHBOARD CONTROL THAT DOES NOT EXIST
//
// `grep -rni draft_editor apps/web` matches `PATCH /api/workspaces/[id]`,
// `PATCH /api/inboxes/[id]` and the generated types — no screen, no component,
// no locale string. Six strings in this module told the user to "change it in
// the dashboard" anyway, one of them the MODEL-VISIBLE description of
// `draft_editor_hide`: on a tool whose `destructiveHint: false` case rests on
// reversibility, on a submission already rejected once for annotation accuracy.
//
// ── Both of the first attempts at this test had reachable holes ────────────
// The first checked only `definition.description`, so the same promise added
// to a property's `inputSchema` description — equally model-visible, and
// equally what a plugin reviewer reads — passed at 1205/1205. The second
// exercised six results chosen by hand, so adding it to `draftNotFound`'s
// detail passed too. Both are closed by ENUMERATING rather than sampling:
// every string in the definition tree, and every refusal path the module has.
//
// WHEN THE DASHBOARD TOGGLE SHIPS in apps/web, these are the tests to relax —
// deliberately, not by deleting an assertion: change them to require that any
// such promise names a real route.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A mention of a dashboard where there is no business mentioning one.
 *
 * TWO carve-outs, both narrow, and both about the `dashboard_url` field rather
 * than about the draft editor:
 *
 *   * that field's OWN description may describe the link it carries — it is a
 *     real link to a real, signed-in dashboard. Allowed by PATH, so it covers
 *     exactly that one property and nothing else;
 *   * any string may name the identifier `dashboard_url`, because the output
 *     schema has to tell a client what to fall back to.
 *
 * Everything else is banned, and the WORD is banned rather than a phrasing.
 * "change it in the dashboard" was only one of the six strings that shipped;
 * "open your dashboard" or "the dashboard setting" would be exactly as untrue
 * while slipping past a pattern written around the wording that happened to
 * ship. What does not exist is a draft-editor control in the dashboard, and
 * the honest surface for that is silence until one does.
 */
function mentionsDashboard(path: string, text: string): boolean {
  // The `dashboard_url` field describing itself, at any depth.
  if (/(?:^|\.)dashboard_url(?:\.|$)/.test(path)) return false;
  return /dashboard/i.test(text.replace(/\bdashboard_url\b/g, ""));
}

/** Every string anywhere inside `value`, however deeply nested, with its path. */
function everyString(
  value: unknown,
  path = "",
  out: Array<[string, string]> = [],
): Array<[string, string]> {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) {
    value.forEach((item, i) => everyString(item, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      everyString(item, path === "" ? key : `${path}.${key}`, out);
    }
  }
  return out;
}

Deno.test("no string in the advertised tool surface promises a dashboard control", () => {
  // THE WHOLE DEFINITION TREE, not `description` alone. `title`, the
  // `inputSchema` property descriptions, the `outputSchema` descriptions and
  // the annotation titles are all model-visible and all read by a plugin
  // reviewer; the first version of this test looked at one field of the five.
  for (const definition of DRAFT_EDITOR_TOOL_DEFINITIONS) {
    const strings = everyString(definition);
    assert(strings.length > 10, `${definition.name} has almost no strings — the walk failed`);
    // There is no honest reason for this module's advertised surface to
    // mention a dashboard at all until one exists.
    for (const [path, text] of strings) {
      assert(
        !mentionsDashboard(path, text),
        `${definition.name}.${path} mentions a dashboard: ${JSON.stringify(text)}`,
      );
    }
  }
  // Proof the walk reaches past `description`: the schema prose really is in it.
  const read = DRAFT_EDITOR_TOOL_DEFINITIONS.find((d) => d.name === "draft_read")!;
  const paths = everyString(read).map(([path]) => path);
  assert(
    paths.some((p) => p.startsWith("inputSchema.")),
    `the walk never reached inputSchema: ${paths.join(",")}`,
  );
  assert(paths.some((p) => p.startsWith("outputSchema.")), "the walk never reached outputSchema");
  assert(paths.includes("annotations.title"), "the walk never reached the annotations");

  // And the fact the copy rests on, so this starts failing the moment a screen
  // does appear and the copy can honestly be widened again.
  const source = Deno.readTextFileSync(new URL("./mcp-app-drafts.ts", import.meta.url));
  assert(
    source.includes("draft_editor_hide again with"),
    "the tool's own reversal is what the copy offers instead",
  );
});

// ── Every outcome this module can produce, one scenario per call site ──────
//
// The previous version collected six results chosen by hand, so fifteen
// refusal paths were never reached and a promise added to any of them passed.
// This is the enumeration instead: one entry per `draftFailure` /
// `invalidArgs` / `draftNotFound` call site in the module, plus the success
// envelopes and receipts, driven through the real `runDraftEditorTool`
// dispatcher and walked for EVERY string rather than for three named fields.
//
// `expect` is what each entry must actually land on — the receipt's
// `error_code`, or the envelope's `card` on the success paths. Without it the
// table could look complete while several entries fell through to the same
// branch, which is how a hand-written enumeration rots.
type DraftToolName = "draft_read" | "draft_editor_save" | "draft_editor_hide";

interface OutcomeCase {
  /** The `mcp-app-drafts.ts` construct this reaches, so a failure is locatable. */
  at: string;
  tool: DraftToolName;
  /** The receipt `error_code` this must produce, or null for a success path. */
  expect: string | null;
  options?: Parameters<typeof fakeDeps>[0];
  caller?: DraftEditorCaller;
  args: unknown;
}

const WITH_ATTACHMENT: ProviderDraft = {
  subject: "Quarterly numbers",
  to: ["a@x.com"],
  cc: [],
  bcc: [],
  bodyText: "Here they are.",
  bodyHtml: null,
  attachments: [{ filename: "q3.pdf", mime_type: "application/pdf", size_bytes: 12 }],
};

const USER_VISIBLE_OUTCOMES: OutcomeCase[] = [
  // ── gateDraftTool: four call sites, five detail branches ────────────────
  {
    at: "gate: insufficient_scope",
    tool: "draft_read",
    expect: "insufficient_scope",
    caller: caller({ scopes: ["read:email"] }),
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "gate: inbox_not_found",
    tool: "draft_read",
    expect: "inbox_not_found",
    options: { resolveFails: true },
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "gate: draft_editor_disabled",
    tool: "draft_read",
    expect: "draft_editor_disabled",
    options: { enabled: false },
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "gate: draft_editor_hidden, the workspace branch",
    tool: "draft_read",
    expect: "draft_editor_hidden",
    options: { workspaceHidden: true },
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "gate: draft_editor_hidden, the inbox branch",
    tool: "draft_read",
    expect: "draft_editor_hidden",
    options: { inboxHidden: true },
    args: { draft_id: "Drafts:2" },
  },

  // ── runDraftRead ────────────────────────────────────────────────────────
  { at: "draft_read: draft_id missing", tool: "draft_read", expect: "invalid_arguments", args: {} },
  {
    at: "draft_read: the provider threw",
    tool: "draft_read",
    expect: "provider_error",
    options: { throwOnRead: true },
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "draft_read: no such draft",
    tool: "draft_read",
    expect: "draft_not_found",
    options: { stored: null },
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "draft_read: the editor envelope",
    tool: "draft_read",
    expect: null,
    args: { draft_id: "Drafts:2" },
  },

  // ── runDraftEditorSave ──────────────────────────────────────────────────
  {
    at: "save: draft_id missing",
    tool: "draft_editor_save",
    expect: "invalid_arguments",
    args: { subject: "x" },
  },
  {
    at: "save: nothing to change",
    tool: "draft_editor_save",
    expect: "invalid_arguments",
    args: { draft_id: "Drafts:2" },
  },
  {
    at: "save: subject too long",
    tool: "draft_editor_save",
    expect: "invalid_arguments",
    args: { draft_id: "Drafts:2", subject: "x".repeat(999) },
  },
  {
    at: "save: body_text too long",
    tool: "draft_editor_save",
    expect: "invalid_arguments",
    args: { draft_id: "Drafts:2", body_text: "x".repeat(1_000_001) },
  },
  {
    at: "save: an address that is not one",
    tool: "draft_editor_save",
    expect: "invalid_recipients",
    args: { draft_id: "Drafts:2", to: ["not-an-address"] },
  },
  {
    at: "save: the provider threw on the read",
    tool: "draft_editor_save",
    expect: "provider_error",
    options: { throwOnRead: true },
    args: { draft_id: "Drafts:2", subject: "x" },
  },
  {
    at: "save: no such draft on the read",
    tool: "draft_editor_save",
    expect: "draft_not_found",
    options: { stored: null },
    args: { draft_id: "Drafts:2", subject: "x" },
  },
  {
    at: "save: refuses rather than dropping attachments",
    tool: "draft_editor_save",
    expect: "draft_has_attachments",
    options: { stored: WITH_ATTACHMENT },
    args: { draft_id: "Drafts:2", subject: "x" },
  },
  {
    at: "save: the write said the draft is gone",
    tool: "draft_editor_save",
    expect: "draft_not_found",
    options: { throwOnWrite: "draft_not_found" },
    args: { draft_id: "Drafts:2", subject: "x" },
  },
  {
    at: "save: the write failed",
    tool: "draft_editor_save",
    expect: "provider_error",
    options: { throwOnWrite: "imap_write_failed" },
    args: { draft_id: "Drafts:2", subject: "x" },
  },
  {
    at: "save: the saved envelope",
    tool: "draft_editor_save",
    expect: null,
    args: { draft_id: "Drafts:2", subject: "x" },
  },

  // ── runDraftEditorHide ──────────────────────────────────────────────────
  {
    at: "hide: scope missing or wrong",
    tool: "draft_editor_hide",
    expect: "invalid_arguments",
    caller: HIDE_CALLER,
    args: {},
  },
  {
    at: "hide: hidden is not a boolean",
    tool: "draft_editor_hide",
    expect: "invalid_arguments",
    caller: HIDE_CALLER,
    args: { scope: "inbox", hidden: "yes" },
  },
  {
    at: "hide: a member asking for workspace scope",
    tool: "draft_editor_hide",
    expect: "insufficient_role",
    caller: HIDE_CALLER,
    options: { role: "member" },
    args: { scope: "workspace" },
  },
  {
    at: "hide: the write failed",
    tool: "draft_editor_hide",
    expect: "provider_error",
    caller: HIDE_CALLER,
    options: { throwOnHide: "db down" },
    args: { scope: "inbox" },
  },
  {
    at: "hide: the inbox receipt",
    tool: "draft_editor_hide",
    expect: null,
    caller: HIDE_CALLER,
    args: { scope: "inbox" },
  },
  {
    at: "hide: the workspace receipt",
    tool: "draft_editor_hide",
    expect: null,
    caller: HIDE_CALLER,
    args: { scope: "workspace" },
  },
  {
    at: "hide: the un-hide receipt",
    tool: "draft_editor_hide",
    expect: null,
    caller: HIDE_CALLER,
    args: { scope: "inbox", hidden: false },
  },
];

Deno.test("no refusal and no receipt sends the user to a dashboard control", async () => {
  const offenders: string[] = [];
  for (const testCase of USER_VISIBLE_OUTCOMES) {
    const { deps } = fakeDeps(testCase.options ?? {});
    const run = runDraftEditorTool(
      testCase.tool,
      deps,
      testCase.caller ?? caller(),
      testCase.args,
    );
    assert(run !== null, `${testCase.at}: ${testCase.tool} is not dispatched at all`);
    const out = await run!;

    // The scenario really reached the branch it claims to, so the table cannot
    // look complete while several entries collapse onto one refusal.
    const envelope = out.result.structuredContent as {
      card?: unknown;
      receipt?: { error_code?: unknown };
    };
    const landed = envelope?.receipt?.error_code ?? null;
    assertEquals(landed, testCase.expect, `${testCase.at} landed somewhere else`);
    assertEquals(
      out.result.isError === true,
      testCase.expect !== null,
      `${testCase.at}: isError disagrees with the outcome`,
    );

    // BOTH halves of the result, and ALL of both. The model reads `content`;
    // the CARD renders the envelope, and the hide receipt's way-back sentence
    // — the one that said "or change it in the dashboard" — lives only in the
    // envelope. Reading three named fields is how the last version missed
    // fifteen paths, so this walks whatever is there.
    const strings = everyString(out.result);
    assert(strings.length > 0, `${testCase.at} produced no user-visible string at all`);
    for (const [path, text] of strings) {
      if (mentionsDashboard(path, text)) {
        offenders.push(`${testCase.at} → ${path}: ${JSON.stringify(text)}`);
      }
    }
  }
  // Collected rather than asserted one at a time, so a failure names EVERY
  // string still promising a control that does not exist, not just the first.
  assertEquals(offenders, [], `${offenders.length} user-visible string(s) promise a dashboard`);
});

Deno.test("the enumeration above covers every refusal site in the module", () => {
  // ── THE ONE TEXTUAL CHECK KEPT, AND WHY ──────────────────────────────────
  // Everything else in this pair is behavioural: real dispatcher, real
  // handlers, real strings. But "did I drive EVERY refusal?" is a question
  // about paths NOT taken, and nothing at runtime can answer it — an unreached
  // branch emits nothing to assert on. So the count of refusal constructors in
  // the source is the coverage tripwire.
  //
  // Deliberately the narrowest form: a count. Not a shape, not a projection,
  // not a stripped-comment scan — the three things three rounds of review
  // walked straight through. It never decides whether the code is CORRECT; the
  // test above does that. All it does is fail closed when a refusal path is
  // added or removed, so whoever does that adds the scenario rather than
  // leaving a silent hole. A `return draftFailure(` written inside a comment
  // trips it too: also fail-closed, and the fix is to correct the table.
  const source = Deno.readTextFileSync(new URL("./mcp-app-drafts.ts", import.meta.url));
  const calls =
    source.match(/(?:return|failure:)\s+(?:draftFailure|invalidArgs|draftNotFound)\(/g) ?? [];
  // `invalidArgs` and `draftNotFound` each `return draftFailure(` themselves.
  // They are the funnel, not refusal sites, so they get no scenario of their own.
  const FUNNEL_INTERNAL_CALLS = 2;
  // `gateDraftTool`'s `draft_editor_hidden` refusal is ONE call site with TWO
  // detail branches (workspace-wide vs this inbox), and both are driven.
  const EXTRA_DETAIL_BRANCHES = 1;
  const refusalSites = calls.length - FUNNEL_INTERNAL_CALLS;
  const refusalScenarios = USER_VISIBLE_OUTCOMES.filter((c) => c.expect !== null).length;
  assertEquals(
    refusalScenarios - EXTRA_DETAIL_BRANCHES,
    refusalSites,
    `mcp-app-drafts.ts has ${refusalSites} refusal sites but the table drives ` +
      `${refusalScenarios - EXTRA_DETAIL_BRANCHES} — add the new one to ` +
      "USER_VISIBLE_OUTCOMES so its strings are checked too",
  );
  // The success paths are enumerated too, and are not vacuous.
  assertEquals(
    USER_VISIBLE_OUTCOMES.filter((c) => c.expect === null).length,
    5,
    "the two envelopes and the three hide receipts",
  );
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

// ═══════════════════════════════════════════════════════════════════════════
// 6. The opt-out actually opts out (WS-2, 2026-09-16)
//
// The bug: `gateDraftTool` checked scopes, the inbox and the workspace flag,
// and never looked at the per-inbox opt-out. Only the envelope builders in
// `index.ts` did. So with the card hidden, `draft` correctly lost its
// `_meta.ui` and its envelope while these three app-only tools kept working —
// `draft_read` returned the full decrypted body in a live `card:
// "draft_editor"` envelope and `draft_editor_save` rewrote the draft. Measured
// against production with the demo inbox hidden.
//
// Reachable with no adversary: the card's restore-recovery effect calls
// `draft_read` whenever a cell remounts from storage.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a hidden inbox refuses draft_read, and returns no body", async () => {
  const { deps } = fakeDeps({ inboxHidden: true });
  const out = await runDraftRead(deps, caller(), { draft_id: "Drafts:2" });
  assertEquals(out.result.isError, true);
  assertEquals(failureCode(out), "draft_editor_hidden");
  assertEquals(out.logErrorCode, "draft_editor_hidden");
  // The whole point: no draft_editor envelope, so nothing for a restoring card
  // to render an editor from, and no body anywhere in the response.
  const env = out.result.structuredContent as Record<string, unknown>;
  assertEquals(env.card, "receipt");
  assert(!("draft" in env), "a refused read must carry no draft block");
  const text = (out.result.content as Array<{ text: string }>)[0].text;
  assert(!text.includes("Here they are."), "never echoes the stored body");
});

Deno.test("a workspace-wide opt-out refuses draft_read too", async () => {
  // The workspace opt-out already failed closed through the ANDed gate; this
  // pins that it keeps doing so now that the two flags are returned apart, and
  // that it reports the opt-out code rather than the rollout one.
  const { deps } = fakeDeps({ workspaceHidden: true });
  const out = await runDraftRead(deps, caller(), { draft_id: "Drafts:2" });
  assertEquals(failureCode(out), "draft_editor_hidden");
  assert(
    String((out.result.structuredContent as any).receipt.detail).includes("whole workspace"),
    "names the grain that is off, so the caller knows which scope to reverse",
  );
});

Deno.test("a hidden inbox refuses draft_editor_save and writes nothing", async () => {
  const { deps, writes } = fakeDeps({ inboxHidden: true });
  const out = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Rewritten by whoever asked.",
  });
  assertEquals(out.result.isError, true);
  assertEquals(failureCode(out), "draft_editor_hidden");
  assertEquals(writes.length, 0, "a hidden editor must not touch the draft");
});

// ── draft_editor_hide is the one tool the opt-out does NOT gate ────────────
// It was gated on `hidden === false` — refuse a hide while hidden, allow an
// un-hide — and that was wrong in two ways that are not edge cases. These four
// tests are the round-two correction; the previous pin ("a hidden inbox refuses
// draft_editor_hide{hidden:true}") asserted the behaviour being removed.

Deno.test("a hidden inbox still accepts draft_editor_hide{hidden:true}", async () => {
  // `idempotentHint: true` says repeating the call has no ADDITIONAL effect on
  // the environment. It does not say the second call errors. A caller retrying
  // a timed-out hide is the exact scenario the annotation exists for, and it
  // used to come back `draft_editor_hidden`.
  const { deps, hides } = fakeDeps({ inboxHidden: true });
  const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox" });
  assertEquals(out.result.isError, false, "a repeat hide is not an error");
  assertEquals(hides, [{
    scope: "inbox",
    workspaceId: "w1",
    inboxId: IMAP_INBOX.id,
    hidden: true,
  }], "and it writes the same value, so the state after two calls is the state after one");
});

Deno.test("a hidden INBOX does not block a WORKSPACE-scope hide", async () => {
  // THE BUG. `gateDraftTool` ORs `workspace.hidden || inboxHidden` with no idea
  // which grain was asked for, and `resolveInbox` resolves that same inbox — so
  // with the workspace flag CLEAR and one inbox hidden, a workspace-scope hide
  // was refused with `draft_editor_hidden` and wrote nothing. The caller asked
  // about the workspace and was told about an inbox. For a single-inbox key,
  // which is the modal shape of this product, it was unconditional: hide the
  // one inbox and the workspace switch became unreachable from the tool.
  for (const hidden of [true, false]) {
    const { deps, hides } = fakeDeps({ inboxHidden: true, workspaceHidden: false });
    const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "workspace", hidden });
    assertEquals(out.result.isError, false, `workspace scope, hidden:${hidden}`);
    assertEquals(hides, [{
      scope: "workspace",
      workspaceId: "w1",
      inboxId: IMAP_INBOX.id,
      hidden,
    }]);
  }
});

Deno.test("the hide tool never reads the opt-out it writes, in either direction", async () => {
  // Pinning the ABSENCE of the read, not just the outcome: re-reading the flag
  // here is exactly how both faults were built, and a round-trip test alone
  // would still pass against a fake that happens to return false.
  for (const scope of ["inbox", "workspace"]) {
    for (const hidden of [true, false]) {
      const { deps, gateReads } = fakeDeps({ inboxHidden: true, workspaceHidden: true });
      const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope, hidden });
      assertEquals(out.result.isError, false, `${scope}/${hidden}`);
      assert(
        !gateReads.includes("inbox"),
        `${scope}/${hidden}: the per-inbox opt-out must not gate the tool that writes it`,
      );
    }
  }
});

Deno.test("everything that is not the opt-out still gates the hide tool", async () => {
  // The escape hatch skips condition (4) of `gateDraftTool` and nothing else.
  // Without this, "unconditional allowWhileHidden" could quietly become "this
  // tool is ungated".
  const never = fakeDeps({ enabled: false, inboxHidden: true });
  assertEquals(
    failureCode(await runDraftEditorHide(never.deps, HIDE_CALLER, { scope: "inbox" })),
    "draft_editor_disabled",
    "the rollout gate still refuses, and says so rather than 'you turned it off'",
  );
  assertEquals(never.hides.length, 0);

  const unreachable = fakeDeps({ resolveFails: true, inboxHidden: true });
  assertEquals(
    failureCode(await runDraftEditorHide(unreachable.deps, HIDE_CALLER, { scope: "inbox" })),
    "inbox_not_found",
    "the key's own inbox allowlist still applies",
  );
  assertEquals(unreachable.hides.length, 0);

  const viewer = fakeDeps({ inboxHidden: true });
  assertEquals(
    failureCode(
      await runDraftEditorHide(viewer.deps, { ...HIDE_CALLER, scopes: ["read:email"] }, {
        scope: "inbox",
      }),
    ),
    "insufficient_scope",
    "manage:drafts is still required",
  );
  assertEquals(viewer.hides.length, 0);

  const member = fakeDeps({ role: "member", inboxHidden: true });
  assertEquals(
    failureCode(await runDraftEditorHide(member.deps, HIDE_CALLER, { scope: "workspace" })),
    "insufficient_role",
    "workspace grain is still an owner/admin action",
  );
  assertEquals(member.hides.length, 0);
});

Deno.test("the rollout gate still refuses before the opt-out is even read", async () => {
  // Ordering matters: a workspace that was never rolled out must say so, not
  // leak "you turned it off" for a feature it was never offered.
  const { deps } = fakeDeps({ enabled: false, inboxHidden: true });
  const out = await runDraftRead(deps, caller(), { draft_id: "Drafts:2" });
  assertEquals(failureCode(out), "draft_editor_disabled");
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The opt-out is reversible — it was a one-way door
//
// `workspaceEnabled` returned false when `draft_editor_hidden` was true, and
// `gateDraftTool` called it first, so a workspace-scope hide disabled the tool
// that would undo it. Measured 2026-09-16:
//   hide scope=workspace              -> "hidden for every inbox..."
//   hide scope=workspace hidden=false -> error_code: draft_editor_disabled
// while the tool description, `idempotentHint: true` and the receipt all
// promised a reversal.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("workspace hide -> un-hide round trips", async () => {
  const off = fakeDeps();
  const hidden = await runDraftEditorHide(off.deps, HIDE_CALLER, { scope: "workspace" });
  assertEquals(hidden.result.isError, false);
  assertEquals(off.hides, [{
    scope: "workspace",
    workspaceId: "w1",
    inboxId: IMAP_INBOX.id,
    hidden: true,
  }]);

  // Now the world the first call created: the workspace flag is set.
  const on = fakeDeps({ workspaceHidden: true });
  const shown = await runDraftEditorHide(on.deps, HIDE_CALLER, {
    scope: "workspace",
    hidden: false,
  });
  assertEquals(shown.result.isError, false, "un-hiding must not be gated on the flag it clears");
  assertEquals(on.hides, [{
    scope: "workspace",
    workspaceId: "w1",
    inboxId: IMAP_INBOX.id,
    hidden: false,
  }]);
});

Deno.test("inbox hide -> un-hide round trips", async () => {
  const on = fakeDeps({ inboxHidden: true });
  const shown = await runDraftEditorHide(on.deps, HIDE_CALLER, {
    scope: "inbox",
    hidden: false,
  });
  assertEquals(shown.result.isError, false);
  assertEquals(on.hides[0].hidden, false);
});

Deno.test("the un-hide path never reads the flag it is clearing", async () => {
  // Not decoration: reading it is exactly how the one-way door was built, and a
  // future refactor that re-read it here would rebuild it silently, because the
  // round-trip tests above would still pass against a fake that returns false.
  // Pinning the absence of the read is what catches that.
  const { deps, gateReads } = fakeDeps({ workspaceHidden: true });
  await runDraftEditorHide(deps, HIDE_CALLER, { scope: "workspace", hidden: false });
  assert(!gateReads.includes("inbox"), "the per-inbox opt-out must not gate an un-hide");

  // ...but the ROLLOUT gate still applies. Un-hiding a card the workspace was
  // never offered is not a thing to succeed at.
  const never = fakeDeps({ enabled: false, workspaceHidden: true });
  const out = await runDraftEditorHide(never.deps, HIDE_CALLER, {
    scope: "workspace",
    hidden: false,
  });
  assertEquals(failureCode(out), "draft_editor_disabled");
  assertEquals(never.hides.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Workspace scope is an owner/admin action
//
// `PATCH /api/workspaces/[id]` requires owner or admin to write
// `workspaces.draft_editor_hidden`. The tool required only `manage:drafts`, so
// any member's key — or a prompt-injected model holding one — flipped a
// workspace-wide setting for every colleague through a path the dashboard
// deliberately gates. Inbox scope is unchanged: its blast radius is the
// caller's own mailbox, where "harder to change than the draft itself" would be
// the wrong trade.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a member cannot hide the card for the whole workspace", async () => {
  const { deps, hides } = fakeDeps({ role: "member" });
  const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "workspace" });
  assertEquals(out.result.isError, true);
  assertEquals(failureCode(out), "insufficient_role");
  assertEquals(out.logErrorCode, "insufficient_role");
  assertEquals(hides.length, 0, "nothing written for a member");
  const detail = String((out.result.structuredContent as any).receipt.detail);
  assert(detail.includes('scope:"inbox"'), "names the thing the member CAN do");
});

Deno.test("a member cannot un-hide it for the whole workspace either", async () => {
  // Both directions. Turning the card back on for everybody is as much a
  // decision about other people's screens as turning it off.
  const { deps, hides } = fakeDeps({ role: "member", workspaceHidden: true });
  const out = await runDraftEditorHide(deps, HIDE_CALLER, {
    scope: "workspace",
    hidden: false,
  });
  assertEquals(failureCode(out), "insufficient_role");
  assertEquals(hides.length, 0);
});

Deno.test("a member can still hide and show the card for one inbox", async () => {
  for (const hidden of [true, false]) {
    const { deps, hides, gateReads } = fakeDeps({
      role: "member",
      inboxHidden: hidden === false,
    });
    const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "inbox", hidden });
    assertEquals(out.result.isError, false, `inbox scope, hidden:${hidden}`);
    assertEquals(hides[0].hidden, hidden);
    assert(!gateReads.includes("role"), "inbox scope must not cost a role lookup");
  }
});

Deno.test("owners and admins may change the workspace setting", async () => {
  for (const role of ["owner", "admin"]) {
    const { deps, hides } = fakeDeps({ role });
    const out = await runDraftEditorHide(deps, HIDE_CALLER, { scope: "workspace" });
    assertEquals(out.result.isError, false, role);
    assertEquals(hides[0].scope, "workspace");
  }
});

Deno.test("an unknowable role is refused, not waved through", async () => {
  // `api_keys.created_by` is nullable, and a role lookup can fail. Neither is a
  // reason to let a key change a setting for everybody in the workspace.
  const noUser = fakeDeps();
  const out = await runDraftEditorHide(noUser.deps, { ...HIDE_CALLER, user_id: null }, {
    scope: "workspace",
  });
  assertEquals(failureCode(out), "insufficient_role");
  assertEquals(noUser.hides.length, 0);

  const noRole = fakeDeps({ role: null });
  const out2 = await runDraftEditorHide(noRole.deps, HIDE_CALLER, { scope: "workspace" });
  assertEquals(failureCode(out2), "insufficient_role");
  assertEquals(noRole.hides.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. A line-ending-only body is not a body edit
//
// A `<textarea>` hands its value back as CRLF whatever went in, so a card that
// re-sent an untouched body produced a "changed" body_text. The HTML part was
// then regenerated from `plainTextBodyToHtml` — destroying a rich HTML part —
// and on IMAP the save moved the draft id. Confirmed against production.
// ═══════════════════════════════════════════════════════════════════════════

const RICH_HTML = '<div dir="ltr">Here they are.<br><img src="cid:logo"></div>';

function storedWithHtml(bodyText: string): ProviderDraft {
  return {
    subject: "Quarterly numbers",
    to: ["a@x.com"],
    cc: [],
    bcc: [],
    bodyText,
    bodyHtml: RICH_HTML,
    attachments: [],
  };
}

Deno.test("a CRLF-only difference preserves the stored HTML part", async () => {
  const { deps, writes } = fakeDeps({ stored: storedWithHtml("Line one\nLine two\n") });
  const out = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Line one\r\nLine two\r\n",
  });
  assertEquals(out.result.isError, false);
  assertEquals(writes.length, 1);
  assertEquals(
    writes[0].params.htmlBody,
    RICH_HTML,
    "a line-ending-only body must not regenerate the HTML part",
  );
});

Deno.test("a lone-CR difference is not a body edit either", async () => {
  const { deps, writes } = fakeDeps({ stored: storedWithHtml("Line one\nLine two") });
  await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Line one\rLine two",
  });
  assertEquals(writes[0].params.htmlBody, RICH_HTML);
});

Deno.test("a GENUINE body edit still regenerates the HTML part", async () => {
  // The narrowness is the point. Regenerating on a real edit is contract §6 and
  // §8's deliberate trade — the 2026-09-09 `approval_update` bug, where the
  // recipient read the sentence the reviewer had replaced — and this fix must
  // not have softened it by a single character.
  const { deps, writes } = fakeDeps({ stored: storedWithHtml("Line one\nLine two\n") });
  await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Line one\r\nLine three\r\n",
  });
  const html = String(writes[0].params.htmlBody);
  assert(html !== RICH_HTML, "a real edit must own the HTML part");
  assert(html.includes("Line three"), "the regenerated part says what the user typed");
  assert(!html.includes("Line two"), "and never the wording that was replaced");
});

Deno.test("a subject-only save leaves both body parts exactly as stored", async () => {
  const { deps, writes } = fakeDeps({ stored: storedWithHtml("Line one\nLine two\n") });
  await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", subject: "New subject" });
  assertEquals(writes[0].params.htmlBody, RICH_HTML);
  assertEquals(writes[0].params.body, "Line one\nLine two\n");
});

Deno.test("normalizeLineEndings folds CRLF and lone CR, and nothing else", () => {
  assertEquals(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
  // A trailing-whitespace or spacing difference is a REAL edit: folding it
  // would call a genuine change a no-op and leave a stale HTML part behind.
  assertEquals(normalizeLineEndings("a b"), "a b");
  assertEquals(normalizeLineEndings("a b "), "a b ");
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. A CLEARED body is an edit, and `null` is not `""`
//
// The comparison above was written against `stored.body_text ?? ""`, and that
// coalesce reopened the hole the regeneration rule exists to close. A draft with
// NO text part and an HTML part stores `body_text: null`; the card renders that
// as an empty textarea; a person who types and deletes back to empty sends
// `body_text: ""`. `"" !== ""` is false, so it was classified as an OMITTED body
// and the stored rich HTML was carried through untouched — the user cleared the
// message and it still went out carrying the original wording in the text/html
// part most clients render. A regression from the `typeof bodyText === "string"`
// test the line-ending fix replaced, which got this case right.
// ═══════════════════════════════════════════════════════════════════════════

/** An HTML-only draft: a real shape, and the one the bug needs. */
function storedHtmlOnly(): ProviderDraft {
  return {
    subject: "Quarterly numbers",
    to: ["a@x.com"],
    cc: [],
    bcc: [],
    bodyText: null,
    bodyHtml: RICH_HTML,
    attachments: [],
  };
}

Deno.test("clearing the body of an HTML-only draft drops the stored HTML", async () => {
  const { deps, writes } = fakeDeps({ stored: storedHtmlOnly() });
  const out = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "",
  });
  assertEquals(out.result.isError, false);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].params.body, "", "the text part is what the user left");
  assert(
    writes[0].params.htmlBody !== RICH_HTML,
    "the cleared body must NOT keep sending the wording the user deleted",
  );
  // An empty regeneration is dropped rather than written as an empty
  // `text/html` part: a cleared body should leave a message with no HTML part.
  assertEquals(writes[0].params.htmlBody, undefined);
});

Deno.test("writing a body into an HTML-only draft owns the HTML part too", async () => {
  // The same `null` vs `""` distinction, in the direction that is easy to get
  // right by accident. Pinned so a "fix" that special-cases only the empty
  // string cannot pass.
  const { deps, writes } = fakeDeps({ stored: storedHtmlOnly() });
  await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "Replaced entirely.",
  });
  const html = String(writes[0].params.htmlBody);
  assert(html.includes("Replaced entirely."), "the HTML says what the user typed");
  assert(!html.includes("cid:logo"), "and nothing of the part it replaced");
});

Deno.test("an omitted body_text still leaves an HTML-only draft untouched", async () => {
  // The boundary of the rule above: `null` vs `""` matters only when the caller
  // SENT a body. A subject-only save on the same draft must keep the rich part,
  // or every metadata edit would flatten the message.
  const { deps, writes } = fakeDeps({ stored: storedHtmlOnly() });
  await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", subject: "New subject" });
  assertEquals(writes[0].params.htmlBody, RICH_HTML);
});

Deno.test("an EMPTY stored text part is the same as none, so clearing still drops the HTML", async () => {
  // The other half of the `null` vs `""` bug, and the half the first fix left
  // open. `null` is not the only way a draft arrives with no usable text part:
  // `mime.ts` sets `out.text = decodeCharset(bytes, charset)` for a text/plain
  // part that is PRESENT and EMPTY, so a multipart/alternative with an empty
  // text part parses to `""`, not `null`. Verified 2026-09-17 against a message
  // this server itself builds: `draft{action:"create", body:"",
  // html_body:"<p>…</p>"}` reads back as `body_text: ""`.
  //
  // With the condition written as `stored.body_text === null`, such a draft
  // compared `"" !== ""` — false — so an explicit clear was classified as an
  // OMITTED body and the stored rich HTML was carried through untouched. Same
  // harm as the `?? ""` bug: the user deletes the message and it still goes out
  // carrying the original wording in the text/html part most clients render.
  //
  // The card cannot trigger it (`DraftEditor.tsx` makes an untouched empty
  // textarea produce an empty patch), so only a direct tool call reaches it —
  // but the invariant the comment states is "a stored draft with no text part
  // has nothing for a supplied body to be equal to", and an empty text part is
  // no text part.
  const { deps, writes } = fakeDeps({
    stored: { ...storedHtmlOnly(), bodyText: "" },
  });
  const out = await runDraftEditorSave(deps, caller(), {
    draft_id: "Drafts:2",
    body_text: "",
  });
  assertEquals(out.result.isError, false);
  assertEquals(writes[0].params.body, "");
  assert(
    writes[0].params.htmlBody !== RICH_HTML,
    "an empty stored text part must not make an explicit clear a no-op",
  );
  assertEquals(writes[0].params.htmlBody, undefined);
});

Deno.test("an empty stored text part does not make every save an edit", async () => {
  // The boundary, so the fix above cannot be a blanket "always regenerate".
  // A subject-only save on the same draft still sends no body, so the rich part
  // survives exactly as it does for a `null` text part.
  const { deps, writes } = fakeDeps({
    stored: { ...storedHtmlOnly(), bodyText: "" },
  });
  await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", subject: "New subject" });
  assertEquals(writes[0].params.htmlBody, RICH_HTML);
});

Deno.test("clearing the body of a TEXT draft is an edit too", async () => {
  // Same harm, the ordinary shape: a draft with both parts, emptied. `"" !==
  // "Line one\n..."` so this one was already caught — pinned because the fix
  // touches the expression that decides it.
  const { deps, writes } = fakeDeps({ stored: storedWithHtml("Line one\nLine two\n") });
  await runDraftEditorSave(deps, caller(), { draft_id: "Drafts:2", body_text: "" });
  assertEquals(writes[0].params.body, "");
  assertEquals(writes[0].params.htmlBody, undefined, "no stale HTML, and no empty HTML part");
});
