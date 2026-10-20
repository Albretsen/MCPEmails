#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "Show" on the line a draft card ends on (2026-10-14), driven through the
// REAL card the way draft-state.test.mjs does: `main.tsx` in jsdom, with this
// file playing the host.
//
//   node harness/draft-ended.test.mjs
//
//   1. A send made in the card: open on arrival, Hide folds it to the one line,
//      Show opens it again, the toggle announces its state and keeps focus.
//   2. A discard: one line with Show; the text it had, unsaved changes named,
//      and Copy text.
//   3. Discard that finds the draft already sent: the card's copy, said to be
//      the card's copy.
//   4. Reopening the chat after a send: Show reveals what was SENT (the text
//      saved in the card), never the assistant's original, while the replay is
//      checked and after.
//   5. Reopening with no stored copy (another tab, another device): the one
//      line and no Show at all.
//   6. Reopening after a discard with unsaved edits: the edited text.
//   7. A send the assistant made (its own card): no copy, no Show.
//   8. What is stored where: nothing in localStorage, the copy expires, and
//      a copy from another mailbox is not shown.
//
// DEPENDENCIES: esbuild and jsdom, resolved as in draft-qa.test.mjs.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-ended.bundle.mjs");

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

function expectJson(label, actual, wanted) {
  expect(label, JSON.stringify(actual), JSON.stringify(wanted));
}

const show = (s) => JSON.stringify(s);
const after = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => after(40);

// ---- fixtures ---------------------------------------------------------------

const INBOX = "51ab6d90-4c18-4a2f-9d77-8e6a1b022c9d";
const OLD = () => new Date(Date.now() - 600_000).toISOString();

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

const draftResult = (over) => ({ structuredContent: draftEnvelope(over), content: [{ type: "text", text: "{}" }] });

