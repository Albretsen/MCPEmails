#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Draft card polish (QA report of 2026-10-13, "Smaller issues"), and the card's
// side of the server's new draft fields, driven through the REAL card.
//
//   node harness/draft-polish.test.mjs
//
// Same scripted host as draft-qa.test.mjs: `main.tsx` evaluated into jsdom, the
// host answering `ui/initialize` and every `tools/call` from a script. Groups:
//
//   R. recipients: case-insensitive duplicates, Backspace takes the last chip,
//      a comma inside a display name, the warning next to its field and kept
//      current while typing, "Cc Bcc" kept on one line.
//   F. focus: no fullscreen from tabbing through the body; focus survives
//      "Cc Bcc", the signature's Edit and chip removal.
//   L. fullscreen layout (the stylesheet: jsdom does not lay out).
//   C. copy: English dates on a Norwegian locale, the turn-off confirm and
//      receipt naming the dashboard switch, no "new id" note, "Saved earlier".
//   D. Hide folds this card only and Show brings it back as it was; turning
//      cards off is behind the header's "⋯" menu; dashboard links only to a
//      page about the receipt.
//   H. the formatted preview: labelled read only, no `[image: ...]`, the
//      signature set apart.
//   S. server fields: body.formatting_removed, signature.rich, last_saved_at
//      null, and the replay check against a model's fresh draft_read of an old
//      draft (one verifying read, never a loop).
// ---------------------------------------------------------------------------

// Dates are asserted as text, so the zone is pinned before anything reads it.
process.env.TZ = "UTC";

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-polish.bundle.mjs");

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


const SIG_HTML =
  '<p>Here they are.</p>\n<div class="mcpemails-signature"><table><tr><td><img src="https://x.example/logo.png" alt="MCP Emails logo"></td><td>Asgeir<br><a href="https://mcpemails.com">mcpemails.com</a></td></tr></table></div>';
