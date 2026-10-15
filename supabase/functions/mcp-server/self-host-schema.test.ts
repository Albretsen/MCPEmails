// ---------------------------------------------------------------------------
// The self-host schema has every table, RPC and selected column the server
// names.
//
// self-host/db/00-schema.sql is a hand-kept copy of the slice of the hosted
// schema this server touches. Nothing tied the two together, so migrations
// landed and the copy fell behind: by 2026-10 it lacked 21 tables, 6 RPCs and
// the inbox columns every inbox lookup selects (imap_security, smtp_security,
// send_approval_required). PostgREST rejects a select that names an unknown
// column, the lookup came back empty, and every tool that resolves an inbox
// answered "No inbox matches" on a self-hosted install (issue #82).
//
// This file reads the server source statically and holds the schema to three
// things:
//
//   1. every table named in `.from("…")` is created;
//   2. every function named in `.rpc("…")` is created;
//   3. every column named in the `.select(…)` chained onto a `.from("…")` exists
//      on that table, whether the projection is a literal, a module constant or
//      a `reachableInboxSelect(…)` call.
//
// It does not see columns that are only written (insert/update payloads) or
// only filtered on. Those fail more quietly on a self-host install, so when a
// migration adds one the server writes, add it to 00-schema.sql in the same PR
// anyway.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVER_DIR = new URL("./", import.meta.url);
const SCHEMA_PATH = new URL("../../../self-host/db/00-schema.sql", import.meta.url);

async function serverSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const entry of Deno.readDir(SERVER_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    sources.set(entry.name, await Deno.readTextFile(new URL(entry.name, SERVER_DIR)));
  }
  return sources;
}

interface SelfHostSchema {
  tables: Map<string, Set<string>>;
  functions: Set<string>;
}

/** Tables (with columns, from CREATE TABLE and ADD COLUMN) and functions. */
export function parseSchema(sql: string): SelfHostSchema {
  const tables = new Map<string, Set<string>>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Set());
    return tables.get(name)!;
  };
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(\n([\s\S]*?)\n\);/g)) {
    const columns = table(match[1]);
    for (const line of match[2].split("\n")) {
      const column = /^\s+([a-z_][a-z0-9_]*)\s+[a-z]/.exec(line)?.[1];
      if (column && !["constraint", "primary", "unique", "check", "foreign"].includes(column)) {
        columns.add(column);
      }
    }
  }
  for (const match of sql.matchAll(/ALTER TABLE public\.(\w+)\n([\s\S]*?);/g)) {
    const columns = table(match[1]);
    for (const added of match[2].matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)) columns.add(added[1]);
  }
  const functions = new Set(
    [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]),
  );
  return { tables, functions };
}

/** `const NAME = "a" + "b";` and `export const NAME = ["a", "b"] as const;` */
function stringConstants(sources: Map<string, string>): Map<string, string> {
  const constants = new Map<string, string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) =\s*((?:"[^"]*"\s*\+?\s*)+);/gm)) {
      constants.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map((s) => s[1]).join(""));
    }
    for (const m of source.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = \[([^\]]*)\](?: as const)?;/gm)) {
      constants.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map((s) => s[1]).join(", "));
    }
  }
  return constants;
}

