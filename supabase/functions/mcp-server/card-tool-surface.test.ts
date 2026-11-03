// card-tool-surface.ts, and how a per-operation call from the draft card compares
// with the consolidated one. index.ts cannot be imported by a test, so the wiring
// is pinned on its source, as in card-send-path.test.ts.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PER_OPERATION_TOOLS_FIELD, stampToolSurface } from "./card-tool-surface.ts";
import { goneNoteTargetDraftId, noteTargetDraftId } from "./card-activity.ts";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const envelope = () => ({ schema_version: "review-card-v1", card: "draft_editor", draft: { draft_id: "Drafts:1" } });

Deno.test("a draft result from a per-operation name says so", () => {
  for (const name of ["draft_create", "draft_reply", "draft_update", "draft_send", "draft_delete"]) {
    const sc: Record<string, unknown> = envelope();
    stampToolSurface(sc, name);
    assertEquals(sc[PER_OPERATION_TOOLS_FIELD], true, name);
  }
});

Deno.test("a consolidated result is left exactly as it was, and so are the names both surfaces share", () => {
  for (const name of ["draft", "draft_read", "draft_editor_save", "draft_editor_hide", "email_send", "email_compose"]) {
    const sc = envelope();
    stampToolSurface(sc, name);
    assertEquals(JSON.stringify(sc), JSON.stringify(envelope()), name);
  }
});

Deno.test("only an envelope is stamped", () => {
  for (const notCard of [null, undefined, "text", [], { draft_id: "Drafts:1" }]) {
    const copy = JSON.stringify(notCard);
    stampToolSurface(notCard, "draft_send");
    assertEquals(JSON.stringify(notCard), copy);
  }
});

Deno.test("it is stamped at the end of dispatch, by the name the host called, on structuredContent only", () => {
  const start = index.indexOf("await stampCardDiagnostics(toolResult, apiKey.workspace_id, ctx.cardDiagnostics);");
  assert(start > 0);
  const near = index.slice(start, start + 500);
  assertStringIncludes(near, "stampToolSurface(");
  assertStringIncludes(near, ".structuredContent");
  assertStringIncludes(near, "toolName,");
  assert(!near.includes("dispatchName"), "the called name, not the dispatch name: both spellings dispatch alike");
});

Deno.test("draft_send and draft_delete dispatch to the handlers draft{action} does, with the same scopes", () => {
  assertStringIncludes(index, 'if (dispatchName === "draft_send") return await executeSendDraft(rawArgs, apiKey);');
  assertStringIncludes(index, 'if (dispatchName === "draft_delete") return await executeDeleteDraft(rawArgs, apiKey);');
  assertStringIncludes(index, 'legacy: "draft_send",\n        scope: "send:email",');
  assertStringIncludes(index, 'legacy: "draft_delete",\n        scope: "manage:drafts",');
  assertStringIncludes(index, "requiredScope: (action?.scope ?? legacy.requiredScope)");
});

Deno.test("a card send is recognised by base_revision under either spelling, so via_card and the model's note hold", () => {
  // Decided on dispatchName and arguments, never on the name the host called.
  const args = { inbox_id: "i", draft_id: "Drafts:1", base_revision: 3 };
  assertEquals(noteTargetDraftId("draft_send", args, { approvalDispatch: false }), null);
  assertEquals(noteTargetDraftId("draft_send", { inbox_id: "i", draft_id: "Drafts:1" }, { approvalDispatch: false }), "Drafts:1");
  assertEquals(goneNoteTargetDraftId("draft_send", args, { approvalDispatch: false }), null);
  for (const fn of ["executeSendDraft", "executeDeleteDraft"]) {
    const start = index.indexOf(`async function ${fn}(`);
    const body = index.slice(start, index.indexOf("\n}\n", start));
    assertStringIncludes(body, "viaCard: baseRevision !== null && apiKey.internalApprovalDispatch !== true");
    assert(!body.includes("toolName"), `${fn} must not depend on the called name`);
  }
});
