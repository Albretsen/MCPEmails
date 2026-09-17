#!/usr/bin/env node
// ---------------------------------------------------------------------------
// What is actually IN web storage, for every card the server can send.
//
//   node harness/storage-audit.mjs      (one of the three `npm run verify` runs)
//
// hardening.mjs asks the forward question — "is this particular body, bcc or
// subject absent" — against a hand-picked list of five strings from one
// fixture. That catches a regression it was written for and nothing else: a new
// field on a new card kind leaks past it silently, because nobody thought to
// add a sixth needle.
//
// This asks the REVERSE question, which is the one that cannot rot: drive every
// exported fixture through the shipped `setState` path, then read back the
// serialised bytes and require that EVERY string in them is explainable — a
// structural constant, a contract enum, an https dashboard URL, an opaque id of
// a known shape, or a headline the CARD wrote. Anything else fails, including
// something nobody has thought of yet.
//
// Written by the WS-1b verification pass, deliberately not reusing the fix
// author's assertions.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as F from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/storage-audit.bundle.mjs");

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    entries: () => [...map.entries()],
  };
}

/** Every string that may appear as a VALUE in the stored blob. */
const ENUMS = new Set([
  "review-card-v1",
  // card kinds
  "outbound_review", "bulk_plan", "receipt", "draft_editor",
  // card states
  "pending", "editing", "sent", "scheduled", "rejected", "expired",
  "decided_elsewhere", "executed", "error",
  // receipt outcomes
  "discarded", "failed", "cancelled",
  // providers
  "gmail", "outlook", "imap",
]);

