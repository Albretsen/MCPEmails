#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The quoted original of a reply draft (release review, 2026-10-17), driven
// through the REAL card.
//
//   node harness/draft-quote.test.mjs
//
// QA found a reply whose Signature row read "Asgeir Albretsen + 17 more
// lines": `splitBody` took the last `-- ` line, so the quoted thread was "the
// signature", and its Edit box held the whole original. The server now marks
// where the quote starts (`body.quoted.line`), and the card shows it as a
// read-only section of its own. Groups:
//
//   P. the pure split: byte-exact, defensive about the marker.
//   Q. rendering: the Signature row is the signature, the quote is collapsed
//      to its attribution and expands read only.
//   E. edit isolation: editing the message or the signature saves the quote
//      back byte for byte (CRLF included), and no box contains it.
//   B. backward compatibility: no marker is the old behaviour; a deferred body
//      brings its marker through `_meta`.
//   N. the signature notes: none without a signature, the inbox's first line
//      when the draft lacks it, and the sign-off hint.
//
// Same scripted host as draft-polish.test.mjs (copied, as every DOM suite
// here owns its own).
// ---------------------------------------------------------------------------

process.env.TZ = "UTC";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-quote.bundle.mjs");

const PROTOCOL_VERSION = "2026-01-26";
const UNSAVED_KEY = "mcpemails.unsaved.v1";
const CARD_KEY = "mcpemails.card.v3";

// ---- tiny harness -----------------------------------------------------------

const groups = [];
let current = null;

function group(name) {
  current = { name, checks: [] };
  groups.push(current);
}

function expect(label, actual, wanted) {
  current.checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
}

function expectJson(label, actual, wanted) {
  expect(label, JSON.stringify(actual), JSON.stringify(wanted));
}

const show = (s) => JSON.stringify(s);
const after = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => after(40);

/** Text a person must never be shown. All from the QA report. */
const FORBIDDEN = [/-32603/, /Failed to fetch/i, /draft_not_found/, /Reload the draft list/i, /Error:/];

function forbiddenIn(text) {
  return FORBIDDEN.filter((re) => re.test(text)).map(String);
}

// ---- fixtures ---------------------------------------------------------------

const INBOX = "51ab6d90-4c18-4a2f-9d77-8e6a1b022c9d";

function draftBlock(over = {}) {
  const { body, recipients, ...rest } = over;
  return {
    draft_id: "Drafts:102",
    id_is_stable: false,
    origin: "create",
    last_saved_at: new Date().toISOString(),
    last_saved_by: "agent",
    identity: { inbox_id: INBOX, email_address: "you@example.com", provider: "imap" },
    recipients: { to: ["dana@x.example"], cc: [], bcc: [], ...(recipients ?? {}) },
    subject: "Quarterly numbers",
    body: { text: "Here they are.", html: null, truncated: false, ...(body ?? {}) },
    attachments: [],
    signature: { embedded: false },
    in_reply_to: null,
    can_send: true,
    ...rest,
  };
}

function draftEnvelope(over = {}) {
  return {
    schema_version: "review-card-v1",
    card: "draft_editor",
    state: "editing",
    actor: { can_edit: true },
    dashboard_url: "https://mcpemails.com/dashboard",
    draft: draftBlock(over),
  };
}

/** The tools/call RESULT for a draft envelope. */
const draftResult = (over) => ({ structuredContent: draftEnvelope(over), content: [{ type: "text", text: "{}" }] });

/**
 * A refusal the way the server on `main` writes it: a failed receipt, with the
 * model's wording in `content` and (on old servers) in the receipt too.
 */
