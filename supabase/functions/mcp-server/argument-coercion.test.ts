import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { coerceArgumentTypes } from "./argument-coercion.ts";

// See tool-surface.test.ts for why the environment is set before a dynamic import.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { TOOL_REGISTRY, validateInputSchema } = await import("./index.ts");

function schemaOf(name: string): Record<string, unknown> {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  assert(tool, `${name} is missing from TOOL_REGISTRY`);
  return tool!.inputSchema as Record<string, unknown>;
}

/** Coerce, then validate against the real registry schema, as tools/call does. */
function coerceAndValidate(tool: string, args: Record<string, unknown>) {
  const schema = schemaOf(tool);
  const coerced = coerceArgumentTypes(schema, args);
  return { args, coerced, errors: validateInputSchema(schema, args) };
}

// ── The reported call ───────────────────────────────────────────────────────

Deno.test("email_compose send with a single-string `to` validates (the reported call)", () => {
  const { args, coerced, errors } = coerceAndValidate("email_compose", {
    action: "send",
    to: "recipient@example.no",
    subject: "middagsvarsel",
    body: "Det er middag.",
  });
  assertEquals(errors, []);
  assertEquals(args.to, ["recipient@example.no"]);
  assertEquals(coerced, [{ path: "to", from: "string", to: "array" }]);
});

Deno.test("the same call is refused without coercion, so the test above proves something", () => {
  const errors = validateInputSchema(schemaOf("email_compose"), {
    action: "send",
    to: "recipient@example.no",
    subject: "middagsvarsel",
    body: "Det er middag.",
  });
  assertEquals(errors.map((error: { path: string; keyword: string }) => [error.path, error.keyword]), [["arguments.to", "type"]]);
});

// ── Recipient lists ─────────────────────────────────────────────────────────

Deno.test("comma- and semicolon-separated recipients split into a list", () => {
  const { args, errors } = coerceAndValidate("email_compose", {
    action: "send",
    to: "a@example.com, b@example.com;c@example.com ",
    cc: "d@example.com",
    bcc: "e@example.com",
    subject: "s",
    body: "b",
  });
  assertEquals(errors, []);
  assertEquals(args.to, ["a@example.com", "b@example.com", "c@example.com"]);
  assertEquals(args.cc, ["d@example.com"]);
  assertEquals(args.bcc, ["e@example.com"]);
});

Deno.test("a JSON-encoded array string is parsed", () => {
  const { args, errors } = coerceAndValidate("email_compose", {
    action: "send",
    to: '["a@example.com","b@example.com"]',
    subject: "s",
    body: "b",
  });
  assertEquals(errors, []);
  assertEquals(args.to, ["a@example.com", "b@example.com"]);
});

Deno.test("a coerced recipient that is not an email is still refused, on the item", () => {
  const { args, errors } = coerceAndValidate("email_compose", {
    action: "send",
    to: "Recipient",
    subject: "s",
    body: "b",
  });
  assertEquals(args.to, ["Recipient"]);
  assertEquals(errors.map((error: { path: string; keyword: string }) => [error.path, error.keyword]), [["arguments.to[0]", "format"]]);
});

Deno.test("draft create accepts a single-string `to` too", () => {
  const { args, errors } = coerceAndValidate("draft", {
    action: "create",
    to: "a@example.com",
    subject: "s",
    body: "b",
  });
  assertEquals(errors, []);
  assertEquals(args.to, ["a@example.com"]);
});

Deno.test("a correct array is never touched", () => {
  const args = { action: "send", to: ["a@example.com"], subject: "s", body: "b" };
  assertEquals(coerceArgumentTypes(schemaOf("email_compose"), args), []);
  assertEquals(args.to, ["a@example.com"]);
});

// ── Ids are wrapped, never split ────────────────────────────────────────────

Deno.test("a single message id string becomes a one-item list, commas and all", () => {
  const args: Record<string, unknown> = { message_ids: "abc,def" };
  coerceArgumentTypes({
    type: "object",
    properties: { message_ids: { type: "array", items: { type: "string" } } },
  }, args);
  assertEquals(args.message_ids, ["abc,def"]);
});

// ── Booleans and numbers ────────────────────────────────────────────────────

Deno.test("\"false\" / \"TRUE\" become booleans; other strings do not", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "boolean" },
      b: { type: "boolean" },
      c: { type: "boolean" },
      d: { type: "boolean" },
    },
  };
  const args: Record<string, unknown> = { a: "false", b: " TRUE ", c: "yes", d: "1" };
  coerceArgumentTypes(schema, args);
  assertEquals(args, { a: false, b: true, c: "yes", d: "1" });
});

Deno.test("email_compose include_signature \"false\" validates as false", () => {
  const { args, errors } = coerceAndValidate("email_compose", {
    action: "send",
    to: ["a@example.com"],
    subject: "s",
    body: "b",
    include_signature: "false",
  });
  assertEquals(errors, []);
  assertEquals(args.include_signature, false);
});

Deno.test("integer and number strings become numbers; the rest stay strings", () => {
  const schema = {
    type: "object",
    properties: {
      i: { type: "integer" },
      big: { type: "integer" },
      frac: { type: "integer" },
      n: { type: "number" },
      word: { type: "integer" },
      empty: { type: "integer" },
    },
  };
  const args: Record<string, unknown> = {
    i: " 20 ",
    big: "99999999999999999999",
    frac: "2.5",
    n: "-0.5",
    word: "all",
    empty: "",
  };
  coerceArgumentTypes(schema, args);
  assertEquals(args, { i: 20, big: "99999999999999999999", frac: "2.5", n: -0.5, word: "all", empty: "" });
});

Deno.test("a type that already admits a string is never coerced", () => {
  const args: Record<string, unknown> = { v: "true", w: "20" };
  const changed = coerceArgumentTypes({
    type: "object",
    properties: { v: { type: ["string", "boolean"] }, w: { type: "string" } },
  }, args);
  assertEquals(changed, []);
  assertEquals(args, { v: "true", w: "20" });
});

Deno.test("null and undeclared properties are left alone", () => {
  const args: Record<string, unknown> = { a: null, extra: "true" };
  const changed = coerceArgumentTypes({
    type: "object",
    properties: { a: { type: "boolean" } },
  }, args);
  assertEquals(changed, []);
  assertEquals(args, { a: null, extra: "true" });
});

// ── Objects and nesting ─────────────────────────────────────────────────────

Deno.test("a lone attachment object is wrapped, and its nested index coerced", () => {
  const { args, errors } = coerceAndValidate("email_compose", {
    action: "send",
    to: ["a@example.com"],
    subject: "s",
    body: "b",
    attachments: { source_message_id: "m1", attachment_index: "0" },
  });
  assertEquals(errors, []);
  assertEquals(args.attachments, [{ source_message_id: "m1", attachment_index: 0 }]);
});

Deno.test("an array of objects given a string is left for the validator", () => {
  const args: Record<string, unknown> = { attachments: "report.pdf" };
  const changed = coerceArgumentTypes({
    type: "object",
    properties: { attachments: { type: "array", items: { type: "object" } } },
  }, args);
  assertEquals(changed, []);
  assertEquals(args.attachments, "report.pdf");
});

Deno.test("the operator log carries paths and types, never values", () => {
  const changed = coerceArgumentTypes(schemaOf("email_compose"), {
    action: "send",
    to: "secret-person@example.com",
    include_signature: "false",
  });
  assert(!JSON.stringify(changed).includes("secret-person"));
  assertEquals(changed, [
    { path: "to", from: "string", to: "array" },
    { path: "include_signature", from: "string", to: "boolean" },
  ]);
});
