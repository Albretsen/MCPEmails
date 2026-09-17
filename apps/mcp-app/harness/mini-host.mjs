#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A browser host for the card, in one file, with a storage inspector.
//
//   node harness/mini-host.mjs          # http://localhost:3012
//
// Why this exists alongside fixture-server.mjs: that one is an MCP SERVER and
// needs the ext-apps `basic-host` reference app (cloned into a scratchpad, long
// gone) to put a browser in front of it. The WS-1b audit is about what the card
// leaves behind in WEB STORAGE, which is a question you can only answer in a
// real browser, so this serves the built bundle in an iframe and speaks the
// same postMessage JSON-RPC the sandbox proxy does — no clone, no build step
// beyond `npm run build`.
//
// It deliberately serves the card SAME-ORIGIN with the page that inspects its
// storage. That is not laziness: it is the audit's open question made concrete.
// If Claude's sandbox gives every MCP App one shared origin, then any other
// installed app reads our `localStorage` exactly the way `dump()` does here.
// We cannot see inside Claude's sandbox to find out, so the card is written so
// that the answer does not change the outcome — and this page is where you
// check that claim byte by byte.
//
// Not shipped. Knows nothing about auth.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const PORT = Number(process.env.MINI_HOST_PORT ?? 3012);

/** `?card=before` serves a bundle built from another checkout, when present. */
const CARDS = {
  current: resolve(appRoot, "dist/index.html"),
  before: resolve(appRoot, "dist/card-before.html"),
};

const FIXTURES = {
  draft: F.draftEditorImap,
  outbound: F.outboundGmail,
  bulk: F.bulkDelete,
  receipt: F.receiptSent,
  // The two hostile pushes from the audit.
  draftless: { schema_version: "review-card-v1", card: "draft_editor" },
  someone_else: {
    ...F.draftEditorImap,
    draft: {
      ...F.draftEditorImap.draft,
      draft_id: "Drafts:999",
      subject: "SOMEONE ELSE'S CALL",
      body: { text: "This body belongs to another conversation.", html: null },
    },
  },
  // What the server would send for an internal workspace once the envelope
  // carries the flag (contract.ts#Envelope.diagnostics).
  draft_internal: { ...F.draftEditorImap, diagnostics: true },
  // The send of the draft above. Pushed on top of a mounted draft it is the
  // whole of the "I cannot see what I just sent" fix: the receipt wins, and
  // store.ts#carrySentDraft keeps the message under it.
  sent: { ...F.draftSendReceiptMerged, draft_id: F.draftEditorImap.draft.draft_id },
  // The same transition for a discard, which must NOT keep the message.
  discarded: {
    ...F.draftDeleteReceiptMerged,
    draft_id: F.draftEditorImap.draft.draft_id,
  },
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>mini host</title>
<style>
  body { font: 13px ui-monospace, monospace; margin: 12px; display: grid; gap: 10px;
         grid-template-columns: 420px 1fr; align-items: start; }
  iframe { width: 420px; height: 620px; border: 1px solid #ccc; background: #fff; }
  button { font: inherit; margin: 0 4px 4px 0; }
  pre { white-space: pre-wrap; word-break: break-all; background: #f6f6f6; padding: 8px;
        max-height: 620px; overflow: auto; }
  h2 { font-size: 13px; margin: 6px 0 2px; }
</style>
<div>
  <div id="controls"></div>
  <iframe id="card" src="/card.html"></iframe>
</div>
<div>
  <h2>localStorage, read from a DIFFERENT page on the card's origin</h2>
  <pre id="storage">(press "dump storage")</pre>
  <h2>host log</h2>
  <pre id="log"></pre>
</div>
<script>
const FIXTURES = __FIXTURES__;
const frame = document.getElementById("card");
const logEl = document.getElementById("log");
const storeEl = document.getElementById("storage");
const log = (...a) => { logEl.textContent = a.join(" ") + "\\n" + logEl.textContent; };

let mountedFixture = "draft";
let mountedArgs = { action: "create", inbox: "demo@mcpemails.com" };

function post(msg) { frame.contentWindow.postMessage(msg, "*"); }

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize") {
    log("<- ui/initialize");
    post({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "mini-host", version: "0.0.1" },
      hostCapabilities: { openLinks: {}, updateModelContext: {}, serverTools: {} },
      // toolInfo deliberately absent, like Claude: the card must run on the
      // argument-hash branch of persist.ts#cardKey.
      hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline","fullscreen"] },
    }});
    return;
  }
  if (m.method === "tools/call") {
    const name = m.params?.name;
    log("<- tools/call", name, JSON.stringify(m.params?.arguments ?? {}));
    // "?fail=1": every server call is refused. This is how the restore path's
    // failure rendering gets exercised — a restored stub has no content to
    // fall back on, so a refused draft_read must end in one line, not in an
    // empty editor over a real draft.
    if (new URLSearchParams(location.search).get("fail")) {
      post({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "host refused" } });
      return;
    }
    // draft_read is the re-request a restored stub makes. Everything else gets
    // the mounted fixture back so the card has something coherent.
    const result = name === "draft_read" ? FIXTURES.draft : (FIXTURES[mountedFixture] ?? FIXTURES.draft);
    post({ jsonrpc: "2.0", id: m.id, result: { structuredContent: result, content: [{ type: "text", text: "ok" }] } });
    return;
  }
  if (m.method === "ui/open-link" || m.method === "ui/update-model-context" || m.method === "ui/request-display-mode") {
    log("<-", m.method, JSON.stringify(m.params ?? {}).slice(0, 120));
    if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
    return;
  }
  if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
});