function failedResult(code, headline = "That draft could not be found.", detail = "Reload the draft list to get the current id.") {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${code}. ${headline} ${detail}` }],
    structuredContent: {
      schema_version: "review-card-v1",
      card: "receipt",
      state: "error",
      dashboard_url: "https://mcpemails.com/dashboard",
      receipt: {
        outcome: "failed",
        headline,
        detail,
        affected_count: 0,
        dashboard_url: "https://mcpemails.com/dashboard",
        error_code: code,
      },
      actor: { can_decide: false, reason: null },
    },
  };
}

const sentResult = () => ({
  content: [{ type: "text", text: "Sent." }],
  structuredContent: {
    schema_version: "review-card-v1",
    card: "receipt",
    state: "sent",
    receipt: { outcome: "sent", headline: "Sent.", detail: "", affected_count: 1, dashboard_url: null },
  },
});

/** A JSON-RPC error, the way QA saw a lost save. */
const TRANSPORT = { error: { code: -32603, message: "Failed to fetch" } };

// ---- the DOM, which is also the host ----------------------------------------

/**
 * Install a browser + host. `tools` maps a tool name to a function of the
 * arguments that returns a result object, `TRANSPORT`, or a promise of either.
 * Every call is recorded in `calls`.
 */
function installDom({ storage = null } = {}) {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
    pretendToBeVisual: true,
    url: "https://card.test/",
  });
  const w = dom.window;
  if (storage) {
    for (const [k, v] of storage.local) w.localStorage.setItem(k, v);
    for (const [k, v] of storage.session) w.sessionStorage.setItem(k, v);
  }

  const calls = [];
  const requests = [];
  const tools = {};

  function deliver(message) {
    queueMicrotask(() => {
      w.dispatchEvent(new w.MessageEvent("message", { data: message, source: w }));
    });
  }

  w.postMessage = (message) => {
    if (message.method === "ui/initialize") {
      deliver({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: { name: "scripted-host", version: "0.0.1" },
          hostCapabilities: { openLinks: {}, updateModelContext: {} },
          hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
        },
      });
      return;
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      calls.push({ name, args });
      const fn = tools[name];
      Promise.resolve(fn ? fn(args) : TRANSPORT).then((r) => {
        if (r && r.error) deliver({ jsonrpc: "2.0", id: message.id, error: r.error });
        else deliver({ jsonrpc: "2.0", id: message.id, result: r });
      });
      return;
    }
    if (message.id !== undefined && message.method) {
      requests.push({ method: message.method, params: message.params });
      // Any other request (update-model-context, display mode): answer empty.
      deliver({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  };

  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const key of ["window", "document", "Node", "Event", "MessageChannel", "ResizeObserver", "localStorage", "sessionStorage", "navigator", "DOMParser", "NodeFilter"]) {
    Object.defineProperty(globalThis, key, { value: w[key], configurable: true, writable: true });
  }
  for (const key of ["cancelAnimationFrame", "getComputedStyle", "requestAnimationFrame"]) {
    globalThis[key] = w[key].bind(w);
  }
  return { dom, w, calls, requests, tools, deliver };
}

let instance = 0;

async function boot(opts = {}) {
  const host = installDom(opts);
  const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
  // Send's undo window (DraftEditor.tsx#SEND_UNDO_MS) is pinned in
  // draft-send-safety.test.mjs. Here a send goes out on the next tick, so the
  // scenarios below read as they did before the window existed.
  mod.setSendUndoMs(0);
  const root = globalThis.document.getElementById("root");
  const until = Date.now() + 2000;
  while (Date.now() < until && !mod.getState().connected) await after(5);

  const btn = (re) =>
    [...root.querySelectorAll("button")].find((b) => re.test(b.textContent.trim())) ?? null;
  return {
    ...host,
    mod,
    root,
    text: () => root.textContent,
    btn,
    /** The result the host pushes for the call that mounted the card. */
    push: (env) =>
      host.deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: env, content: [{ type: "text", text: "Draft saved." }] },
      }),
    input: (id, value) => {
      const el = globalThis.document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new host.w.Event("input", { bubbles: true }));
    },
    value: (id) => globalThis.document.getElementById(id)?.value,
    press: (el) => {
      el.focus();
      el.click();
    },
    key: (el, key) =>
      el.dispatchEvent(new host.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    active: () => globalThis.document.activeElement,
    softOff: (b) => !!b && b.getAttribute("aria-disabled") === "true",
    storage: () => ({
      local: Object.entries({ ...host.w.localStorage }),
      session: Object.entries({ ...host.w.sessionStorage }),
    }),
    /**
     * The frame goes away. Its timers must not outlive it: they would write to
     * the NEXT scenario's storage, because the globals now point there.
     */
    // Preact 11 runs useEffect cleanups on unmount after paint (rAF, or a 35 ms
    // timeout), not synchronously. Wait for them, or the old card's unmount
    // cleanup (clearUnsaved) runs against the NEXT card's window and storage.
    kill: async () => {
      mod.disarmResultWatchdog();
      mod.render(null, root);
      await new Promise((r) => setTimeout(r, 60));
    },
    done: async () => {
      mod.disarmResultWatchdog();
      host.w.dispatchEvent(new host.w.Event("pagehide"));
      mod.render(null, root);
      await new Promise((r) => setTimeout(r, 60));
    },
  };
}

/** Boot, push a fresh draft, and wait for the editor. */
async function editor(over = {}, opts = {}) {
  const c = await boot(opts);
  c.push(draftEnvelope(over));
  await settle();
  return c;
}



/** A reply as the server writes it: message, signature, attribution, quote. */
const MESSAGE = "Thanks, Friday works for me.";
const SIGNATURE = "Asgeir Albretsen\nFounder, MCP Emails\nmcpemails.com";
// CRLF in the quote on purpose: a save must hand these bytes back unchanged,
// though a textarea would have turned them into LF.
const QUOTE =
  "\r\n\r\nOn Mon, 7 Sep 2026 17:32:55 +0000, Dana Example <dana@x.example> wrote:\r\n" +
  "> Can we move the call to Friday?\r\n>\r\n> -- \r\n> Dana\r\n> Unsubscribe: https://x.example/u";
const REPLY = `${MESSAGE}\n\n-- \n${SIGNATURE}${QUOTE}`;
/** The line the attribution is on, counted in "\n", as the server sends it. */
const QUOTE_LINE = REPLY.slice(0, REPLY.indexOf("On Mon")).split("\n").length - 1;

const reply = (over = {}) => ({
  body: { text: REPLY, html: null, quoted: { line: QUOTE_LINE }, ...(over.body ?? {}) },
  signature: { embedded: true },
  ...over,
  ...(over.body ? { body: { text: REPLY, html: null, quoted: { line: QUOTE_LINE }, ...over.body } } : {}),
});

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { setSendUndoMs } from "./src/components/DraftEditor";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { splitQuote, quotePreview, repeatsSignOff, splitBody, joinBody } from "./src/format";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-quote-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".css": "text" },
    logOverride: { "ignored-bare-import": "silent" },
    outfile: OUT,
  });

  const sigRow = (c) => [...c.root.querySelectorAll(".row.sig")].find((r) => /Signature/.test(r.textContent)) ?? null;
  const quoteRow = (c) => c.root.querySelector(".quote-row");
  const lastSave = (c) => c.calls.filter((x) => x.name === "draft_editor_save").at(-1)?.args ?? null;
  const saved = (c) => (args) =>
    draftResult(reply({ draft_id: "Drafts:140", origin: "save", body: { text: args.body_text ?? REPLY } }));

  // ── P. the pure split ─────────────────────────────────────────────────────
  group("P. splitQuote: byte-exact, and nothing for a marker that does not fit");
  {
    const c = await boot();
    const s = c.mod.splitQuote(REPLY, { line: QUOTE_LINE });
    expect("head is message + signature", s?.head, `${MESSAGE}\n\n-- \n${SIGNATURE}`);
    expect("quote keeps its blank lines and CRLF", s?.quote, QUOTE);
    expect("head + quote is the text", s ? s.head + s.quote : null, REPLY);
    expect("no marker: null", c.mod.splitQuote(REPLY, undefined), null);
    expect("a line past the end: null", c.mod.splitQuote(REPLY, { line: 999 }), null);
    expect("a fraction: null", c.mod.splitQuote(REPLY, { line: 1.5 }), null);
    expect("a string: null", c.mod.splitQuote(REPLY, { line: "3" }), null);
    expect("a marker on trailing blanks only: null", c.mod.splitQuote("Hi\n\n", { line: 2 }), null);
    expect("preview is the attribution", c.mod.quotePreview(QUOTE), "On Mon, 7 Sep 2026 17:32:55 +0000, Dana Example <dana@x.example> wrote:");
    expect("a bare > quote has a plain label", c.mod.quotePreview("\n\n> hi"), "Earlier message");
    expect("sign-off: Asgeir over Asgeir Albretsen", c.mod.repeatsSignOff("Hi.\n\nBest regards,\nAsgeir", "Asgeir Albretsen"), true);
    expect("sign-off: the full name", c.mod.repeatsSignOff("Hi.\nAsgeir Albretsen\n", "Asgeir Albretsen"), true);
    expect("no sign-off: Best regards alone", c.mod.repeatsSignOff("Hi.\n\nBest regards,", "Asgeir Albretsen"), false);
    expect("no sign-off: the name inside a sentence", c.mod.repeatsSignOff("Asgeir will call you.", "Asgeir Albretsen"), false);
    expect("no sign-off: a different name", c.mod.repeatsSignOff("Thanks,\nDana", "Asgeir Albretsen"), false);
    await c.kill();
  }

  // ── Q. rendering ──────────────────────────────────────────────────────────
  group("Q. the Signature row is the signature; the quote is its own collapsed section");
  {
    const c = await editor(reply());
    // One "\n" stays with the message: `splitBody`'s separator is
    // "\n-- \n", as it always was.
    expect("message box holds the message only", c.value("d-body"), `${MESSAGE}\n`);
    expect("signature row counts the signature's lines", sigRow(c)?.querySelector(".sig-text")?.textContent, "Asgeir Albretsen + 2 more lines");
    expect("a Quoted row", quoteRow(c)?.querySelector(".lbl")?.textContent, "Quoted");
    expect("collapsed to its attribution", /Dana Example <dana@x\.example> wrote:/.test(quoteRow(c)?.textContent ?? ""), true);
    expect("the quoted lines are not on screen", /Can we move the call/.test(c.text()), false);
    expect("no unsubscribe link in sight", /Unsubscribe/.test(c.text()), false);
    c.press(c.btn(/^Show quote$/));
    await settle();
    const region = c.root.querySelector("#d-quoted");
    expect("Show expands it", /Can we move the call to Friday\?/.test(region?.textContent ?? ""), true);
    expect("read only: not a text box", region?.tagName, "DIV");
    expect("no textarea holds it", [...c.root.querySelectorAll("textarea")].some((t) => /wrote:/.test(t.value)), false);
    expect("the link says Hide quote", !!c.btn(/^Hide quote$/), true);
    expect("aria-expanded follows", c.btn(/^Hide quote$/)?.getAttribute("aria-expanded"), "true");
    c.press(c.btn(/^Hide quote$/));
    await settle();
    expect("Hide collapses it", !!c.root.querySelector("#d-quoted"), false);
    expect("word count is the message's", /5 words/.test(c.text()), true);
    expect("nothing to save on open", c.softOff(c.btn(/^Save$/)), true);
    await c.done();
  }

  // ── E. edit isolation ─────────────────────────────────────────────────────
  group("E1. editing the signature never touches the quote");
  {
    const c = await editor(reply());
    c.tools.draft_editor_save = saved(c);
    c.press(c.btn(/^Edit$/));
    await settle();
    expect("the signature box holds the signature only", c.value("d-signature"), SIGNATURE);
    c.input("d-signature", "Asgeir");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    const body = lastSave(c)?.body_text;
    expect("saved: message, separator, new signature, quote verbatim", body, `${MESSAGE}\n\n-- \nAsgeir${QUOTE}`);
    expect("the quote's bytes (CRLF) are unchanged", body?.endsWith(QUOTE), true);
    await c.done();
  }

  group("E2. editing the message keeps signature and quote byte for byte");
  {
    const c = await editor(reply());
    c.tools.draft_editor_save = saved(c);
    c.input("d-body", "Friday at 3 then.\n");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("saved body", lastSave(c)?.body_text, `Friday at 3 then.\n\n-- \n${SIGNATURE}${QUOTE}`);
    expect("the quote is still shown after the save", !!quoteRow(c), true);
    await c.done();
  }

  group("E3. clearing the signature box still keeps the quote");
  {
    const c = await editor(reply());
    c.tools.draft_editor_save = saved(c);
    c.press(c.btn(/^Edit$/));
    await settle();
    c.input("d-signature", "");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("saved body ends in the quote", lastSave(c)?.body_text, `${MESSAGE}\n\n-- \n${QUOTE}`);
    await c.done();
  }

  group("E4. a reply with no signature: the message box stops at the quote");
  {
    const text = `Sounds good.${QUOTE}`;
    const line = text.slice(0, text.indexOf("On Mon")).split("\n").length - 1;
    const c = await editor({ body: { text, html: null, quoted: { line } }, signature: { embedded: false } });
    c.tools.draft_editor_save = (args) => draftResult({ draft_id: "Drafts:141", origin: "save", body: { text: args.body_text, html: null, quoted: { line } } });
    expect("message box", c.value("d-body"), "Sounds good.");
    expect("no Signature row", !!sigRow(c), false);
    expect("a Quoted row", !!quoteRow(c), true);
    c.input("d-body", "Sounds good, see you then.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("saved", lastSave(c)?.body_text, `Sounds good, see you then.${QUOTE}`);
    await c.done();
  }

  // ── B. backward compatibility ─────────────────────────────────────────────
  group("B1. an envelope without the marker behaves as before");
  {
    const c = await editor({ body: { text: REPLY, html: null }, signature: { embedded: true } });
    expect("no Quoted row", !!quoteRow(c), false);
    // The old split, unchanged: everything after the LAST `-- ` line.
    c.press(c.btn(/^Edit$/));
    await settle();
    // (A textarea's value is LF; the split itself is the old one.)
    expect("the signature box is the old split", c.value("d-signature"), c.mod.splitBody(REPLY).signature.replace(/\r\n/g, "\n"));
    await c.done();
  }

  group("B2. a deferred body brings its marker through _meta");
  {
    const c = await boot();
    const env = draftEnvelope(reply());
    env.schema_version = "review-card-v2";
    env.draft.body = { text: null, html: null, truncated: false, deferred: true };
    c.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: env,
        content: [{ type: "text", text: "{}" }],
        _meta: { "mcpemails/draft_body": { text: REPLY, html: null, truncated: false, quoted: { line: QUOTE_LINE } } },
      },
    });
    await settle();
    expect("no draft_read needed", c.calls.filter((x) => x.name === "draft_read").length, 0);
    expect("message box", c.value("d-body"), `${MESSAGE}\n`);
    expect("a Quoted row", !!quoteRow(c), true);
    await c.done();
  }

  // ── N. the signature notes ────────────────────────────────────────────────
  group("N1. no signature anywhere: no note at all");
  {
    const c = await editor({ body: { text: "Here they are." }, signature: { embedded: false } });
    expect("no signature note", /signature/i.test(c.text()), false);
    await c.done();
  }

  group("N2. the inbox has one the draft lacks: named, and never 'added when sent'");
  {
    const c = await editor({ body: { text: "Here they are." }, signature: { embedded: false, first_line: "Asgeir Albretsen" } });
    expect("names it", /Your signature \(Asgeir Albretsen\) is not in this draft/.test(c.text()), true);
    expect("does not promise to add it", /added when/.test(c.text()), false);
    await c.done();
  }

  group("N3. a signature the text shows: no note, even if the server said embedded false");
  {
    const c = await editor(reply({ signature: { embedded: false, first_line: "Asgeir Albretsen" } }));
    expect("no 'not in this draft' line", /not in this draft/.test(c.text()), false);
    await c.done();
  }

  group("N4. a sign-off over a signature that starts with the same name");
  {
    const text = `Thanks, Friday works.\n\nBest regards,\nAsgeir\n\n-- \n${SIGNATURE}${QUOTE}`;
    const line = text.slice(0, text.indexOf("On Mon")).split("\n").length - 1;
    const c = await editor({ body: { text, html: null, quoted: { line } }, signature: { embedded: true } });
    expect("the hint", /Your message already ends with a sign-off\./.test(c.text()), true);
    c.input("d-body", "Thanks, Friday works.\n\nBest regards,");
    await settle();
    expect("gone once the name is gone", /already ends with a sign-off/.test(c.text()), false);
    await c.done();
  }

  group("N5. no hint without a repeated name");
  {
    const c = await editor(reply());
    expect("no hint", /already ends with a sign-off/.test(c.text()), false);
    await c.done();
  }

  // ---- report ---------------------------------------------------------------

  let failed = 0;
  for (const g of groups) {
    const bad = g.checks.filter((c) => !c.ok);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "}  ${g.name}`);
    for (const c of bad) {
      console.log(`        ${c.label}: got ${show(c.actual)}, want ${show(c.wanted)}`);
    }
  }
  const total = groups.reduce((n, g) => n + g.checks.length, 0);
  console.log(`\n${total - failed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