const SIG_TEXT = "Here they are.\n\n-- \nAsgeir\nmcpemails.com";

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n' +
        'export { splitAddresses, commaEndsAddress, addressKey } from "./src/components/DraftEditor";\n' +
        'export { hiddenDetail, turnOnUrl } from "./src/components/App";\n' +
        'export { dashboardLinkLabel } from "./src/components/Receipt";\n' +
        'export { setLocale, formatDateTime, formatWhen } from "./src/format";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-polish-entry.ts",
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

  // ── R. Recipients ─────────────────────────────────────────────────────────

  group("R0. address parsing (pure)");
  {
    const c = await boot();
    const m = c.mod;
    expectJson("a comma inside an unquoted display name is not a separator", m.splitAddresses("Doe, Jane <jane@x.example>"), ["jane@x.example"]);
    expectJson("nor inside a quoted one", m.splitAddresses('"Doe, Jane" <jane@x.example>, sam@x.example'), ["jane@x.example", "sam@x.example"]);
    expectJson("plain lists still split on , and ;", m.splitAddresses("a@x.example, b@x.example; c@x.example"), ["a@x.example", "b@x.example", "c@x.example"]);
    expectJson("a stray word with no address after it stays its own (invalid) piece", m.splitAddresses("Doe, sam@x.example"), ["Doe", "sam@x.example"]);
    expect("a comma after a bare name does not end an address", m.commaEndsAddress("Doe"), false);
    expect("nor inside quotes", m.commaEndsAddress('"Doe'), false);
    expect("a comma after an address does", m.commaEndsAddress("sam@x.example"), true);
    expect("addresses compare case-insensitively", m.addressKey("Dana <Dana@X.Example>"), m.addressKey("dana@x.example"));
    await c.done();
  }

  group("R1. an upper-case copy of an address is not added twice");
  {
    const c = await editor();
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "Dana@X.example");
    c.key(to, "Enter");
    await settle();
    expectJson("still one chip", chipsIn(c, "to"), ["dana@x.example"]);
    expect("the field is cleared", c.value("d-to"), "");
    c.input("d-to", "sam@x.example, SAM@x.example");
    c.key(to, "Enter");
    await settle();
    expectJson("nor within one paste", chipsIn(c, "to"), ["dana@x.example", "sam@x.example"]);
    await c.done();
  }

  group("R2. Backspace in an empty field removes the last chip, on the second press");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example"] } });
    const to = c.root.querySelector("#d-to");
    to.focus();
    c.key(to, "Backspace");
    await settle();
    // The two-step itself is pinned in draft-ux.test.mjs.
    expectJson("the first press removes nothing", chipsIn(c, "to"), ["a@x.example", "b@x.example"]);
    c.key(to, "Backspace");
    await settle();
    expectJson("the last chip went", chipsIn(c, "to"), ["a@x.example"]);
    expect("focus stays in the field", c.active()?.id, "d-to");
    c.input("d-to", "x");
    c.key(c.root.querySelector("#d-to"), "Backspace");
    await settle();
    expectJson("not while the field has text", chipsIn(c, "to"), ["a@x.example"]);
    await c.done();
  }

  group("R3. Doe, Jane <jane@x.example> is one recipient, with no false warning");
  {
    const c = await editor();
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "Doe");
    const ev = new c.w.KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true });
    to.dispatchEvent(ev);
    await settle();
    expect("typing the comma after a name does not commit it", ev.defaultPrevented, false);
    expectJson("no chip yet", chipsIn(c, "to"), ["dana@x.example"]);
    c.input("d-to", "Doe, Jane <jane@x.example>");
    c.key(to, "Enter");
    await settle();
    expectJson("one chip, the address", chipsIn(c, "to"), ["dana@x.example", "jane@x.example"]);
    expect("no warning", /does not look like/.test(c.text()), false);
    await c.done();
  }

  group("R4. the warning sits under its field and follows the correction");
  {
    const c = await editor({ recipients: { to: [] } });
    const to = c.root.querySelector("#d-to");
    c.input("d-to", "a@b");
    c.key(to, "Enter");
    await settle();
    const warn = c.root.querySelector("#d-to-warn");
    expect("a warning for To", !!warn, true);
    expect("directly under the To row", warn?.previousElementSibling?.contains(to), true);
    expect("the field points at it", to.getAttribute("aria-describedby"), "d-to-warn");
    expect("and is marked invalid", to.getAttribute("aria-invalid"), "true");
    c.input("d-to", "a@b.");
    await settle();
    expect("still invalid: the warning names the current text", /a@b\. is not a complete/.test(c.text()), true);
    expect("not the old text", /a@b does not look/.test(c.text()), false);
    c.input("d-to", "a@b.example");
    await settle();
    expect("valid: the warning is gone", !!c.root.querySelector("#d-to-warn"), false);
    expect("and the field is no longer marked", to.getAttribute("aria-invalid"), null);
    await c.done();
  }

  group("R5. the Cc Bcc link never wraps");
  {
    expect("a link in a field row does not wrap", /\.row > \.link \{[^}]*white-space: nowrap/.test(css), true);
    expect("and does not shrink", /\.row > \.link \{[^}]*flex: 0 0 auto/.test(css), true);
  }

  // ── F. Focus ──────────────────────────────────────────────────────────────

  group("F1. tabbing into and typing in the message box does not open fullscreen");
  {
    const c = await editor();
    c.root.querySelector("#d-body").focus();
    c.input("d-body", "typed");
    await settle();
    expectJson("no display-mode request", c.requests.filter((r) => /display-mode/.test(r.method)), []);
    expect("Expand is still offered", !!c.btn(/^Expand$/), true);
    c.press(c.btn(/^Expand$/));
    await settle();
    expect("and asks when pressed", c.requests.some((r) => /display-mode/.test(r.method)), true);
    await c.done();
  }

  group("F2. focus moves on, rather than being dropped, after Cc Bcc, Edit and chip removal");
  {
    const c = await editor({ recipients: { to: ["a@x.example", "b@x.example", "c@x.example"] }, body: { text: SIG_TEXT } });
    c.press(c.btn(/^Cc Bcc$/));
    await settle();
    expect("Cc Bcc: focus is in Cc", c.active()?.id, "d-cc");
    c.press(c.btn(/^Edit$/));
    await settle();
    expect("signature Edit: focus is in the signature box", c.active()?.id, "d-signature");
    const x = (addr) => c.root.querySelector(`[aria-label="Remove ${addr}"]`);
    // Focus lands on the chip, not on its remove button: the buttons are out
    // of the tab order (draft-ux.test.mjs).
    c.press(x("a@x.example"));
    await settle();
    expect("removing the first chip focuses the one that took its place", c.active(), x("b@x.example").parentElement);
    c.press(x("c@x.example"));
    await settle();
    expect("removing the last chip focuses the one before", c.active(), x("b@x.example").parentElement);
    c.press(x("b@x.example"));
    await settle();
    expect("removing the only chip focuses the field", c.active()?.id, "d-to");
    expectJson("no chips left", chipsIn(c, "to"), []);
    await c.done();
  }

  // ── L. Fullscreen layout ──────────────────────────────────────────────────

  group("L. fullscreen uses the width, scrolls once and keeps Save/Send in view");
  {
    const fs = css.slice(css.indexOf('.card[data-mode="fullscreen"] {'));
    expect("no 720px column", /\.card\[data-mode="fullscreen"\] \{[^}]*max-width: 720px/.test(css), false);
    expect("a wide cap instead", /\.card\[data-mode="fullscreen"\] \{[^}]*max-width: 1100px/.test(css), true);
    // Only where `:has()` is missing. The draft editor's own layout, in which
    // the row is not over the content at all, is pinned in draft-ux.test.mjs.
    expect("the action row is sticky", /\.card\[data-mode="fullscreen"\] > \.acts \{[^}]*position: sticky;[^}]*bottom: 0/.test(fs), true);
    expect("with room for the host's composer, safe-area first", /--fs-room: max\(var\(--safe-bottom\), \d+px\)/.test(css), true);
    const c = await boot();
    c.push(draftEnvelope());
    await settle();
    // Fullscreen: the host context changes, and the box must not cap itself.
    c.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "fullscreen" } });
    await settle();
    expect("the card is in fullscreen", c.root.getAttribute("data-mode"), "fullscreen");
    expect("the provider line can be ordered above the footer", !!c.root.querySelector(":scope > .prov"), true);
    await c.done();
  }

  // ── C. Copy ───────────────────────────────────────────────────────────────

  group("C1. dates are English on a Norwegian locale, with its 24-hour clock");
  {
    const c = await boot();
    c.mod.setLocale("nb-NO");
    const at = "2025-10-09T14:02:00Z";
    const dt = c.mod.formatDateTime(at);
    expect("English month", /Oct/.test(dt), true);
    expect("not Norwegian", /okt/i.test(dt), false);
    expect("24-hour clock kept", /14:02/.test(dt), true);
    const now = new Date("2026-10-13T16:00:00Z");
    expect("today: the time alone", c.mod.formatWhen("2026-10-13T14:02:00Z", now), "14:02");
    expect("this year: no year", c.mod.formatWhen("2026-10-09T14:02:00Z", now), "Oct 9, 14:02");
    expect("before: with the year", /^Oct 9, 2025, 14:02$/.test(c.mod.formatWhen(at, now)), true);
    c.mod.setLocale("en-US");
    expect("an American locale keeps its 12-hour clock", /2:02\sPM/.test(c.mod.formatWhen("2026-10-13T14:02:00Z", now)), true);
    c.mod.setLocale(undefined);
    await c.done();
  }

  group("C2. the turn-off confirm and receipt say how to turn the card back on");
  {
    const c = await editor();
    expect("the bottom row has no Hide any more", !!c.root.querySelector(".acts .link") && [...c.root.querySelectorAll(".acts .link")].some((l) => l.textContent.trim() === "Hide"), false);
    c.press(c.btn(/^⋯$/));
    await settle();
    expect("the menu opens", !!c.root.querySelector('[role="menu"]'), true);
    expect("focus is on its item", c.active()?.textContent, "Turn off draft cards…");
    c.press(c.btn(/^Turn off draft cards…$/));
    await settle();
    expect("the confirm names the dashboard switch", /Show the draft editor\s+card/.test(c.text()), true);
    expect("and where it is", /MCP Emails dashboard/.test(c.text()), true);
    expectJson("nothing was called yet", c.calls, []);
    c.tools.draft_editor_hide = (args) => ({
      content: [{ type: "text", text: "Draft editor card hidden." }],
      structuredContent: {
        schema_version: "review-card-v1",
        card: "receipt",
        state: "discarded",
        dashboard_url: "https://mcpemails.com/dashboard",
        receipt: {
          outcome: "discarded",
          headline: "Draft editor hidden.",
          detail: `The card will not appear for you@example.com. Drafts still work exactly as before. Call draft_editor_hide again with scope:"${args.scope}" and hidden:false.`,
          affected_count: 1,
          dashboard_url: "https://mcpemails.com/dashboard",
          error_code: null,
        },
      },
    });
    c.press(c.btn(/^This inbox$/));
    await settle();
    expect("the receipt is shown", /Draft cards turned off\./.test(c.text()), true);
    expect("without the model's instruction", /draft_editor_hide|hidden:false/.test(c.text()), false);
    expect("with the person's way back", /Show the draft editor card/.test(c.text()), true);
    expect("for one inbox: under Inboxes", /under Inboxes/.test(c.text()), true);
    expect("a link to the switch", !!c.btn(/^Turn cards back on$/), true);
    expect("no generic dashboard link", !!c.btn(/^Open in dashboard$/), false);
    expect("for all: under Settings", /under Settings/.test(c.mod.hiddenDetail("workspace")), true);
    expect("inbox switch URL", c.mod.turnOnUrl("inbox", "https://mcpemails.com/dashboard"), "https://mcpemails.com/dashboard/inboxes");
    expect("workspace switch URL", c.mod.turnOnUrl("workspace", "https://mcpemails.com/dashboard"), "https://mcpemails.com/dashboard/settings");
    expect("never from a non-https base", c.mod.turnOnUrl("inbox", "javascript:alert(1)"), null);
    await c.done();
  }

  group("D1. Hide folds this card only, and Show brings it back with the edits");
  {
    const c = await editor();
    c.input("d-body", "Typed but not saved.");
    await settle();
    c.press(c.btn(/^Hide$/));
    await settle();
    expectJson("nothing was called", c.calls.filter((x) => x.name !== "draft_editor_save"), []);
    expect("folded: no editor", c.root.querySelector("#d-body"), null);
    expect("folded: the subject is on the line", c.text().includes("Quarterly numbers"), true);
    expect("folded: says there are unsaved changes", /Unsaved changes/.test(c.text()), true);
    expect("focus is on Show", c.active()?.textContent, "Show");
    c.press(c.btn(/^Show$/));
    await settle();
    expect("Show brings the editor back", !!c.root.querySelector("#d-body"), true);
    expect("with the unsaved text", c.value("d-body")?.startsWith("Typed but not saved."), true);
    expect("focus is on Hide", c.active()?.textContent, "Hide");
    await c.done();
  }

  group("D2. the menu closes on Escape and returns focus to its button");
  {
    const c = await editor();
    c.press(c.btn(/^⋯$/));
    await settle();
    c.key(c.active(), "Escape");
    await settle();
    expect("closed", c.root.querySelector('[role="menu"]'), null);
    expect("focus on ⋯", c.active()?.textContent.trim(), "⋯");
    c.press(c.btn(/^Hide$/));
    await settle();
    expect("the folded card still has the menu", !!c.btn(/^⋯$/), true);
    await c.done();
  }

  group("D3. dashboard links only to a page about the receipt");
  {
    const c = await boot();
    const m = c.mod;
    expect("bare dashboard: no link", m.dashboardLinkLabel("https://mcpemails.com/dashboard"), null);
    expect("bare dashboard with a slash: no link", m.dashboardLinkLabel("https://mcpemails.com/dashboard/"), null);
    expect("approvals: open it", m.dashboardLinkLabel("https://mcpemails.com/dashboard/approvals"), "Open in dashboard");
    expect("settings: the way back", m.dashboardLinkLabel("https://mcpemails.com/dashboard/settings"), "Turn cards back on");
    expect("inboxes: the way back", m.dashboardLinkLabel("https://mcpemails.com/dashboard/inboxes"), "Turn cards back on");
    expect("nothing: no link", m.dashboardLinkLabel(null), null);
    await c.done();
  }

  group("C3. no 'new id' note, and a draft with no save time reads 'Saved earlier'");
  {
    const c = await editor({ id_is_stable: false, last_saved_at: null, last_saved_by: null, origin: "read" });
    c.tools.draft_read = () => draftResult({ origin: "read", last_saved_at: null, last_saved_by: null });
    await settle();
    const titles = [...c.root.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).join(" ");
    expect("no new-id text on screen", /new id/i.test(c.text()), false);
    expect("nor in a tooltip", /new id/i.test(titles), false);
    expect("not 'Not saved yet'", /Not saved yet/.test(c.text()), false);
    expect("'Saved earlier'", /Saved earlier/.test(c.text()), true);
    await c.done();
  }

  // ── H. The formatted preview ──────────────────────────────────────────────

  group("H. the formatted preview is read only, image-free and sets the signature apart");
  {
    const c = await editor({ body: { text: SIG_TEXT, html: SIG_HTML }, signature: { embedded: true, rich: true } });
    c.press(c.btn(/^Show formatting$/));
    await settle();
    const pv = c.root.querySelector(".html-preview");
    expect("a distinct preview block", !!pv, true);
    expect("labelled read only", /read only/i.test(pv?.textContent ?? ""), true);
    expect("no [image: ...] literal", /\[image/.test(pv?.textContent ?? ""), false);
    expect("the signature is its own block", !!pv?.querySelector(".html-sig"), true);
    expect("with its text", /Asgeir/.test(pv?.querySelector(".html-sig")?.textContent ?? ""), true);
    expect("the message is before it", /Here they are/.test(pv?.textContent ?? ""), true);
    expect("no editable box while previewing", !!c.root.querySelector("#d-body"), false);
    expect("table cells carry no border", /\.body-html th \{ border: 0;/.test(css), true);
    await c.done();
  }

  // ── S. The server's new fields ────────────────────────────────────────────

  group("S1. body.formatting_removed: one line, and no Show formatting");
  {
    const c = await editor({ body: { text: SIG_TEXT, html: SIG_HTML }, signature: { embedded: true, rich: true } });
    c.tools.draft_editor_save = () =>
      draftResult({ draft_id: "Drafts:140", origin: "save", body: { text: SIG_TEXT + "!", html: null, formatting_removed: true }, signature: { embedded: true } });
    c.press(c.btn(/^Edit$/));
    await settle();
    c.input("d-signature", "Asgeir\nmcpemails.com!");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("the save landed", c.mod.getState().envelope?.draft?.draft_id, "Drafts:140");
    expect("it says the formatting was removed", /removed this draft's formatting/.test(c.text()), true);
    expect("Show formatting is not offered", !!c.btn(/^Show formatting$/), false);
    await c.done();
  }

  group("S2. signature.rich: warned before editing, preview withdrawn once edited");
  {
    const c = await editor({ body: { text: SIG_TEXT, html: SIG_HTML }, signature: { embedded: true, rich: true } });
    expect("Show formatting is offered at first", !!c.btn(/^Show formatting$/), true);
    expect("Edit warns in its tooltip", /plain text/.test(c.btn(/^Edit$/)?.getAttribute("title") ?? ""), true);
    c.press(c.btn(/^Edit$/));
    await settle();
    expect("opening the box warns before any change", /Changing\s+it here saves it as plain text/.test(c.text()), true);
    c.input("d-signature", "Asgeir!\nmcpemails.com");
    await settle();
    expect("once edited: saving will replace the formatting", /Saving will replace the signature's formatting/.test(c.text()), true);
    expect("the old preview is no longer offered", !!c.btn(/^Show formatting$/), false);
    c.press(c.btn(/^Undo signature changes$/));
    await settle();
    expect("undo puts the stored signature back", /Saving will replace/.test(c.text()), false);
    expect("and the preview returns", !!c.btn(/^Show formatting$/), true);
    expect("nothing left to save", c.softOff(c.btn(/^Save$/)), true);

    // A body-only edit keeps the formatting, so it does not warn.
    c.input("d-body", "Here they are, revised.");
    await settle();
    expect("a body edit does not warn", /Saving will replace/.test(c.text()), false);
    await c.done();
  }

  group("S3. a plain signature edit does not warn");
  {
    const c = await editor({ body: { text: SIG_TEXT } });
    c.press(c.btn(/^Edit$/));
    await settle();
    c.input("d-signature", "Asgeir!");
    await settle();
    expect("no formatting warning", /formatting/.test(c.text()), false);
    await c.done();
  }

  group("S4. a model's fresh draft_read of an old draft: one verifying read, then Send");
  {
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const c = await boot();
    c.tools.draft_read = () => draftResult({ origin: "read", last_saved_at: old, last_saved_by: "user" });
    c.push(draftEnvelope({ origin: "read", last_saved_at: old, last_saved_by: "user" }));
    await settle();
    await settle();
    expect("exactly one draft_read", c.calls.filter((x) => x.name === "draft_read").length, 1);
    expect("trusted after it", c.mod.getState().draftCheck, "trusted");
    expect("Send is on", c.softOff(c.btn(/^Send$/)), false);
    expect("no checking line left", /Checking for a newer version/.test(c.text()), false);
    expect("the header shows the real save, by the person", /Saved .* by you/.test(c.text()), true);
    // The host repeats the result (a re-render, a second notification).
    c.push(draftEnvelope({ origin: "read", last_saved_at: old, last_saved_by: "user" }));
    await after(150);
    expect("no second read, no loop", c.calls.filter((x) => x.name === "draft_read").length, 1);
    expect("still trusted", c.mod.getState().draftCheck, "trusted");
    // Refresh is the card's own answer, also carrying the old stamp.
    c.press(c.btn(/^Refresh$/));
    await settle();
    expect("Refresh reads once", c.calls.filter((x) => x.name === "draft_read").length, 2);
    expect("and stays trusted", c.mod.getState().draftCheck, "trusted");
    expect("Send still on", c.softOff(c.btn(/^Send$/)), false);
    await c.done();
  }

  group("S5. the same with last_saved_at null");
  {
    const c = await boot();
    c.tools.draft_read = () => draftResult({ origin: "read", last_saved_at: null, last_saved_by: null });
    c.push(draftEnvelope({ origin: "read", last_saved_at: null, last_saved_by: null }));
    await settle();
    await settle();
    expect("exactly one draft_read", c.calls.filter((x) => x.name === "draft_read").length, 1);
    expect("Send is on", c.softOff(c.btn(/^Send$/)), false);
    expect("'Saved earlier'", /Saved earlier/.test(c.text()), true);
    await after(150);
    expect("still one read", c.calls.filter((x) => x.name === "draft_read").length, 1);
    await c.done();
  }

  group("S6. a re-read answered under a newer id (resolved_from) is adopted silently");
  {
    const c = await boot();
    c.tools.draft_read = () => draftResult({ draft_id: "Drafts:150", resolved_from: "Drafts:102", origin: "read", last_saved_at: null });
    c.push(draftEnvelope({ origin: "read", last_saved_at: null }));
    await settle();
    await settle();
    expect("the current id is adopted", c.mod.getState().envelope?.draft?.draft_id, "Drafts:150");
    expect("trusted", c.mod.getState().draftCheck, "trusted");
    expect("nothing about ids on screen", /Drafts:|resolved/i.test(c.text()), false);
    c.tools.draft = () => ({ content: [{ type: "text", text: "Sent." }], structuredContent: { schema_version: "review-card-v1", card: "receipt", state: "sent", receipt: { outcome: "sent", headline: "Sent.", detail: "", affected_count: 1, dashboard_url: null } } });
    c.press(c.btn(/^Send$/));
    await settle();
    expect("Send uses the current id", c.calls.at(-1)?.args?.draft_id, "Drafts:150");
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
