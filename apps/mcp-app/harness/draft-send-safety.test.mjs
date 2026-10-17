#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft card's send-safety fixes of 2026-10-15, driven through the REAL
// card the way draft-state.test.mjs does: `main.tsx` in jsdom, with this file
// playing the host.
//
//   node harness/draft-send-safety.test.mjs
//
// One group per finding of the QA report:
//
//   1. The footer does not move. Save and the Send slot keep their order,
//      their elements, their labels and a fixed width whatever the draft's
//      dirty or busy state. A click aimed at Save landed on what had just
//      grown into "Save and send", and sent a real reply.
//   2. Send has an undo window. Nothing is called until it runs out; Undo, a
//      double-click, an edit, unmount, pagehide and the host's teardown all
//      cancel it; Enter elsewhere in the card never sends.
//   3. Enter on a recipient that is not an address says so, and the next
//      address typed does not merge into it.
//   4. An older card notices a newer one without being touched: a hint from
//      another card frame (BroadcastChannel or a storage event), or the card
//      becoming visible again, re-reads the draft once and folds it.
//      Since 2026-10-17 (4f-4k): one current card per draft. A newer card's
//      hint folds the older card at once, unsaved edits and all (kept behind
//      "Show", Send never offered); a Save or "Open here" makes a card current
//      and its claim folds every other card for the draft at once.
//
// DEPENDENCIES: esbuild and jsdom, resolved as in draft-qa.test.mjs.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-send-safety.bundle.mjs");

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

// ---- another card frame -----------------------------------------------------

/** A BroadcastChannel stand-in: same name, other instance, next tick. */
class Bus {
  static open = new Set();
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    Bus.open.add(this);
  }
  postMessage(data) {
    const copy = JSON.parse(JSON.stringify(data));
    for (const ch of Bus.open) {
      if (ch !== this && ch.name === this.name) {
        queueMicrotask(() => ch.onmessage?.({ data: copy }));
      }
    }
  }
  close() {
    Bus.open.delete(this);
  }
}

// ---- the DOM, which is also the host ----------------------------------------

