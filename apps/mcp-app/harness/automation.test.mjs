#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The automation card, driven through the REAL card.
//
//   node harness/automation.test.mjs
//
// Boots `main.tsx` into jsdom, plays the host (pushes the tool-input and a
// plain `automation` / `automation_read` result, answers `card_automation`
// from a script) and reads the screen. What is pinned: the model's plain
// result is enough to mount the card, the rule sentence and matches render,
// "nothing matches" is said plainly, a dry-run result asks only for the rule,
// the switch sends one call per click with only automation_id + enabled, a
// refused switch shows the server's words, a list result is one line, and a
// hostile sender stays text.
//
// DEPENDENCIES: esbuild and jsdom from the root node_modules. example.com only.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/automation.bundle.mjs");
const PROTOCOL_VERSION = "2026-01-26";

const groups = [];
let current = null;
function group(name) {
  current = { name, checks: [] };
  groups.push(current);
}
function expect(label, actual, wanted) {
  current.checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
}
const expectJson = (label, actual, wanted) => expect(label, JSON.stringify(actual), JSON.stringify(wanted));
const after = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => after(40);

const RULE = "11111111-1111-4111-8111-111111111111";
const HOSTILE = '<img src=x onerror="alert(1)">news@example.com';

function cardRule(over = {}) {
  return {
    schema_version: "review-card-v1",
    card: "automation",
    state: "pending",
    automation: {
      id: RULE,
      name: "Newsletters",
      enabled: false,
      sentence: "Move mail from news@example.com to Newsletters, every hour.",
      inbox: "me@example.com",
      note: null,
      ...over,
    },
  };
}
const ok = (env) => ({ content: [{ type: "text", text: "ok" }], structuredContent: env });
const matches = (n) => Array.from({ length: n }, (_, i) => ({ from: i ? "news@example.com" : HOSTILE, subject: `Issue ${i}` }));

// ---- the DOM, which is also the host ----------------------------------------

// The scripted tools for the NEXT card, set before it mounts: the card calls
// `card_automation` the moment the result lands.
let nextTools = {};
function installDomOnce() {
  nextTools = {};
  return { tools: nextTools };
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
    pretendToBeVisual: true,
    url: "https://card.test/",
  });
  const w = dom.window;
  const calls = [];
  const tools = nextTools;
  nextTools = {};
  const sent = [];
  const deliver = (message) =>
    queueMicrotask(() => w.dispatchEvent(new w.MessageEvent("message", { data: message, source: w })));

  w.postMessage = (message) => {
    sent.push(message);
    if (message.method === "ui/initialize") {
      deliver({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: { name: "scripted-host", version: "0.0.1" },
          hostCapabilities: { openLinks: {}, updateModelContext: { text: {} } },
          hostContext: { theme: "light", displayMode: "inline" },
        },
      });
      return;
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      calls.push({ name, args });
      const fn = tools[name];
      Promise.resolve(fn ? fn(args) : { error: { code: -32603, message: "no" } }).then((r) => {
        if (r && r.error) deliver({ jsonrpc: "2.0", id: message.id, error: r.error });
        else deliver({ jsonrpc: "2.0", id: message.id, result: r });
      });
      return;
    }
    if (message.id !== undefined && message.method) deliver({ jsonrpc: "2.0", id: message.id, result: {} });
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
  return { w, calls, tools, sent, deliver };
}