function mount(fixture, { withResult = true, args } = {}) {
  mountedFixture = fixture;
  if (args) mountedArgs = args;
  frame.src = "/card.html" + location.search;
  frame.onload = () => setTimeout(() => {
    post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: mountedArgs } });
    if (withResult) {
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
             params: { structuredContent: FIXTURES[fixture], content: [{ type: "text", text: "ok" }] } });
    }
    log("-> mounted", fixture, withResult ? "with result" : "WITHOUT result (remount)");
  }, 60);
}

function push(fixture) {
  post({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
         params: { structuredContent: FIXTURES[fixture], content: [{ type: "text", text: "ok" }] } });
  log("-> pushed a SECOND tool-result:", fixture);
}

function dump() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out.push(k + " = " + localStorage.getItem(k));
  }
  storeEl.textContent = out.length ? out.join("\\n\\n") : "(empty)";
}

const buttons = [
  ["mount draft", () => mount("draft")],
  ["mount outbound", () => mount("outbound", { args: { approval_id: "ap-1" } })],
  ["remount draft (no result)", () => mount("draft", { withResult: false })],
  ["push draft-less envelope", () => push("draftless")],
  ["push someone else's draft", () => push("someone_else")],
  ["mount internal draft (diagnostics)", () => mount("draft_internal")],
  ["send the mounted draft", () => push("sent")],
  ["discard the mounted draft", () => push("discarded")],
  ["dump storage", dump],
  ["clear storage", () => { localStorage.clear(); dump(); }],
];
for (const [label, fn] of buttons) {
  const b = document.createElement("button");
  b.textContent = label;
  b.id = "btn-" + label.replace(/[^a-z]+/gi, "-").toLowerCase();
  b.onclick = fn;
  document.getElementById("controls").append(b);
}
</script>`;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/card.html") {
    const which = url.searchParams.get("card") === "before" ? "before" : "current";
    const file = CARDS[which];
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/html" }).end(`missing ${file}`);
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      .end(readFileSync(file));
    return;
  }
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    // `<`: the fixtures carry deliberately hostile markup, including a
    // literal `</script>`, and inlining them raw would close this page's own
    // script tag. Exactly the class of bug the fixtures exist to catch, found
    // by the fixtures. Escaping `<` is the standard answer.
    .end(
      PAGE.replace("__FIXTURES__", JSON.stringify(FIXTURES).replace(/</g, "\\u003c")),
    );
}).listen(PORT, () => {
  console.log(`[mini-host] http://localhost:${PORT}  (?card=before for the old bundle)`);
});