/** The argument text of the call whose "(" is at `open`, or null. */
function callArgument(source: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

/** The projection a `.select(…)` argument evaluates to, or null if unknown. */
function evaluateProjection(arg: string, constants: Map<string, string>): string | null {
  // Only the first argument is the projection; `{ count: "exact" }` follows it.
  const first = arg.replace(/,\s*\{[\s\S]*\}\s*$/, "").trim().replace(/,$/, "");
  const reachable = /^reachableInboxSelect\(([\s\S]*)\)$/.exec(first);
  if (reachable) {
    const extra = [...reachable[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const base = constants.get("REACHABLE_INBOX_COLUMNS");
    return base === undefined ? null : [...extra, base].join(", ");
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(first)) return constants.get(first) ?? null;
  if (/^(?:"[^"]*"\s*\+?\s*)+$/.test(first)) {
    return [...first.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  }
  return null;
}

/** Plain column names in a PostgREST projection; `*` and embeds are skipped. */
function projectionColumns(projection: string): string[] {
  return projection.split(",").map((part) => part.trim()).filter((part) => part && part !== "*")
    .filter((part) => !part.includes("("))
    .map((part) => part.replace(/^\w+:/, "").replace(/::\w+$/, "").replace(/->.*$/, ""));
}

const sources = await serverSources();
const schema = parseSchema(await Deno.readTextFile(SCHEMA_PATH));

Deno.test("self-host schema creates every table the server queries", () => {
  const missing = new Set<string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(/\.from\("([a-z_]+)"\)/g)) {
      if (!schema.tables.has(m[1])) missing.add(m[1]);
    }
  }
  assertEquals([...missing].sort(), [], "add these tables to self-host/db/00-schema.sql");
});

Deno.test("self-host schema creates every RPC the server calls", () => {
  const missing = new Set<string>();
  for (const source of sources.values()) {
    for (const m of source.matchAll(/\.rpc\("([a-z_]+)"/g)) {
      if (!schema.functions.has(m[1])) missing.add(m[1]);
    }
  }
  assertEquals([...missing].sort(), [], "add these functions to self-host/db/00-schema.sql");
});

Deno.test("self-host schema has every column the server selects", () => {
  const constants = stringConstants(sources);
  const missing = new Set<string>();
  const unresolved: string[] = [];
  let checked = 0;
  for (const [file, source] of sources) {
    // `.from("t")` followed, across whitespace only, by `.select(`.
    for (const m of source.matchAll(/\.from\("([a-z_]+)"\)\s*\.select\(/g)) {
      const arg = callArgument(source, m.index! + m[0].length - 1);
      const projection = arg === null ? null : evaluateProjection(arg, constants);
      if (projection === null) {
        const line = source.slice(0, m.index).split("\n").length;
        unresolved.push(`${file}:${line} ${arg?.trim().slice(0, 60)}`);
        continue;
      }
      const columns = schema.tables.get(m[1]);
      for (const column of projectionColumns(projection)) {
        checked++;
        if (!columns?.has(column)) missing.add(`${m[1]}.${column}`);
      }
    }
  }
  assertEquals(unresolved, [], "teach evaluateProjection this projection shape");
  assertEquals([...missing].sort(), [], "add these columns to self-host/db/00-schema.sql");
  assert(checked > 100, `expected to check well over 100 selected columns, checked ${checked}`);
});

// decryptStoredToken() base64url-decodes the string PostgREST returns. A bytea
// column comes back hex-encoded ("\x7678..."), which fails that decode on every
// IMAP/SMTP call. The self-host schema had them as bytea until issue #82.
Deno.test("self-host schema stores encrypted credentials as text", async () => {
  const sql = await Deno.readTextFile(SCHEMA_PATH);
  const inboxes = /CREATE TABLE IF NOT EXISTS public\.inboxes \(\n([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
  for (const column of ["imap_password", "oauth_access_token", "oauth_refresh_token"]) {
    assert(new RegExp(`^\\s+${column}\\s+text\\b`, "m").test(inboxes), `inboxes.${column} must be text`);
  }
});

Deno.test("parseSchema reads CREATE TABLE columns and ADD COLUMN upgrades", () => {
  const parsed = parseSchema(
    "CREATE TABLE IF NOT EXISTS public.t (\n  id uuid PRIMARY KEY,\n  CONSTRAINT c CHECK (true)\n);\n" +
      "ALTER TABLE public.t\n  ADD COLUMN IF NOT EXISTS added text,\n  ADD COLUMN IF NOT EXISTS other int;\n" +
      "CREATE OR REPLACE FUNCTION public.f(a int)\n",
  );
  assertEquals([...parsed.tables.get("t")!].sort(), ["added", "id", "other"]);
  assertEquals([...parsed.functions], ["f"]);
});
