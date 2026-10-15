#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft card's smaller UX issues (second QA pass, 2026-10-13), driven
// through the REAL card.
//
//   node harness/draft-ux.test.mjs
//
// Same scripted host as draft-qa.test.mjs and draft-polish.test.mjs: `main.tsx`
// evaluated into jsdom, the host answering `ui/initialize` and every
// `tools/call` from a script. No test here sends anything. Groups:
//
//   A. addresses: a space separates plain addresses and nothing else; a
//      display name is left out and the card says so; a duplicate is named.
//   K. keyboard: Backspace in an empty field takes two presses; the remove
//      buttons are out of the tab order and the chips are reached with the
//      arrow keys; focus after a removal.
//   N. notices: actions in a notice are spaced; "Copied" reverts.
//   G. the signature box has Cancel and Escape.
//   R. a Refresh that worked says so, briefly, in the link itself.
//   L. fullscreen: the action row is beside the scroller, not over it (the
//      tree and the stylesheet; jsdom does not lay out).
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-ux.bundle.mjs");

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
  c.push(draftEnvelope(over));
  await settle();
  return c;
}


const SIG_TEXT = "Here they are.\n\n-- \nAsgeir\nmcpemails.com";

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { splitAddresses, parseRecipients, keyEndsAddress, ADDR_NOTE_MS, FLASH_MS } from "./src/components/DraftEditor";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-ux-entry.ts",
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
  const chipsIn = (c, field) =>
    [...c.root.querySelectorAll(`#d-${field}-box .chip .name`)].map((n) => n.textContent);
  const chipEls = (c, field) => [...c.root.querySelectorAll(`#d-${field}-box .chip`)];
  const said = (c, field) => c.root.querySelector(`#d-${field}-box [role="status"]`)?.textContent ?? "";
  const note = (c, field) => c.root.querySelector(`#d-${field}-note`)?.textContent ?? null;

  // ── A. Addresses ──────────────────────────────────────────────────────────

  group("A0. address parsing (pure)");
  {
    const c = await boot();
    const m = c.mod;
    expectJson("a space separates plain addresses", m.splitAddresses("a@x.example b@x.example"), ["a@x.example", "b@x.example"]);
    expectJson("so do a tab and a line break", m.splitAddresses("a@x.example\tb@x.example\nc@x.example"), ["a@x.example", "b@x.example", "c@x.example"]);
    expectJson("mixed with commas and semicolons", m.splitAddresses("a@x.example b@x.example, c@x.example; d@x.example e@x.example"), ["a@x.example", "b@x.example", "c@x.example", "d@x.example", "e@x.example"]);
    expectJson("a display name with a space is not split", m.splitAddresses("Dana Smith <dana@x.example>"), ["dana@x.example"]);
    expectJson("nor a quoted one", m.splitAddresses('"Smith, Dana K" <dana@x.example>'), ["dana@x.example"]);
    expectJson("an address after a closing bracket is its own", m.splitAddresses("Dana Smith <dana@x.example> sam@x.example"), ["dana@x.example", "sam@x.example"]);
    expectJson("two named addresses with only a space between", m.splitAddresses('Dana Smith <dana@x.example> "Lee, Jo" <jo@x.example>'), ["dana@x.example", "jo@x.example"]);
    expectJson("words that are not all addresses stay one (invalid) piece", m.splitAddresses("dana smith"), ["dana smith"]);
    expectJson("as does an address with a stray word", m.splitAddresses("a@x.example oops"), ["a@x.example oops"]);
    expectJson("the name is reported, without its quotes", m.parseRecipients('"Smith, Dana" <dana@x.example>, sam@x.example'), [
      { address: "dana@x.example", name: "Smith, Dana" },
      { address: "sam@x.example", name: null },
    ]);
    expectJson("an address repeated as its own name is no name", m.parseRecipients("Dana@x.example <dana@x.example>"), [{ address: "dana@x.example", name: null }]);
    expect("Enter ends an address", m.keyEndsAddress("Enter", "sam@x.example"), true);
    expect("a space ends a complete plain address", m.keyEndsAddress(" ", "sam@x.example"), true);
    expect("not a name being typed", m.keyEndsAddress(" ", "Dana"), false);
    expect("not half an address", m.keyEndsAddress(" ", "sam@x"), false);
    expect("nothing ends an empty field", m.keyEndsAddress("Enter", "  "), false);
    await c.done();
  }

  group("A1. a@x.example b@x.example becomes two recipients");
  {
    const c = await editor({ recipients: { to: [] } });
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "a@x.example b@x.example");
    c.key(to, "Enter");
    await settle();
    expectJson("two chips", chipsIn(c, "to"), ["a@x.example", "b@x.example"]);
    expect("no warning", /does not look like/.test(c.text()), false);
    expect("the field is cleared", c.value("d-to"), "");
    c.input("d-to", "c@x.example");
    const space = new c.w.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    to.dispatchEvent(space);
    await settle();
    expect("a space after a complete address commits it", space.defaultPrevented, true);
    expectJson("three chips", chipsIn(c, "to"), ["a@x.example", "b@x.example", "c@x.example"]);
    c.input("d-to", "Dana");
    const inName = new c.w.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    to.dispatchEvent(inName);
    await settle();
    expect("a space inside a name is just a space", inName.defaultPrevented, false);
    expectJson("still three", chipsIn(c, "to"), ["a@x.example", "b@x.example", "c@x.example"]);
    c.input("d-to", "Dana Smith <dana@x.example> sam@x.example");
    c.key(to, "Enter");
    await settle();
    expectJson("a name and a bare address, a space apart", chipsIn(c, "to"), ["a@x.example", "b@x.example", "c@x.example", "dana@x.example", "sam@x.example"]);
    await c.done();
  }

  group("A2. a display name is left out, and the card says so");
  {
    const c = await editor({ recipients: { to: [] } });
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "Dana Smith <dana@x.example>");
    c.key(to, "Enter");
    await settle();
    expectJson("the chip is the bare address", chipsIn(c, "to"), ["dana@x.example"]);
    expect("the chip's title is the address", chipEls(c, "to")[0].getAttribute("title"), "dana@x.example");
    expect("a note under the field says the name was left out", note(c, "to"), "Added as dana@x.example. A draft keeps the address, not the name.");
    expect("it is a live region", c.root.querySelector("#d-to-note")?.getAttribute("role"), "status");
    expect("directly under the To row", c.root.querySelector("#d-to-note")?.previousElementSibling?.contains(to), true);
    expect("it is not a warning", !!c.root.querySelector("#d-to-warn"), false);
    c.input("d-to", "s");
    await settle();
    expect("typing in the field clears it", note(c, "to"), null);
    await c.done();
  }

  group("A3. an address that is already there is named, not dropped silently");
  {
    const c = await editor();
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "Dana@X.example");
    c.key(to, "Enter");
    await settle();
    expectJson("still one chip", chipsIn(c, "to"), ["dana@x.example"]);
    expect("the note says so", note(c, "to"), "Dana@X.example is already in To.");
    expect("the field is cleared", c.value("d-to"), "");
    expect("Save is not offered for it", c.softOff(c.btn(/^Save$/)), true);
    c.input("d-to", "dana@x.example, sam@x.example, DANA@x.example");
    c.key(to, "Enter");
    await settle();
    expectJson("the new one is added", chipsIn(c, "to"), ["dana@x.example", "sam@x.example"]);
    expect("several are counted", note(c, "to"), "2 of those are already in To.");
    await after(c.mod.ADDR_NOTE_MS + 150);
    expect("the note clears itself", note(c, "to"), null);
    await c.done();
  }

  // ── K. Keyboard ───────────────────────────────────────────────────────────

  group("K1. Backspace in an empty field: the first press marks, the second removes");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example"] } });
    const to = c.root.querySelector("#d-to");
    const armed = () => chipEls(c, "to").map((el) => el.getAttribute("data-armed") === "true");
    to.focus();
    c.key(to, "Backspace");
    await settle();
    expectJson("nothing is removed", chipsIn(c, "to"), ["a@x.example", "b@x.example"]);
    expectJson("the last chip is marked", armed(), [false, true]);
    expect("and announced", said(c, "to"), "b@x.example selected. Press Backspace again to remove it.");
    expect("focus stays in the field", c.active()?.id, "d-to");
    c.key(to, "a");
    await settle();
    expectJson("any other key clears the mark", armed(), [false, false]);
    c.key(to, "Backspace");
    await settle();
    expectJson("marked again", armed(), [false, true]);
    c.root.querySelector("#d-subject").focus();
    await settle();
    expectJson("leaving the field clears the mark", armed(), [false, false]);
    expectJson("and removes nothing", chipsIn(c, "to"), ["a@x.example", "b@x.example"]);
    to.focus();
    c.key(to, "Backspace");
    to.dispatchEvent(new c.w.KeyboardEvent("keydown", { key: "Backspace", repeat: true, bubbles: true, cancelable: true }));
    await settle();
    expectJson("a held Backspace does not run on into the chips", chipsIn(c, "to"), ["a@x.example", "b@x.example"]);
    c.key(to, "Backspace");
    await settle();
    expectJson("the second press removes the marked chip", chipsIn(c, "to"), ["a@x.example"]);
    expect("and says so", said(c, "to"), "Removed b@x.example from To.");
    expectJson("the next chip is not marked", armed(), [false]);
    expect("focus is still in the field", c.active()?.id, "d-to");
    await c.done();
  }

  group("K2. the field is one Tab stop, and the chips are reached with the arrow keys");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example", "c@x.example"] } });
    const to = c.root.querySelector("#d-to");
    const box = c.root.querySelector("#d-to-box");
    const tabbable = [...box.querySelectorAll("button, input, [tabindex]")].filter((el) => el.getAttribute("tabindex") !== "-1");
    expectJson("the input is the only Tab stop in the box", tabbable.map((el) => el.id), ["d-to"]);
    expectJson("every remove button is out of the tab order", [...box.querySelectorAll(".chip-x")].map((b) => b.getAttribute("tabindex")), ["-1", "-1", "-1"]);
    expectJson("and still named for a screen reader", [...box.querySelectorAll(".chip-x")].map((b) => b.getAttribute("aria-label")), ["Remove a@x.example", "Remove b@x.example", "Remove c@x.example"]);
    const chips = () => chipEls(c, "to");
    expect("a chip is named with its address and place", chips()[1].getAttribute("aria-label"), "b@x.example, 2 of 3 in To");
    expect("and described with how to remove it", /Delete/.test(c.root.querySelector(`#${chips()[1].getAttribute("aria-describedby")}`)?.textContent ?? ""), true);
    expect("the input says the chips are there", /3 recipients added\. Press Left arrow/.test(c.root.querySelector(`#${to.getAttribute("aria-describedby")}`)?.textContent ?? ""), true);

    to.focus();
    c.input("d-to", "abc");
    c.key(to, "ArrowLeft");
    expect("Left inside typed text stays in the input", c.active()?.id, "d-to");
    c.input("d-to", "");
    to.focus();
    c.key(to, "ArrowLeft");
    expect("Left at the start moves onto the last chip", c.active(), chips()[2]);
    c.key(c.active(), "ArrowLeft");
    expect("Left again, the one before", c.active(), chips()[1]);
    c.key(c.active(), "Home");
    expect("Home, the first", c.active(), chips()[0]);
    c.key(c.active(), "ArrowLeft");
    expect("Left on the first stays", c.active(), chips()[0]);
    c.key(c.active(), "ArrowRight");
    c.key(c.active(), "ArrowRight");
    expect("Right walks back", c.active(), chips()[2]);
    c.key(c.active(), "ArrowRight");
    expect("Right from the last chip returns to the input", c.active()?.id, "d-to");
    c.key(to, "ArrowLeft");
    c.key(c.active(), "Escape");
    expect("Escape returns to the input", c.active()?.id, "d-to");

    c.key(to, "ArrowLeft");
    c.key(c.active(), "Home");
    c.key(c.active(), "Delete");
    await settle();
    expectJson("Delete removes the focused chip", chipsIn(c, "to"), ["b@x.example", "c@x.example"]);
    expect("focus lands on the chip that took its place", c.active(), chips()[0]);
    expect("and the removal is announced", said(c, "to"), "Removed a@x.example from To.");
    c.key(c.active(), "ArrowRight");
    c.key(c.active(), "Backspace");
    await settle();
    expectJson("Backspace removes the focused chip", chipsIn(c, "to"), ["b@x.example"]);
    expect("focus lands on the one before", c.active(), chips()[0]);
    c.key(c.active(), "Delete");
    await settle();
    expectJson("the last one", chipsIn(c, "to"), []);
    expect("then focus is in the input, never dropped", c.active()?.id, "d-to");
    expect("Save is offered for the removals", c.softOff(c.btn(/^Save$/)), false);
    await c.done();
  }

  group("K3. a read-only draft's chips are not focusable and have no remove button");
  {
    const c = await boot();
    c.push({ ...draftEnvelope({ recipients: { to: ["a@x.example"] } }), actor: { can_edit: false, reason: "viewer_role" } });
    await settle();
    const chip = chipEls(c, "to")[0];
    expect("the chip is drawn", !!chip, true);
    expect("with no tabindex", chip?.getAttribute("tabindex") ?? null, null);
    expect("and no remove button", !!c.root.querySelector(".chip-x"), false);
    await c.done();
  }

  // ── N. Notices ────────────────────────────────────────────────────────────

  group("N1. actions in a notice are spaced, and Copied goes back to Copy text");
  {
    expect("consecutive links in a notice have a gap", /\.notice \.link \+ \.link \{[^}]*margin-left: \d+px/.test(css), true);
    const c = await editor();
    let copied = null;
    Object.defineProperty(c.w.navigator, "clipboard", { value: { writeText: (t) => ((copied = t), Promise.resolve()) }, configurable: true });
    c.tools.draft_editor_save = () => failedResult("draft_not_found");
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("Check again and Copy text are both offered", !!c.btn(/^Check again$/) && !!c.btn(/^Copy text$/), true);
    const link = c.btn(/^Copy text$/);
    c.press(link);
    await settle();
    expect("the text went to the clipboard", copied, "Quarterly numbers\n\nMy careful edit.");
    expect("the link says Copied", link.textContent.trim(), "Copied");
    await after(c.mod.FLASH_MS + 150);
    expect("and goes back to Copy text", link.textContent.trim(), "Copy text");
    expect("the same button, so focus is kept", c.active(), link);
    c.press(link);
    await settle();
    expect("a second copy says Copied again", link.textContent.trim(), "Copied");
    // Unmounting inside the two seconds must not leave a timer writing to a
    // card that is gone.
    await c.done();
    await after(c.mod.FLASH_MS + 150);
    expect("nothing is left on screen by a late timer", c.root.textContent, "");
  }

  // ── G. Signature ──────────────────────────────────────────────────────────

  group("G1. Cancel closes the signature box and puts the signature back");
  {
    const c = await editor({ body: { text: SIG_TEXT } });
    const edit = c.btn(/^Edit$/);
    c.press(edit);
    await settle();
    expect("the box is open", c.value("d-signature"), "Asgeir\nmcpemails.com");
    expect("Cancel is offered", !!c.btn(/^Cancel$/), true);
    c.input("d-signature", "Someone else");
    c.input("d-body", "A new message.\n");
    await settle();
    expect("the edit shows as unsaved", /Unsaved changes/.test(c.text()), true);
    c.press(c.btn(/^Cancel$/));
    await settle();
    expect("the box is closed", !!c.root.querySelector("#d-signature"), false);
    expect("the signature is back", c.root.querySelector(".sig-text")?.textContent, "Asgeir + 1 more line");
    expect("the message typed meanwhile is kept", c.value("d-body"), "A new message.\n");
    expect("focus is on Edit, which opened the box", c.active()?.textContent.trim(), "Edit");
    c.tools.draft_editor_save = (args) => draftResult({ body: { text: args.body_text } });
    c.press(c.btn(/^Save$/));
    await settle();
    expect("what is saved carries the original signature", c.calls.at(-1)?.args?.body_text, "A new message.\n\n-- \nAsgeir\nmcpemails.com");
    await c.done();
  }

  group("G2. Escape in the signature box does the same, and leaves a clean draft clean");
  {
    const c = await editor({ body: { text: SIG_TEXT } });
    const message = c.value("d-body");
    c.press(c.btn(/^Edit$/));
    await settle();
    c.input("d-signature", "Someone else\n-- \nwith a separator of its own");
    await settle();
    const esc = new c.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    c.root.querySelector("#d-signature").dispatchEvent(esc);
    await settle();
    expect("Escape is handled", esc.defaultPrevented, true);
    expect("the box is closed", !!c.root.querySelector("#d-signature"), false);
    expect("the signature is back", c.root.querySelector(".sig-text")?.textContent, "Asgeir + 1 more line");
    expect("the message is untouched", c.value("d-body"), message);
    expect("nothing is unsaved", /Unsaved changes/.test(c.text()), false);
    expect("Save is off", c.softOff(c.btn(/^Save$/)), true);
    expect("focus is on Edit", c.active()?.textContent.trim(), "Edit");
    c.press(c.btn(/^Edit$/));
    await settle();
    expect("it opens again on the original", c.value("d-signature"), "Asgeir\nmcpemails.com");
    await c.done();
  }

  // ── R. Refresh ────────────────────────────────────────────────────────────

  group("R1. a Refresh that finds nothing new says Up to date, then reverts");
  {
    const c = await editor();
    const link = c.btn(/^Refresh$/);
    const rowBefore = [...c.root.querySelector(".acts-l").children].filter((el) => !el.classList.contains("sr-only")).length;
    c.tools.draft_read = () => draftResult();
    c.press(link);
    await settle();
    expect("one read", c.calls.filter((x) => x.name === "draft_read").length, 1);
    expect("the link answers", link.textContent.trim(), "Up to date");
    expect("and a live region says it", c.root.querySelector('.acts-l [role="status"]')?.textContent, "This draft is up to date.");
    expect("nothing is added to the row's layout", [...c.root.querySelector(".acts-l").children].filter((el) => !el.classList.contains("sr-only")).length, rowBefore);
    expect("the same button, so focus is kept", c.active(), link);
    await after(c.mod.FLASH_MS + 150);
    expect("it goes back to Refresh", link.textContent.trim(), "Refresh");
    expect("and the live region empties", c.root.querySelector('.acts-l [role="status"]')?.textContent, "");
    await c.done();
  }

  group("R2. a Refresh that brings a newer copy says Updated");
  {
    const c = await editor();
    c.tools.draft_read = () => draftResult({ body: { text: "Changed in the mail client." } });
    const link = c.btn(/^Refresh$/);
    c.press(link);
    await settle();
    expect("the new text is on screen", c.value("d-body"), "Changed in the mail client.");
    expect("the link says Updated", link.textContent.trim(), "Updated");
    expect("and the live region", c.root.querySelector('.acts-l [role="status"]')?.textContent, "Updated from your Drafts folder.");
    await c.done();
  }

  group("R3. a Refresh that failed gets no such word");
  {
    const c = await editor();
    c.tools.draft_read = () => TRANSPORT;
    c.press(c.btn(/^Refresh$/));
    await settle();
    await settle();
    expect("no Up to date", /Up to date|Updated/.test(c.text()), false);
    expect("the link still reads Refresh", !!c.btn(/^Refresh$/), true);
    await c.done();
  }

  group("R4. the card's own check of a replayed draft gets no such word either");
  {
    const c = await boot();
    c.tools.draft_read = () => draftResult({ origin: "read", last_saved_at: null, last_saved_by: null });
    c.push(draftEnvelope({ origin: "read", last_saved_at: null, last_saved_by: null }));
    await settle();
    await settle();
    // Mounted for the model's read: one line until opened (DraftReadLine.tsx).
    c.press(c.btn(/^Open editor$/));
    await settle();
    expect("the check ran", c.calls.filter((x) => x.name === "draft_read").length, 1);
    expect("and the link reads Refresh", !!c.btn(/^Refresh$/), true);
    expect("no Up to date", /Up to date/.test(c.text()), false);
    await c.done();
  }

  // ── L. Fullscreen layout ──────────────────────────────────────────────────

  group("L1. the action row is beside the scrolling part, not over it");
  {
    const c = await editor({ body: { text: SIG_TEXT }, recipients: { cc: ["cc@x.example"], bcc: ["bcc@x.example"] } });
    c.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "fullscreen" } });
    await settle();
    const main = c.root.querySelector(":scope > .ed-main");
    expect("the card is in fullscreen", c.root.getAttribute("data-mode"), "fullscreen");
    expect("the editor's content is one child of the card", !!main, true);
    expectJson(
      "holding the header, every field, the message and the signature",
      ["#d-to", "#d-cc", "#d-bcc", "#d-subject", "#d-body", ".sig", ".hdr"].map((sel) => !!main?.querySelector(sel)),
      [true, true, true, true, true, true, true],
    );
    expect("the action row is outside it", !!c.root.querySelector(":scope > .acts") && !main?.querySelector(".acts"), true);
    expect("and so is the provider line", !!c.root.querySelector(":scope > .prov") && !main?.querySelector(".prov"), true);
    c.press(c.btn(/^Discard$/));
    await settle();
    expect("a confirm is an action row too", !!c.root.querySelector(":scope > .acts") && !main?.querySelector(".acts"), true);
    c.press(c.btn(/^No$/));
    await settle();

    const rule = (selector) => {
      const at = css.lastIndexOf(`${selector} {`);
      return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
    };
    expect("inline, the wrapper is no box", /^\.ed-main \{[^}]*display: contents/m.test(css), true);
    expect("fullscreen: the card is the frame's height", /height: 100dvh/.test(rule('.card[data-mode="fullscreen"]:has(> .ed-main)')), true);
    const scroller = rule('.card[data-mode="fullscreen"] > .ed-main');
    expect("the wrapper takes the room that is left", /flex: 1 1 0/.test(scroller), true);
    expect("and is the scroller", /overflow-y: auto/.test(scroller), true);
    expect("its rows do not shrink", /flex-shrink: 0/.test(rule('.card[data-mode="fullscreen"] > .ed-main > *')), true);
    expect("the action row is not sticky there", /position: static/.test(rule('.card[data-mode="fullscreen"]:has(> .ed-main) > .acts')), true);
    expect("no height is guessed for the action row", /scroll-padding-bottom|--acts-h/.test(css), false);
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
