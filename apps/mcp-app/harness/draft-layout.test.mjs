#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft card's layout fixes of 2026-10-17, from a live review in claude.ai,
// driven through the REAL card the way draft-send-safety.test.mjs does:
// `main.tsx` in jsdom, with this file playing the host.
//
//   node harness/draft-layout.test.mjs
//
// One group per finding:
//
//   1. Nothing moves under the pointer. The header's status sits on the left
//      and its controls are one group on the right; the ⋯ menu and its
//      confirms are an overlay, not rows pushed into the card; the delete
//      confirm takes the footer's LEFT side with "Keep draft" where "Delete
//      draft" was, and never puts an answer where Save or Send are.
//   2. One status: the header and the line under the buttons agree (Unsaved
//      changes, Saving…, Saved to Drafts), inline and fullscreen alike, with
//      no provider jargon.
//   3. Send is off, and says why, while a save is in flight.
//   4. (Refresh's answer in the status line: draft-ux.test.mjs, R1 to R2b.)
//   5. "Delete draft" and "Undo my edits" are two names for two actions.
//   6. An empty subject asks "No subject. Send anyway?" beside Subject, and a
//      second, deliberate press on the same Send sends.
//   7. Narrow widths: the footer's links move into the ⋯ menu.
//   8. Right-to-left text (re-test, 2026-10-17): each field and read-only text
//      view picks its own direction, and the message box does it per line.
//   9. A narrow header gives up the From address before the status.
//
// jsdom has no layout, so this pins the DOM and the CSS that make the
// geometry hold; footer-geometry.mjs measures the same promises in real Chrome
// at 280 to 600px.
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
const OUT = resolve(appRoot, "dist/draft-layout.bundle.mjs");

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
  for (const key of ["window", "document", "Node", "Event", "MessageChannel", "ResizeObserver", "localStorage", "sessionStorage", "navigator", "DOMParser"]) {
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


/** The undo window these groups run with. */
const UNDO = 300;
const pastUndo = () => after(UNDO + 150);

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { setSendUndoMs, CONFIRM_GUARD_MS, SLOW_WRITE_MS, UNSAVED_DEBOUNCE_MS } from "./src/components/DraftEditor";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-layout-entry.ts",
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

  const css = readFileSync(resolve(appRoot, "src/styles.css"), "utf8");
  /** The body of the LAST top-level rule with exactly this selector. */
  const rule = (selector) => {
    const at = css.lastIndexOf(`\n${selector} {`);
    return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
  };

  async function card(over = {}, opts = {}) {
    const c = await editor(over, opts);
    c.mod.setSendUndoMs(UNDO);
    return c;
  }

  // ── 1. Nothing moves under the pointer ──────────────────────────────────

  group("1a. header: the status is on the left, the controls are one group on the right");
  {
    const c = await card();
    const hdr = c.root.querySelector(".ed-hdr");
    const left = hdr?.querySelector(".hdr-l");
    const right = hdr?.querySelector(".hdr-r");
    expect("the status is in the left half", !!left?.querySelector(".hdr-status"), true);
    expect("after the From address", left?.querySelector(".hdr-from")?.nextElementSibling?.classList.contains("hdr-status"), true);
    expect("the right half holds no status text", right?.querySelector(".muted, .hdr-status"), null);
    const labels = () => [...right.querySelectorAll("button")].map((b) => b.textContent.trim());
    expectJson("the right half is the controls, in order", labels(), ["Expand", "Hide", "⋯"]);
    const els = [...right.querySelectorAll("button")];
    c.input("d-body", "An edit.");
    await settle();
    expect("edited: the header says Unsaved changes", left.querySelector(".hdr-status")?.textContent, "Unsaved changes");
    expectJson("edited: the same controls", labels(), ["Expand", "Hide", "⋯"]);
    expect("edited: the same elements", [...right.querySelectorAll("button")].every((b, i) => b === els[i]), true);
    expect("the header does not wrap (CSS)", /flex-wrap:\s*nowrap/.test(rule(".hdr.ed-hdr")), true);
    expect("\"Draft\" never shrinks into two lines (CSS)", /flex:\s*none/.test(rule(".ed-hdr > .hdr-l > b")), true);
    await c.done();
  }

  group("1b. the ⋯ menu is an overlay: it inserts nothing between the header and the fields");
  {
    const c = await card();
    const main = c.root.querySelector(".ed-main");
    const rowsBefore = [...main.children];
    c.press(c.btn(/^⋯$/));
    await settle();
    const menu = c.root.querySelector('[role="menu"]');
    expect("the menu opens", !!menu, true);
    expect("inside the ⋯ button's anchor in the header", !!menu?.closest(".hdr-r .menu-anchor > .pop"), true);
    expect("the editor's rows are the same rows", [...main.children].length === rowsBefore.length && [...main.children].every((el, i) => el === rowsBefore[i]), true);
    expect("the overlay is positioned (CSS)", /position:\s*absolute/.test(rule(".pop")), true);
    expect("focus is on the first item shown", c.active()?.textContent, "Turn off draft cards…");
    c.press(c.btn(/^Turn off draft cards…$/));
    await settle();
    expect("its confirm stays in the overlay", !!c.btn(/^Cancel$/)?.closest(".pop"), true);
    expect("still no row inserted", [...main.children].length, rowsBefore.length);
    expect("focus is on Cancel", c.active(), c.btn(/^Cancel$/));
    c.key(c.active(), "Escape");
    await settle();
    expect("Escape closes it", c.root.querySelector(".pop"), null);
    expect("and gives focus back to ⋯", c.active(), c.btn(/^⋯$/));
    expectJson("nothing was called", c.calls, []);
    await c.done();
  }

  group("1c. the menu: a pointer elsewhere closes it, the arrow keys move in it, a folded card draws it in flow");
  {
    const c = await card();
    c.press(c.btn(/^⋯$/));
    await settle();
    const items = [...c.root.querySelectorAll('[role="menuitem"]')];
    expect("several items (narrow ones included in the DOM)", items.length >= 2, true);
    // jsdom draws no boxes, so the card would count only the always-shown
    // item. Give every item a box, as a narrow frame does.
    for (const el of items) el.getClientRects = () => [{ width: 1, height: 1 }];
    const first = c.active();
    c.key(first, "ArrowDown");
    await settle();
    expect("ArrowDown moves to another item", c.active() !== first && c.active()?.getAttribute("role") === "menuitem", true);
    c.key(c.active(), "ArrowUp");
    await settle();
    expect("ArrowUp comes back", c.active(), first);
    globalThis.document.getElementById("d-subject").dispatchEvent(new c.w.Event("pointerdown", { bubbles: true }));
    await settle();
    expect("a pointer on the Subject closes it", c.root.querySelector(".pop"), null);
    c.press(c.btn(/^Hide$/));
    await settle();
    c.press(c.btn(/^⋯$/));
    await settle();
    expect("folded: the panel is in flow", !!c.root.querySelector(".pop.inflow [role=menu]"), true);
    expect("folded: and only the turn-off item", [...c.root.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim()).join("|"), "Turn off draft cards…");
    expect("in-flow is not positioned (CSS)", /position:\s*static/.test(rule(".pop.inflow")), true);
    await c.done();
  }

  group("1d. Delete draft's confirm: real buttons on the LEFT, the safe one where the link was");
  {
    const c = await card();
    c.tools.draft = () => receiptResult("discarded", "Draft discarded. Nothing was sent.", "rejected");
    const links = c.root.querySelector(".ed-acts > .ed-links");
    expect("Delete draft is the first link of the row", links?.firstElementChild?.textContent.trim(), "Delete draft");
    const [save, send] = c.footer();
    c.press(c.btn(/^Delete draft$/));
    await settle();
    const keep = c.btn(/^Keep draft$/);
    const yes = c.btn(/^Yes, delete$/);
    const left = c.root.querySelector(".ed-acts > .acts-l");
    expect("the confirm is the row's left side", !!keep && keep.parentElement === left && yes?.parentElement === left, true);
    expect("Keep draft is first, where the link was", left?.firstElementChild, keep);
    expect("both are real buttons", keep?.classList.contains("btn") && yes?.classList.contains("btn"), true);
    expect("focus is on Keep draft", c.active(), keep);
    expect("Save is the same element, still there", c.footer()[0], save);
    expect("Send is the same element, still there", c.footer()[1], send);
    expect("Save is off meanwhile", c.softOff(save), true);
    expect("Send is off meanwhile", c.softOff(send), true);
    expect("the question is said", c.root.querySelector("#d-status")?.textContent, "Delete this draft from your mailbox?");
    expect("and names the group", left?.getAttribute("aria-labelledby"), "d-status");
    send.click();
    await settle();
    expectJson("a click on Send's place deletes and sends nothing", c.calls, []);
    expect("the confirm is still open", !!c.btn(/^Yes, delete$/), true);
    c.press(c.btn(/^Yes, delete$/));
    await settle();
    expectJson("Yes, delete deletes", c.calls.map((x) => [x.name, x.args.action]), [["draft", "delete"]]);
    await c.done();
  }

  group("1e. Delete draft from the menu: the confirm stays in the overlay");
  {
    const c = await card();
    c.press(c.btn(/^⋯$/));
    await settle();
    const item = c.btn(/^Delete draft…$/);
    expect("the menu offers Delete draft (shown at narrow widths)", item?.classList.contains("narrow-only"), true);
    c.press(item);
    await settle();
    expect("the question is in the overlay", /Delete this draft from your mailbox\?/.test(c.root.querySelector(".pop")?.textContent ?? ""), true);
    expect("focus is on Keep draft", c.active(), c.btn(/^Keep draft$/));
    expect("Save and Send are off", c.softOff(c.footer()[0]) && c.softOff(c.footer()[1]), true);
    c.key(c.active(), "Escape");
    await settle();
    expect("Escape closes it", c.root.querySelector(".pop"), null);
    expect("focus back on ⋯", c.active(), c.btn(/^⋯$/));
    expectJson("nothing was called", c.calls, []);
    await c.done();
  }

  // ── 2. One status ─────────────────────────────────────────────────────────

  group("2a. the header and the line under the buttons say the same thing");
  {
    const c = await card();
    const head = () => c.root.querySelector(".ed-hdr .hdr-status")?.textContent ?? "";
    const line = () => c.root.querySelector("#d-status")?.textContent ?? "";
    expect("clean: the header says when it was saved", /^Saved .* by the assistant$/.test(head()), true);
    expect("clean: the line says Saved to Drafts", /^\d+ words · Saved to Drafts$/.test(line()), true);
    let answer;
    c.tools.draft_editor_save = () => new Promise((r) => { answer = r; });
    c.input("d-body", "An edit.");
    await settle();
    expect("edited: header", head(), "Unsaved changes");
    expect("edited: line", /^\d+ words · Unsaved changes$/.test(line()), true);
    c.press(c.footer()[0]);
    await settle();
    expect("saving: header", head(), "Saving…");
    expect("saving: line", /^\d+ words · Saving…$/.test(line()), true);
    expect("saving: nothing says Saved to Drafts", /Saved to Drafts/.test(c.text()), false);
    await after(c.mod.SLOW_WRITE_MS + 100);
    expect("slow: one sentence, no Saved to Drafts after it", /^Still saving\. Your mail provider can take a moment\.$/.test(line()), true);
    answer(draftResult({ origin: "save", last_saved_by: "user", body: { text: "An edit." } }));
    await settle();
    expect("saved: header", /^Saved .* by you$/.test(head()), true);
    expect("saved: line", /^\d+ words · Saved to Drafts$/.test(line()), true);
    await c.done();
  }

  group("2b. fullscreen says it in the same words, with no provider jargon");
  {
    const c = await card();
    c.push({ ...draftEnvelope(), provider: { label: "IMAP + SMTP", route: "Saved to your Drafts folder", caveats: [] } });
    await settle();
    const inline = c.root.querySelector("#d-status")?.textContent;
    c.goFullscreen();
    await settle();
    expect("the card is fullscreen", c.root.getAttribute("data-mode"), "fullscreen");
    expect("the same line as inline", c.root.querySelector("#d-status")?.textContent, inline);
    expect("no IMAP or SMTP on screen", /IMAP|SMTP/.test(c.text()), false);
    expect("the provider detail is kept in the tooltip", /IMAP \+ SMTP/.test(c.root.querySelector("#d-status")?.getAttribute("title") ?? ""), true);
    await c.done();
  }

  // ── 3. Send waits for a save in flight ──────────────────────────────────

  group("3. Send is off, and says why, while a save is in flight");
  {
    const c = await card();
    let answer;
    c.tools.draft_editor_save = () => new Promise((r) => { answer = r; });
    c.tools.draft = () => receiptResult("sent", "Sent.", "sent");
    c.input("d-body", "An edit.");
    await settle();
    c.press(c.footer()[0]);
    await settle();
    const send = c.footer()[1];
    expect("Send is off", c.softOff(send), true);
    expect("its tooltip says it waits for the save", /Saving your changes/.test(send.getAttribute("title") ?? ""), true);
    send.click();
    await settle();
    expect("pressing it starts no countdown", send.textContent.trim(), "Send");
    expectJson("and calls nothing but the save", c.calls.map((x) => x.name), ["draft_editor_save"]);
    answer(draftResult({ origin: "save", last_saved_by: "user", body: { text: "An edit." } }));
    await settle();
    expect("once saved, Send is on", c.softOff(send), false);
    c.press(send);
    await settle();
    expect("and starts the undo countdown as before", send.textContent.trim(), "Undo");
    c.press(send);
    await settle();
    await c.done();
  }

  // ── 5. Two different actions, two different names ──────────────────────

  group("5. Delete draft and Undo my edits are unmistakable");
  {
    const c = await card();
    expect("no button says Discard", [...c.root.querySelectorAll("button")].some((b) => /discard/i.test(b.textContent)), false);
    expect("the footer says Delete draft", !!c.btn(/^Delete draft$/), true);
    expect("in the danger tone", c.btn(/^Delete draft$/)?.getAttribute("data-tone"), "danger");
    c.input("d-body", "Put back later.");
    await after(c.mod.UNSAVED_DEBOUNCE_MS + 100);
    const s = c.storage();
    c.kill();
    const r = await boot({ storage: s });
    r.tools.draft_read = () => draftResult();
    r.deliver(TOOL_INPUT);
    await settle();
    r.push(draftEnvelope());
    await settle();
    await settle();
    expect("the edit was put back", r.value("d-body"), "Put back later.");
    expect("the notice offers Undo my edits", !!r.btn(/^Undo my edits$/), true);
    expect("and never Discard these edits", /Discard these edits/.test(r.text()), false);
    r.press(r.btn(/^Undo my edits$/));
    await settle();
    expect("Undo my edits puts the stored text back", r.value("d-body"), "Here they are.");
    expectJson("and calls nothing", r.calls.filter((x) => x.name !== "draft_read"), []);
    await r.done();
  }

  // ── 6. No subject ─────────────────────────────────────────────────────────

  group("6. an empty subject asks once, beside Subject, and a second deliberate press sends");
  {
    const c = await card({ subject: "" });
    c.tools.draft = () => receiptResult("sent", "Sent.", "sent");
    const rowsBefore = c.root.querySelector(".tight").children.length;
    const send = c.footer()[1];
    c.press(send);
    await settle();
    const warn = globalThis.document.getElementById("d-subject-warn");
    expect("the warning", warn?.textContent.trim(), "No subject. Send anyway?");
    expect("inside the Subject row", warn?.parentElement, globalThis.document.getElementById("d-subject").parentElement);
    expect("which adds no row", c.root.querySelector(".tight").children.length, rowsBefore);
    expect("Subject points at it", globalThis.document.getElementById("d-subject").getAttribute("aria-describedby"), "d-subject-warn");
    expect("no countdown yet", send.textContent.trim(), "Send");
    expect("Send is the same element", c.footer()[1], send);
    // The second half of a double click: ignored.
    send.click();
    await settle();
    expect("a press right after it is ignored", send.textContent.trim(), "Send");
    await after(c.mod.CONFIRM_GUARD_MS + 50);
    c.press(send);
    await settle();
    expect("a deliberate second press starts the countdown", send.textContent.trim(), "Undo");
    expect("the warning is gone", globalThis.document.getElementById("d-subject-warn"), null);
    await pastUndo();
    expectJson("and it sends", c.calls.map((x) => [x.name, x.args.action]), [["draft", "send"]]);
    await c.done();

    const d = await card({ subject: "" });
    d.press(d.footer()[1]);
    await settle();
    d.input("d-subject", "Now with a subject");
    await settle();
    expect("typing a subject takes the warning away", globalThis.document.getElementById("d-subject-warn"), null);
    d.press(d.footer()[1]);
    await settle();
    expect("and Send counts down on the first press", d.footer()[1].textContent.trim(), "Undo");
    d.press(d.footer()[1]);
    await settle();
    await d.done();

    const e = await card();
    e.press(e.footer()[1]);
    await settle();
    expect("with a subject: no warning, straight to the countdown", e.footer()[1].textContent.trim(), "Undo");
    e.press(e.footer()[1]);
    await settle();
    await e.done();
  }

  // ── 7. Narrow widths ──────────────────────────────────────────────────────

  group("7. narrow: the footer's links move into the ⋯ menu, Save and Send never split");
  {
    const c = await card({ body: { text: "Here they are.", html: "<p>Here they are.</p>" } });
    const links = c.root.querySelector(".ed-acts > .ed-links");
    expectJson("wide: the row's links", [...links.querySelectorAll("button")].map((b) => b.textContent.trim()), ["Delete draft", "Refresh", "Show formatting"]);
    c.press(c.btn(/^⋯$/));
    await settle();
    const narrow = [...c.root.querySelectorAll('[role="menuitem"].narrow-only')].map((b) => b.textContent.trim());
    expectJson("the menu holds the same three, for narrow widths", narrow, ["Refresh", "Show formatting", "Delete draft…"]);
    c.press([...c.root.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === "Show formatting"));
    await settle();
    expect("the menu's Show formatting works", !!c.root.querySelector(".html-preview"), true);
    expect("and closes the menu", c.root.querySelector(".pop"), null);
    // The container query, and that it comes after the rule it overrides.
    const at = css.indexOf("@container card (max-width:");
    const q = css.slice(css.lastIndexOf("@container card", css.indexOf(".ed-acts > .ed-links { display: none; }")));
    expect("below the width the row's links are hidden", /\.ed-acts > \.ed-links \{ display: none; \}/.test(q), true);
    expect("and the menu's narrow items shown", /\.pop-menu > \.menu-item\.narrow-only \{ display: block; \}/.test(q), true);
    expect("which wins over the rule hiding them", css.indexOf(".pop-menu > .menu-item.narrow-only { display: none; }") < css.indexOf(".ed-acts > .ed-links { display: none; }"), true);
    expect("a container query exists at all", at >= 0, true);
    expect("Save and Send stay one group that does not wrap", /flex:\s*none/.test(rule(".acts-r")), true);
    await c.done();
  }

  // ── 8. Right-to-left text (live re-test, 2026-10-17) ─────────────────────

  group("8. every field and read-only text view picks its own direction");
  {
    const quoted =
      "Hei, dette er en test.\nمرحبا، هذه رسالة اختبار.\n-- \nAsgeir" +
      "\n\nOn Mon, 7 Sep 2026 17:32:55 +0000, Dana Example <dana@x.example> wrote:\n> مرحبا\n";
    const line = quoted.slice(0, quoted.indexOf("On Mon")).split("\n").length - 1;
    const c = await card({ subject: "رسالة اختبار", body: { text: quoted, quoted: { line } } });
    const dir = (el) => el?.getAttribute("dir") ?? null;
    expect("Subject", dir(c.root.querySelector("#d-subject")), "auto");
    expect("Message", dir(c.root.querySelector("#d-body")), "auto");
    expect("the signature preview", dir(c.root.querySelector(".row.sig:not(.quote-row) .sig-text")), "auto");
    expect("the quote preview", dir(c.root.querySelector(".quote-row .sig-text")), "auto");
    c.press(c.btn(/^Show quote$/));
    await settle();
    expect("the quote", dir(c.root.querySelector("#d-quoted")), "auto");
    c.press(c.btn(/^Edit$/));
    await settle();
    expect("the signature box", dir(c.root.querySelector("#d-signature")), "auto");
    await c.done();

    const h = await card({ body: { text: "Hei.", html: "<p>Hei.</p><p>مرحبا.</p>" } });
    h.press(h.btn(/^Show formatting$/));
    await settle();
    expect("the formatted view", dir(h.root.querySelector(".html-preview .body-html")), "auto");
    await h.done();

    // dir="auto" on a textarea reads the WHOLE box's first strong character;
    // `plaintext` is what gives each line its own.
    const block = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`, "g")) ?? [];
    expect("message lines one by one (CSS)", block(".textarea").some((r) => /unicode-bidi:\s*plaintext/.test(r)), true);
    expect("quote lines one by one (CSS)", block(".quote-text").some((r) => /unicode-bidi:\s*plaintext/.test(r)), true);
    expect("formatted paragraphs one by one (CSS)", /\.html-preview \.body-html[^{]*\{\s*unicode-bidi:\s*plaintext/.test(css), true);
  }

  group("9. narrow header: the From address gives way before the status");
  {
    // "Saved 15:15 by you" was cut to "Saved 15:15 …" at 300px while half the
    // address still showed. footer-geometry.mjs measures it in Chrome.
    expect("the address has no basis of its own (CSS)", /flex:\s*1 1 0/.test(rule(".ed-hdr > .hdr-l > .hdr-from")), true);
    expect("and shrinks to nothing (CSS)", /min-width:\s*0/.test(rule(".ed-hdr > .hdr-l > .hdr-from")), true);
    expect("the status is never cut with an ellipsis (CSS)", /ellipsis|nowrap/.test(rule(".hdr-status")), false);
    expect("the status wraps under, not the controls (CSS)", /flex-wrap:\s*wrap/.test(rule(".ed-hdr > .hdr-l")), true);
    expect("the header itself still does not wrap (CSS)", /flex-wrap:\s*nowrap/.test(rule(".hdr.ed-hdr")), true);
    // Narrow, the status always has its own line, so a status that fits and
    // one that does not leave the header the same height.
    const narrow = css.slice(css.indexOf("@container card (max-width: 379px) {\n  .ed-main"));
    expect("narrow: the status takes a line of its own (CSS)", /\.ed-main > \.ed-hdr \.hdr-status \{ order: 1; flex-basis: 100%; \}/.test(narrow.slice(0, 400)), true);
    expect("narrow: the controls stay on the right (CSS)", /\.ed-main > \.ed-hdr > \.hdr-r \{ margin-left: auto; \}/.test(narrow.slice(0, 400)), true);
  }

  report();
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
