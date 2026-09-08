// ---------------------------------------------------------------------------
// SERVER_VERSION must equal the version published in the MCP registry manifest
// (/server.json) and the npm package (packages/mcpemails/package.json). All
// three name the same product to the outside world; when the initialize
// handshake reported "1.0.0" against a registry listing of "1.0.4" nothing
// caught it for months. This test does.
//
// Run: deno test --allow-read supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { SERVER_VERSION } from "./server-version.ts";

const here = new URL(".", import.meta.url);
const repoRoot = new URL("../../../", here);

function readJson(relative: string): Record<string, unknown> {
  const path = new URL(relative, repoRoot);
  return JSON.parse(Deno.readTextFileSync(path)) as Record<string, unknown>;
}

Deno.test("SERVER_VERSION is a plain semver string", () => {
  assertMatch(SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});

Deno.test("SERVER_VERSION matches server.json", () => {
  const manifest = readJson("server.json");
  assertEquals(
    SERVER_VERSION,
    manifest.version,
    "server-version.ts and /server.json disagree; bump both together",
  );
  const packages = manifest.packages as Array<Record<string, unknown>> | undefined;
  for (const pkg of packages ?? []) {
    assertEquals(
      SERVER_VERSION,
      pkg.version,
      `server-version.ts and server.json packages[].version (${pkg.identifier}) disagree`,
    );
  }
});

Deno.test("SERVER_VERSION matches packages/mcpemails/package.json", () => {
  const pkg = readJson("packages/mcpemails/package.json");
  assertEquals(
    SERVER_VERSION,
    pkg.version,
    "server-version.ts and packages/mcpemails/package.json disagree; bump both together",
  );
});
