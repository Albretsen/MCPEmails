import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { resolveAppEnv, resolveAppUrl } from "./app-env.ts";

Deno.test("app-env: unset APP_ENV is production and APP_URL defaults to the apex", () => {
  assertEquals(resolveAppEnv(undefined), "production");
  assertEquals(resolveAppUrl({}), "https://mcpemails.com");
  assertEquals(resolveAppUrl({ APP_ENV: "production", APP_URL: "" }), "https://mcpemails.com");
});

Deno.test("app-env: APP_URL wins and loses its trailing slash", () => {
  assertEquals(resolveAppUrl({ APP_URL: "https://mcpemails.com/" }), "https://mcpemails.com");
  assertEquals(
    resolveAppUrl({ APP_ENV: "staging", APP_URL: "https://staging.mcpemails.com" }),
    "https://staging.mcpemails.com",
  );
});

Deno.test("app-env: outside production a missing APP_URL fails loudly", () => {
  assertThrows(() => resolveAppUrl({ APP_ENV: "staging" }), Error, "APP_URL is required when APP_ENV=staging");
  assertThrows(() => resolveAppUrl({ APP_ENV: "Staging", APP_URL: "  " }), Error, "APP_URL is required");
});
