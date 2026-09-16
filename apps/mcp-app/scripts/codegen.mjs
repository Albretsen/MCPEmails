#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Emits supabase/functions/mcp-server/ui/review-card.html.ts from dist/index.html.
//
// The edge function cannot read files at runtime, so the single-file bundle is
// inlined as a Deno module constant. Enforces the size budget from phase-0
// findings Q3/Q4: the ext-apps reference host re-fetches this resource on every
// tool call and caches nothing, so it is paid for per call out of the edge
// function. Claude's own host is the opposite and caches it hard, which is what
// the build fingerprint below is for.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../..");

const BUNDLE = resolve(appRoot, "dist/index.html");
const OUT = resolve(repoRoot, "supabase/functions/mcp-server/ui/review-card.html.ts");

// Raw bytes. Target <50 KB, hard failure over 150 KB (findings Q3).
const TARGET_RAW = 50 * 1024;
const MAX_RAW = 150 * 1024;

if (!existsSync(BUNDLE)) {
  console.error(`codegen: ${BUNDLE} not found — run \`npm run build:bundle\` first.`);
  process.exit(1);
}

const html = readFileSync(BUNDLE, "utf8");
const raw = Buffer.byteLength(html, "utf8");
const gz = gzipSync(Buffer.from(html, "utf8"), { level: 9 }).length;

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

// Content fingerprint of the bundle. This is what makes the resource URI change
// when, and only when, the card changes — see the comment on REVIEW_CARD_BUILD_ID
// in the emitted module.
const buildId = createHash("sha256").update(html, "utf8").digest("hex").slice(0, 12);

console.log(`codegen: bundle ${kb(raw)} raw / ${kb(gz)} gzipped, build ${buildId}`);

if (raw > MAX_RAW) {
  console.error(
    `codegen: FAILED — ${kb(raw)} exceeds the ${kb(MAX_RAW)} hard cap. ` +
      `This payload is re-sent on every tool call (findings Q4).`,
  );
  process.exit(1);
}
if (raw > TARGET_RAW) {
  console.warn(`codegen: WARNING — over the ${kb(TARGET_RAW)} target.`);
}

if (process.argv.includes("--size-only")) process.exit(0);

// Backtick template literal: escape backticks, backslashes and ${.
const escaped = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const module = `// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT HAND-EDIT.
//
// Source:    apps/mcp-app/ (Vite + Preact, vite-plugin-singlefile)
// Regenerate: npm run build -w apps/mcp-app
//
// Served as the MCP Apps UI resource:
//   uri:      ui://mcpemails/review-card.${buildId}.html
//   mimeType: text/html;profile=mcp-app
//   _meta.ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [],
//                      baseUriDomains: [] }, prefersBorder: false }
//
// Size at generation: ${kb(raw)} raw / ${kb(gz)} gzipped.
// The ext-apps reference host re-fetches this on EVERY tool call and caches
// nothing (docs/mcp-apps/phase-0-protocol-findings.md, Q4), so keep it small.
// Claude's host caches it per URI instead (CONCEPT-draft-editor.md §13).
// ---------------------------------------------------------------------------

export const REVIEW_CARD_HTML = \`${escaped}\`;

/**
 * Content fingerprint of the bundle above: the first 12 hex of its SHA-256.
 *
 * It exists because Claude's host caches the UI resource by URI and a fixed URI
 * therefore pins a user to whichever build they first loaded. Verified in
 * production on 2026-09-16 (CONCEPT-draft-editor.md §13): the host fetched the
 * card once, and three later tool calls and a full OAuth reconnect all reused
 * that copy, so a card deploy could not reach a running client at all. The URI
 * carries this value so that a new bundle is a new URI, which is a guaranteed
 * cache miss, and an unchanged bundle is byte-identical to the last deploy.
 */
export const REVIEW_CARD_BUILD_ID = "${buildId}";

export const REVIEW_CARD_URI = \`ui://mcpemails/review-card.\${REVIEW_CARD_BUILD_ID}.html\`;
export const REVIEW_CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** Content-level and listing-level \`_meta.ui\` for the resource (findings Q7.2). */
export const REVIEW_CARD_UI_META = {
  csp: {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },
  prefersBorder: false,
} as const;
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, module, "utf8");
console.log(`codegen: wrote ${OUT} (${kb(Buffer.byteLength(module, "utf8"))})`);
