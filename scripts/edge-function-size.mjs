#!/usr/bin/env node
// edge-function-size.mjs
// Sum the local source files in an edge function's module graph, which is
// roughly what `supabase functions deploy --use-api` uploads. The API path
// refuses anything over 5 MB with a 413 ("Function source code exceeds the
// maximum deployment size"). The Docker path (no --use-api) bundles an eszip
// instead and has no such cap in practice: client-api went out that way on
// 2026-10-24 at 4.84 MB of source, as a 2.7 MB eszip.
//
// Prints one line per function and a GitHub Actions ::warning:: when one
// passes WARN_BYTES. It never fails the build: the deploy workflow falls back
// to the Docker bundler on a 413, so this is a heads-up, not a gate.
//
// Usage (from repo root, needs deno on PATH):
//   node scripts/edge-function-size.mjs mcp-server client-api

import { execFileSync } from "node:child_process";

// Decimal megabytes. client-api got the 413 at 4.84 MB by this count, so the
// upload carries more than the module graph and the real margin is smaller.
const CAP_BYTES = 5_000_000;
const WARN_BYTES = 4_500_000;

const fns = process.argv.slice(2);
if (fns.length === 0) {
  console.error("usage: node scripts/edge-function-size.mjs <function> [...]");
  process.exit(2);
}

const mb = (n) => (n / 1_000_000).toFixed(2);

for (const fn of fns) {
  const out = execFileSync(
    "deno",
    ["info", "--json", "--node-modules-dir=none", `supabase/functions/${fn}/index.ts`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const local = JSON.parse(out).modules.filter((m) => m.specifier?.startsWith("file://"));
  const bytes = local.reduce((sum, m) => sum + (m.size ?? 0), 0);
  console.log(`${fn}: ${local.length} local files, ${mb(bytes)} MB (API upload cap ${mb(CAP_BYTES)} MB)`);
  if (bytes > WARN_BYTES) {
    const over = bytes > CAP_BYTES ? "is over" : "is close to";
    console.log(
      `::warning title=${fn} source size::${fn} ${over} the 5 MB --use-api cap (${mb(bytes)} MB). ` +
        "The deploy workflow falls back to the Docker bundler on a 413.",
    );
  }
}