/** The nine headlines persist.ts#neutralHeadline can write. Card-authored. */
const HEADLINES = new Set([
  "Sent.", "Scheduled.", "Draft discarded.", "Rejected. Nothing was sent.",
  "This request expired.", "Already decided elsewhere.", "Done.",
  "Cancelled. Nothing was changed.", "That did not go through.",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_ID = /^[\w.:@+/=-]{1,256}$/;
const HTTPS = /^https:\/\/[^\s"'<>]{1,200}$/i;
const FINGERPRINT = /^[-a-z0-9]{1,32}$/;

/**
 * A byte a source file has no legitimate use for: anything below 0x20 except
 * tab, newline and carriage return, plus DEL.
 *
 * Written as a numeric predicate rather than a regex character class ON
 * PURPOSE. A class would need the literal control characters in THIS file, and
 * that is the exact thing being pinned out of existence — a control byte in
 * source survives a diff, a code review and a `grep` untouched. (`grep` in the
 * repo's own shell is a function wrapping `ugrep -I`, which skips a file
 * containing a NUL as binary and prints nothing at all.)
 */
const isInvisible = (code) =>
  code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);

/** Walk the parsed blob and yield [path, value] for every string. */
function strings(v, path = "$", out = []) {
  if (typeof v === "string") { out.push([path, v]); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => strings(x, `${path}[${i}]`, out)); return out; }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push([`${path}.<key>`, k]);          // keys are data too
      strings(x, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Is this string explainable? `path` is only used to report a failure. */
function explainable(path, s) {
  if (s === "") return true;
  if (ENUMS.has(s)) return true;
  if (HEADLINES.has(s)) return true;
  if (HTTPS.test(s)) return true;             // dashboard_url
  // `inbox_id` and `approval_id`. Both are UUIDs on the wire and both are
  // UUID-checked by redact() before they are written, so "it is a UUID" is the
  // whole of what is admitted here — a server-authored sentence in either field
  // fails this line rather than being explained by the key it sits under.
  if (UUID.test(s)) return true;
  // The argument hash, `NO_ARGS`, or the per-browser salt. All three are
  // card-computed values over a bounded alphabet; none is server-authored.
  if (FINGERPRINT.test(s)) return true;
  // Object keys: the stored shape, plus the entry keys the card computes.
  if (/\.<key>$/.test(path)) return /^(k|d|s|t|f|e|_stub|schema_version|card|state|dashboard_url|draft|draft_id|id_is_stable|identity|inbox_id|provider|outbound|approval_id|receipt|outcome|headline|[ai][\w-]{0,32})$/.test(s);
  if (/\.draft_id$/.test(path) && DRAFT_ID.test(s)) return true;
  return false;
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents: 'export * from "./src/store";\nexport * from "./src/persist";\n',
      resolveDir: appRoot, sourcefile: "audit-entry.ts", loader: "ts",
    },
    bundle: true, format: "esm", platform: "neutral", target: "es2022", outfile: OUT,
  });

  let i = 0;
  let checked = 0;
  const bad = [];
  // The two pins below are counted apart from the stored-string audit on
  // purpose: `checked` is "strings found in the blob", and diluting it with a
  // fixed handful of structural checks would make the headline number stop
  // meaning what it says.
  let pinned = 0;
  const pinBad = [];

  for (const [name, env] of Object.entries(F)) {
    if (!env || typeof env !== "object" || typeof env.card !== "string") continue;
    const storage = fakeStorage();
    globalThis.localStorage = storage;
    globalThis.window = { parent: { postMessage() {} }, addEventListener() {}, removeEventListener() {} };
    const mod = await import(`${pathToFileURL(OUT).href}?s=${++i}`);
    // A `draft{action:"create"}` call: the arguments carry the composed body,
    // which must not reach storage either, hashed or otherwise.
    const args = {
      action: "create",
      inbox_id: "51ab6d90-4c18-4a2f-9d77-8e6a1b022c9d",
      to: ["dana@northwind.example"],
      subject: "Q3 numbers",
      body: "Here are the Q3 numbers you asked for.",
    };
    mod.setState({ toolInput: args, toolInfo: { tool: "draft", callId: "i7" } });
    mod.setState({ envelope: env });

    for (const [key, blob] of storage.entries()) {
      checked++;
      if (key !== "mcpemails.card.v3") { bad.push(`${name}: unexpected storage key ${key}`); continue; }
      if (blob.includes(args.body) || blob.includes(JSON.stringify(args))) {
        bad.push(`${name}: the call ARGUMENTS reached storage verbatim`);
      }
      let parsed;
      try { parsed = JSON.parse(blob); } catch { bad.push(`${name}: blob is not JSON`); continue; }
      for (const [path, s] of strings(parsed)) {
        checked++;
        if (!explainable(path, s)) bad.push(`${name} ${path} = ${JSON.stringify(s.slice(0, 80))}`);
      }
    }
  }

  // ------------------------------------------------------------------------
  // (2) THE ENTRY KEY'S OWN SHAPE
  //
  // Everything above audits the stored VALUES. The key is data too — the
  // disclosure paragraph in persist.ts names it as one of the two most
  // content-derived values in the file — and nothing pinned how it is built.
  //
  // `a<hash>` is taken over `${tool} ${JSON.stringify(args)}`, and that
  // separator was a literal NUL on `main` until the WS-1b storage rewrite. It
  // became a space for a good reason and it became one SILENTLY: the round-3
  // pass had to reconstruct the change from the bytes, because the one suite
  // that would have named it never ran. This is the pin.
  //
  // It is not a collision pin. `JSON.stringify` of an arguments object always
  // starts with `{`, which a tool name cannot contain, so the split point is
  // unambiguous and a reachable collision was probed for and not found. It is
  // a pin against the separator drifting back to a byte that nothing in the
  // toolchain can show you.
  // ------------------------------------------------------------------------
  {
    const mod = await import(`${pathToFileURL(OUT).href}?sep=1`);
    const pin = (label, ok) => {
      pinned++;
      if (!ok) pinBad.push(`entry key: ${label}`);
    };
    const sig = mod.callSignature({ tool: "draft" }, { action: "create" });
    pin("the signature is tool, ONE SPACE, arguments", sig === 'draft {"action":"create"}');
    // Its own check rather than left implicit in the equality above, so that a
    // drift to 0x01 or 0x1f reports the REASON instead of a diff between two
    // strings that look identical in a terminal.
    pin(
      "the separator is not a control byte",
      typeof sig === "string" && ![...sig].some((ch) => isInvisible(ch.codePointAt(0))),
    );
    // The branch that actually runs on Claude, which omits `toolInfo`: it must
    // still produce the same shape rather than a leading-space special case
    // nobody has looked at.
    pin(
      "an absent tool name still separates",
      mod.callSignature(null, { action: "create" }) === ' {"action":"create"}',
    );
    pin("no arguments means no key at all", mod.callSignature({ tool: "draft" }, null) === null);
    // And the key the card actually stores is that signature hashed: `a` plus
    // the two FNV passes, over a bounded alphabet and nothing else.
    pin(
      "the fallback key is a hash of it",
      /^a[0-9a-z]{1,32}$/.test(String(mod.cardKey({ tool: "draft" }, { action: "create" }))),
    );
  }

  // ------------------------------------------------------------------------
  // (3) THE SAME HAZARD, ONE LEVEL UP
  //
  // The separator is one instance of a general rule: this card's sources carry
  // no invisible bytes. The NUL that used to be in persist.ts shipped for weeks
  // without anyone seeing it, and the reason is structural rather than
  // careless — a control character in a string literal is unreviewable. So the
  // rule is checked rather than remembered.
  // ------------------------------------------------------------------------
  {
    const SRC = resolve(appRoot, "src");
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
      );
    const files = walk(SRC).filter((f) => /\.(ts|tsx|css)$/.test(f));
    pinned++;
    if (files.length < 10) pinBad.push(`source scan: only ${files.length} files under src/`);
    for (const f of files) {
      pinned++;
      // Read as BYTES. Decoding first would let a stray 0x00 disappear into a
      // replacement character on any malformed sequence around it.
      const buf = readFileSync(f);
      const at = buf.findIndex((b) => isInvisible(b));
      if (at !== -1) {
        const hex = buf[at].toString(16).padStart(2, "0");
        pinBad.push(`source scan: ${f.slice(appRoot.length + 1)} byte ${at} is 0x${hex}`);
      }
    }
  }

  console.log(`storage audit: ${checked - bad.length}/${checked} stored strings explainable`);
  for (const b of bad) console.log("  UNEXPLAINED  " + b);
  console.log(`key + source pins: ${pinned - pinBad.length}/${pinned} passed`);
  for (const b of pinBad) console.log("  FAILED       " + b);
  process.exit(bad.length + pinBad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
