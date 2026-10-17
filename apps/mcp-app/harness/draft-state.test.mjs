#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft card's state bugs from the second QA pass of 2026-10-13, driven
// through the REAL card the way draft-qa.test.mjs does: `main.tsx` in jsdom,
// with this file playing the host.
//
//   node harness/draft-state.test.mjs
//
// One group per finding:
//
//   1. "Use the newer version" loads what the mailbox holds now, by reading it
//      again, and never the result the card was mounted with.
//   2. One coherent notice: nothing offers to save over a newer version while
//      saving is off.
//   3. Send follows the recipients on screen, not the last saved ones.
//   4. Discard on a draft that is already gone ends on the receipt; a repeated
//      check says when it was made.
//   5. A card whose draft the assistant has since rewritten folds to one line.
//   6. A card that ends while fullscreen asks for inline again.
//   7. Reopening the chat: a discarded or sent draft stays one line, and a
//      draft saved in the card comes back under its current id.
//   8. A save that takes a while says it is still working.
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
const OUT = resolve(appRoot, "dist/draft-state.bundle.mjs");

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

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { setSendUndoMs } from "./src/components/DraftEditor";\n' +
        'export { getState, setState, disarmResultWatchdog, supersededBy, SUPERSEDE_SLACK_MS, REPLAY_AGE_MS } from "./src/store";\n' +
        'export { editsNotice } from "./src/draft-failure";\n' +
        'export { SLOW_WRITE_MS } from "./src/components/DraftEditor";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-state-entry.ts",
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

  /**
   * A card with an unsaved subject edit, reloaded: returns the storage a
   * reload starts from. The edit was made against the ORIGINAL draft.
   */
  async function stashSubjectEdit() {
    const c = await boot();
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.deliver(TOOL_INPUT);
    c.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    c.input("d-subject", "My subject");
    await settle();
    c.w.dispatchEvent(new c.w.Event("pagehide"));
    const s = c.storage();
    c.kill();
    return s;
  }

  // ── 1. "Use the newer version" ───────────────────────────────────────────

  group("1a. Use the newer version reads the draft again and loads THAT, not the mounted result");
  {
    const s = await stashSubjectEdit();
    const r = await boot({ storage: s });
    // What the mailbox holds now: saved since, two recipients, a new id.
    const newest = { draft_id: "Drafts:103", origin: "read", last_saved_by: "user", subject: "Saved later", recipients: { to: ["dana@x.example", "sam@x.example"] }, body: { text: "The newest saved body." } };
    r.tools.draft_read = () => draftResult(newest);
    r.deliver(TOOL_INPUT);
    await settle();
    r.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("the restored edit is on screen", r.value("d-subject"), "My subject");
    const link = r.btn(/^Use the newer version$/);
    expect("the conflict offers the newer version", !!link, true);
    // The draft moves once more before the click: the click must read again.
    r.tools.draft_read = () => draftResult({ ...newest, draft_id: "Drafts:104", subject: "Saved latest of all" });
    const before = r.calls.length;
    r.press(link);
    await settle();
    await settle();
    expectJson("the click re-read the draft", r.calls.slice(before).map((x) => x.name), ["draft_read"]);
    expect("the subject is the mailbox's current one", r.value("d-subject"), "Saved latest of all");
    expect("never the assistant's original", r.value("d-subject") === "Quarterly numbers", false);
    expect("the body is the current one", r.value("d-body"), "The newest saved body.");
    expect("with both recipients", /sam@x\.example/.test(r.root.querySelector("#d-to-box")?.textContent ?? ""), true);
    expect("the conflict notice is gone", /changed somewhere else/.test(r.text()), false);
    expect("nothing is left unsaved", r.softOff(r.btn(/^Save$/)), true);
    await r.done();
  }

  group("1b. Use the newer version whose read fails keeps the edits");
  {
    const s = await stashSubjectEdit();
    const r = await boot({ storage: s });
    r.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", origin: "read", subject: "Saved later" });
    r.deliver(TOOL_INPUT);
    await settle();
    r.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    r.tools.draft_read = () => TRANSPORT;
    r.press(r.btn(/^Use the newer version$/));
    await settle();
    await settle();
    expect("the edit is still in the box", r.value("d-subject"), "My subject");
    expect("and the card says the check failed", /Could not reach the server to check this draft/.test(r.text()), true);
    await r.done();
  }

  // ── 2. One coherent notice ───────────────────────────────────────────────

  group("2. nothing offers to save over a newer version while saving is off");
  {
    const m = (await boot()).mod;
    const n = (check, restored, conflict, canEdit = true) => m.editsNotice({ canEdit, check, restored, conflict });
    expect("trusted + conflict: the conflict", n("trusted", true, true), "conflict");
    expect("trusted + restored: put back", n("trusted", true, false), "restored");
    expect("unverified: none, whatever else is true", n("unverified", true, true), null);
    expect("read only: none", n("trusted", true, true, false), null);
    expect("still checking: a conflict is not claimed yet", n("checking", true, true), "restored");
    expect("still checking, nothing restored: none", n("pending", false, true), null);
    expect("clean: none", n("trusted", false, false), null);

    // QA's screen: a remount whose check says the draft cannot be found (the
    // lineage table was missing), over edits restored against a newer copy.
    const s = await stashSubjectEdit();
    const r = await boot({ storage: s });
    r.tools.draft_read = () => failedResult("draft_not_found");
    r.deliver(TOOL_INPUT);
    // The replay differs from what the edit was made against, so the restore
    // reads as a conflict at mount.
    r.push(draftEnvelope({ last_saved_at: OLD(), subject: "Original subject" }));
    await settle();
    await settle();
    expect("the draft is in doubt", r.mod.getState().draftCheck, "unverified");
    expect("the red notice says it cannot be saved", /cannot be saved or sent from here/.test(r.text()), true);
    expect("no offer to save over a newer version", /saving will replace the newer version/.test(r.text()), false);
    expect("no Use the newer version over an unchecked copy", !!r.btn(/^Use the newer version$/), false);
    expect("no second notice about put-back edits", /put back/.test(r.text()), false);
    expect("exactly one notice", r.root.querySelectorAll(".notice").length, 1);
    expect("the text is still in the box", r.value("d-subject"), "My subject");
    await r.done();
  }

  // ── 3. Send follows the recipients on screen ─────────────────────────────

  group("3. Send is off the moment the last recipient is removed, and back with one");
  {
    const c = await editor();
    const send = () => c.btn(/^Send$/);
    expect("Send is on with a recipient", c.softOff(send()), false);
    c.press(c.root.querySelector("#d-to-box .chip-x"));
    await settle();
    expect("no recipient left: Send is off before any save", c.softOff(send()), true);
    expect("and says why", send().getAttribute("title"), "Add a recipient to send this draft");
    c.tools.draft = () => sentResult();
    send().click();
    await settle();
    expectJson("pressing it sends nothing", c.calls, []);
    c.input("d-to", "sam@x.example");
    await settle();
    expect("a complete address being typed counts", c.softOff(send()), false);
    c.input("d-to", "sam@x");
    await settle();
    expect("an incomplete one does not", c.softOff(send()), true);
    expect("and the button names the field", /incomplete address in To/.test(send().getAttribute("title")), true);
    await c.done();

    // Cc or Bcc alone is a recipient.
    const b = await editor({ recipients: { to: [], bcc: ["boss@x.example"] } });
    expect("a Bcc alone keeps Send on", b.softOff(b.btn(/^Send$/)), false);
    await b.done();

    // A stored draft with nobody on it: `can_send` is false for that reason,
    // and adding someone turns Send on.
    const e = await editor({ recipients: { to: [] }, can_send: false });
    expect("an empty draft cannot be sent", e.softOff(e.btn(/^Send$/)), true);
    e.input("d-to", "sam@x.example");
    await settle();
    expect("until it has a recipient", e.softOff(e.btn(/^Send$/)), false);
    await e.done();

    // A key that may not send stays off whatever is typed.
    const k = await editor({ can_send: false });
    expect("no send access: off", k.softOff(k.btn(/^Send$/)), true);
    expect("and says so", k.btn(/^Send$/).getAttribute("title"), "This connection is not allowed to send");
    await k.done();
  }

  // ── 4. A draft that is already gone ──────────────────────────────────────

  group("4a. Discard on a draft that is already gone ends on the receipt");
  {
    for (const [label, answer, re] of [
      ["a bare refusal", () => ({ isError: true, content: [{ type: "text", text: "Draft Drafts:102 no longer exists." }] }), /This draft is no longer in Drafts/],
      ["a discarded line", () => failedResult("draft_not_found", "This draft was discarded."), /This draft was discarded/],
      ["a sent line", () => failedResult("draft_not_found", "This draft was already sent."), /This draft was already sent/],
    ]) {
      const c = await editor();
      // The card already knows the draft cannot be found.
      c.tools.draft_read = () => failedResult("draft_not_found");
      c.press(c.btn(/^Refresh$/));
      await settle();
      expect(`${label}: the not-found notice is up`, /could not be found in Drafts/.test(c.text()), true);
      c.tools.draft = answer;
      c.press(c.btn(/^Delete draft$/));
      await settle();
      c.press(c.btn(/^Yes, delete$/));
      await settle();
      expect(`${label}: the editor is gone`, c.isEditor(), false);
      expect(`${label}: one line says how it ended`, re.test(c.text()), true);
      expect(`${label}: no failure notice`, /could not be found in Drafts|Not discarded/.test(c.text()), false);
      expect(`${label}: the card is a receipt`, c.mod.getState().envelope?.card, "receipt");
      expect(`${label}: the frame is not empty`, c.root.children.length > 0, true);
      await c.done();
    }
  }

  group("4b. Check again on a not-found card says when it checked, and recovers when found");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => failedResult("draft_not_found");
    c.input("d-body", "My edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("after the save: no check time yet", /Last checked/.test(c.text()), false);
    c.tools.draft_read = () => failedResult("draft_not_found");
    c.press(c.btn(/^Check again$/));
    await settle();
    expect("still not found", /could not be found in Drafts/.test(c.text()), true);
    expect("with the time it was checked", /Last checked \d{1,2}:\d{2}:\d{2}/.test(c.text()), true);
    expect("the text is still there", c.value("d-body"), "My edit.");
    // Refresh, the footer link, is the same check.
    c.press(c.btn(/^Refresh$/));
    await settle();
    expect("Refresh says so too", /Last checked \d{1,2}:\d{2}:\d{2}/.test(c.text()), true);
    c.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", origin: "read" });
    c.press(c.btn(/^Check again$/));
    await settle();
    expect("found again: the notice is gone", /could not be found/.test(c.text()), false);
    expect("the edit is kept", c.value("d-body"), "My edit.");
    expect("and Save is back", c.softOff(c.btn(/^Save$/)), false);
    await c.done();
  }

  // ── 5. A superseded card folds to one line ───────────────────────────────

  group("5a. supersededBy: only a later write by the assistant");
  {
    const m = (await boot()).mod;
    const held = draftBlock({ revision: 1 });
    const read = (over) => draftBlock({ origin: "read", ...over });
    expect("a higher revision by the assistant", m.supersededBy(held, read({ revision: 2 })), true);
    expect("the same revision", m.supersededBy(held, read({ revision: 1 })), false);
    expect("a higher revision by the person (their own save)", m.supersededBy(held, read({ revision: 2, last_saved_by: "user" })), false);
    expect("a save's own answer never", m.supersededBy(held, draftBlock({ origin: "save", revision: 2 })), false);
    expect("no lineage on the read", m.supersededBy(held, read({})), false);
    const t0 = "2026-10-13T10:00:00.000Z";
    const bare = draftBlock({ last_saved_at: t0 });
    expect("no held revision: a clearly later save", m.supersededBy(bare, read({ revision: 1, last_saved_at: "2026-10-13T10:05:00.000Z" })), true);
    expect("no held revision: the same write, a moment apart", m.supersededBy(bare, read({ revision: 1, last_saved_at: "2026-10-13T10:00:01.000Z" })), false);
    expect("nothing held", m.supersededBy(null, read({ revision: 2 })), false);
  }

  group("5b. reopening the chat: the older card of a rewritten draft is one line");
  {
    const c = await boot();
    c.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", resolved_from: "Drafts:102", origin: "read", revision: 2, body: { text: "The assistant's rewrite." } });
    c.deliver(TOOL_INPUT);
    c.push(draftEnvelope({ last_saved_at: OLD(), revision: 1 }));
    await settle();
    await settle();
    expect("no editor", c.isEditor(), false);
    expect("one line says where the draft went", /A newer version of this draft is below\./.test(c.text()), true);
    expect("the frame is not empty", c.root.children.length > 0, true);
    expect("the stale text is not on screen", /Here they are/.test(c.text()), false);
    // The way back, because the detection is an inference.
    c.press(c.btn(/^Edit here anyway$/));
    await settle();
    expect("Edit here anyway opens the editor", c.isEditor(), true);
    expect("on the current version", c.value("d-body"), "The assistant's rewrite.");
    expect("with Send on", c.softOff(c.btn(/^Send$/)), false);
    await c.done();

    // The person's own save since is not a newer card.
    const u = await boot();
    u.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", resolved_from: "Drafts:102", origin: "read", revision: 2, last_saved_by: "user", body: { text: "Saved by me." } });
    u.deliver(TOOL_INPUT);
    u.push(draftEnvelope({ last_saved_at: OLD(), revision: 1 }));
    await settle();
    await settle();
    expect("own save: still the editor", u.isEditor(), true);
    expect("own save: on the saved text", u.value("d-body"), "Saved by me.");
    await u.done();

    // Unsaved edits are never folded away.
    const s = await stashSubjectEdit();
    const r = await boot({ storage: s });
    r.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", origin: "read", revision: 2, body: { text: "The assistant's rewrite." } });
    r.deliver(TOOL_INPUT);
    await settle();
    r.push(draftEnvelope({ last_saved_at: OLD(), revision: 1 }));
    await settle();
    await settle();
    expect("unsaved edits: the editor stays", r.isEditor(), true);
    expect("unsaved edits: the edit is there", r.value("d-subject"), "My subject");
    await r.done();
  }

  group("5c. a card left on screen notices when focus comes back to it");
  {
    const c = await editor({ revision: 1 });
    c.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", resolved_from: "Drafts:102", origin: "read", revision: 2, body: { text: "The assistant's rewrite." } });
    c.attend();
    await settle();
    expectJson("a card just answered does not ask again", c.calls, []);
    await later(c.mod.REPLAY_AGE_MS + 1000, async () => {
      c.attend();
      await settle();
    });
    expectJson("after a while, one silent read", c.calls.map((x) => [x.name, x.args.draft_id]), [["draft_read", "Drafts:102"]]);
    expect("the card folds to one line", /A newer version of this draft is below\./.test(c.text()), true);
    expect("no editor", c.isEditor(), false);
    await later(3 * c.mod.REPLAY_AGE_MS, async () => {
      c.attend();
      await settle();
    });
    expect("a folded card does not keep asking", c.calls.length, 1);
    await c.done();

    // A silent read that fails says nothing and changes nothing.
    const f = await editor({ revision: 1 });
    f.tools.draft_read = () => TRANSPORT;
    await later(f.mod.REPLAY_AGE_MS + 1000, async () => {
      f.attend();
      await settle();
    });
    expect("failed silent read: one call", f.calls.length, 1);
    expect("failed silent read: no notice", f.root.querySelectorAll(".notice").length, 0);
    expect("failed silent read: still trusted", f.mod.getState().draftCheck, "trusted");
    expect("failed silent read: Send still on", f.softOff(f.btn(/^Send$/)), false);
    await f.done();

    // With unsaved typing the card stays an editor and keeps the typing.
    const e = await editor({ revision: 1 });
    e.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", resolved_from: "Drafts:102", origin: "read", revision: 2, body: { text: "The assistant's rewrite." } });
    e.input("d-subject", "My own subject");
    await settle();
    await later(e.mod.REPLAY_AGE_MS + 1000, async () => {
      e.attend();
      await settle();
    });
    await settle();
    expect("typing: the editor stays", e.isEditor(), true);
    expect("typing: kept", e.value("d-subject"), "My own subject");
    expect("typing: the newer body arrived under it", e.value("d-body"), "The assistant's rewrite.");
    await e.done();
  }

  // ── 6. Leaving fullscreen when the card ends ─────────────────────────────

  group("6. a card that ends while fullscreen asks for inline again");
  {
    const c = await editor();
    c.goFullscreen();
    await settle();
    expect("the card is fullscreen", c.root.getAttribute("data-mode"), "fullscreen");
    c.tools.draft = () => discardedResult();
    c.press(c.btn(/^Delete draft$/));
    await settle();
    c.press(c.btn(/^Yes, delete$/));
    await settle();
    await settle();
    expect("discarded: one line", c.isEditor(), false);
    expectJson("discarded: inline was requested", c.modeRequests(), ["inline"]);
    expect("discarded: the card is inline", c.root.getAttribute("data-mode"), "inline");
    await c.done();

    const s = await editor();
    s.goFullscreen();
    await settle();
    s.tools.draft = () => sentResult();
    s.press(s.btn(/^Send$/));
    await settle();
    expectJson("sent: inline was requested", s.modeRequests(), ["inline"]);
    await s.done();

    const h = await editor();
    h.goFullscreen();
    await settle();
    h.tools.draft_editor_hide = () => receiptResult("executed", "The draft editor is hidden for this inbox.", "executed");
    h.press(h.btn(/^⋯$/));
    await settle();
    h.press(h.btn(/^Turn off draft cards…$/));
    await settle();
    h.press(h.btn(/^This inbox$/));
    await settle();
    expectJson("hidden: inline was requested", h.modeRequests(), ["inline"]);
    await h.done();

    // Folding the card (Hide, not turning it off) leaves fullscreen too.
    const f = await editor();
    f.goFullscreen();
    await settle();
    f.press(f.btn(/^Hide$/));
    await settle();
    expectJson("folded: inline was requested", f.modeRequests(), ["inline"]);
    expectJson("folded: nothing was called", f.calls, []);
    await f.done();

    // Superseded while fullscreen.
    const p = await editor({ revision: 1 });
    p.goFullscreen();
    await settle();
    p.tools.draft_read = () => draftResult({ origin: "read", revision: 2, body: { text: "The assistant's rewrite." } });
    p.press(p.btn(/^Refresh$/));
    await settle();
    await settle();
    expect("superseded: one line", /A newer version of this draft is below\./.test(p.text()), true);
    expectJson("superseded: inline was requested", p.modeRequests(), ["inline"]);
    await p.done();

    // An inline card that ends asks for nothing.
    const i = await editor();
    i.tools.draft = () => sentResult();
    i.press(i.btn(/^Send$/));
    await settle();
    expectJson("inline: no display-mode request", i.modeRequests(), []);
    await i.done();
  }

  // ── 7. Reopening the chat ────────────────────────────────────────────────

  group("7a. a draft discarded in the card stays one line after the chat is reopened");
  {
    const c = await editor();
    c.tools.draft = () => discardedResult();
    c.press(c.btn(/^Delete draft$/));
    await settle();
    c.press(c.btn(/^Yes, delete$/));
    await settle();
    const s = c.storage();
    c.kill();

    // The reopened chat: the host replays the ORIGINAL result, and the server
    // (with lineage) says the draft's line was closed by a delete.
    const r = await boot({ storage: s });
    let answer;
    r.tools.draft_read = () => new Promise((res) => { answer = res; });
    r.deliver(TOOL_INPUT);
    await settle();
    expect("the receipt is back before anything else", /discarded/i.test(r.text()), true);
    r.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    expect("the replay is checked", r.calls.at(-1)?.name, "draft_read");
    expect("no editor while it is checked", r.isEditor(), false);
    expect("the old text is not shown", /Here they are/.test(r.text()), false);
    expect("still the one line", /discarded/i.test(r.text()), true);
    answer(failedResult("draft_not_found", "This draft was discarded."));
    await settle();
    await settle();
    expect("after the check: still no editor", r.isEditor(), false);
    expect("after the check: still the one line", /discarded/i.test(r.text()), true);
    expect("no failure notice", r.root.querySelectorAll(".notice").length, 0);
    expect("the card is a receipt", r.mod.getState().envelope?.card, "receipt");
    await r.done();

    // The check cannot reach the server: the card stays ended.
    const o = await boot({ storage: s });
    o.tools.draft_read = () => TRANSPORT;
    o.deliver(TOOL_INPUT);
    await settle();
    o.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("offline: no editor", o.isEditor(), false);
    expect("offline: still the one line", /discarded/i.test(o.text()), true);
    await o.done();

    // The same key, but the draft is alive (a second call with the same
    // arguments): the editor.
    const a = await boot({ storage: s });
    a.tools.draft_read = () => draftResult({ origin: "read" });
    a.deliver(TOOL_INPUT);
    await settle();
    a.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("a live draft: the editor", a.isEditor(), true);
    expect("a live draft: Send on", a.softOff(a.btn(/^Send$/)), false);
    await a.done();
  }

  group("7b. nothing remembered (another device): a closed draft still ends as one line");
  {
    for (const [headline, re] of [
      ["This draft was discarded.", /This draft was discarded\./],
      ["This draft was already sent.", /This draft was already sent\./],
    ]) {
      const c = await boot();
      c.tools.draft_read = () => failedResult("draft_not_found", headline);
      c.deliver(TOOL_INPUT);
      c.push(draftEnvelope({ last_saved_at: OLD() }));
      await settle();
      await settle();
      expect(`${headline} no editor`, c.isEditor(), false);
      expect(`${headline} one line`, re.test(c.text()), true);
      expect(`${headline} no old text`, /Here they are/.test(c.text()), false);
      await c.done();
    }
    // A draft the server merely cannot find keeps the editor and says so: it
    // may hold text worth copying, and the server did not say it ended.
    const c = await boot();
    c.tools.draft_read = () => failedResult("draft_not_found");
    c.deliver(TOOL_INPUT);
    c.push(draftEnvelope({ last_saved_at: OLD() }));
    await settle();
    await settle();
    expect("plain not found: the editor stays", c.isEditor(), true);
    expect("plain not found: and says so", /could not be found in Drafts/.test(c.text()), true);
    await c.done();
  }

  group("7c. a draft saved in the card comes back current after the chat is reopened");
  {
    const c = await editor();
    c.tools.draft_editor_save = (args) => draftResult({ draft_id: "Drafts:103", origin: "save", last_saved_by: "user", revision: 2, body: { text: args.body_text } });
    c.input("d-body", "Saved in the card.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await after(400);
    c.w.dispatchEvent(new c.w.Event("pagehide"));
    const s = c.storage();
    c.kill();

    const r = await boot({ storage: s });
    // With lineage, either id answers with the current draft.
    r.tools.draft_read = (args) => draftResult({
      draft_id: "Drafts:103",
      ...(args.draft_id === "Drafts:103" ? {} : { resolved_from: args.draft_id }),
      origin: "read",
      last_saved_by: "user",
      revision: 2,
      body: { text: "Saved in the card." },
    });
    r.deliver(TOOL_INPUT);
    await settle();
    r.push(draftEnvelope({ last_saved_at: OLD(), revision: 1 }));
    await settle();
    await settle();
    expect("the read asked with the id the card last held", r.calls[0]?.args.draft_id, "Drafts:103");
    expect("the editor is up", r.isEditor(), true);
    expect("on the saved text, not the pre-save text", r.value("d-body"), "Saved in the card.");
    expect("under the current id", r.mod.getState().envelope?.draft?.draft_id, "Drafts:103");
    expect("no not-found notice", /could not be found/.test(r.text()), false);
    expect("no notice at all", r.root.querySelectorAll(".notice").length, 0);
    expect("Send is on", r.softOff(r.btn(/^Send$/)), false);
    expect("not folded: the person saved it here", /newer version of this draft is below/.test(r.text()), false);
    await r.done();
  }

  // ── 8. A slow save says it is still working ──────────────────────────────

  group("8. a save that takes a while says so, and stops saying so");
  {
    const c = await editor({ identity: { inbox_id: INBOX, email_address: "you@example.com", provider: "gmail" } });
    let answer;
    c.tools.draft_editor_save = () => new Promise((r) => { answer = r; });
    c.input("d-body", "edited");
    await settle();
    const lines = c.root.querySelectorAll(".line.prov").length;
    c.press(c.btn(/^Save$/));
    await settle();
    expect("at first only the button says Saving", /Still saving/.test(c.text()), false);
    await after(c.mod.SLOW_WRITE_MS + 150);
    expect("then a calm hint", /Still saving\. Gmail can take a moment\./.test(c.text()), true);
    expect("in the line that was already there", c.root.querySelectorAll(".line.prov").length, lines);
    expect("not as a notice", c.root.querySelectorAll(".notice").length, 0);
    answer(draftResult({ origin: "save", last_saved_by: "user", identity: { inbox_id: INBOX, email_address: "you@example.com", provider: "gmail" }, body: { text: "edited" } }));
    await settle();
    expect("gone once the save answers", /Still saving/.test(c.text()), false);
    expect("the word count is back", /1 words/.test(c.text()), true);
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