function installDom({ storage = null, channel = false } = {}) {
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

  // jsdom has no BroadcastChannel, and Node's cannot be used once this file
  // has swapped the global Event for jsdom's. `Bus` below is the same contract
  // in a few lines: every channel of a name hears every OTHER channel of that
  // name, asynchronously. Only installed where a group asks for it, so a card
  // from an earlier group can never hear one.
  if (channel) w.BroadcastChannel = Bus;

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
    key: (el, key) =>
      el.dispatchEvent(new host.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    active: () => globalThis.document.activeElement,
    /** The two real buttons of the action row, in order. */
    footer: () => [...root.querySelectorAll(".ed-acts > .acts-r > .btn")],
    /** The Send slot: Send, or Undo while a send counts down. */
    slot: () => root.querySelectorAll(".ed-acts > .acts-r > .btn")[1] ?? null,
    /** The line under the buttons. */
    lead: () => root.querySelector(".line.prov")?.textContent ?? "",
    /** Every send-shaped call: a save or a send of the draft. */
    writes: () => host.calls.filter((x) => x.name === "draft_editor_save" || (x.name === "draft" && x.args.action === "send")),
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
    kill: () => {
      mod.disarmResultWatchdog();
      mod.render(null, root);
    },
    done: async () => {
      mod.disarmResultWatchdog();
      host.w.dispatchEvent(new host.w.Event("pagehide"));
      mod.render(null, root);
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


/** The undo window these groups run with. The shipped one is pinned in 2a. */
const UNDO = 300;
/** Long enough for a countdown of `UNDO` to have run out, and its send to answer. */
const pastUndo = () => after(UNDO + 150);

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { getState, setState, disarmResultWatchdog, REPLAY_AGE_MS } from "./src/store";\n' +
        'export { SEND_UNDO_MS, setSendUndoMs } from "./src/components/DraftEditor";\n' +
        'export { SIGNAL_CHANNEL, SIGNAL_KEY, SIGNAL_GAP_MS, signalTag } from "./src/draft-signal";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-send-safety-entry.ts",
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

  /** An editor with the short undo window. */
  async function card(over = {}, opts = {}) {
    const c = await editor(over, opts);
    c.mod.setSendUndoMs(UNDO);
    return c;
  }

  /** A hint from "another card frame", over the storage carrier. */
  const storageHint = (c, msg) =>
    c.w.dispatchEvent(new c.w.StorageEvent("storage", {
      key: c.mod.SIGNAL_KEY,
      newValue: JSON.stringify({ t: "mcpemails-draft/1", from: "another-frame", ...msg }),
    }));

  // ── 1. The footer does not move ──────────────────────────────────────────

  group("1a. Save and the Send slot: same elements, same order, same labels, clean or edited");
  {
    const c = await card();
    const [save, send] = c.footer();
    expectJson("clean: the row is Save, Send", c.footer().map((b) => b.textContent.trim()), ["Save", "Send"]);
    expect("both are fixed slots", save.classList.contains("slot") && send.classList.contains("slot"), true);
    c.input("d-body", "An edit.");
    await settle();
    expectJson("edited: still Save, Send (never Save and send)", c.footer().map((b) => b.textContent.trim()), ["Save", "Send"]);
    expect("edited: the same Save element", c.footer()[0], save);
    expect("edited: the same Send element", c.footer()[1], send);
    expect("edited: no button anywhere says Save and send", !!c.btn(/Save and send/), false);
    expect("edited: Send says what it does with the edit", /Saves your changes first/.test(send.getAttribute("title") ?? ""), true);
    await c.done();
  }

  group("1b. busy and counting down keep the slots: only the label inside changes");
  {
    const c = await card();
    let answer;
    c.tools.draft_editor_save = () => new Promise((r) => { answer = r; });
    c.input("d-body", "An edit.");
    await settle();
    const [save, send] = c.footer();
    c.press(save);
    await settle();
    expect("saving: Save is the same element", c.footer()[0], save);
    expect("saving: still a fixed slot", save.classList.contains("slot"), true);
    expect("saving: Send is the same element", c.footer()[1], send);
    expect("saving: two buttons, no more", c.footer().length, 2);
    answer(draftResult({ origin: "save", last_saved_by: "user", body: { text: "An edit." } }));
    await settle();
    c.press(send);
    await settle();
    expectJson("counting down: Save, Undo", c.footer().map((b) => b.textContent.trim()), ["Save", "Undo"]);
    expect("counting down: Undo IS the Send element", c.footer()[1], send);
    expect("counting down: still a fixed slot", send.classList.contains("slot"), true);
    c.press(send);
    await settle();
    await c.done();
  }

  group("1c. the slot width is fixed in CSS, not a min-width");
  {
    const css = readFileSync(resolve(appRoot, "src/styles.css"), "utf8");
    const rule = /\.btn\.slot\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect("a .btn.slot rule exists", rule.length > 0, true);
    expect("with a width", /(^|[\s;])width\s*:/.test(rule), true);
    expect("that does not flex", /flex\s*:\s*none/.test(rule), true);
    // The row itself: Save and Send are one group that never wraps or shrinks,
    // and the row never wraps it away from the links (footer-geometry.mjs
    // measures this in real Chrome; jsdom has no layout).
    const row = /\.acts\.ed-acts\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const group = /\.acts-r\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect("the footer row does not wrap", /flex-wrap\s*:\s*nowrap/.test(row), true);
    expect("the buttons stay at the top of the row", /align-items\s*:\s*flex-start/.test(row), true);
    expect("Save and Send are one group that does not flex", /flex\s*:\s*none/.test(group), true);
    const c = await card();
    const [save, send] = c.footer();
    expect("in the DOM, too: one parent for both", !!save && save.parentElement === send?.parentElement && save.parentElement.classList.contains("acts-r"), true);
    await c.done();
  }

  // ── 2. Send waits, with Undo in its place ────────────────────────────────

  group("2a. Send calls nothing until the undo window runs out");
  {
    const c = await card();
    expect("the shipped window is a few seconds", c.mod.SEND_UNDO_MS >= 3000 && c.mod.SEND_UNDO_MS <= 10000, true);
    c.tools.draft = () => sentResult();
    c.press(c.slot());
    await settle();
    expectJson("right after the click: no call at all", c.calls, []);
    expect("the line says it is about to send", /Sending in \d+ s/.test(c.lead()), true);
    expect("and how to stop it", /Undo/.test(c.lead()), true);
    expect("focus stays on the slot, now Undo", c.active()?.textContent.trim(), "Undo");
    await pastUndo();
    expectJson("once it runs out: exactly one send", c.calls.map((x) => [x.name, x.args.action]), [["draft", "send"]]);
    await c.done();
  }

  group("2b. Undo cancels, and the draft is untouched");
  {
    const c = await card();
    c.tools.draft = () => sentResult();
    c.press(c.slot());
    await settle();
    c.press(c.slot());
    await pastUndo();
    expectJson("nothing was called", c.calls, []);
    expect("still the editor", c.isEditor(), true);
    expect("the body is as it was", c.value("d-body"), "Here they are.");
    expect("the card says it was not sent", /Not sent/.test(c.lead()), true);
    expect("Send is back", !!c.btn(/^Send$/), true);
    // And Send works again afterwards.
    c.press(c.slot());
    await pastUndo();
    expectJson("a second Send, left alone, sends", c.calls.map((x) => x.args.action), ["send"]);
    await c.done();
  }

  group("2c. a double-click on Send never sends");
  {
    // The two clicks of a real double-click: no render in between.
    const c = await card();
    c.tools.draft = () => sentResult();
    const send = c.slot();
    send.focus();
    send.click();
    send.click();
    await pastUndo();
    expectJson("back to back: nothing was called", c.calls, []);
    await c.done();

    // With a render in between: the second click lands on Undo.
    const d = await card();
    d.tools.draft = () => sentResult();
    const s2 = d.slot();
    d.press(s2);
    await settle();
    d.press(s2);
    await pastUndo();
    expectJson("a render apart: nothing was called", d.calls, []);
    await d.done();
  }

  group("2d. an edited draft is saved and sent only when the window runs out");
  {
    const c = await card();
    c.tools.draft_editor_save = (args) => draftResult({ draft_id: "Drafts:103", origin: "save", last_saved_by: "user", body: { text: args.body_text } });
    c.tools.draft = () => sentResult();
    c.input("d-body", "Edited before sending.");
    await settle();
    c.press(c.slot());
    await settle();
    expectJson("no save and no send yet", c.writes(), []);
    expect("Save is off while it counts down", c.softOff(c.footer()[0]), true);
    c.press(c.footer()[0]);
    await settle();
    expectJson("pressing Save meanwhile writes nothing", c.writes(), []);
    await pastUndo();
    await settle();
    expectJson("then the save, then the send", c.writes().map((x) => x.name === "draft" ? x.args.action : x.name), ["draft_editor_save", "send"]);
    await c.done();
  }

  group("2e. an edit during the countdown cancels it");
  {
    const c = await card();
    c.tools.draft = () => sentResult();
    c.press(c.slot());
    await settle();
    c.input("d-body", "Wait, one more line.");
    await pastUndo();
    expectJson("nothing was called", c.calls, []);
    expect("the card says why", /draft changed/.test(c.lead()), true);
    expect("the edit is kept", c.value("d-body"), "Wait, one more line.");
    await c.done();
  }

  group("2d'. Try again in a failure notice saves nothing during a countdown");
  {
    // Save itself is off while a send counts down; the failure notice's
    // "Try again" is the other way into onSave, and has to be refused too.
    const c = await card();
    c.tools.draft_editor_save = () => failedResult("provider_error", "That draft could not be saved.", "Try again shortly.");
    c.input("d-body", "Edited.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    const retry = c.btn(/^Try again$/);
    expect("the failed save offers Try again", !!retry, true);
    const before = c.writes().length;
    c.tools.draft = () => sentResult();
    c.press(c.slot());
    await settle();
    if (retry) c.press(c.btn(/^Try again$/) ?? retry);
    await settle();
    expect("Try again during the countdown writes nothing", c.writes().length, before);
    c.press(c.slot()); // Undo
    await settle();
    await c.done();
  }

  group("2e'. an edit in the last frame before expiry is not sent");
  {
    // The cancel effect runs a frame after the render that carries an edit.
    // Animation frames are held back here, so that frame is wide open (hooks
    // fall back to a 100 ms timer), and the edit lands 2 ms before expiry:
    // only a check made when the countdown runs out can stop it.
    const c = await card();
    c.tools.draft_editor_save = (args) => draftResult({ draft_id: "Drafts:103", origin: "save", last_saved_by: "user", body: { text: args.body_text } });
    c.tools.draft = () => sentResult();
    const pressedAt = Date.now();
    c.press(c.slot());
    await settle();
    await after(120); // the countdown's first render has been armed
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    try {
      await new Promise((r) => setTimeout(() => {
        c.input("d-body", "Typed in the last moment.");
        r();
      }, Math.max(0, pressedAt + UNDO - 3 - Date.now())));
      await pastUndo();
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
    await settle();
    expectJson("no save and no send", c.writes(), []);
    expect("the card says why", /draft changed/.test(c.lead()), true);
    expect("the edit is kept", c.value("d-body"), "Typed in the last moment.");
    await c.done();
  }

  group("2f. teardown, unmount and pagehide cancel; they never send");
  {
    const t = await card();
    t.tools.draft = () => sentResult();
    t.press(t.slot());
    await settle();
    t.deliver({ jsonrpc: "2.0", id: 9101, method: "ui/resource-teardown", params: {} });
    await pastUndo();
    expectJson("host teardown: nothing was called", t.calls, []);
    await t.done();

    const u = await card();
    u.tools.draft = () => sentResult();
    u.press(u.slot());
    await settle();
    u.kill();
    await pastUndo();
    expectJson("unmount: nothing was called", u.calls, []);

    const p = await card();
    p.tools.draft = () => sentResult();
    p.press(p.slot());
    await settle();
    p.w.dispatchEvent(new p.w.Event("pagehide"));
    await pastUndo();
    expectJson("pagehide: nothing was called", p.calls, []);
    await p.done();
  }

  group("2g. folding the card or opening Discard cancels a countdown");
  {
    const c = await card();
    c.tools.draft = () => sentResult();
    c.press(c.slot());
    await settle();
    c.press(c.btn(/^Hide$/));
    await settle();
    c.press(c.btn(/^Show$/));
    await settle();
    expect("Hide: the countdown is over, not just out of sight", c.slot()?.textContent.trim(), "Send");
    expect("Hide: and the card says so", /Not sent/.test(c.lead()), true);
    await pastUndo();
    expectJson("Hide: nothing was called", c.calls, []);
    await c.done();

    const d = await card();
    d.tools.draft = () => sentResult();
    d.press(d.slot());
    await settle();
    d.press(d.btn(/^Delete draft$/));
    await settle();
    d.press(d.btn(/^Keep draft$/));
    await settle();
    expect("Discard confirm: the countdown is over", d.slot()?.textContent.trim(), "Send");
    await pastUndo();
    expectJson("Discard confirm: nothing was called", d.calls, []);
    await d.done();
  }

  group("2h. Enter in the card's fields never sends");
  {
    const c = await card();
    c.tools.draft = () => sentResult();
    for (const id of ["d-subject", "d-body", "d-to"]) {
      const el = c.w.document.getElementById(id);
      el.focus();
      c.key(el, "Enter");
    }
    await pastUndo();
    expect("no countdown started", !!c.btn(/^Undo$/), false);
    expectJson("nothing was called", c.calls, []);
    await c.done();
  }

  // ── 3. Enter on a recipient that is not an address ───────────────────────

  group("3. Enter on an invalid address says so, and the next address does not merge into it");
  {
    const c = await card();
    const to = c.w.document.getElementById("d-to");
    to.focus();
    c.input("d-to", "not-an-email");
    c.key(to, "Enter");
    await settle();
    expect("the error is shown under To", /not-an-email does not look like an email address/.test(c.text()), true);
    expect("the field is marked invalid", to.getAttribute("aria-invalid"), "true");
    expect("the text is still there to fix", c.value("d-to"), "not-an-email");
    expect("and selected, so typing replaces it", [to.selectionStart, to.selectionEnd].join(","), `0,${"not-an-email".length}`);
    // Typing the next address goes where a browser puts it: over the selection.
    const v = to.value;
    c.input("d-to", v.slice(0, to.selectionStart) + "second@example.com" + v.slice(to.selectionEnd));
    c.key(to, "Enter");
    await settle();
    const chips = [...c.root.querySelectorAll("#d-to-box .chip .name")].map((n) => n.textContent);
    expectJson("the chips are the real addresses", chips, ["dana@x.example", "second@example.com"]);
    expect("no glued chip", chips.some((t) => /not-an-email/.test(t)), false);
    expect("the field is empty again", c.value("d-to"), "");

    // Blur, the path that already worked, still does.
    c.input("d-to", "also-wrong");
    to.dispatchEvent(new c.w.FocusEvent("blur"));
    await settle();
    expect("blur: the error is shown", /also-wrong does not look like an email address/.test(c.text()), true);
    await c.done();
  }

  // ── 4. An older card notices a newer one without being touched ───────────

  const newer = { draft_id: "Drafts:103", resolved_from: "Drafts:102", origin: "read", revision: 2, body: { text: "The assistant's rewrite." } };

  group("4a. a hint on the BroadcastChannel folds the older card at once");
  {
    const c = await card({ revision: 1 }, { channel: true });
    c.tools.draft_read = () => draftResult(newer);
    expect("before: a live editor", c.isEditor(), true);
    const ch = new Bus(c.mod.SIGNAL_CHANNEL);
    ch.postMessage({ t: "mcpemails-draft/1", from: "another-frame", ids: [c.mod.signalTag("Drafts:103"), c.mod.signalTag("Drafts:102")], inbox: c.mod.signalTag(INBOX), revision: 2 });
    await settle();
    await settle();
    expectJson("one silent read of its own draft", c.calls.map((x) => [x.name, x.args.draft_id]), [["draft_read", "Drafts:102"]]);
    expect("folded to one line", /Newer version below/.test(c.text()), true);
    expect("no Send on screen", !!c.btn(/^Send$/), false);
    // The same hint again, over the other carrier: no second read, no loop.
    storageHint(c, { ids: [c.mod.signalTag("Drafts:103")], inbox: c.mod.signalTag(INBOX), revision: 2 });
    await settle();
    expect("a folded card does not read again", c.calls.length, 1);
    ch.close();
    await c.done();
  }

  group("4b. a storage-event hint works where there is no channel");
  {
    const c = await card({ revision: 1 });
    c.tools.draft_read = () => draftResult(newer);
    storageHint(c, { ids: [c.mod.signalTag("Drafts:102")], inbox: null, revision: 2 });
    await settle();
    await settle();
    expect("one read", c.calls.length, 1);
    expect("folded", /Newer version below/.test(c.text()), true);
    await c.done();
  }

  group("4c. hints that say nothing new cost nothing");
  {
    const c = await card({ revision: 2 });
    c.tools.draft_read = () => draftResult(newer);
    storageHint(c, { ids: [c.mod.signalTag("Drafts:102")], inbox: null, revision: 2 });
    await settle();
    expect("the revision this card holds: no read", c.calls.length, 0);
    storageHint(c, { ids: [c.mod.signalTag("Drafts:999")], inbox: c.mod.signalTag("another-inbox"), revision: 5 });
    await settle();
    expect("another draft in another inbox: no read", c.calls.length, 0);
    storageHint(c, { t: "something-else", ids: [c.mod.signalTag("Drafts:102")], revision: 5 });
    await settle();
    expect("not a hint: no read", c.calls.length, 0);
    expect("still the editor", c.isEditor(), true);
    await c.done();
  }

  group("4c'. a burst of hints is one read (SIGNAL_GAP_MS)");
  {
    const c = await card({ revision: 1 });
    // The read finds nothing newer, so the card stays live and could read again.
    c.tools.draft_read = () => draftResult({ origin: "read", revision: 1 });
    const hint = () => storageHint(c, { ids: [c.mod.signalTag("Drafts:102")], inbox: c.mod.signalTag(INBOX), revision: 2 });
    hint();
    await settle();
    hint();
    await settle();
    hint();
    await settle();
    expect("three hints in a row: one read", c.calls.length, 1);
    expect("still the editor", c.isEditor(), true);
    await later(c.mod.SIGNAL_GAP_MS + 500, async () => {
      hint();
      await settle();
    });
    expect("a hint after the gap reads again", c.calls.length, 2);
    await c.done();
  }

  group("4d. a fresh card announces itself; a re-read and a replay do not");
  {
    const heard = [];
    const ch = new Bus("mcpemails-draft-cards");
    ch.onmessage = (e) => heard.push(e.data);
    const c = await card({ revision: 3 }, { channel: true });
    await settle();
    expect("one hint for the fresh card", heard.length, 1);
    expect("naming its draft by digest", heard[0]?.ids?.includes(c.mod.signalTag("Drafts:102")), true);
    expect("and its revision", heard[0]?.revision, 3);
    expect("with no draft text in it", /Here they are|Quarterly|dana@|Drafts:/.test(JSON.stringify(heard[0])), false);
    expectJson("and nothing left in storage", Object.keys({ ...c.w.localStorage }).filter((k) => k === c.mod.SIGNAL_KEY), []);
    // A Refresh is a re-read, which must never announce (that is the loop).
    c.tools.draft_read = () => draftResult({ origin: "read", revision: 3 });
    c.press(c.btn(/^Refresh$/));
    await settle();
    await settle();
    expect("a re-read sends no hint", heard.length, 1);
    ch.close();
    await c.done();

    const heard2 = [];
    const ch2 = new Bus("mcpemails-draft-cards");
    ch2.onmessage = (e) => heard2.push(e.data);
    const r = await boot({ channel: true });
    r.tools.draft_read = () => draftResult({ origin: "read", revision: 1 });
    r.deliver(TOOL_INPUT);
    r.push(draftEnvelope({ last_saved_at: OLD(), revision: 1 }));
    await settle();
    await settle();
    expect("a replay sends no hint", heard2.length, 0);
    ch2.close();
    await r.done();
  }

  group("4e. becoming visible re-checks once; sitting hidden reads nothing");
  {
    const c = await card({ revision: 1 });
    c.tools.draft_read = () => draftResult(newer);
    let hidden = true;
    Object.defineProperty(c.w.document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    await later(c.mod.REPLAY_AGE_MS + 1000, async () => {
      c.w.document.dispatchEvent(new c.w.Event("visibilitychange"));
      await settle();
    });
    expect("hidden: nothing is read", c.calls.length, 0);
    await after(300);
    expect("sitting hidden: still nothing (no polling)", c.calls.length, 0);
    hidden = false;
    await later(c.mod.REPLAY_AGE_MS + 1000, async () => {
      c.w.document.dispatchEvent(new c.w.Event("visibilitychange"));
      await settle();
    });
    await settle();
    expect("visible: one read", c.calls.length, 1);
    expect("and the card folds", /Newer version below/.test(c.text()), true);
    await c.done();
  }

  // ── 4f-4l. One current card per draft (live review, 2026-10-17) ──────────
  //
  // The assistant rewrote a draft while the older card held unsaved Cc edits.
  // The older card stayed open, took in the new body under the edits without
  // a word, and after a Save there BOTH cards showed Send until the newer one
  // caught up about five seconds later. Now: the older card folds at once
  // (edits kept, "Show"), never offers Send while another card is current, and
  // a Save or "Open here" makes it current and folds the other one at once.

  /** Everything this card broadcasts, from a listener on the same bus. */
  const listen = () => {
    const heard = [];
    const ch = new Bus("mcpemails-draft-cards");
    ch.onmessage = (e) => heard.push(e.data);
    return { heard, claims: () => heard.filter((m) => m.kind === "claim"), close: () => ch.close() };
  };
  const claimFrom = (c, ids, mounted, revision = null) =>
    storageHint(c, { kind: "claim", ids: ids.map((id) => c.mod.signalTag(id)), inbox: c.mod.signalTag(INBOX), revision, mounted });

  group("4f. an older card with unsaved edits folds at once, keeps them, and never offers Send");
  {
    const c = await card({ revision: 1, recipients: { cc: [] } });
    let answer;
    c.tools.draft_read = () => new Promise((r) => { answer = r; });
    c.input("d-subject", "My own subject");
    await settle();
    storageHint(c, { ids: [c.mod.signalTag("Drafts:103"), c.mod.signalTag("Drafts:102")], inbox: c.mod.signalTag(INBOX), revision: 2 });
    await settle();
    // Before the verifying read has answered: the fold is immediate.
    expect("folded before the read answers", c.isEditor(), false);
    expect("the line says where and that the edits are kept", /Newer version below.*Your unsaved edits are kept here/.test(c.text()), true);
    expect("no Send on screen", !!c.btn(/^Send$/), false);
    expect("Show, not Open here", !!c.btn(/^Show$/) && !c.btn(/^Open here$/), true);
    expectJson("one read, to lay the newer text under the edits", c.calls.map((x) => x.name), ["draft_read"]);
    answer(draftResult(newer));
    await settle();
    await settle();
    expect("still folded after the read", c.isEditor(), false);
    c.press(c.btn(/^Show$/));
    await settle();
    expect("Show opens the editor", c.isEditor(), true);
    expect("with the edit", c.value("d-subject"), "My own subject");
    expect("over the newer body, not merged silently", c.value("d-body"), "The assistant's rewrite.");
    expect("and the card says so", /Newer version below\. Your unsaved edits are shown on top of the current version\. Save here/.test(c.text()), true);
    expect("Send is off", c.softOff(c.btn(/^Send$/)), true);
    c.input("d-subject", "My own subject, edited again");
    await settle();
    expect("editing here does NOT turn Send on", c.softOff(c.btn(/^Send$/)), true);
    expectJson("nothing was written", c.writes(), []);
    await c.done();
  }

  group("4g. a Save in the older card makes it current and claims the draft at once");
  {
    const bus = listen();
    const c = await card({ revision: 1 }, { channel: true });
    bus.heard.length = 0; // the card's own mount hint
    c.tools.draft_read = () => draftResult(newer);
    c.input("d-subject", "My own subject");
    await settle();
    storageHint(c, { ids: [c.mod.signalTag("Drafts:103")], inbox: c.mod.signalTag(INBOX), revision: 2 });
    await settle();
    await settle();
    c.press(c.btn(/^Show$/));
    await settle();
    c.tools.draft_editor_save = (args) =>
      draftResult({ draft_id: "Drafts:104", resolved_from: "Drafts:103", origin: "save", last_saved_by: "user", revision: 3, subject: args.subject, body: { text: "The assistant's rewrite." } });
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    expectJson("the save was made against the newer revision", c.writes().map((w) => [w.name, w.args.base_revision]), [["draft_editor_save", 2]]);
    expect("current again: Send on", c.softOff(c.btn(/^Send$/)), false);
    expect("no fold notice", /Newer version below|kept here/.test(c.text()), false);
    const claims = bus.claims();
    expect("one claim", claims.length, 1);
    expect("naming the newer card's id, so that card folds", claims[0]?.ids?.includes(c.mod.signalTag("Drafts:103")), true);
    expect("and the id it holds now", claims[0]?.ids?.includes(c.mod.signalTag("Drafts:104")), true);
    expect("with the revision it was mounted with", claims[0]?.mounted, 1);
    expect("and no draft text", /My own|rewrite|Quarterly|dana@|Drafts:/.test(JSON.stringify(claims[0])), false);
    bus.close();
    await c.done();
  }

  group("4h. a claim from another card folds this card at once, with no read");
  {
    const c = await card({ revision: 2, draft_id: "Drafts:103", resolved_from: "Drafts:102" });
    c.tools.draft_read = () => draftResult({ ...newer, revision: 3, last_saved_by: "user" });
    expect("before: Send on", c.softOff(c.btn(/^Send$/)), false);
    claimFrom(c, ["Drafts:102", "Drafts:103", "Drafts:104"], 1, 3);
    await settle();
    expect("folded", c.isEditor(), false);
    expect("toward the card above (mounted earlier)", /Now edited in the card above/.test(c.text()), true);
    expect("no Send", !!c.btn(/^Send$/), false);
    expectJson("no read", c.calls, []);
    // A claim for another draft does nothing.
    const o = await card({ revision: 2 });
    claimFrom(o, ["Drafts:999"], 1, 3);
    await settle();
    expect("another draft's claim: still the editor", o.isEditor(), true);
    await o.done();
    await c.done();
  }

  group("4i. Open here takes the draft back: one read, then current, then a claim");
  {
    const bus = listen();
    const c = await card({ revision: 2, draft_id: "Drafts:103" }, { channel: true });
    bus.heard.length = 0;
    c.tools.draft_read = () => draftResult({ draft_id: "Drafts:104", resolved_from: "Drafts:103", origin: "read", revision: 3, last_saved_by: "user", body: { text: "Saved in the other card." } });
    claimFrom(c, ["Drafts:103", "Drafts:104"], 3, 3);
    await settle();
    expect("folded toward the card below", /Now edited in the card below/.test(c.text()), true);
    c.press(c.btn(/^Open here$/));
    await settle();
    await settle();
    expectJson("one read", c.calls.map((x) => x.name), ["draft_read"]);
    expect("the editor, on the current text", c.value("d-body"), "Saved in the other card.");
    expect("Send on", c.softOff(c.btn(/^Send$/)), false);
    expect("claimed", bus.claims().length, 1);
    bus.close();
    await c.done();
  }

  group("4j. a hint the server does not bear out unfolds the card again");
  {
    const c = await card({ revision: 1 });
    c.tools.draft_read = () => draftResult({ origin: "read", revision: 1 });
    storageHint(c, { ids: [c.mod.signalTag("Drafts:102")], inbox: null, revision: 5 });
    await settle();
    await settle();
    expect("one read", c.calls.length, 1);
    expect("back to the editor", c.isEditor(), true);
    expect("Send on", c.softOff(c.btn(/^Send$/)), false);
    await c.done();
  }

  group("4k. a model's draft_read mount announces nothing");
  {
    const bus = listen();
    const c = await card({ origin: "read", revision: 4 }, { channel: true });
    await settle();
    expect("no hint for a read", bus.heard.length, 0);
    bus.close();
    await c.done();
  }

  report(null);
}

// ---- report -----------------------------------------------------------------

/**
 * Every group's checks, and a crash as a failure of the group it happened in
 * rather than instead of the report: a regression that takes a button off the
 * screen should still say which groups passed before it.
 */
function report(crash) {
  let failed = 0;
  for (const g of groups) {
    const bad = g.checks.filter((c) => !c.ok);
    failed += bad.length;
    const crashed = crash && g === current;
    console.log(`${bad.length || crashed ? "FAIL" : "ok  "}  ${g.name}`);
    for (const c of bad) {
      console.log(`        ${c.label}: got ${show(c.actual)}, want ${show(c.wanted)}`);
    }
    if (crashed) console.log(`        crashed: ${crash?.stack ?? crash}`);
  }
  const total = groups.reduce((n, g) => n + g.checks.length, 0);
  console.log(`\n${total - failed}/${total} checks passed${crash ? ", and a group crashed" : ""}`);
  process.exit(failed || crash ? 1 : 0);
}

main().catch((e) => report(e ?? new Error("unknown crash")));
