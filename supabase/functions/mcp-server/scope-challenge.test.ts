// ---------------------------------------------------------------------------
// The scope-denial challenge is read by OAuth clients byte for byte, so the
// exact header shape is pinned here.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildInsufficientScopeChallenge,
  insufficientScopeErrorData,
  isInsufficientScopeError,
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
