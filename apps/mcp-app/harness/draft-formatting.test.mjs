#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A formatted draft and the plain-text editor (QA, 2026-10-17), driven through
// the REAL card.
//
//   node harness/draft-formatting.test.mjs
//
// Same scripted host as draft-polish.test.mjs. One typed word into a draft with
// a heading, bold text, a list and a link was saved as plain text with no
// warning and no notice. Groups:
//
//   W. the warning: none for an edit the server makes inside the HTML (it runs
//      the same html-text-merge.ts), one for an edit it cannot, and the
//      formatted preview withdrawn while it shows.
//   U. "Keep the formatting" puts the stored message back, and focus with it.
//   N. the notice after a save that removed formatting.
//   T. the toggle between the preview and the box keeps focus in the frame.
// ---------------------------------------------------------------------------

// Dates are asserted as text, so the zone is pinned before anything reads it.
process.env.TZ = "UTC";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-formatting.bundle.mjs");

const PROTOCOL_VERSION = "2026-01-26";

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

const show = (s) => JSON.stringify(s);
const after = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => after(40);

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



const FORMATTED_HTML =
  "<h2>Launch plan</h2>\n<p>We ship on <b>Friday</b> after the review.</p>\n" +
  "<ul><li>Fix the footer</li><li>Update the docs</li></ul>\n" +
  '<p>Details are <a href="https://example.com/plan">in the plan</a>.</p>';
const FORMATTED_TEXT =
  "Launch plan\n\nWe ship on Friday after the review.\n\n- Fix the footer\n- Update the docs\n\nDetails are in the plan (https://example.com/plan).";
const formatted = (over = {}) => ({ body: { text: FORMATTED_TEXT, html: FORMATTED_HTML }, ...over });
const WARNING = /Saving\s+this edit turns the whole message into plain text/;

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { setSendUndoMs } from "./src/components/DraftEditor";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-formatting-entry.ts",
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

  // ── W. The warning ────────────────────────────────────────────────────────

  group("W1. one typed word that the server keeps inside the HTML: no warning");
  {
    const c = await editor(formatted());
    let saved = null;
    c.tools.draft_editor_save = (args) => {
      saved = args;
      return draftResult({ draft_id: "Drafts:140", origin: "save", body: { text: args.body_text, html: FORMATTED_HTML.replace("after", "right after") } });
    };
    c.input("d-body", FORMATTED_TEXT.replace("after the review", "right after the review"));
    await settle();
    expect("no warning", WARNING.test(c.text()), false);
    expect("the preview is still offered", !!c.btn(/^Show formatting$/), true);
    c.press(c.btn(/^Save$/));
    await settle();
    expect("the save went out", saved?.body_text?.includes("right after"), true);
    expect("no removal notice", /removed this draft's formatting/.test(c.text()), false);
    expect("and the preview is still offered after it", !!c.btn(/^Show formatting$/), true);
    await c.done();
  }

  group("W2. an edit the server cannot place: warned before saving, preview withdrawn");
  {
    const c = await editor(formatted());
    expect("nothing before an edit", WARNING.test(c.text()), false);
    c.input("d-body", FORMATTED_TEXT + "\n\nOne more thing.");
    await settle();
    expect("the warning shows", WARNING.test(c.text()), true);
    expect("as a warning notice", !!c.root.querySelector('.notice[data-tone="warning"]'), true);
    expect("next to the body, before the action row", (() => {
      const n = c.root.querySelector('.notice[data-tone="warning"]');
      const body = c.root.querySelector("#d-body");
      return !!n && !!body && !!(body.compareDocumentPosition(n) & c.w.Node.DOCUMENT_POSITION_FOLLOWING);
    })(), true);
    expect("with a way back", !!c.btn(/^Keep the formatting$/), true);
    expect("the formatted preview is withdrawn", !!c.btn(/^Show formatting$/), false);
    // Editing a link's words is never made inside the HTML either.
    c.input("d-body", FORMATTED_TEXT.replace("in the plan (", "in the new plan ("));
    await settle();
    expect("a link's words: warned too", WARNING.test(c.text()), true);
    // And a line-ending-only difference is no edit.
    c.input("d-body", FORMATTED_TEXT.replace(/\n/g, "\r\n"));
    await settle();
    expect("CRLF alone: no warning", WARNING.test(c.text()), false);
    await c.done();
  }

  group("W3. a plain draft (text with line breaks) is never warned about");
  {
    const c = await editor({ body: { text: "Hi,\nsee you.", html: "Hi,<br>\nsee you." } });
    c.input("d-body", "Hi,\nsee you.\n\nA new paragraph.");
    await settle();
    expect("no warning", WARNING.test(c.text()), false);
    await c.done();
  }

  // ── U. Keep the formatting ────────────────────────────────────────────────

  group("U1. Keep the formatting restores the stored message and focus");
  {
    const c = await editor(formatted());
    c.input("d-body", "Launch plan\n\nAll rewritten.\n\n- Fix the footer\n- Update the docs\n\nDetails are in the plan (https://example.com/plan).\nExtra");
    await settle();
    c.press(c.btn(/^Keep the formatting$/));
    await settle();
    expect("the stored text is back", c.value("d-body"), FORMATTED_TEXT);
    expect("the warning is gone", WARNING.test(c.text()), false);
    expect("the preview is offered again", !!c.btn(/^Show formatting$/), true);
    expect("nothing left to save", c.softOff(c.btn(/^Save$/)), true);
    expect("focus is in the message box, not dropped", c.active()?.id, "d-body");
    await c.done();
  }

  // ── N. After a save that removed formatting ──────────────────────────────

  group("N1. the save that removed the formatting says so");
  {
    const c = await editor(formatted());
    c.tools.draft_editor_save = (args) =>
      draftResult({ draft_id: "Drafts:141", origin: "save", body: { text: args.body_text, html: null, formatting_removed: true } });
    c.input("d-body", FORMATTED_TEXT + "\nP.S.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("the save landed", c.mod.getState().envelope?.draft?.draft_id, "Drafts:141");
    expect("the notice shows", /removed this draft's formatting, so it is plain text now/.test(c.text()), true);
    expect("the warning has gone with the edit", WARNING.test(c.text()), false);
    expect("no formatted view is offered", !!c.btn(/^Show formatting$/), false);
    await c.done();
  }

  group("N2. the notice follows the server's flag even with an HTML part present");
  {
    const c = await editor({ body: { text: "Hi.", html: "Hi.", formatting_removed: true } });
    expect("the notice shows", /removed this draft's formatting/.test(c.text()), true);
    await c.done();
  }

  // ── T. The toggle keeps focus in the frame ───────────────────────────────

  group("T1. Show formatting / Edit plain text move focus deliberately");
  {
    const c = await editor(formatted());
    c.root.querySelector("#d-body").focus();
    const show = c.btn(/^Show formatting$/);
    // The click a mouse makes on a platform that does not focus buttons: focus
    // is still in the box that is about to be replaced.
    show.click();
    await settle();
    expect("the preview is up", !!c.root.querySelector(".html-preview"), true);
    expect("focus is on the toggle, not dropped", c.active()?.textContent?.trim(), "Edit plain text");
    c.btn(/^Edit plain text$/).click();
    await settle();
    expect("the box is back", !!c.root.querySelector("#d-body"), true);
    expect("focus is in the box", c.active()?.id, "d-body");
    expect("never the document body", c.active() === c.w.document.body, false);
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
