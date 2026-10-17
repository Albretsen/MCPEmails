#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft card QA blockers of 2026-10-13, driven through the REAL card.
//
//   node harness/draft-qa.test.mjs
//
// Every scenario boots `main.tsx` into jsdom, as card-render.test.mjs does, and
// plays the HOST: it answers `ui/initialize`, pushes the tool result, and
// answers every `tools/call` the card makes from a script. So what is pinned
// here is the whole path a person hits, from the button through App.tsx and
// store.ts to the screen, and not a restatement of any one module.
//
// One group per brief item:
//
//   1. a failed action (failed receipt, transport error, unreadable answer)
//      never takes the editor or the typed text away; it says so in human
//      words; a lost answer is followed by a `draft_read` that reconciles, and
//      a current id in the answer is adopted.
//   2. a replayed (remounted) result is re-read before it is trusted, and Send
//      is off until then.
//   3. unsaved edits survive a reload through sessionStorage (never
//      localStorage), and nothing is written unattended while in doubt.
//   4. cancelling a confirm returns focus to the link that opened it, never to
//      Send; Escape cancels; focus starts on the safe choice.
//   5. Save keeps focus through busy and failure.
//   6. Save and Send refuse while an address field holds text that is not a
//      valid address, and say so.
//
// DEPENDENCIES: esbuild (via vite) and jsdom (via the apps/web workspace), both
// resolved up out of the root node_modules, as in draft-sync.test.mjs.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-qa.bundle.mjs");

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
          hostContext: { theme: "light", displayMode: "inline" },
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
      // Any other request (update-model-context, display mode): answer empty.
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
  return { dom, w, calls, tools, deliver };
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
        'export { setSendUndoMs } from "./src/components/DraftEditor";\n' +
        'export { getState, setState, disarmResultWatchdog, runTeardownSaver, mergeEnvelope, isReplayedDraft, REPLAY_AGE_MS } from "./src/store";\n' +
        'export { failureNotice, patchLanded, textRefusalCode } from "./src/draft-failure";\n' +
        'export { loadUnsaved, saveUnsaved, clearUnsaved } from "./src/unsaved";\n' +
        // The SAME Preact instance main.tsx rendered with, so a scenario can
        // unmount its card and stop its timers before the next one boots.
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-qa-entry.ts",
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

  // ── 0. The pure rules, on the real modules ───────────────────────────────

  group("0. every failure notice is human, whatever the code");
  {
    const c = await boot();
    const codes = [
      "transport", "unreadable", "draft_not_found", "draft_has_attachments", "invalid_recipients",
      "provider_error", "insufficient_scope", "insufficient_role", "inbox_not_found",
      "draft_editor_hidden", "draft_editor_disabled", "invalid_arguments", "", "something_new",
      "draft_changed", "draft_already_sent", "quota_exceeded", "auth_failed",
      "approval_unavailable", "draft_has_no_recipients", "not_sent",
    ];
    const bad = [];
    for (const code of codes) {
      for (const action of ["save", "send", "refresh", "discard", "hide"]) {
        for (const settled of [null, "landed", "not_landed", "still_there"]) {
          const n = c.mod.failureNotice({ action, code, settled, headline: "Error: draft_not_found" });
          const f = forbiddenIn(n.text);
          if (f.length || !n.text) bad.push(`${code}/${action}/${settled}: ${f}`);
        }
      }
    }
    expectJson("no notice carries model or protocol wording", bad, []);
    expect(
      "an already-sent draft is named as sent (new server, same code)",
      /already sent/.test(c.mod.failureNotice({ action: "save", code: "draft_not_found", headline: "This draft was already sent." }).text),
      true,
    );
    const d = draftBlock({ recipients: { to: ["Dana@X.example"] }, body: { text: "a\r\nb" } });
    expect("patchLanded: same fields, case and CRLF tolerant", c.mod.patchLanded({ to: ["dana@x.example"], body_text: "a\nb" }, d), true);
    expect("patchLanded: a field that differs", c.mod.patchLanded({ subject: "Other" }, d), false);
    expect("patchLanded: an empty patch never claims saved", c.mod.patchLanded({}, d), false);
    const now = Date.parse("2026-10-13T12:00:00Z");
    const env = draftEnvelope({ last_saved_at: "2026-10-13T11:59:58Z" });
    expect("isReplayedDraft: a fresh result is not a replay", c.mod.isReplayedDraft(env, null, now), false);
    expect("isReplayedDraft: an old one is", c.mod.isReplayedDraft(draftEnvelope({ last_saved_at: "2026-10-13T11:00:00Z" }), null, now), true);
    expect("isReplayedDraft: a stub restored from storage always is", c.mod.isReplayedDraft(env, "storage", now), true);
    expect("isReplayedDraft: no stamp counts as a replay", c.mod.isReplayedDraft(draftEnvelope({ last_saved_at: null }), null, now), true);
    const merged = c.mod.mergeEnvelope(draftEnvelope(), failedResult("draft_not_found").structuredContent);
    expect("mergeEnvelope: a failed receipt keeps the editor", merged.card, "draft_editor");
    expect("mergeEnvelope: with the draft in it", merged.draft?.draft_id, "Drafts:102");
    await c.done();
  }

  // ── 1. A failed action never takes the editor away ───────────────────────

  group("1a. a failed receipt on Save keeps the editor, the text and says so in human words");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => failedResult("draft_not_found");
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("the editor is still there", !!c.value("d-subject"), true);
    expect("the typed text is still in the box", c.value("d-body"), "My careful edit.");
    expect("the card names the problem", /could not be found/.test(c.text()), true);
    expectJson("no model or protocol wording on screen", forbiddenIn(c.text()), []);
    expect("Check again is offered", !!c.btn(/^Check again$/), true);
    expect("Copy text is offered", !!c.btn(/^Copy text$/), true);
    expect("Save is off: the id names nothing", c.softOff(c.btn(/^Save$/)), true);
    expect("Send is off", c.softOff(c.btn(/^Send$/)), true);
    await c.done();
  }

  group("1b. a lost save that DID land: re-read, adopt the new id, keep the text");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => TRANSPORT;
    // The server stored it under a new id. With lineage, the old id resolves.
    c.tools.draft_read = () => draftResult({ draft_id: "Drafts:103", origin: "read", body: { text: "My careful edit." } });
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    expectJson("save, then a re-read with the id the card held", c.calls.map((x) => [x.name, x.args.draft_id]), [
      ["draft_editor_save", "Drafts:102"],
      ["draft_read", "Drafts:102"],
    ]);
    expect("the new id is adopted", c.mod.getState().envelope?.draft?.draft_id, "Drafts:103");
    expect("the text is still in the box", c.value("d-body"), "My careful edit.");
    expect("it says the changes were saved", /your changes were saved/.test(c.text()), true);
    expectJson("no raw -32603 on screen", forbiddenIn(c.text()), []);
    expect("the draft is trusted again", c.mod.getState().draftCheck, "trusted");
    expect("Send is on", c.softOff(c.btn(/^Send$/)), false);
    c.tools.draft = () => sentResult();
    c.press(c.btn(/^Send$/));
    await settle();
    expectJson("and the send uses the CURRENT id, and says which revision it shows", c.calls.at(-1), {
      name: "draft",
      args: { action: "send", inbox_id: INBOX, draft_id: "Drafts:103", base_revision: 0 },
    });
    await c.done();
  }

  group("1c. a lost save that did NOT land: text kept, Save and Try again offered");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => TRANSPORT;
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    expect("the text is still in the box", c.value("d-body"), "My careful edit.");
    expect("it says the changes were not saved", /before your changes were saved/.test(c.text()), true);
    expect("Save is on again", c.softOff(c.btn(/^Save$/)), false);
    c.tools.draft_editor_save = () => draftResult({ draft_id: "Drafts:104", origin: "save", body: { text: "My careful edit." } });
    const retry = c.btn(/^Try again$/);
    expect("Try again is offered", !!retry, true);
    c.press(retry);
    await settle();
    expectJson("Try again repeats the save, with the edit", c.calls.at(-1), {
      name: "draft_editor_save",
      args: { inbox_id: INBOX, draft_id: "Drafts:102", base_revision: 0, body_text: "My careful edit." },
    });
    await c.done();
  }

  group("1d. a lost save and a lost re-read: nothing offered blind");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => TRANSPORT;
    c.tools.draft_read = () => TRANSPORT;
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    expect("the editor is still there with the text", c.value("d-body"), "My careful edit.");
    expect("the draft is in doubt", c.mod.getState().draftCheck, "unverified");
    expect("it says it is not clear", /not clear whether your changes were saved/.test(c.text()), true);
    expect("Save is off", c.softOff(c.btn(/^Save$/)), true);
    expect("Send is off", c.softOff(c.btn(/^Send$/)), true);
    expect("Check again is offered", !!c.btn(/^Check again$/), true);
    expectJson("no raw transport wording", forbiddenIn(c.text()), []);
    // Teardown must not write blind either.
    const before = c.calls.length;
    await c.mod.runTeardownSaver();
    await settle();
    expect("teardown writes nothing while in doubt", c.calls.length, before);
    await c.done();
  }

  group("1e. old server: a lost save, then the old id is gone");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => TRANSPORT;
    c.tools.draft_read = () => failedResult("draft_not_found");
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    expect("the editor is still there with the text", c.value("d-body"), "My careful edit.");
    expect("it says the draft could not be found", /could not be found/.test(c.text()), true);
    expect("Copy text is offered", !!c.btn(/^Copy text$/), true);
    expectJson("no model wording", forbiddenIn(c.text()), []);
    await c.done();
  }

  group("1f. an unreadable isError answer is treated as lost, and reconciled");
  {
    const c = await editor();
    c.tools.draft_editor_save = () => ({ isError: true, content: [{ type: "text", text: "Error: upstream exploded" }] });
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.input("d-body", "My careful edit.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    await settle();
    expect("a re-read followed", c.calls.at(-1)?.name, "draft_read");
    expect("the text is still in the box", c.value("d-body"), "My careful edit.");
    expectJson("the raw error text is not shown", forbiddenIn(c.text()), []);
    await c.done();
  }

  group("1g. a lost send: re-read, say the draft is still there, and keep Send off until confirmed");
  {
    const c = await editor();
    c.tools.draft = () => TRANSPORT;
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.press(c.btn(/^Send$/));
    await settle();
    await settle();
    expect("the editor is still there", c.value("d-subject"), "Quarterly numbers");
    expect("it says it does not look sent", /does not look like it was sent/.test(c.text()), true);
    expect("the re-read made the draft trusted", c.mod.getState().draftCheck, "trusted");
    expect("but Send stays off: it may have gone out", c.softOff(c.btn(/^Send$/)), true);
    expect("and the card says why", /could not confirm whether this draft was sent/.test(c.text()), true);
    const sends = () => c.calls.filter((x) => x.name === "draft").length;
    c.press(c.btn(/^Send$/));
    await settle();
    expect("pressing Send does nothing", sends(), 1);
    // A Save (or a Refresh) replaces the failure notice; the hold outlives it.
    c.tools.draft_editor_save = () => draftResult({ origin: "save", subject: "Edited" });
    c.input("d-subject", "Edited");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expect("after a Save, Send is still off", c.softOff(c.btn(/^Send$/)), true);
    const allow = c.btn(/turn sending back on/);
    expect("the person can turn it back on", !!allow, true);
    c.press(allow);
    await settle();
    expect("and then Send works", c.softOff(c.btn(/^Send$/)), false);
    c.tools.draft = () => sentResult();
    c.press(c.btn(/^Send$/));
    await settle();
    expect("one more send, on purpose", sends(), 2);
    await c.done();
  }

  group("1h. two cards: a stale card's Save is refused as draft_changed; text kept; newer version offered");
  {
    // Card A shows revision 1 of Drafts:102. The assistant has since rewritten
    // it as Drafts:103 (revision 2), with a different recipient.
    const c = await editor({ revision: 1 });
    const newer = { draft_id: "Drafts:103", revision: 2, origin: "read", resolved_from: "Drafts:102", recipients: { to: ["new-recipient@x.example"] }, body: { text: "The assistant's corrected body." } };
    const changed = failedResult("draft_changed", "This draft was changed somewhere else.", "Nothing was saved. Your text is still here. Load the newer version to see what changed.");
    changed.structuredContent.current = draftEnvelope(newer);
    c.tools.draft_editor_save = () => changed;
    c.input("d-body", "Here they are, edited in card A.");
    await settle();
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("the save said which revision it was editing", c.calls.at(-1)?.args, {
      inbox_id: INBOX, draft_id: "Drafts:102", base_revision: 1, body_text: "Here they are, edited in card A.",
    });
    expect("the editor is still there", c.mod.getState().envelope?.card, "draft_editor");
    expect("still on the copy it showed", c.mod.getState().envelope?.draft?.draft_id, "Drafts:102");
    expect("the typed text is still in the box", c.value("d-body"), "Here they are, edited in card A.");
    expect("it says the draft changed elsewhere", /changed somewhere else after you opened it/.test(c.text()), true);
    expectJson("no model wording", forbiddenIn(c.text()), []);
    expect("Save is off", c.softOff(c.btn(/^Save$/)), true);
    expect("Send is off", c.softOff(c.btn(/^Send$/)), true);
    expect("Copy text is offered", !!c.btn(/^Copy text$/), true);
    const load = c.btn(/^Load the newer version$/);
    expect("Load the newer version is offered", !!load, true);
    c.tools.draft_read = () => draftResult(newer);
    c.press(load);
    await settle();
    expectJson("loading re-reads the draft", [c.calls.at(-1)?.name, c.calls.at(-1)?.args.draft_id], ["draft_read", "Drafts:102"]);
    expect("the newer id is adopted", c.mod.getState().envelope?.draft?.draft_id, "Drafts:103");
    expect("with its revision", c.mod.getState().envelope?.draft?.revision, 2);
    expect("the person's text is still on top", c.value("d-body"), "Here they are, edited in card A.");
    expect("the newer recipient is on screen", /new-recipient@x\.example/.test(c.text()), true);
    expect("it says the edits would replace the newer version", /saving will replace the newer version/.test(c.text()), true);
    expect("Save is on again", c.softOff(c.btn(/^Save$/)), false);
    c.tools.draft_editor_save = (args) => draftResult({ draft_id: "Drafts:104", revision: 3, origin: "save", recipients: { to: ["new-recipient@x.example"] }, body: { text: args.body_text } });
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("the next save is on the current id and revision", [c.calls.at(-1)?.args.draft_id, c.calls.at(-1)?.args.base_revision], ["Drafts:103", 2]);
    await c.done();
  }

  group("1i. two cards: Save and send from the stale card sends nothing");
  {
    const c = await editor({ revision: 1 });
    c.tools.draft_editor_save = () => failedResult("draft_changed", "This draft was changed somewhere else.", "Nothing was saved.");
    c.tools.draft = () => sentResult();
    c.input("d-body", "Edited in card A.");
    await settle();
    c.press(c.btn(/^Send$/));
    await settle();
    expectJson("a save was tried, and no send followed", c.calls.map((x) => x.name), ["draft_editor_save"]);
    expect("the text is kept", c.value("d-body"), "Edited in card A.");
    expect("the card says it was not saved", /Not saved\. This draft was changed somewhere else/.test(c.text()), true);
    await c.done();
  }

  group("1j. Save and send whose save is refused as draft_changed sends nothing");
  {
    const c = await editor({ revision: 1 });
    c.tools.draft_editor_save = () => failedResult("draft_changed", "x", "y");
    c.tools.draft = () => sentResult();
    c.input("d-body", "Edited.");
    await settle();
    c.press(c.btn(/^Send$/));
    await settle();
    expectJson("the save was refused, and NOT sent", c.calls.map((x) => x.name), ["draft_editor_save"]);
    expect("the card says why", /Not saved\. This draft was changed somewhere else/.test(c.text()), true);
    expect("the edit is still in the box", c.value("d-body"), "Edited.");
    await c.done();
  }

  group("1k. a send refused as draft_changed, or as already sent, stops there");
  {
    for (const [code, re] of [["draft_changed", /Not sent\. This draft was changed somewhere else/], ["draft_already_sent", /already sent/]]) {
      const c = await editor({ revision: 4 });
      c.tools.draft = () => failedResult(code, "x", "y");
      c.press(c.btn(/^Send$/));
      await settle();
      expectJson(`${code}: the send carried the revision`, c.calls.at(-1)?.args, { action: "send", inbox_id: INBOX, draft_id: "Drafts:102", base_revision: 4 });
      expect(`${code}: the editor is kept`, c.value("d-subject"), "Quarterly numbers");
      expect(`${code}: the card says so`, re.test(c.text()), true);
      expect(`${code}: Send is off`, c.softOff(c.btn(/^Send$/)), true);
      expect(`${code}: nothing retried`, c.calls.length, 1);
      await c.done();
    }
  }

  group("1l. a send refused with a bare error sentence says so, and only a lost one keeps Send off");
  {
    const cases = [
      ["Your email account has exceeded its sending quota. Please try again later.", /Not sent\. Your email account has reached its sending limit/, false],
      ["Unable to access the gmail inbox: its OAuth token has been revoked or expired, so the inbox has been marked 'error'. Ask the user to reconnect it by opening this link in their browser: https://mcpemails.com/x", /Not sent\. This mailbox needs to be reconnected/, false],
      ["draft_send: unable to create the required approval request. No draft was sent; retry shortly.", /Not sent\. This mailbox asks for approval before sending/, false],
      ["The mail server refused this message before any of it was transmitted, so nothing was sent: there is no delivery.", /Not sent\. The mail server refused it before anything went out/, false],
      ["Draft Drafts:102 no longer exists. On this inbox each draft_update rewrites the draft and returns a NEW draft_id.", /could not be found in Drafts/, true],
    ];
    for (const [text, re, sendOff] of cases) {
      const c = await editor();
      c.tools.draft = () => ({ isError: true, content: [{ type: "text", text }] });
      c.tools.draft_read = () => draftResult({ origin: "read" });
      c.press(c.btn(/^Send$/));
      await settle();
      await settle();
      const label = text.slice(0, 24);
      expect(`${label}: the card says it in a person's words`, re.test(c.text()), true);
      expect(`${label}: never "the connection dropped"`, /connection dropped|Could not reach the server/.test(c.text()), false);
      expectJson(`${label}: no model wording`, forbiddenIn(c.text()), []);
      expect(`${label}: no re-read, the server answered`, c.calls.some((x) => x.name === "draft_read"), false);
      expect(`${label}: Send ${sendOff ? "waits for a re-read" : "is still on"}`, c.softOff(c.btn(/^Send$/)), sendOff);
      expect(`${label}: the editor is kept`, c.value("d-subject"), "Quarterly numbers");
      await c.done();
    }
    // A send the server itself calls "may or may not have been delivered" is a
    // lost answer: re-read, and Send stays off until the person says so.
    const c = await editor();
    c.tools.draft = () => ({
      isError: true,
      delivery_status: "unknown",
      content: [{ type: "text", text: "An error occurred while sending the draft via gmail. The message may or may not have been delivered. Do not retry automatically to avoid duplicate delivery." }],
    });
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.press(c.btn(/^Send$/));
    await settle();
    await settle();
    expect("unknown delivery: re-read", c.calls.at(-1)?.name, "draft_read");
    expect("unknown delivery: Send stays off", c.softOff(c.btn(/^Send$/)), true);
    // And on a save, a bare error sentence is never taken as a refusal.
    expect("textRefusalCode reads only the server's own sentences", c.mod.textRefusalCode({ isError: true, content: [{ type: "text", text: "Error: upstream exploded" }] }), null);
    await c.done();
  }

  // ── 2. A replayed result is re-read before it is trusted ─────────────────

  group("2a. a remounted card checks the replayed result before offering Send");
  {
    const c = await boot();
    let answer;
    c.tools.draft_read = () => new Promise((r) => { answer = r; });
    c.push(draftEnvelope({ last_saved_at: "2026-10-13T11:59:00.000Z" }));
    await settle();
    expect("a re-read was asked for", c.calls.at(-1)?.name, "draft_read");
    expect("Send is off while unchecked", c.softOff(c.btn(/^Send$/)), true);
    expect("and the card says it is checking", /Checking for a newer version/.test(c.text()), true);
    answer(draftResult({ draft_id: "Drafts:110", subject: "Renamed since", origin: "read" }));
    await settle();
    expect("the current copy is shown", c.value("d-subject"), "Renamed since");
    expect("under the current id", c.mod.getState().envelope?.draft?.draft_id, "Drafts:110");
    expect("Send is on once checked", c.softOff(c.btn(/^Send$/)), false);
    await c.done();
  }

  group("2b. a replay whose re-read fails stays unsendable, and says why");
  {
    const c = await boot();
    c.tools.draft_read = () => TRANSPORT;
    c.push(draftEnvelope({ last_saved_at: "2026-10-13T11:59:00.000Z" }));
    await settle();
    await settle();
    expect("unverified", c.mod.getState().draftCheck, "unverified");
    expect("Send is off", c.softOff(c.btn(/^Send$/)), true);
    expect("Check again is offered", !!c.btn(/^Check again$/), true);
    await c.done();
  }

  group("2c. a fresh first result is trusted without an extra read");
  {
    const c = await editor();
    expectJson("no read", c.calls, []);
    expect("Send is on", c.softOff(c.btn(/^Send$/)), false);
    await c.done();
  }

  // ── 3. Unsaved edits survive a reload ────────────────────────────────────

  group("3. unsaved edits are kept in sessionStorage across a reload, never in localStorage");
  {
    // As a reload sees it: the result is minutes old by the time it is replayed.
    const original = draftEnvelope({ last_saved_at: new Date(Date.now() - 600_000).toISOString() });
    const toolInput = {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { action: "create", inbox_id: INBOX, to: ["dana@x.example"], subject: "Quarterly numbers", body: "Here they are." } },
    };
    const c = await boot();
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.deliver(toolInput);
    c.push(original);
    await settle();
    await settle();
    c.input("d-body", "Half-typed, not saved.");
    c.input("d-to", "sam@x");
    await settle();
    c.w.dispatchEvent(new c.w.Event("pagehide"));
    const s = c.storage();
    const session = s.session.find(([k]) => k === UNSAVED_KEY)?.[1] ?? "";
    expect("the edit is in sessionStorage", session.includes("Half-typed, not saved."), true);
    expect("with the half-typed address", session.includes("sam@x"), true);
    expect("nothing but the pointer is in localStorage", s.local.every(([k]) => k === CARD_KEY), true);
    expect(
      "and no content reached localStorage",
      s.local.some(([, v]) => v.includes("Half-typed") || v.includes("Quarterly")),
      false,
    );
    c.kill();

    // The reload: a new frame with the same tab storage, handed the ORIGINAL
    // result by the host. The re-read answers with the stored draft unchanged.
    const r = await boot({ storage: s });
    let answer;
    const reads = [];
    r.tools.draft_read = () => new Promise((res) => { reads.push(res); answer = (v) => reads.forEach((f) => f(v)); });
    r.deliver(toolInput);
    await settle();
    r.push(original);
    await settle();
    expect("the edit is back in the box", r.value("d-body"), "Half-typed, not saved.");
    expect("the half-typed address is back", r.value("d-to"), "sam@x");
    expect("the card says they were put back", /put back/.test(r.text()), true);
    const before = r.calls.length;
    await r.mod.runTeardownSaver();
    await settle();
    expect("teardown writes nothing while restored edits are unchecked", r.calls.length, before);
    answer(draftResult({ origin: "read", last_saved_at: new Date().toISOString() }));
    await settle();
    expect("the edit survives the re-read", r.value("d-body"), "Half-typed, not saved.");
    r.tools.draft_editor_save = () => draftResult({ draft_id: "Drafts:120", origin: "save", recipients: { to: ["dana@x.example", "sam@x.example"] }, body: { text: "Half-typed, not saved." } });
    r.input("d-to", "sam@x.example");
    await settle();
    r.press(r.btn(/^Save$/));
    await settle();
    await after(400);
    expect(
      "a save clears what was kept",
      (r.storage().session.find(([k]) => k === UNSAVED_KEY)?.[1] ?? "").includes("Half-typed"),
      false,
    );
    await r.done();
  }

  group("3b. unsaved edits belong to the card that made them: a second card on the same draft starts clean");
  {
    const gmail = (over = {}) => draftEnvelope({ draft_id: "r-77", id_is_stable: true, identity: { inbox_id: INBOX, email_address: "you@example.com", provider: "gmail" }, ...over });
    const inputFor = (args) => ({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } });
    const callA = inputFor({ action: "create", inbox_id: INBOX, to: ["dana@x.example"], subject: "Quarterly numbers", body: "Here they are." });
    const callB = inputFor({ action: "update", inbox_id: INBOX, draft_id: "r-77", body: "Here they are." });

    const a = await boot();
    a.deliver(callA);
    a.push(gmail());
    await settle();
    a.input("d-body", "Card A's half-typed edit.");
    await settle();
    a.w.dispatchEvent(new a.w.Event("pagehide"));
    const s = a.storage();
    expect("card A's edit is stashed", (s.session.find(([k]) => k === UNSAVED_KEY)?.[1] ?? "").includes("Card A's"), true);
    a.kill();

    // Card B: same tab, same Gmail draft id, a different tool call.
    const b = await boot({ storage: s });
    b.deliver(callB);
    await settle();
    b.push(gmail({ origin: "update" }));
    await settle();
    expect("card B shows the stored body, not card A's edit", b.value("d-body"), "Here they are.");
    expect("and says nothing was put back", /put back/.test(b.text()), false);
    b.kill();

    // Card A reloaded: the same call, so its edit comes back.
    const r = await boot({ storage: s });
    // The replay is checked and found current. (Unchecked, the one notice is
    // the one that says saving is off: draft-state.test.mjs, group 2.)
    r.tools.draft_read = () => ({ structuredContent: gmail({ origin: "read" }), content: [{ type: "text", text: "{}" }] });
    r.deliver(callA);
    await settle();
    r.push(gmail());
    await settle();
    await settle();
    expect("card A's reload gets its edit back", r.value("d-body"), "Card A's half-typed edit.");
    expect("and says so", /put back/.test(r.text()), true);
    r.kill();
  }

  group("3c. restored edits over a draft that changed since: the conflict notice, against the verified copy");
  {
    const toolInput = {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { action: "create", inbox_id: INBOX, subject: "Quarterly numbers", body: "Here they are." } },
    };
    const original = draftEnvelope({ last_saved_at: new Date(Date.now() - 600_000).toISOString() });
    const c = await boot();
    c.tools.draft_read = () => draftResult({ origin: "read" });
    c.deliver(toolInput);
    c.push(original);
    await settle();
    await settle();
    c.input("d-subject", "My subject");
    await settle();
    c.w.dispatchEvent(new c.w.Event("pagehide"));
    const s = c.storage();
    c.kill();

    // Reload: the replayed result is verified, and the verified copy has a
    // subject somebody else changed meanwhile.
    const r = await boot({ storage: s });
    r.tools.draft_read = () => draftResult({ origin: "read", subject: "Changed elsewhere", last_saved_at: new Date().toISOString() });
    r.deliver(toolInput);
    await settle();
    r.push(original);
    await settle();
    await settle();
    expect("the restored edit is kept", r.value("d-subject"), "My subject");
    expect("the conflict is shown", /This draft was changed somewhere else/.test(r.text()), true);
    expect("and that the edits were put back", /put back/.test(r.text()), true);
    const before = r.calls.length;
    await r.mod.runTeardownSaver();
    await settle();
    expect("nothing is written unattended over it", r.calls.length, before);
    r.kill();

    // The re-read answering AFTER the editor is up with the restored edit:
    // the edit is rebased onto the verified copy, and the conflict is found
    // there, not only at boot.
    const late = await boot({ storage: s });
    let answer;
    late.tools.draft_read = () => new Promise((res) => { answer = res; });
    late.deliver(toolInput);
    await settle();
    late.push(original);
    await settle();
    expect("late re-read: the edit is up before the answer", late.value("d-subject"), "My subject");
    expect("late re-read: no conflict yet", /changed somewhere else/.test(late.text()), false);
    answer(draftResult({ origin: "read", subject: "Changed elsewhere", last_saved_at: new Date().toISOString() }));
    await settle();
    await settle();
    expect("late re-read: the edit is kept", late.value("d-subject"), "My subject");
    expect("late re-read: the conflict is shown", /This draft was changed somewhere else/.test(late.text()), true);
    late.kill();

    // The same reload against a verified copy nobody touched: no conflict.
    const q = await boot({ storage: s });
    q.tools.draft_read = () => draftResult({ origin: "read", last_saved_at: new Date().toISOString() });
    q.deliver(toolInput);
    await settle();
    q.push(original);
    await settle();
    await settle();
    expect("unchanged copy: the edit is back", q.value("d-subject"), "My subject");
    expect("unchanged copy: no conflict claimed", /changed somewhere else/.test(q.text()), false);
    expect("unchanged copy: the put-back notice", /put back/.test(q.text()), true);
    q.kill();

    // A restore whose verified copy changed a DIFFERENT field than the one
    // edited is not a conflict either.
    const o = await boot({ storage: s });
    o.tools.draft_read = () => draftResult({ origin: "read", body: { text: "Body changed elsewhere." }, last_saved_at: new Date().toISOString() });
    o.deliver(toolInput);
    await settle();
    o.push(original);
    await settle();
    await settle();
    expect("other field changed: the server's body is shown", o.value("d-body"), "Body changed elsewhere.");
    expect("other field changed: the edit is kept", o.value("d-subject"), "My subject");
    expect("other field changed: no conflict claimed", /changed somewhere else/.test(o.text()), false);
    o.kill();
  }

  // ── 4. Confirms: focus and Escape ────────────────────────────────────────

  group("4. cancelling Discard returns focus to Discard, never to Send");
  {
    const c = await editor();
    c.input("d-body", "edited");
    await settle();
    const discard = c.btn(/^Delete draft$/);
    c.press(discard);
    await settle();
    const no = c.btn(/^Keep draft$/);
    const yes = c.btn(/^Yes, delete$/);
    expect("focus starts on the safe choice", c.active(), no);
    const row = [...no.parentElement.querySelectorAll("button")];
    expect("No comes before Yes, so it is not where Send sits", row.indexOf(no) < row.indexOf(yes), true);
    expect("Yes is not the first stop", row[0] === yes, false);
    c.press(no);
    await settle();
    expect("focus is back on Discard", c.active(), c.btn(/^Delete draft$/));
    expect("not on Send", /send/i.test(c.active()?.textContent ?? ""), false);
    // The second half of a double click lands where No was.
    c.btn(/^Send$/).click();
    c.btn(/^Save$/).click();
    await settle();
    expectJson("a click right after closing sends and saves nothing", c.calls, []);

    c.press(c.btn(/^Delete draft$/));
    await settle();
    c.key(c.active(), "Escape");
    await settle();
    expect("Escape cancels the confirm", !!c.btn(/^Yes, delete$/), false);
    expect("and returns focus to Discard", c.active(), c.btn(/^Delete draft$/));

    c.press(c.btn(/^⋯$/));
    await settle();
    c.press(c.btn(/^Turn off draft cards…$/));
    await settle();
    expect("Turn off: focus starts on Cancel", c.active(), c.btn(/^Cancel$/));
    c.key(c.active(), "Escape");
    await settle();
    expect("Turn off: Escape returns focus to the menu button", c.active(), c.btn(/^⋯$/));
    expectJson("nothing was called", c.calls, []);
    await c.done();
  }

  // ── 5. Save keeps focus ──────────────────────────────────────────────────

  group("5. Save keeps focus while busy and after it fails");
  {
    const c = await editor();
    let answer;
    c.tools.draft_editor_save = () => new Promise((r) => { answer = r; });
    c.input("d-body", "edited");
    await settle();
    const save = c.btn(/^Save$/);
    c.press(save);
    await settle();
    const busy = c.btn(/^Saving$/);
    expect("the busy button is the same element", busy, save);
    expect("it is not natively disabled", busy.disabled, false);
    expect("it says it is unavailable", busy.getAttribute("aria-disabled"), "true");
    expect("focus is still on it", c.active(), save);
    answer(failedResult("provider_error", "That draft could not be read.", "Try again shortly."));
    await settle();
    expect("after the failure focus is still on Save", c.active(), save);
    expect("the text is kept", c.value("d-body"), "edited");
    await c.done();
  }

  // ── 6. Invalid or uncommitted recipients block Save and Send ─────────────

  group("6. a@b typed in To blocks Save and Send, and says so");
  {
    const c = await editor();
    c.input("d-to", "a@b");
    await settle();
    const save = c.btn(/^Save$/);
    expect("Save can be pressed for typed text", c.softOff(save), false);
    c.press(save);
    await settle();
    expectJson("nothing was saved", c.calls, []);
    expect("the text is still in the field", c.value("d-to"), "a@b");
    expect("the card says what is wrong", /"a@b" in To is not a complete email address/.test(c.text()), true);
    expect("focus is on the field", c.active()?.id, "d-to");
    c.press(c.btn(/^Send$/));
    await settle();
    expectJson("nothing was sent either", c.calls, []);

    c.input("d-to", "sam@x.example, a@b");
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("still nothing written", c.calls, []);
    expect("only the bad part stays in the field", c.value("d-to"), "a@b");
    expect("the good one became a chip", /sam@x\.example/.test(c.root.querySelector(".fld")?.textContent ?? ""), true);

    c.tools.draft_editor_save = (args) => draftResult({ draft_id: "Drafts:130", origin: "save", recipients: { to: args.to } });
    c.input("d-to", "");
    c.press(c.btn(/^Save$/));
    await settle();
    expectJson("with the field fixed, the save goes out with the address", c.calls.at(-1)?.args.to, ["dana@x.example", "sam@x.example"]);
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
