// ---------------------------------------------------------------------------
// The scope-denial challenge is read by OAuth clients byte for byte, so the
// exact header shape is pinned here.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildInsufficientScopeChallenge,
  insufficientScopeDescription,
  insufficientScopeErrorData,
  insufficientScopeToolResult,
  isInsufficientScopeError,
  OPENAI_WWW_AUTHENTICATE_META_KEY,
} from "./scope-challenge.ts";

const RESOURCE = "https://mcpemails.com/.well-known/oauth-protected-resource";

Deno.test("challenge carries error, space-separated scope and resource_metadata", () => {
  assertEquals(
    buildInsufficientScopeChallenge(["send:email"], [], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="send:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
});

Deno.test("the scope is the UNION of what is required and what the token holds", () => {
  // The regression this exists for: a read-only OAuth token stepping up to
  // send. Claude re-authorizes for what this header names, and does not
  // reliably carry earlier step-ups forward, so a header saying only
  // "send:email" hands the user back a token that can no longer read.
  assertEquals(
    buildInsufficientScopeChallenge(["send:email"], ["read:email"], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="send:email read:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
  // Several step-ups deep: everything already held survives, in order.
  assertEquals(
    buildInsufficientScopeChallenge(
      ["delete:email"],
      ["read:email", "send:email", "manage:folders"],
      RESOURCE,
    ),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="delete:email read:email send:email manage:folders", ` +
      `resource_metadata="${RESOURCE}"`,
  );
});

Deno.test("an empty grant asks for the required scope alone", () => {
  // A key carrying no scopes at all (or a JSON body that somehow lost its
  // granted_scopes) must still produce today's challenge, not a broken one.
  assertEquals(
    buildInsufficientScopeChallenge(["manage:drafts"], [], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="manage:drafts", ` +
      `resource_metadata="${RESOURCE}"`,
  );
  assertEquals(
    buildInsufficientScopeChallenge(
      ["manage:drafts"],
      undefined as unknown as string[],
      RESOURCE,
    ),
    buildInsufficientScopeChallenge(["manage:drafts"], [], RESOURCE),
  );
});

Deno.test("only the FIRST required scope is asked for, never every alternative", () => {
  // `required_scopes` is an OR-list (the registry's altScopes): any one of them
  // would have authorized the call. Naming both would ask the user to consent
  // to two permissions where one suffices, which is the over-broad prompt this
  // whole change exists to remove. The caller puts the primary first.
  assertEquals(
    buildInsufficientScopeChallenge(["read:email", "search:email"], [], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="read:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
  // The JSON body is the contract that keeps the whole OR-list; the header
  // narrows. Both halves of that statement are checked here.
  assertEquals(
    insufficientScopeErrorData(["read:email", "search:email"], []).required_scopes,
    ["read:email", "search:email"],
  );
});

Deno.test("a scope already held is not repeated when it is also required", () => {
  // Can only happen through a malformed body, but a duplicated token would be
  // a malformed scope list on the wire, so the dedupe is pinned.
  assertEquals(
    buildInsufficientScopeChallenge(["send:email"], ["send:email", "read:email"], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="send:email read:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
});

Deno.test("a scope that would break the header quoting is dropped, not emitted", () => {
  // Dropped BEFORE the union picks a required scope, so a malformed leading
  // entry cannot displace the usable one behind it.
  const challenge = buildInsufficientScopeChallenge(['bad"scope', "send:email"], [], RESOURCE);
  assertEquals(challenge.includes('scope="send:email"'), true);
  assertEquals(challenge.includes('bad"'), false);
  // The same on the granted side: a bad entry cannot smuggle a quote in.
  const held = buildInsufficientScopeChallenge(["send:email"], ['bad"held', "read:email"], RESOURCE);
  assertEquals(held.includes('scope="send:email read:email"'), true);
  assertEquals(held.includes('bad"'), false);
  // Nothing valid left: no scope attribute at all rather than an empty one.
  assertEquals(buildInsufficientScopeChallenge([], [], RESOURCE).includes("scope="), false);
});

Deno.test("error data is the documented shape and does not alias its inputs", () => {
  const required = ["send:email"];
  const granted = ["read:email"];
  const data = insufficientScopeErrorData(required, granted);
  assertEquals(data, {
    error_code: "insufficient_scope",
    required_scopes: ["send:email"],
    granted_scopes: ["read:email"],
  });
  required.push("x");
  assertEquals(data.required_scopes, ["send:email"]);
});

Deno.test("isInsufficientScopeError keys off the string discriminator", () => {
  const denial = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32004, message: "x", data: insufficientScopeErrorData(["send:email"], []) },
  };
  assertEquals(isInsufficientScopeError(denial), true);
  assertEquals(isInsufficientScopeError({ jsonrpc: "2.0", id: 1, result: {} }), false);
  assertEquals(
    isInsufficientScopeError({ error: { code: -32004, message: "x" } }),
    false,
  );
  assertEquals(
    isInsufficientScopeError({ error: { code: -32001, message: "x", data: { hint: "y" } } }),
    false,
  );
  assertEquals(isInsufficientScopeError(null), false);
});

// ---------------------------------------------------------------------------
// The OpenAI shape: an isError RESULT with `_meta["mcp/www_authenticate"]`.
// ---------------------------------------------------------------------------

/** A denial exactly as handleToolsCall builds it (jsonRpcErrorBody). */
function denial(required: string[], granted: string[], id: string | number | null = 3) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32004,
      message: "Insufficient scope",
      data: {
        ...insufficientScopeErrorData(required, granted),
        required_scope: required[0],
        accepted_scopes: required,
        key_scopes: granted,
      },
    },
  };
}

Deno.test("the OpenAI result is a JSON-RPC result, isError, with text and no error member", () => {
  const response = denial(["send:email"], ["read:email", "search:email"]);
  assert(isInsufficientScopeError(response));
  const out = insufficientScopeToolResult(response, RESOURCE);
  assertEquals(out.jsonrpc, "2.0");
  assertEquals(out.id, 3, "the id of the request it answers");
  assert(!("error" in out), "a result, not an error, or ChatGPT never reads _meta");
  assertEquals(out.result.isError, true);
  assertEquals(out.result.content.length, 1);
  assertEquals(out.result.content[0].type, "text");
  assert(out.result.content[0].text.startsWith("This needs permission to send email."));
  assert(out.result.content[0].text.includes("Reconnect MCP Emails and approve sending."));
  assert(!("structuredContent" in out.result), "an error result need not match outputSchema");
});

Deno.test("mcp/www_authenticate carries error, error_description and the SAME scope as the 403", () => {
  // The reviewer's actual token: read + search, asked to send.
  const required = ["send:email"];
  const granted = ["read:email", "search:email"];
  const out = insufficientScopeToolResult(denial(required, granted), RESOURCE);
  const challenges = out.result._meta[OPENAI_WWW_AUTHENTICATE_META_KEY] as string[];
  assertEquals(challenges.length, 1);
  assertEquals(
    challenges[0],
    `Bearer error="insufficient_scope", ` +
      `error_description="This needs permission to send email. Reconnect MCP Emails and approve sending.", ` +
      `scope="send:email read:email search:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
  // Same scope value as the header the 403 path sends for the same denial.
  const header = buildInsufficientScopeChallenge(required, granted, RESOURCE);
  const scopeOf = (v: string) => v.match(/scope="([^"]*)"/g)!.find((m) => m.startsWith("scope="));
  assertEquals(scopeOf(challenges[0]), scopeOf(header));
});

Deno.test("the automation denial names the automation permission", () => {
  const out = insufficientScopeToolResult(denial(["manage:automations"], ["read:email"]), RESOURCE);
  const challenge = (out.result._meta[OPENAI_WWW_AUTHENTICATE_META_KEY] as string[])[0];
  assert(challenge.includes(`scope="manage:automations read:email"`));
  assert(challenge.includes(`error_description="This needs permission to create and manage automations.`));
  assert(out.result.content[0].text.includes("missing scope: manage:automations"));
});

Deno.test("the OpenAI result keeps our machine-readable copy of the denial", () => {
  const out = insufficientScopeToolResult(denial(["read:email", "search:email"], []), RESOURCE);
  assertEquals(out.result._meta["com.mcpemails/insufficient_scope"], {
    error_code: "insufficient_scope",
    required_scopes: ["read:email", "search:email"],
    granted_scopes: [],
  });
});

Deno.test("the 403 header keeps its generic error_description byte for byte", () => {
  // The Claude path must not change: only the OpenAI result passes a description.
  assert(
    buildInsufficientScopeChallenge(["send:email"], [], RESOURCE).includes(
      `error_description="The token does not carry a scope this call requires."`,
    ),
  );
});

Deno.test("a custom error_description cannot break out of its quoted-string", () => {
  const value = buildInsufficientScopeChallenge(["send:email"], [], RESOURCE, 'bad" scope="x\\');
  assert(value.includes(`error_description="bad scope=x"`));
  assertEquals(value.match(/scope="/g)!.length, 1, "only the real scope parameter opens a quote");
});

Deno.test("every scope we issue has wording, and an unknown one still reads sensibly", () => {
  for (
    const scope of [
      "read:email",
      "search:email",
      "send:email",
      "delete:email",
      "manage:folders",
      "manage:drafts",
      "manage:automations",
      "schedule:email",
      "manage:contacts",
    ]
  ) {
    const text = insufficientScopeDescription(scope);
    assert(!text.includes("'"), `${scope} has its own wording`);
    assert(!/["\\]/.test(text), `${scope} wording is quoted-string safe`);
  }
  assert(insufficientScopeDescription("x:y").includes("'x:y'"));
});

Deno.test("additional required scopes join the union right after the primary, once", () => {
  assertEquals(
    buildInsufficientScopeChallenge(
      ["manage:automations"],
      ["read:email", "manage:folders"],
      RESOURCE,
      undefined,
      ["manage:folders"],
    ),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="manage:automations manage:folders read:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
  // Default: no additional scopes, byte-identical to before.
  assertEquals(
    buildInsufficientScopeChallenge(["send:email"], ["read:email"], RESOURCE),
    buildInsufficientScopeChallenge(["send:email"], ["read:email"], RESOURCE, undefined, []),
  );
});

Deno.test("error data carries additional_required_scopes only when there are some", () => {
  assert(!("additional_required_scopes" in insufficientScopeErrorData(["a:b"], [])));
  assertEquals(
    insufficientScopeErrorData(["manage:automations"], [], ["manage:folders"]).additional_required_scopes,
    ["manage:folders"],
  );
});

Deno.test("the OpenAI result for an automation missing both scopes names both, and asks for both", () => {
  const response = {
    jsonrpc: "2.0",
    id: "abc",
    error: {
      code: -32004,
      message: "Insufficient scope",
      data: insufficientScopeErrorData(
        ["manage:automations"],
        ["read:email", "search:email"],
        ["manage:folders"],
      ),
    },
  };
  const out = insufficientScopeToolResult(response, RESOURCE);
  assertEquals(out.id, "abc");
  const text = out.result.content[0].text;
  assert(
    text.startsWith(
      "This needs permission to create and manage automations and to organize email and manage folders. " +
        "Reconnect MCP Emails and approve managing automations and organizing email.",
    ),
    text,
  );
  assert(text.includes("missing scopes: manage:automations, manage:folders"), text);
  const challenge = (out.result._meta[OPENAI_WWW_AUTHENTICATE_META_KEY] as string[])[0];
  assert(challenge.includes(`scope="manage:automations manage:folders read:email search:email"`), challenge);
  assert(challenge.includes(`error="insufficient_scope"`));
  assert(challenge.includes(`error_description="This needs permission to`));
});
