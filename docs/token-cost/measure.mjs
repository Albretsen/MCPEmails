#!/usr/bin/env node
// ---------------------------------------------------------------------------
// measure.mjs: token/byte accounting for MCP JSON-RPC tool responses.
//
// Usage:
//   node docs/token-cost/measure.mjs <file.json> [...more files]
//   cat response.json | node docs/token-cost/measure.mjs
//   node docs/token-cost/measure.mjs --self-test
//
// Input may be any of:
//   * a full JSON-RPC envelope        { jsonrpc, id, result: {...} }
//   * a bare MCP tool result          { content: [...], structuredContent: {...} }
//   * a raw payload object            { inboxes: [...] } / { messages: [...] }
//   * NDJSON (one payload per line)
//
// What it reports, and why each number matters:
//   wire            bytes of the whole JSON-RPC frame (what the server sends)
//   content.text    the human/model-visible text block: this is what almost
//                   every MCP client actually puts in the model's context
//   structured      structuredContent, a SECOND full copy of the same object.
//                   Clients that forward both double the cost of every call.
//   per-item        bytes/tokens divided by messages[] or inboxes[] length
//   field weights   top-level (and per-message) field sizes, biggest first,
//                   so you can see which key is buying the tokens
//
// Tokenizer: uses `gpt-tokenizer` (cl100k_base) when resolvable, else python
// `tiktoken`, else a bytes/3.7 estimate that is LABELLED as an estimate.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = (s) => Buffer.byteLength(s, "utf8");

// ── Tokenizer resolution ────────────────────────────────────────────────────
function resolveTokenizer() {
  // 1. npm gpt-tokenizer (cl100k_base), resolved from cwd or this file.
  for (const base of [process.cwd() + "/x.js", import.meta.url]) {
    try {
      const req = createRequire(base);
      const { encode } = req("gpt-tokenizer");
      return { name: "gpt-tokenizer (cl100k_base)", exact: true, count: (s) => encode(s).length };
    } catch { /* keep looking */ }
  }
  // 2. python tiktoken.
  try {
    execFileSync("python3", ["-c", "import tiktoken"], { stdio: "ignore" });
    return {
      name: "python tiktoken (cl100k_base)",
      exact: true,
      count: (s) => {
        const out = execFileSync(
          "python3",
          ["-c", "import sys,tiktoken;print(len(tiktoken.get_encoding('cl100k_base').encode(sys.stdin.read())))"],
          { input: s, encoding: "utf8", maxBuffer: 1 << 28 },
        );
        return Number(out.trim());
      },
    };
  } catch { /* fall through */ }
  // 3. Estimate.
  return {
    name: "ESTIMATE bytes/3.7 (no tokenizer found, run `npm i gpt-tokenizer`)",
    exact: false,
    count: (s) => Math.round(B(s) / 3.7),
  };
}
const TOK = resolveTokenizer();

const measure = (s) => ({ bytes: B(s), tokens: TOK.count(s) });
const fmt = (n) => n.toLocaleString("en-US");

// ── Shape helpers ───────────────────────────────────────────────────────────
function unwrap(doc) {
  const result = doc && doc.result && typeof doc.result === "object" ? doc.result : doc;
  const content = Array.isArray(result?.content) ? result.content : null;
  const structured = result?.structuredContent ?? null;
  let payload = structured;
  if (!payload && content) {
    const t = content.find((c) => c?.type === "text")?.text;
    if (typeof t === "string") { try { payload = JSON.parse(t); } catch { payload = null; } }
  }
  if (!payload) payload = result;
  return { result, content, structured, payload };
}

/** Byte cost of one field inside its parent, including key, quotes, comma. */
function fieldWeights(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj)
    .map(([k, v]) => ({ key: k, bytes: B(JSON.stringify(k)) + 1 + B(JSON.stringify(v ?? null)) + 1 }))
    .sort((a, b) => b.bytes - a.bytes);
}

function itemsOf(payload) {
  for (const k of ["messages", "inboxes", "folders", "drafts", "contacts", "scheduled_sends"]) {
    if (Array.isArray(payload?.[k])) return { key: k, items: payload[k] };
  }
  return { key: null, items: null };
}

function bar(frac, width = 24) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return "#".repeat(n) + ".".repeat(width - n);
}

