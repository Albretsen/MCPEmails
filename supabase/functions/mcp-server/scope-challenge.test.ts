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
    buildInsufficientScopeChallenge(["send:email"], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="send:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
  assertEquals(
    buildInsufficientScopeChallenge(["read:email", "search:email"], RESOURCE),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="read:email search:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
});

Deno.test("a scope that would break the header quoting is dropped, not emitted", () => {
  const challenge = buildInsufficientScopeChallenge(['bad"scope', "send:email"], RESOURCE);
  assertEquals(challenge.includes('scope="send:email"'), true);
  assertEquals(challenge.includes('bad"'), false);
  // Nothing valid left: no scope attribute at all rather than an empty one.
  assertEquals(buildInsufficientScopeChallenge([], RESOURCE).includes("scope="), false);
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
