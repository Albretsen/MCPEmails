// ---------------------------------------------------------------------------
// Two consistency checks, deliberately separate:
//
// 1. SERVER_VERSION must equal the top-level `version` of /server.json, the
//    MCP registry manifest for THIS server. When the initialize handshake
//    reported "1.0.0" against a registry listing of "1.0.4" nothing caught it
//    for months. This test does.
//
// 2. server.json `packages[].version` must equal packages/mcpemails/package.json,
//    because the registry only accepts a package version that is actually on
//    npm. That version is the stdio bridge's, not the server's: the bridge is
//    a pure pipe and is republished far less often than the server changes,
//    so it is NOT required to match SERVER_VERSION (see commit 33242bb).
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

Deno.test("SERVER_VERSION matches server.json's top-level version", () => {
  const manifest = readJson("server.json");
  assertEquals(
    SERVER_VERSION,
    manifest.version,
    "server-version.ts and /server.json disagree; bump both together",
  );
});

Deno.test("server.json packages[].version matches the npm bridge's package.json", () => {
  const manifest = readJson("server.json");
  const bridge = readJson("packages/mcpemails/package.json");
  const packages = manifest.packages as Array<Record<string, unknown>> | undefined;
  for (const pkg of packages ?? []) {
    assertEquals(
      pkg.version,
      bridge.version,
      `server.json packages[].version (${pkg.identifier}) and packages/mcpemails/package.json disagree; the registry requires the version that is actually on npm`,
    );
  }
});