// ── Report ──────────────────────────────────────────────────────────────────
function report(label, doc) {
  const { result, content, structured, payload } = unwrap(doc);
  const wire = measure(JSON.stringify(doc));
  const textBlock = content?.find((c) => c?.type === "text")?.text ?? null;

  console.log("\n" + "=".repeat(72));
  console.log(label);
  console.log("=".repeat(72));
  console.log(`tokenizer: ${TOK.name}${TOK.exact ? "" : "  [ESTIMATE]"}`);
  console.log(`wire (whole JSON-RPC frame) : ${fmt(wire.bytes)} B   ${fmt(wire.tokens)} tok`);

  if (textBlock !== null) {
    const t = measure(textBlock);
    const pretty = /\n\s\s/.test(textBlock);
    console.log(`content[].text              : ${fmt(t.bytes)} B   ${fmt(t.tokens)} tok   ${pretty ? "(PRETTY-PRINTED)" : "(compact)"}`);
    if (pretty) {
      try {
        const c = measure(JSON.stringify(JSON.parse(textBlock)));
        console.log(`  same JSON, compact        : ${fmt(c.bytes)} B   ${fmt(c.tokens)} tok   ` +
          `-> pretty costs +${fmt(t.tokens - c.tokens)} tok (${Math.round((t.tokens / c.tokens - 1) * 100)}%)`);
      } catch { /* not JSON */ }
    }
  }
  if (structured !== null) {
    const s = measure(JSON.stringify(structured));
    console.log(`structuredContent           : ${fmt(s.bytes)} B   ${fmt(s.tokens)} tok`);
    if (textBlock !== null) {
      console.log(`  >> DUPLICATION: text + structuredContent carry the same object.`);
      console.log(`     A client forwarding both spends ${fmt(measure(textBlock).tokens + s.tokens)} tok for ${fmt(s.tokens)} tok of information.`);
    }
  }

  const { key, items } = itemsOf(payload);
  if (items && items.length) {
    const each = items.map((it) => measure(JSON.stringify(it)));
    const total = each.reduce((a, b) => a + b.bytes, 0);
    const totTok = each.reduce((a, b) => a + b.tokens, 0);
    console.log(`\n${key}: ${items.length} item(s)`);
    console.log(`  per item (mean)           : ${fmt(Math.round(total / items.length))} B   ${fmt(Math.round(totTok / items.length))} tok`);
    console.log(`  largest item              : ${fmt(Math.max(...each.map((e) => e.bytes)))} B`);
    console.log(`  smallest item             : ${fmt(Math.min(...each.map((e) => e.bytes)))} B`);

    // Per-item field weights, summed across all items.
    const agg = new Map();
    for (const it of items) for (const f of fieldWeights(it)) agg.set(f.key, (agg.get(f.key) ?? 0) + f.bytes);
    const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]);
    const max = rows[0]?.[1] ?? 1;
    console.log(`\n  per-item field weights (summed over ${items.length} items, compact JSON bytes):`);
    for (const [k, v] of rows) {
      console.log(`    ${bar(v / max)} ${String(v).padStart(8)} B  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
    }
  }

  const top = fieldWeights(payload);
  if (top.length) {
    const total = top.reduce((a, b) => a + b.bytes, 0);
    const max = top[0].bytes;
    console.log(`\n  top-level field weights (compact JSON bytes):`);
    for (const f of top) {
      console.log(`    ${bar(f.bytes / max)} ${String(f.bytes).padStart(8)} B  ${(f.bytes / total * 100).toFixed(1).padStart(5)}%  ${f.key}`);
    }
  }

  if (result?.isError) console.log("\n  note: isError=true (error result, not a success payload)");
  return wire;
}

// ── Entry point ─────────────────────────────────────────────────────────────
function parseDocs(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try { return [JSON.parse(trimmed)]; } catch { /* try NDJSON */ }
  return trimmed.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const args = process.argv.slice(2);

if (args[0] === "--self-test") {
  const payload = { messages: [{ id: "x", subject: "hi", body_text: "hello world" }], has_more: false, next_offset: 1 };
  report("SELF TEST", { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload } });
  process.exit(0);
}

let totalWire = 0, totalTok = 0, n = 0;
if (args.length === 0) {
  const text = readFileSync(0, "utf8");
  for (const [i, doc] of parseDocs(text).entries()) {
    const w = report(`<stdin>${parseDocs(text).length > 1 ? ` [${i}]` : ""}`, doc);
    totalWire += w.bytes; totalTok += w.tokens; n++;
  }
} else {
  for (const f of args) {
    for (const [i, doc] of parseDocs(readFileSync(f, "utf8")).entries()) {
      const w = report(`${f}${i ? ` [${i}]` : ""}`, doc);
      totalWire += w.bytes; totalTok += w.tokens; n++;
    }
  }
}

if (n > 1) {
  console.log("\n" + "=".repeat(72));
  console.log(`TOTAL over ${n} responses: ${fmt(totalWire)} B   ${fmt(totalTok)} tok${TOK.exact ? "" : "  [ESTIMATE]"}`);
  console.log("=".repeat(72));
}