let instance = 0;
async function card(result, input = {}) {
  const host = installDom();
  const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
  const root = globalThis.document.getElementById("root");
  const until = Date.now() + 2000;
  while (Date.now() < until && !mod.getState().connected) await after(5);
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input } });
  await settle();
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
  await settle();
  const tabs = () => [...root.querySelectorAll('[role="tab"]')];
  return {
    ...host,
    root,
    tabs,
    on: () => tabs().find((t) => t.textContent === "On"),
    off: () => tabs().find((t) => t.textContent === "Off"),
    selected: () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? null,
    text: () => root.textContent,
    done: () => {
      mod.disarmResultWatchdog();
      mod.render(null, root);
    },
  };
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'import "./src/main";\n' +
        'export { getState, disarmResultWatchdog } from "./src/store";\n' +
        'export { render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "automation-entry.ts",
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

  // The model's own result for create / get / enable: a plain automation row.
  const created = { content: [{ type: "text", text: "{}" }], structuredContent: { automation: { id: RULE, name: "Newsletters", enabled: false } } };

  group("1. a rule result mounts the card and asks for the rest");
  {
    let reply;
    const pending = new Promise((r) => (reply = r));
    const host = installDomOnce();
    host.tools.card_automation = () => pending;
    const c = await card(created, { action: "create" });
    expectJson("one call, the rule id only", c.calls, [{ name: "card_automation", args: { automation_id: RULE } }]);
    reply(ok(cardRule({ matched: 7, capped: false, matches: matches(5) })));
    await settle();
    expect("the sentence", /Move mail from news@example\.com to Newsletters, every hour\./.test(c.text()), true);
    expect("the inbox", /In me@example\.com\./.test(c.text()), true);
    expect("the count", /7 messages match right now:/.test(c.text()), true);
    expect("five rows", c.root.querySelectorAll("ul.samples > li").length, 5);
    expect("hostile sender is text", c.root.querySelector("img"), null);
    expect("switch shows Off", c.selected(), "Off");
    c.done();
  }

  group("2. nothing matches is said plainly; a capped count says so");
  {
    installDomOnce().tools.card_automation = () => ok(cardRule({ matched: 0, capped: false, matches: [] }));
    const c = await card(created);
    expect("plain zero", /Nothing in this inbox matches right now\./.test(c.text()), true);
    expect("no list", c.root.querySelector("ul.samples"), null);
    c.done();
  }
  {
    installDomOnce().tools.card_automation = () => ok(cardRule({ matched: 25, capped: true, matches: matches(5) }));
    const c = await card(created);
    expect("25+", /25\+ messages match right now:/.test(c.text()), true);
    c.done();
  }

  group("3. a dry-run result asks only for the rule");
  {
    installDomOnce().tools.card_automation = () => ok(cardRule());
    const preview = ok({ applied: false, inbox_id: "x", matched: 1, capped_at: 25, matches: matches(1).slice(1).concat({ from: "a@example.com", subject: "Hi", date: "2026-10-20" }) });
    const c = await card(preview, { action: "preview", automation_id: RULE });
    expectJson("preview false", c.calls[0]?.args, { automation_id: RULE, preview: false });
    expect("the result's own match", /1 message matches right now:/.test(c.text()) && /a@example\.com/.test(c.text()), true);
    expect("the rule arrived", /every hour/.test(c.text()), true);
    c.done();
  }
  {
    const preview = ok({ applied: false, inbox_id: "x", matched: 0, capped_at: 25, matches: [] });
    const c = await card(preview, { action: "preview", filter: { from: "x@example.com" }, inbox_id: "x" });
    expect("an unsaved filter calls nothing", c.calls.length, 0);
    expect("and says nothing matches", /Nothing in this inbox matches right now\./.test(c.text()), true);
    expect("with no switch", c.tabs().length, 0);
    c.done();
  }

  group("4. the switch: one call per click, only id + enabled");
  {
    const host = installDomOnce();
    let release;
    host.tools.card_automation = (args) =>
      args.enabled === undefined
        ? ok(cardRule({ matched: 2, capped: false, matches: matches(2) }))
        : new Promise((r) => (release = () => r(ok(cardRule({ enabled: args.enabled })))));
    const c = await card(created);
    c.on().click();
    c.on().click();
    await settle();
    expectJson("one switch call", c.calls.slice(1), [{ name: "card_automation", args: { automation_id: RULE, enabled: true } }]);
    release();
    await settle();
    expect("shows On", c.selected(), "On");
    expect("matches kept after the switch", /2 messages match right now:/.test(c.text()), true);
    c.on().click();
    await settle();
    expect("On again sends nothing", c.calls.length, 2);
    c.off().click();
    await settle();
    expectJson("off", c.calls.at(-1)?.args, { automation_id: RULE, enabled: false });
    release();
    await settle();
    expect("shows Off", c.selected(), "Off");
    c.done();
  }
  {
    const host = installDomOnce();
    host.tools.card_automation = (args) =>
      args.enabled === undefined
        ? ok(cardRule())
        : { content: [{ type: "text", text: "automation enable: this key needs the 'manage:folders' scope to enable that action." }], isError: true };
    const c = await card(created);
    c.on().click();
    await settle();
    expect("refusal is shown in the server's words", /needs the 'manage:folders' scope/.test(c.text()), true);
    expect("still Off", c.selected(), "Off");
    c.done();
  }

  group("5. other results are one line");
  {
    const list = ok({ automations: [{ id: RULE, enabled: true }, { id: "b", enabled: false }], count: 2 });
    const c = await card(list, { action: "list" });
    expect("list line", /2 rules, 1 on\./.test(c.text()), true);
    expect("no call", c.calls.length, 0);
    c.done();
  }
  {
    const c = await card({ content: [{ type: "text", text: "automation get: no automation with that id in this workspace." }], isError: true });
    expect("error line", /did not complete/.test(c.text()), true);
    expect("no call", c.calls.length, 0);
    c.done();
  }

  let failed = 0;
  for (const g of groups) {
    const bad = g.checks.filter((x) => !x.ok);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "}  ${g.name}`);
    for (const x of bad) console.log(`        ${x.label}: got ${JSON.stringify(x.actual)}, want ${JSON.stringify(x.wanted)}`);
  }
  const total = groups.reduce((n, g) => n + g.checks.length, 0);
  console.log(`\n${total - failed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
