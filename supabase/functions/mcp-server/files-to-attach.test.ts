import { assertEquals } from "jsr:@std/assert@1";
import {
  FILES_TO_ATTACH_MAX_ITEMS,
  FILES_WANTED_FIELD,
  isDraftWriteCall,
  parseFilesToAttach,
  stampFilesWanted,
} from "./files-to-attach.ts";

const card = () => ({ schema_version: "1", card: "draft_editor", draft: {} } as Record<string, unknown>);

Deno.test("parseFilesToAttach: trims, de-duplicates, clips and caps", () => {
  assertEquals(parseFilesToAttach(["  signed  contract ", "Signed contract", "", 4, "invoice"]), [
    "signed contract",
    "invoice",
  ]);
  assertEquals(parseFilesToAttach("invoice.pdf"), ["invoice.pdf"]);
  assertEquals(parseFilesToAttach(undefined), []);
  assertEquals(parseFilesToAttach({ a: 1 }), []);
  assertEquals(parseFilesToAttach(Array.from({ length: 9 }, (_, i) => `f${i}`)).length, FILES_TO_ATTACH_MAX_ITEMS);
  assertEquals(parseFilesToAttach(["x".repeat(200)])[0].length, 80);
});

Deno.test("parseFilesToAttach: bidi overrides cannot disguise a name", () => {
  const [name] = parseFilesToAttach(["invoice‮fdp.exe"]);
  assertEquals(name.includes("‮"), false);
});

Deno.test("isDraftWriteCall: draft writes only", () => {
  assertEquals(isDraftWriteCall("draft_create", {}), true);
  assertEquals(isDraftWriteCall("draft", { action: "reply" }), true);
  assertEquals(isDraftWriteCall("draft", { action: "send" }), false);
  assertEquals(isDraftWriteCall("draft_editor_save", {}), false);
  assertEquals(isDraftWriteCall("email_compose", { action: "send" }), false);
});

Deno.test("stampFilesWanted: puts the names on the card, no note", () => {
  const structuredContent = card();
  const note = stampFilesWanted({ structuredContent }, "draft", { action: "create", files_to_attach: ["contract"] });
  assertEquals(note, null);
  assertEquals(structuredContent[FILES_WANTED_FIELD], ["contract"]);
});

Deno.test("stampFilesWanted: no card means a note for the model, and nothing stamped", () => {
  const structuredContent = { draft_id: "d1" } as Record<string, unknown>;
  const note = stampFilesWanted({ structuredContent }, "draft_create", { files_to_attach: ["contract", "invoice"] });
  assertEquals(typeof note, "string");
  assertEquals(note!.includes("contract, invoice"), true);
  assertEquals(FILES_WANTED_FIELD in structuredContent, false);
});

Deno.test("stampFilesWanted: errors, other tools and empty lists are left alone", () => {
  const a = card();
  assertEquals(stampFilesWanted({ structuredContent: a, isError: true }, "draft_create", { files_to_attach: ["x"] }), null);
  assertEquals(FILES_WANTED_FIELD in a, false);
  const b = card();
  assertEquals(stampFilesWanted({ structuredContent: b }, "draft", { action: "send", files_to_attach: ["x"] }), null);
  assertEquals(FILES_WANTED_FIELD in b, false);
  const c = card();
  assertEquals(stampFilesWanted({ structuredContent: c }, "draft_create", { files_to_attach: [] }), null);
  assertEquals(FILES_WANTED_FIELD in c, false);
  assertEquals(stampFilesWanted(undefined, "draft_create", { files_to_attach: ["x"] }), null);
});