function failedResult(code, headline = "This draft is no longer in your mailbox.", detail = "It was probably sent or deleted.") {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${code}.` }],
    structuredContent: {
      schema_version: "review-card-v1",
      card: "receipt",
      state: "error",
      dashboard_url: "https://mcpemails.com/dashboard",
      receipt: { outcome: "failed", headline, detail, affected_count: 0, dashboard_url: null, error_code: code },
      actor: { can_decide: false, reason: null },
    },
  };
}

const receiptResult = (outcome, headline, state) => ({
  content: [{ type: "text", text: headline }],
  structuredContent: {
    schema_version: "review-card-v1",
    card: "receipt",
    state,
    receipt: { outcome, headline, detail: "", affected_count: 1, dashboard_url: null },
  },
});
const sentResult = () => receiptResult("sent", "Sent.", "sent");
const discardedResult = () => receiptResult("discarded", "Draft discarded. Nothing was sent.", "rejected");

const TRANSPORT = { error: { code: -32603, message: "Failed to fetch" } };

/** The mounting call's arguments. The host re-sends them on every mount. */
const TOOL_INPUT = {
  jsonrpc: "2.0",
  method: "ui/notifications/tool-input",
  params: { arguments: { action: "create", inbox_id: INBOX, to: ["dana@x.example"], subject: "Quarterly numbers", body: "Here they are." } },
};

// ---- the DOM, which is also the host ----------------------------------------

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
    if (message.method) requests.push({ method: message.method, params: message.params });
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
    if (message.method === "ui/request-display-mode") {
      deliver({ jsonrpc: "2.0", id: message.id, result: { mode: message.params.mode } });
      return;
    }
    if (message.id !== undefined && message.method) {
      deliver({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  };

  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const key of ["window", "document", "Node", "Event", "MessageChannel", "ResizeObserver", "localStorage", "sessionStorage", "navigator"]) {
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
    /** Is the full editor on screen, as opposed to one line? */
    isEditor: () => !!globalThis.document.getElementById("d-subject"),
    press: (el) => {
      el.focus();
      el.click();
    },
    softOff: (b) => !!b && b.getAttribute("aria-disabled") === "true",
    /** The host says the card is fullscreen now. */
    goFullscreen: () =>
      host.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "fullscreen" } }),
    modeRequests: () =>
      host.requests.filter((r) => r.method === "ui/request-display-mode").map((r) => r.params.mode),
    /** Focus comes into the frame from outside, as on a click or a Tab. */
    attend: () => host.w.dispatchEvent(new host.w.Event("focus")),
    storage: () => ({
      local: Object.entries({ ...host.w.localStorage }),
      session: Object.entries({ ...host.w.sessionStorage }),
    }),
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
  if (opts.input !== false) c.deliver(TOOL_INPUT);
  c.push(draftEnvelope(over));
  await settle();
  return c;
}

/** Run `fn` with the clock moved forward, as if the card had sat for a while. */
async function later(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}


/** `draft{action:"send"}` as the server answers it: today's payload plus the receipt (§8). */
const sendAnswer = (args = {}, detail = "Accepted by the mail server for delivery.") => ({
  content: [{ type: "text", text: "Sent." }],
  structuredContent: {
    draft_id: args.draft_id ?? "Drafts:102",
    message_id: "<m1@x.example>",
    sent_at: new Date().toISOString(),
    schema_version: "review-card-v1",
    card: "receipt",
    state: "sent",
    dashboard_url: "https://mcpemails.com/dashboard",
    receipt: { outcome: "sent", headline: "Sent", detail, affected_count: 1, dashboard_url: null },
  },
});

const ENDED_KEY = "mcpemails.ended.v1";

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { setSendUndoMs } from "./src/components/DraftEditor";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { FLASH_MS } from "./src/components/ui";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-ended-entry.ts",
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

  const toggleOf = (c) => c.btn(/^(Show|Hide)$/);
  const active = (c) => c.w.document.activeElement;

  /** Discard from the editor, through the inline confirm. */
  async function discard(c) {
    c.press(c.btn(/^Delete draft$/));
    await settle();
    c.press(c.btn(/^Yes, delete$/));
    await settle();
  }

  /** Send from the editor after editing the body: the save, then the send. */
  async function sendEdited(c, text) {
    c.tools.draft_editor_save = (args) => draftResult({
      draft_id: "Drafts:103", origin: "save", last_saved_by: "user", revision: 2,
      body: { text: args.body_text },
    });
    c.tools.draft = (args) => sendAnswer(args);
    c.input("d-body", text);
    await settle();
    c.press(c.btn(/^Send$/));
    await settle();
    await settle();
  }

  // ── 1. A send made in the card ───────────────────────────────────────────

  group("1a. a send made here opens on arrival, and Hide folds it to the one line");
  {
    const c = await editor();
    c.tools.draft = (args) => sendAnswer(args);
    c.press(c.btn(/^Send$/));
    await settle();
    expect("the editor is gone", c.isEditor(), false);
    expect("the message is on screen", /Here they are\./.test(c.text()), true);
    expect("no dashboard link: the dashboard has no view of it", !!c.btn(/dashboard/i), false);
    // QA 2026-10-15: "Delivered" claimed more than is known, and the provider
    // label was on the receipt twice.
    expect("accepted, not delivered", /Accepted by the mail server for delivery\./.test(c.text()), true);
    expect("never 'Delivered'", /Delivered/.test(c.text()), false);
    expect("no provider label in the detail", /IMAP \+ SMTP/.test(c.text()), false);
    const hide = toggleOf(c);
    expect("the toggle says Hide", hide?.textContent, "Hide");
    expect("and is expanded", hide?.getAttribute("aria-expanded"), "true");
    const region = hide?.getAttribute("aria-controls");
    expect("it names what it controls", !!region && !!c.w.document.getElementById(region), true);
    expect("which holds the message", /Here they are\./.test(c.w.document.getElementById(region)?.textContent ?? ""), true);
    c.press(hide);
    await settle();
    expect("folded: the message is gone", /Here they are\./.test(c.text()), false);
    expect("folded: the receipt headline stays", /^Sent/.test(c.text()), true);
    const show = toggleOf(c);
    expect("folded: the toggle says Show", show?.textContent, "Show");
    expect("folded: not expanded", show?.getAttribute("aria-expanded"), "false");
    expect("folded: no dangling aria-controls", show?.getAttribute("aria-controls"), null);
    expect("focus stayed on the toggle", active(c) === show, true);
    expect("folded: one header and nothing else", c.root.querySelectorAll(".hdr").length, 1);
    c.press(show);
    await settle();
    expect("Show opens it again", /Here they are\./.test(c.text()), true);
    expect("focus is on Hide now", active(c)?.textContent, "Hide");
    expect("no Copy text on a send", !!c.btn(/^Copy text$/), false);
    await c.done();
  }

  group("1b. Hide in fullscreen asks for inline again");
  {
    const c = await editor();
    c.tools.draft = (args) => sendAnswer(args);
    c.press(c.btn(/^Send$/));
    await settle();
    c.goFullscreen();
    await settle();
    expect("fullscreen shows Collapse", !!c.btn(/^Collapse$/), true);
    const before = c.modeRequests().length;
    c.press(toggleOf(c));
    await settle();
    expect("one more request", c.modeRequests().length, before + 1);
    expect("for inline", c.modeRequests().at(-1), "inline");
    expect("and the line is folded", toggleOf(c)?.textContent, "Show");
    await c.done();
  }

  // ── 2. A discard ─────────────────────────────────────────────────────────

  group("2. a discard ends folded; Show has the text it had, unsaved changes named, and Copy text");
  {
    const c = await editor();
    c.tools.draft = () => discardedResult();
    c.input("d-subject", "Numbers, revised");
    await settle();
    await discard(c);
    expect("the editor is gone", c.isEditor(), false);
    expect("one line says it was discarded", /discarded/i.test(c.text()), true);
    expect("folded: no text", /Here they are|Numbers, revised/.test(c.text()), false);
    const show = toggleOf(c);
    expect("with Show", show?.textContent, "Show");
    c.press(show);
    await settle();
    expect("the unsaved subject is shown", /Numbers, revised/.test(c.text()), true);
    expect("and the body it had", /Here they are\./.test(c.text()), true);
    expect("labelled as the discarded text", /This is the text it had when it was discarded\./.test(c.text()), true);
    expect("naming what was never saved", /never saved: the subject\./.test(c.text()), true);
    expect("no send time on a discard", /Sent \S/.test(c.text()), false);
    let copied = null;
    Object.defineProperty(c.w.navigator, "clipboard", {
      value: { writeText: (t) => ((copied = t), Promise.resolve()) },
      configurable: true,
    });
    c.press(c.btn(/^Copy text$/));
    await settle();
    expect("Copy text puts subject and text on the clipboard", copied, "Numbers, revised\n\nHere they are.");
    expect("and says Copied", !!c.btn(/^Copied$/), true);
    await after(c.mod.FLASH_MS + 100);
    expect("then goes back", !!c.btn(/^Copy text$/), true);
    await c.done();
  }

  // ── 3. Discard that finds the draft gone ─────────────────────────────────

  group("3. Discard on a draft already sent elsewhere shows the card's copy, and says so");
  {
    const c = await editor();
    c.tools.draft = () => failedResult("draft_not_found", "This draft was already sent.");
    await discard(c);
    expect("the line says it was already sent", /This draft was already sent\./.test(c.text()), true);
    c.press(toggleOf(c));
    await settle();
    expect("the copy says whose it is", /This is the text this card had\. What was sent may differ\./.test(c.text()), true);
    expect("and has the text", /Here they are\./.test(c.text()), true);
    await c.done();

    const g = await editor();
    g.tools.draft = () => ({ isError: true, content: [{ type: "text", text: "Draft Drafts:102 no longer exists." }] });
    await discard(g);
    expect("gone: the one line", /This draft is no longer in Drafts\./.test(g.text()), true);
    g.press(toggleOf(g));
    await settle();
    expect("gone: the card's copy", /This is the text this card had\./.test(g.text()), true);
    expect("gone: Copy text is offered", !!g.btn(/^Copy text$/), true);
    await g.done();
  }

  // ── 4. Reopening the chat after a send ───────────────────────────────────

  /** A card that saved an edit and sent it, then the storage a reopen starts from. */
  async function sentEditedStorage() {
    const c = await editor();
    await sendEdited(c, "Edited before sending.");
    expect("(setup) the send happened", /Edited before sending\./.test(c.text()), true);
    const s = c.storage();
    await c.kill();
    return s;
  }

  group("4. reopened after a send: Show has what was SENT, never the assistant's original");
  {
    const s = await sentEditedStorage();
    const r = await boot({ storage: s });
    let answer;
    r.tools.draft_read = () => new Promise((res) => { answer = res; });
    r.deliver(TOOL_INPUT);
    await settle();
    expect("the one line is back", /^Sent\./.test(r.text()), true);
    expect("folded, with Show", toggleOf(r)?.textContent, "Show");
    expect("no text yet", /Edited before sending|Here they are/.test(r.text()), false);
    r.press(toggleOf(r));
    await settle();
    expect("Show: the sent text", /Edited before sending\./.test(r.text()), true);
    expect("Show: not the original", /Here they are/.test(r.text()), false);
    expect("Show: no discard label on a send", /This is the text/.test(r.text()), false);
    // The host replays the ORIGINAL result, which has the assistant's text.
    r.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    expect("during the check: still no editor", r.isEditor(), false);
    expect("during the check: still the sent text", /Edited before sending\./.test(r.text()), true);
    expect("during the check: never the original", /Here they are/.test(r.text()), false);
    answer(failedResult("draft_not_found", "This draft was already sent."));
    await settle();
    await settle();
    expect("after the check: a receipt", r.mod.getState().envelope?.card, "receipt");
    expect("after the check: still open on the sent text", /Edited before sending\./.test(r.text()), true);
    expect("after the check: never the original", /Here they are/.test(r.text()), false);
    r.press(toggleOf(r));
    await settle();
    expect("Hide folds it", /Edited before sending/.test(r.text()), false);
    await r.done();
  }

  // ── 5. Nothing stored ────────────────────────────────────────────────────

  group("5. reopened with no stored copy (another tab or device): the one line, no Show");
  {
    const s = await sentEditedStorage();
    const r = await boot({ storage: { local: s.local, session: [] } });
    r.tools.draft_read = () => failedResult("draft_not_found", "This draft was already sent.");
    r.deliver(TOOL_INPUT);
    await settle();
    expect("the one line", /^Sent\./.test(r.text()), true);
    expect("no Show", toggleOf(r), null);
    r.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("after the replay: still no Show", toggleOf(r), null);
    expect("and never the original text", /Here they are/.test(r.text()), false);
    expect("still one line", r.root.querySelectorAll(".hdr").length, 1);
    await r.done();

    // Nothing in either store (a new device): the replay ends on the server's
    // word, and there is nothing of this card's own to show.
    const n = await boot();
    n.tools.draft_read = () => failedResult("draft_not_found", "This draft was already sent.");
    n.deliver(TOOL_INPUT);
    n.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("new device: one line", /This draft was already sent\./.test(n.text()), true);
    expect("new device: no Show", toggleOf(n), null);
    await n.done();
  }

  // ── 6. Reopening after a discard ─────────────────────────────────────────

  group("6. reopened after a discard with unsaved edits: Show has the edited text, labelled");
  {
    const c = await editor();
    c.tools.draft = () => discardedResult();
    c.input("d-body", "A paragraph I want to keep.");
    await settle();
    await discard(c);
    const s = c.storage();
    await c.kill();

    const r = await boot({ storage: s });
    r.tools.draft_read = () => failedResult("draft_not_found", "This draft was discarded.");
    r.deliver(TOOL_INPUT);
    await settle();
    expect("the one line", /discarded/i.test(r.text()), true);
    r.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("no editor", r.isEditor(), false);
    r.press(toggleOf(r));
    await settle();
    expect("the edited text", /A paragraph I want to keep\./.test(r.text()), true);
    expect("not the assistant's", /Here they are/.test(r.text()), false);
    expect("named as never saved", /never saved: the message\./.test(r.text()), true);
    expect("Copy text", !!r.btn(/^Copy text$/), true);
    await r.done();
  }

  // ── 7. A send the assistant made ─────────────────────────────────────────

  group("7. the assistant's own send card has no copy, so no Show");
  {
    const c = await boot();
    c.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { action: "send", inbox_id: INBOX, draft_id: "Drafts:102" } },
    });
    c.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: sendAnswer() });
    await settle();
    expect("one line", /^Sent/.test(c.text()), true);
    expect("with the detail", /Accepted by the mail server for delivery\./.test(c.text()), true);
    expect("no Show", toggleOf(c), null);
    await c.done();
  }

  // ── 7b. "Delivered" said more than anyone knows (QA 2026-10-15) ─────────────

  group("7b. a receipt stored before 2026-10-15 is reworded: accepted, not delivered, no provider");
  {
    for (const old of ["Delivered via IMAP + SMTP.", "Delivered via IMAP + SMTP at 2026-09-17T08:04:11.394Z."]) {
      const c = await boot();
      c.deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { action: "send", inbox_id: INBOX, draft_id: "Drafts:102" } },
      });
      c.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: sendAnswer({}, old) });
      await settle();
      expect(`"${old}" -> accepted`, /Accepted by the mail server for delivery\./.test(c.text()), true);
      expect(`"${old}" -> never "Delivered"`, /Delivered/.test(c.text()), false);
      expect(`"${old}" -> no provider in the detail`, /IMAP \+ SMTP/.test(c.text()), false);
      await c.done();
    }
  }

  group("7c. the open sent message names the provider once, in its footer");
  {
    const c = await boot();
    c.deliver(TOOL_INPUT);
    c.push({
      ...draftEnvelope(),
      provider: { label: "IMAP + SMTP", route: "Saved to your Drafts folder", caveats: [] },
    });
    await settle();
    // The answer an un-updated server gives, so both halves are exercised.
    c.tools.draft = (args) => sendAnswer(args, "Delivered via IMAP + SMTP.");
    c.press(c.btn(/^Send$/));
    await settle();
    expect("the message is open", /Here they are\./.test(c.text()), true);
    expect("IMAP + SMTP exactly once", (c.text().match(/IMAP \+ SMTP/g) ?? []).length, 1);
    expect("accepted, not delivered", /Accepted by the mail server for delivery\./.test(c.text()), true);
    await c.done();
  }

  // ── 8. Storage ───────────────────────────────────────────────────────────

  group("8. storage: no content in localStorage; the copy expires and is per mailbox");
  {
    const s = await sentEditedStorage();
    const local = s.local.map(([k, v]) => `${k}=${v}`).join("\n");
    expect("localStorage has no body", local.includes("Edited before sending"), false);
    expect("localStorage has no subject", local.includes("Quarterly numbers"), false);
    expect("localStorage has no recipient", local.includes("dana@x.example"), false);
    const entry = s.session.find(([k]) => k === ENDED_KEY);
    expect("the copy is in sessionStorage", !!entry && entry[1].includes("Edited before sending"), true);
    expect("without an HTML part", !!entry && entry[1].includes("body_html"), false);

    const edit = (fn) => ({
      local: s.local,
      session: s.session.map(([k, v]) => (k === ENDED_KEY ? [k, JSON.stringify(JSON.parse(v).map(fn))] : [k, v])),
    });
    const stale = await boot({ storage: edit((e) => ({ ...e, t: Date.now() - 25 * 60 * 60 * 1000 })) });
    stale.deliver(TOOL_INPUT);
    await settle();
    expect("an expired copy: the one line", /^Sent\./.test(stale.text()), true);
    expect("an expired copy: no Show", toggleOf(stale), null);
    await stale.done();

    const other = await boot({ storage: edit((e) => ({ ...e, i: "0f0e0d0c-0b0a-4908-8706-050403020100" })) });
    other.deliver(TOOL_INPUT);
    await settle();
    expect("another mailbox's copy: no Show", toggleOf(other), null);
    await other.done();

    const broken = await boot({ storage: edit((e) => ({ ...e, c: { ...e.c, to: "dana@x.example" } })) });
    broken.deliver(TOOL_INPUT);
    await settle();
    expect("a malformed copy: no Show", toggleOf(broken), null);
    await broken.done();
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
