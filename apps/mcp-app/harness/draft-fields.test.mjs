#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft card's recipient fields and files (live review in claude.ai,
// 2026-10-17), driven through the REAL card.
//
//   node harness/draft-fields.test.mjs
//
// Same scripted host as draft-ux.test.mjs: `main.tsx` evaluated into jsdom,
// the host answering `ui/initialize` and every `tools/call` from a script.
// No test here sends anything. Groups:
//
//   R. an emptied Cc row stays until the card loses focus; a chip removed
//      with the pointer reflows the row at once, a second click too soon is
//      refused, and × never blurs (so never commits) a partial address.
//   D. a duplicate across fields (any case) is refused and named; the note
//      outlives a typed space; no "not complete yet" while typing.
//   L. a long list folds to one row and "+N more"; the Cc Bcc link inside
//      the To box.
//   S. a comma, semicolon or space commits as it arrives, with or without a
//      key event; a pasted list becomes one chip per address.
//   C. suggestions: the combobox, its keys, what it suggests and what it
//      never does (contacts.ts), and the server adapter that is not wired.
//   F. files: chips with sizes in words, remove with Undo, Attach file, the
//      5 MB card limit, Outlook and read-only, and what Save sends.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-fields.bundle.mjs");

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
  for (const key of ["window", "document", "Node", "Event", "MessageChannel", "ResizeObserver", "localStorage", "sessionStorage", "navigator", "DOMParser", "NodeFilter", "FileReader", "File", "Blob"]) {
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



async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { keyEndsAddress, ADDR_NOTE_MS } from "./src/components/DraftEditor";\n' +
        'export { SUGGEST_DEBOUNCE_MS } from "./src/components/Recipients";\n' +
        'export { localContactSource, contactSearchSource, parseNamedAddress, matchesQuery } from "./src/contacts";\n' +
        'export { humanSize, rebaseFileEdits, fileEditsPatch, CARD_UPLOAD_MAX_BYTES } from "./src/attachments";\n' +
        'export { patchLanded } from "./src/draft-failure";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-fields-entry.ts",
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
  const note = (c, field) => c.root.querySelector(`#d-${field}-note`)?.textContent ?? null;
  const warn = (c, field) => c.root.querySelector(`#d-${field}-warn`)?.textContent ?? null;
  const row = (c, field) => !!c.root.querySelector(`#d-${field}`);
  const xFor = (c, label) => c.root.querySelector(`button[aria-label="${label}"]`);
  const fileChips = (c) =>
    [...c.root.querySelectorAll(".att-list .chip.att")].map((el) => ({
      name: el.querySelector(".name")?.textContent,
      size: el.querySelector(".att-size")?.textContent,
      removed: el.getAttribute("data-removed") === "true",
      added: el.getAttribute("data-new") === "true",
    }));
  const unsaved = (c) => /Unsaved changes/.test(c.text());
  const paste = (c, id, text) => {
    const el = globalThis.document.getElementById(id);
    el.focus();
    const ev = new c.w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (type) => (type === "text/plain" ? text : "") },
    });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const pickFiles = (c, files) => {
    const input = c.root.querySelector('.att-list input[type="file"]');
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new c.w.Event("change", { bubbles: true }));
  };
  const waitSugs = () => after(150 + 60);

  // ── R. Nothing moves under the pointer ────────────────────────────────────

  group("R1. removing the last Cc chip keeps the Cc row until the card loses focus");
  {
    const c = await editor({ recipients: { to: ["bjellanda@x.example"], cc: ["cc@x.example"] } });
    expect("the Cc row is shown while it has a chip", row(c, "cc"), true);
    c.press(xFor(c, "Remove cc@x.example"));
    await settle();
    expectJson("the chip is gone", chipsIn(c, "cc"), []);
    expect("the Cc row is still there", row(c, "cc"), true);
    expectJson("To is untouched", chipsIn(c, "to"), ["bjellanda@x.example"]);
    expect("the To row's link offers Bcc only", c.root.querySelector("#d-to-box")?.parentElement?.querySelector(".link")?.textContent, "Bcc");
    // A second click where the chip was: the row did not move, so nothing
    // else is under it. Nothing in To was removed.
    expectJson("still one recipient in To", chipsIn(c, "to"), ["bjellanda@x.example"]);
    c.w.dispatchEvent(new c.w.Event("blur"));
    await settle();
    expect("the card losing focus folds the empty row", row(c, "cc"), false);
    await c.done();
  }

  group("R2. a row being typed in is never folded");
  {
    const c = await editor({ recipients: { cc: ["cc@x.example"] } });
    c.press(xFor(c, "Remove cc@x.example"));
    await settle();
    c.input("d-cc", "half@");
    c.w.dispatchEvent(new c.w.Event("blur"));
    await settle();
    expect("text in Cc keeps the row", row(c, "cc"), true);
    expect("and the text", c.value("d-cc"), "half@");
    await c.done();
  }

  // ── The live claude.ai test of 2026-10-19: the spacer read as a broken
  // layout, and pressing × blurred the input, which committed a partial. ──

  /**
   * A real press on a chip's ×: mousedown (whose default would move focus out
   * of the input), then a click with `detail`, as a mouse makes it. The button
   * is never focused by hand, unlike `press`, because a real one is not.
   * Returns whether the mousedown's default was prevented.
   */
  const pointerX = (c, label, detail = 1) => {
    const x = xFor(c, label);
    const down = new c.w.MouseEvent("mousedown", { bubbles: true, cancelable: true, detail });
    x.dispatchEvent(down);
    // What the browser does with an unprevented mousedown on a button.
    if (!down.defaultPrevented) x.focus();
    x.dispatchEvent(new c.w.MouseEvent("click", { bubbles: true, cancelable: true, detail }));
    return down.defaultPrevented;
  };

  group("R3. a chip removed with the pointer: the row reflows at once, no spacer");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example", "c@x.example"] } });
    const box = () => c.root.querySelector("#d-to-box");
    // Everything in the box before the input, in order: chips only.
    const order = () => {
      const kids = [...box().children];
      return kids.slice(0, kids.indexOf(box().querySelector("input"))).map((el) =>
        el.matches(".chip") ? el.querySelector(".name").textContent : `<${el.className}>`
      );
    };
    pointerX(c, "Remove a@x.example");
    await settle();
    expectJson("the next chip moves into its place", order(), ["b@x.example", "c@x.example"]);
    expect("no spacer element of any kind", box().querySelectorAll(".chip-ghost, [aria-hidden=true]").length, 0);
    expect("and no spacer rule left in the stylesheet", /\.chip-ghost/.test(css), false);
    await c.done();
  }

  group("R4. a second click too soon, or a double-click, removes nothing more");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example", "c@x.example"] } });
    pointerX(c, "Remove a@x.example");
    await settle();
    // b@ slid under the pointer; the second click of the pair lands on its ×.
    pointerX(c, "Remove b@x.example", 2);
    await settle();
    expectJson("a double-click's second click is refused", chipsIn(c, "to"), ["b@x.example", "c@x.example"]);
    pointerX(c, "Remove b@x.example", 1);
    await settle();
    expectJson("so is a quick second click", chipsIn(c, "to"), ["b@x.example", "c@x.example"]);
    await after(520);
    pointerX(c, "Remove b@x.example", 1);
    await settle();
    expectJson("a deliberate click after the window removes", chipsIn(c, "to"), ["c@x.example"]);
    // A click no pointer made (a screen reader's activation) is never refused.
    c.input("d-to", "");
    xFor(c, "Remove c@x.example").click();
    await settle();
    expectJson("an activation with detail 0 removes at once", chipsIn(c, "to"), []);
    await c.done();
  }

  group("R5. pressing × keeps a partial address in the input, unwarned, with focus");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example"] } });
    const input = () => c.root.querySelector("#d-to");
    input().focus();
    c.input("d-to", "as");
    await settle();
    const prevented = pointerX(c, "Remove a@x.example");
    await settle();
    expect("the × does not take focus on mousedown", prevented, true);
    expectJson("the chip is removed", chipsIn(c, "to"), ["b@x.example"]);
    expect("the partial is still in the input", c.value("d-to"), "as");
    expect("nothing was committed or warned about", warn(c, "to"), null);
    expect("no 'does not look like an email' anywhere", /does not look like an email/.test(c.text()), false);
    expect("focus is in the input", c.active(), input());
    // And from a field that did not have focus: it ends in the input, the
    // caret after what is typed.
    c.input("d-to", "");
    input().blur();
    await settle();
    c.root.querySelector("#d-subject")?.focus();
    await after(520); // past the second-click guard (R4)
    pointerX(c, "Remove b@x.example");
    await settle();
    expectJson("removed", chipsIn(c, "to"), []);
    expect("focus moved to the To input", c.active(), input());
    await c.done();
  }

  // ── D. Duplicates across fields ───────────────────────────────────────────

  group("D1. an address already in To is refused in Cc, whatever its case");
  {
    const c = await editor({ recipients: { to: ["bjellanda@x.example"] } });
    c.press(c.btn(/^Cc Bcc$/));
    await settle();
    c.input("d-cc", "Bjellanda@X.Example");
    c.key(c.root.querySelector("#d-cc"), "Enter");
    await settle();
    expectJson("no chip in Cc", chipsIn(c, "cc"), []);
    expect("the note under Cc names the field", note(c, "cc"), "Bjellanda@X.Example is already in To.");
    expect("the input is cleared", c.value("d-cc"), "");
    expect("nothing to save", c.softOff(c.btn(/^Save$/)), true);
    await c.done();
  }

  group("D2. typed into two fields at once, the first one keeps it");
  {
    const c = await editor({ recipients: { to: [], cc: ["keep@x.example"] } });
    let saved = null;
    c.tools.draft_editor_save = (args) => {
      saved = args;
      return draftResult({ recipients: { to: args.to ?? [], cc: args.cc ?? ["keep@x.example"] } });
    };
    c.press(c.btn(/^Bcc$/));
    await settle();
    c.input("d-to", "sam@x.example");
    c.input("d-bcc", "SAM@x.example, KEEP@x.example");
    await settle();
    c.key(c.root.querySelector("#d-bcc"), "Enter");
    await settle();
    expect("the note names both, in two fields", note(c, "bcc"), "2 of those are already on this draft.");
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("To got it", saved?.to, ["sam@x.example"]);
    expect("Bcc did not", saved?.bcc, undefined);
    await c.done();
  }

  group("D3. the note outlives the space typed after the comma (live re-test)");
  {
    const c = await editor({ recipients: { to: ["asgeir@x.example"] } });
    c.press(c.btn(/^Cc Bcc$/));
    await settle();
    const cc = c.root.querySelector("#d-cc");
    c.input("d-cc", "ASGEIR@X.example");
    c.key(cc, ",");
    await settle();
    expect("the note is shown", note(c, "cc"), "ASGEIR@X.example is already in To.");
    c.input("d-cc", " ");
    await settle();
    expect("a space keeps it", note(c, "cc"), "ASGEIR@X.example is already in To.");
    c.input("d-cc", " s");
    await settle();
    expect("real typing takes it away", note(c, "cc"), null);
    c.input("d-cc", "Dana Smith <dana@x.example>; ");
    await settle();
    expect("the dropped name is said", note(c, "cc"), "Added as dana@x.example. A draft keeps the address, not the name.");
    c.input("d-cc", "  ");
    await settle();
    expect("and outlives spaces too", note(c, "cc"), "Added as dana@x.example. A draft keeps the address, not the name.");
    await after(c.mod.ADDR_NOTE_MS + 100);
    expect("until its time is up", note(c, "cc"), null);
    await c.done();
  }

  group("D4. no incompleteness warning while typing; it comes back on commit (live re-test)");
  {
    const c = await editor({ recipients: { to: [] } });
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "bj");
    c.key(to, "Enter");
    await settle();
    expect("Enter on bj warns", /bj does not look like an email address/.test(warn(c, "to") ?? ""), true);
    c.input("d-to", "ex");
    await settle();
    expect("typing ex: no warning", warn(c, "to"), null);
    expect("and nothing says 'yet'", /not a complete email address yet/.test(c.text()), false);
    expect("the field is not marked invalid mid-typing", to.getAttribute("aria-invalid"), null);
    c.key(to, "Enter");
    await settle();
    expect("Enter warns again", /ex does not look like an email address/.test(warn(c, "to") ?? ""), true);
    c.input("d-to", "ex@x.examp");
    to.dispatchEvent(new c.w.FocusEvent("blur"));
    await settle();
    expect("blur commits a whole address", chipsIn(c, "to").at(-1), "ex@x.examp");
    expect("and the warning goes", warn(c, "to"), null);
    await c.done();
  }

  group("D5. a refused address leaves the draft Saved, in To, Cc and Bcc (persona test, 2026-10-26)");
  {
    for (const field of ["to", "cc", "bcc"]) {
      const c = await editor();
      if (field !== "to") c.press(c.btn(/^Cc Bcc$/));
      await settle();
      expect(`${field}: Saved before`, unsaved(c), false);
      const el = c.root.querySelector(`#d-${field}`);
      c.input(`d-${field}`, "ola.nordmann@example");
      c.key(el, "Enter");
      await settle();
      expect(`${field}: the refusal is said`, /ola\.nordmann@example does not look like an email address, so it was not added\./.test(warn(c, field) ?? ""), true);
      expectJson(`${field}: nothing was added`, chipsIn(c, field), field === "to" ? ["dana@x.example"] : []);
      expect(`${field}: the text stays for fixing`, el.value, "ola.nordmann@example");
      expect(`${field}: still Saved, no Unsaved changes`, unsaved(c), false);
      expect(`${field}: Save still pressable, to say why`, c.softOff(c.btn(/^Save$/)), false);
      c.input(`d-${field}`, "");
      await settle();
      expect(`${field}: cleared, still Saved`, unsaved(c), false);
      c.input(`d-${field}`, "ola.nordmann@example.com");
      await settle();
      expect(`${field}: a whole address typed is unsaved work`, unsaved(c), true);
      await c.done();
    }
  }

  // ── L. Layout of the recipient rows ───────────────────────────────────────

  group("L1. a long list folds to its first row and a +N more button");
  {
    const c = await boot();
    // jsdom has no layout: chips sit four to a row, by their place in the box.
    Object.defineProperty(c.w.HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        const p = this.parentElement;
        if (!p || !p.classList.contains("fld")) return 0;
        const flow = [...p.children].filter((el) => el.matches(".chip, .more-chip"));
        const i = flow.indexOf(this);
        return i < 0 ? 0 : Math.floor(i / 4) * 24;
      },
    });
    const many = Array.from({ length: 14 }, (_, i) => `p${i}@x.example`);
    c.push(draftEnvelope({ recipients: { to: many } }));
    await settle();
    const more = () => c.root.querySelector("#d-to-box .more-chip");
    expect("three chips on the first row", chipsIn(c, "to").length, 3);
    expect("and the button with the rest", more()?.textContent, "+11 more");
    expect("which says what it does", more()?.getAttribute("aria-label"), "Show 11 more To recipients");
    expect("not a Tab stop of its own", more()?.getAttribute("tabindex"), "-1");
    more().click();
    await settle();
    expect("a click shows them all", chipsIn(c, "to").length, 14);
    expect("and puts the caret in the field", c.active()?.id, "d-to");
    c.w.dispatchEvent(new c.w.Event("blur"));
    await settle();
    expect("the frame losing focus folds it again", chipsIn(c, "to").length, 3);
    c.root.querySelector("#d-to").dispatchEvent(new c.w.FocusEvent("focusin", { bubbles: true }));
    await settle();
    expect("focus in the field opens it", chipsIn(c, "to").length, 14);
    c.w.dispatchEvent(new c.w.Event("blur"));
    await settle();
    c.input("d-to", "half");
    await settle();
    expect("text in the field (and its warning) keeps it open", chipsIn(c, "to").length, 14);
    await c.done();
    delete c.w.HTMLElement.prototype.offsetTop;
  }

  group("L2. the To row's link sits inside the box; the input can share a chip row");
  {
    const c = await editor({ recipients: { to: ["a@x.example"] } });
    const link = c.root.querySelector("#d-to-box > .link");
    expect("Cc Bcc is inside the To box", link?.textContent, "Cc Bcc");
    expect("nothing after the box in the row", c.root.querySelector("#d-to-box").nextElementSibling, null);
    expect("the input's minimum is small", /\.fld > input \{[^}]*min-width: 3em/.test(css), true);
    await c.done();
  }

  // ── S. Separators and paste ───────────────────────────────────────────────

  group("S1. a comma, semicolon or space commits as it arrives, key event or not");
  {
    const m = (await boot()).mod;
    expect("a semicolon key ends an address", m.keyEndsAddress(";", "a@x.example"), true);
    expect("not inside a quoted name", m.keyEndsAddress(";", '"Doe; Jane'), false);
    const c = await editor({ recipients: { to: [] } });
    const to = c.root.querySelector("#d-to");
    for (const [typed, label] of [
      ["a@x.example;", "a semicolon with no key event"],
      ["b@x.example ", "a space with no key event"],
      ["c@x.example; ", "a semicolon and a space inserted at once"],
      ["d@x.example,", "a comma with no key event"],
    ]) {
      c.input("d-to", typed);
      await settle();
      expect(`${label}: committed`, chipsIn(c, "to").at(-1), typed.replace(/[;, ]+$/, ""));
      expect(`${label}: input empty`, c.value("d-to"), "");
    }
    c.input("d-to", "e@x.example");
    const ev = new c.w.KeyboardEvent("keydown", { key: ";", bubbles: true, cancelable: true });
    to.dispatchEvent(ev);
    await settle();
    expect("the ; key commits too", chipsIn(c, "to").at(-1), "e@x.example");
    expect("and is not typed", ev.defaultPrevented, true);
    c.input("d-to", "Doe, ");
    await settle();
    expect("a name half typed is left alone", c.value("d-to"), "Doe, ");
    c.input("d-to", "Dana Smith ");
    await settle();
    expect("so is a name with a space", c.value("d-to"), "Dana Smith ");
    await c.done();
  }

  group("S2. a pasted list becomes one chip per address; the rest stays with its warning");
  {
    const c = await editor({ recipients: { to: [] } });
    const prevented = paste(c, "d-to", 'Dana Smith <dana@x.example>\nsam@x.example; "Lee, Jo" <jo@x.example>\r\nkim@x.example, not-an-address');
    await settle();
    expect("the browser's paste is replaced", prevented, true);
    expectJson("one chip each", chipsIn(c, "to"), ["dana@x.example", "sam@x.example", "jo@x.example", "kim@x.example"]);
    expect("the invalid one stays in the input", c.value("d-to"), "not-an-address");
    expect("with the usual warning", /not-an-address does not look like an email address/.test(warn(c, "to") ?? ""), true);
    c.input("d-to", "");
    const single = paste(c, "d-to", "x");
    expect("a paste with no list in it is left to the browser", single, false);
    await c.done();
  }

  // ── C. Suggestions ────────────────────────────────────────────────────────

  group("C1. the adapters (pure)");
  {
    const c = await boot();
    const m = c.mod;
    expectJson("a named address", m.parseNamedAddress('"Smith, Dana" <dana@x.example>'), { address: "dana@x.example", name: "Smith, Dana" });
    expectJson("a bare one", m.parseNamedAddress("sam@x.example"), { address: "sam@x.example", name: null });
    expect("not an address", m.parseNamedAddress("Dana"), null);
    expect("a word in the name matches from its start", m.matchesQuery({ address: "d@x.example", name: "Dana Smith" }, "smi"), true);
    expect("not from its middle", m.matchesQuery({ address: "d@x.example", name: "Dana Smith" }, "mith"), false);
    expect("the address matches anywhere", m.matchesQuery({ address: "dana.smith@x.example", name: null }, "smith"), true);
    const local = m.localContactSource(() => [
      { address: "dana@x.example", name: "Dana" },
      { address: "DANA@x.example", name: null },
      { address: "sam@x.example", name: null },
    ]);
    expectJson("local: matches, one per address, the first kept", await local("da"), [{ address: "dana@x.example", name: "Dana" }]);
    const calls = [];
    const server = m.contactSearchSource((name, args) => {
      calls.push({ name, args });
      return Promise.resolve({ structuredContent: { contacts: [{ email_address: "lee@x.example", display_name: " Lee " }, { display_name: "no address" }] } });
    }, "inbox-1");
    expectJson("server: read into suggestions", await server("le"), [{ address: "lee@x.example", name: "Lee" }]);
    expectJson("server: asks contact_search with a limit and the inbox", calls[0], { name: "contact_search", args: { query: "le", limit: 6, inbox_id: "inbox-1" } });
    const failing = m.contactSearchSource(() => Promise.resolve({ isError: true }), null);
    expectJson("server: a refusal is no suggestions", await failing("le"), []);
    const throwing = m.contactSearchSource(() => Promise.reject(new Error("x")), null);
    expectJson("server: a failure is no suggestions", await throwing("le"), []);
    await c.done();
  }

  group("C2. the combobox: two characters, debounced, keys, pick");
  {
    const c = await editor({
      recipients: { to: [] },
      in_reply_to: { message_id: "INBOX:1", subject: "Hi", from: "Dana Smith <dana@x.example>", date: null },
    });
    const to = c.root.querySelector("#d-to");
    const list = () => c.root.querySelector("#d-to-suggest");
    const options = () => [...c.root.querySelectorAll("#d-to-suggest [role=option]")];
    expect("the input is a combobox", to.getAttribute("role"), "combobox");
    expect("controlling the listbox", to.getAttribute("aria-controls"), "d-to-suggest");
    expect("closed at first", to.getAttribute("aria-expanded"), "false");
    c.input("d-to", "d");
    await waitSugs();
    expect("one character asks nothing", options().length, 0);
    c.input("d-to", "da");
    await settle();
    expect("not before the pause", options().length, 0);
    await waitSugs();
    expectJson("the person this draft answers is suggested", options().map((o) => o.textContent), ["Dana Smith dana@x.example"]);
    expect("open", to.getAttribute("aria-expanded"), "true");
    expect("the list is shown", list().hidden, false);
    expect("the first is active", to.getAttribute("aria-activedescendant"), "d-to-suggest-0");
    expect("and marked selected", options()[0].getAttribute("aria-selected"), "true");
    c.key(to, "ArrowDown");
    await settle();
    expect("Down with one suggestion keeps it (never back to the text)", to.getAttribute("aria-activedescendant"), "d-to-suggest-0");
    c.key(to, "ArrowUp");
    await settle();
    expect("so does Up", to.getAttribute("aria-activedescendant"), "d-to-suggest-0");
    c.key(to, "Escape");
    await settle();
    expect("Escape closes", to.getAttribute("aria-expanded"), "false");
    expect("and leaves the text", c.value("d-to"), "da");
    c.input("d-to", "dan");
    await waitSugs();
    c.key(to, "Enter");
    await settle();
    expectJson("Enter picks it", chipsIn(c, "to"), ["dana@x.example"]);
    expect("the input is empty", c.value("d-to"), "");
    expect("closed after", to.getAttribute("aria-expanded"), "false");
    c.input("d-to", "da");
    await waitSugs();
    expect("someone already on the draft is not suggested", options().length, 0);
    await c.done();
  }

  group("C3. a removed recipient is suggested back; a click picks; a late answer is dropped");
  {
    const c = await editor({ recipients: { to: ["sam@x.example", "lee@x.example"] } });
    c.press(xFor(c, "Remove sam@x.example"));
    await settle();
    c.input("d-to", "sa");
    await waitSugs();
    const opt = c.root.querySelector("#d-to-suggest [role=option]");
    expect("suggested", opt?.textContent, "sam@x.example");
    const down = new c.w.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    opt.dispatchEvent(down);
    expect("pressing it keeps focus in the input", down.defaultPrevented, true);
    opt.click();
    await settle();
    expectJson("a click picks it", chipsIn(c, "to"), ["lee@x.example", "sam@x.example"]);
    c.input("d-to", "le");
    c.input("d-to", "");
    await waitSugs();
    expect("cleared before the answer: nothing opens", c.root.querySelector("#d-to").getAttribute("aria-expanded"), "false");
    await c.done();
  }

  group("C5. Down then Enter on a partial picks a suggestion, never the partial (live re-test)");
  {
    const c = await editor({
      recipients: { to: [], cc: [] },
      in_reply_to: { message_id: "INBOX:1", subject: "Hi", from: "bj@x.example", date: null },
    });
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "bj");
    await waitSugs();
    c.key(to, "ArrowDown");
    await settle();
    c.key(to, "Enter");
    await settle();
    expectJson("the suggestion is the chip", chipsIn(c, "to"), ["bj@x.example"]);
    expect("no warning about bj", warn(c, "to"), null);
    await c.done();
  }

  group("C6. several suggestions: Down and Up go round them only");
  {
    const c = await editor({ recipients: { to: ["sam@x.example", "sal@x.example", "lee@x.example"] } });
    c.press(xFor(c, "Remove sam@x.example"));
    await settle();
    c.press(xFor(c, "Remove sal@x.example"));
    await settle();
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "sa");
    await waitSugs();
    const ad = () => to.getAttribute("aria-activedescendant");
    expect("two suggestions, the first active", ad(), "d-to-suggest-0");
    c.key(to, "ArrowDown");
    await settle();
    expect("Down: the second", ad(), "d-to-suggest-1");
    const sel = () => [...c.root.querySelectorAll("#d-to-suggest [role=option]")].map((o) => o.getAttribute("aria-selected"));
    expectJson("aria-selected follows", sel(), ["false", "true"]);
    c.key(to, "ArrowDown");
    await settle();
    expect("Down from the last: the first", ad(), "d-to-suggest-0");
    c.key(to, "ArrowUp");
    await settle();
    expect("Up from the first: the last", ad(), "d-to-suggest-1");
    c.key(to, "Tab");
    await settle();
    expect("Tab closes", to.getAttribute("aria-expanded"), "false");
    expect("the highlight is the inverse pair", /\.suggest > li\[aria-selected="true"\] \{[^}]*background: var\(--accent\)/.test(css), true);
    expect("the list floats over the rows below", /\.suggest \{[^}]*position: absolute/.test(css), true);
    await c.done();
  }

  group("C7. the address the draft is sent from is never suggested");
  {
    const c = await editor({
      recipients: { to: [], cc: ["you@example.com"] },
      in_reply_to: { message_id: "INBOX:1", subject: "Hi", from: "You <you@example.com>", date: null },
    });
    c.press(xFor(c, "Remove you@example.com"));
    await settle();
    c.input("d-to", "yo");
    await waitSugs();
    expect("nothing suggested", c.root.querySelectorAll("#d-to-suggest [role=option]").length, 0);
    await c.done();
  }

  group("C4. read only: no suggestions");
  {
    const c = await boot();
    c.push({ ...draftEnvelope({ in_reply_to: { from: "dana@x.example" } }), actor: { can_edit: false } });
    await settle();
    expect("no combobox", c.root.querySelector("#d-to")?.getAttribute("role") ?? null, null);
    await c.done();
  }

  // ── F. Files ──────────────────────────────────────────────────────────────

  const FILES = [
    { filename: "notes.txt", size_bytes: 18, mime_type: "text/plain" },
    { filename: "plan.pdf", size_bytes: 1258291, mime_type: "application/pdf" },
  ];

  group("F0. sizes in words, the patch and the rebase (pure)");
  {
    const c = await boot();
    const m = c.mod;
    expectJson("sizes", [0, 1, 18, 1023, 1536, 20480, 1258291, null].map(m.humanSize),
      ["0 bytes", "1 byte", "18 bytes", "1023 bytes", "1.5 KB", "20 KB", "1.2 MB", "size unknown"]);
    const removed = [{ id: "r1", index: 1, filename: "plan.pdf", size_bytes: 1258291 }];
    expectJson("the patch carries no card ids", m.fileEditsPatch({ removed, added: [] }), {
      remove_attachments: [{ index: 1, filename: "plan.pdf", size_bytes: 1258291 }],
    });
    expectJson("no edits, no fields", m.fileEditsPatch({ removed: [], added: [] }), {});
    const moved = m.rebaseFileEdits({ removed, added: [] }, [FILES[1], FILES[0]]);
    expectJson("a removal follows its file", moved.removed.map((r) => [r.id, r.index]), [["r1", 0]]);
    const gone = m.rebaseFileEdits({ removed, added: [] }, [FILES[0]]);
    expectJson("and is dropped with it", gone.removed, []);
    const draft = { attachments: [FILES[1]] };
    expect("an added file landed when it is there", m.patchLanded({ add_attachments: [{ filename: "plan.pdf" }] }, draft), true);
    expect("not when it is not", m.patchLanded({ add_attachments: [{ filename: "x.pdf" }] }, draft), false);
    expect("a removal landed when its place holds another file",
      m.patchLanded({ remove_attachments: [{ index: 0, filename: "notes.txt", size_bytes: 18 }] }, draft), true);
    expect("not when the file is still there",
      m.patchLanded({ remove_attachments: [{ index: 0, filename: "plan.pdf", size_bytes: 1258291 }] }, draft), false);
    await c.done();
  }

  group("F1. each file is a chip with its name and size; remove, Undo, Save");
  {
    const c = await editor({ attachments: FILES });
    expectJson("two chips", fileChips(c), [
      { name: "notes.txt", size: "18 bytes", removed: false, added: false },
      { name: "plan.pdf", size: "1.2 MB", removed: false, added: false },
    ]);
    expect("the old summary line is gone", /1 attachment|2 attachments:/.test(c.text()), false);
    expect("nothing to save", c.softOff(c.btn(/^Save$/)), true);
    c.press(xFor(c, "Remove notes.txt"));
    await settle();
    expectJson("the chip stays in place, marked", fileChips(c).map((f) => f.removed), [true, false]);
    expect("Undo is where its remove button was", !!xFor(c, "Keep notes.txt"), true);
    expect("an unsaved change", unsaved(c), true);
    xFor(c, "Keep notes.txt").click();
    await settle();
    expect("Undo takes it back", fileChips(c)[0].removed, false);
    expect("nothing unsaved", unsaved(c), false);
    let saved = null;
    c.tools.draft_editor_save = (args) => {
      saved = args;
      return draftResult({ attachments: [FILES[1]] });
    };
    c.press(xFor(c, "Remove notes.txt"));
    await settle();
    expect("Save is offered", c.softOff(c.btn(/^Save$/)), false);
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("Save names the file by place, name and size", saved?.remove_attachments, [{ index: 0, filename: "notes.txt", size_bytes: 18 }]);
    expectJson("and nothing else changed", Object.keys(saved ?? {}).filter((k) => !["inbox_id", "draft_id", "base_revision", "remove_attachments"].includes(k)), []);
    await settle();
    expectJson("the saved draft has one file", fileChips(c).map((f) => [f.name, f.removed]), [["plan.pdf", false]]);
    expect("and nothing is unsaved", unsaved(c), false);
    await c.done();
  }

  group("F2. Attach file: a chip marked not saved, sent as base64 on Save");
  {
    const c = await editor({ attachments: [] });
    const link = c.btn(/^Attach file$/);
    expect("Attach file is offered on a draft with no files", !!link, true);
    pickFiles(c, [new c.w.File(["hello"], "hi.txt", { type: "text/plain" })]);
    await after(80);
    expectJson("the new chip", fileChips(c), [{ name: "hi.txt", size: "5 bytes, not saved", removed: false, added: true }]);
    expect("an unsaved change", unsaved(c), true);
    let saved = null;
    c.tools.draft_editor_save = (args) => {
      saved = args;
      return draftResult({ attachments: [{ filename: "hi.txt", size_bytes: 5, mime_type: "text/plain" }] });
    };
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("sent inline", saved?.add_attachments, [{ filename: "hi.txt", mime_type: "text/plain", data: "aGVsbG8=" }]);
    await settle();
    expectJson("then it is a stored file", fileChips(c), [{ name: "hi.txt", size: "5 bytes", removed: false, added: false }]);
    expect("nothing unsaved", unsaved(c), false);
    await c.done();
  }

  group("F3. over the card's 5 MB is named and left out; the rest is attached");
  {
    const c = await editor();
    const big = new c.w.File([new Uint8Array(c.mod.CARD_UPLOAD_MAX_BYTES + 1)], "big.bin");
    pickFiles(c, [big, new c.w.File(["ok"], "ok.txt", { type: "text/plain" })]);
    await after(120);
    expectJson("only the small one", fileChips(c).map((f) => f.name), ["ok.txt"]);
    expect("the note names the big one", /^big\.bin not attached: files added here can be up to 5\.0 MB in all\./.test(c.root.querySelector("#d-files-note")?.textContent ?? ""), true);
    c.press(xFor(c, "Remove ok.txt"));
    await settle();
    expectJson("an added file is dropped by its remove button", fileChips(c), []);
    expect("nothing unsaved", unsaved(c), false);
    await c.done();
  }

  group("F4. Outlook: no remove button; read only: nothing to press");
  {
    const c = await editor({ attachments: FILES, identity: { inbox_id: INBOX, email_address: "you@example.com", provider: "outlook" } });
    expect("no remove on Outlook", !!xFor(c, "Remove notes.txt"), false);
    expect("Attach file still offered", !!c.btn(/^Attach file$/), true);
    await c.done();
    const r = await boot();
    r.push({ ...draftEnvelope({ attachments: FILES }), actor: { can_edit: false } });
    await settle();
    expectJson("read only: the chips", fileChips(r).map((f) => f.name), ["notes.txt", "plan.pdf"]);
    expect("no remove", !!xFor(r, "Remove notes.txt"), false);
    expect("no Attach file", !!r.btn(/^Attach file$/), false);
    await r.done();
  }

  group("F5. a removal follows its file when the assistant rewrites the draft");
  {
    const c = await editor({ attachments: FILES });
    c.press(xFor(c, "Remove plan.pdf"));
    await settle();
    c.push(draftEnvelope({ subject: "Rewritten", attachments: [FILES[1], FILES[0]] }));
    await settle();
    expectJson("still marked, at its new place", fileChips(c).map((f) => [f.name, f.removed]), [["plan.pdf", true], ["notes.txt", false]]);
    let saved = null;
    c.tools.draft_editor_save = (args) => {
      saved = args;
      return draftResult({ subject: "Rewritten", attachments: [FILES[0]] });
    };
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("Save names its new place", saved?.remove_attachments, [{ index: 0, filename: "plan.pdf", size_bytes: 1258291 }]);
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
