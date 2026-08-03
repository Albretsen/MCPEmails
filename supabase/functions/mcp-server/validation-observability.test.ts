import { invalidArgumentAuditDetails } from "./validation-observability.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("invalid-argument audit details retain only tool, action, paths, and keywords", () => {
  const details = invalidArgumentAuditDetails("email_read", "search", [
    {
      path: "arguments.search_query",
      keyword: "additionalProperties",
      // This extra property models an internal error object that includes a
      // human-readable message. It must never reach persistent metadata.
      message: "is not allowed: confidential invoice phrase",
    },
    { path: "arguments.limit", keyword: "maximum", message: "must be <= 100" },
  ]);

  assertEquals(details, {
    phase: "schema_validation",
    tool: "email_read",
    action: "search",
    errors: [
      { path: "arguments.search_query", keyword: "additionalProperties" },
      { path: "arguments.limit", keyword: "maximum" },
    ],
  }, "persisted classification");
  if (JSON.stringify(details).includes("confidential invoice phrase")) {
    throw new Error("persisted classification must not contain request-derived text");
  }
});
