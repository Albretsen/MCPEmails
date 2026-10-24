#!/usr/bin/env node
// ---------------------------------------------------------------------------
// §9 `subscription_plan`, driven through the REAL card.
//
//   node harness/subscription-plan.test.mjs
//
// Boots `main.tsx` into jsdom, plays the host (answers ui/initialize, pushes
// the scan result, answers `subscriptions_cleanup` from a script) and reads
// the screen. What is pinned: the plan renders from the fixed contract, the
// suggested senders start ticked, Select all / none, Confirm sends only the
// ticked keys from the plan (once, however fast it is clicked), every result
// status renders, Continue archiving, the expired and read-only states, and a
// hostile display name stays text.
//
// DEPENDENCIES: esbuild and jsdom from the root node_modules, as in
// draft-qa.test.mjs. Fixtures use example.com only.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/subscription-plan.bundle.mjs");
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
const expectJson = (label, actual, wanted) => expect(label, JSON.stringify(actual), JSON.stringify(wanted));
const after = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => after(40);

// ---- fixtures ---------------------------------------------------------------

const PLAN = "3f1c2b9a-6d4e-4a1b-8c2d-9e8f7a6b5c4d";
const HOSTILE = '<img src=x onerror="alert(1)">Deals';

function sender(over) {
  return {
    sender_key: "list:news.example.com",
    display_name: "Example News",
    from_address: "news@example.com",
    domain: "example.com",
    list_id: "news.example.com",
    message_count: 212,
    unread_count: 208,
    read_share: 0.02,
    last_received_at: "2026-10-20T08:00:00Z",
    method: "one_click",
    safe: true,
    unsafe_reason: null,
    url_host: "example.com",
    suggested: true,
    ...over,
  };
}

const SENDERS = [
  sender({}),
  sender({ sender_key: "from:offers@shop.example.com", display_name: HOSTILE, from_address: "offers@shop.example.com", domain: "shop.example.com", list_id: null, method: "mailto", url_host: null, message_count: 40, read_share: 0.1 }),
  sender({ sender_key: "from:digest@example.com", display_name: "Weekly Digest", from_address: "digest@example.com", method: "link", suggested: false, message_count: 12, read_share: 0.5 }),
  sender({ sender_key: "from:promo@example.net", display_name: "Promo", from_address: "promo@example.net", domain: "example.net", method: "none", safe: false, unsafe_reason: "in_junk", url_host: null, suggested: false, message_count: 9, read_share: 0 }),
];

function planEnvelope(over = {}, subOver = {}) {
  return {
    schema_version: "review-card-v1",
    card: "subscription_plan",
    dashboard_url: "https://mcpemails.com/dashboard",
    state: "pending",
    actor: { can_decide: true, reason: null },
    subscriptions: {
      plan_id: PLAN,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      inbox: { inbox_id: "51ab6d90-4c18-4a2f-9d77-8e6a1b022c9d", email_address: "you@example.com", provider: "gmail" },
      window_days: 90,
      scanned: 1840,
      truncated: false,
      summary: { senders: 4, one_click: 1, mailto: 1, link: 1, none: 1, unsafe: 1 },
      senders: SENDERS,
      ...subOver,
    },
    ...over,
  };
}

const RESULTS = [
  { sender_key: "list:news.example.com", display_name: "Example News", status: "requested", method: "one_click", detail: null, draft_id: null, link: null },
  { sender_key: "from:offers@shop.example.com", display_name: HOSTILE, status: "draft_ready", method: "mailto", detail: null, draft_id: "r-1", link: null },
  { sender_key: "from:digest@example.com", display_name: "Weekly Digest", status: "needs_user", method: "link", detail: null, draft_id: null, link: "https://example.com/unsub?u=1" },
  { sender_key: "from:a@example.com", display_name: "A", status: "failed", method: "one_click", detail: "The sender answered 500.", draft_id: null, link: null },
  { sender_key: "from:promo@example.net", display_name: "Promo", status: "skipped_unsafe", method: "none", detail: null, draft_id: null, link: null },
  { sender_key: "from:b@example.com", display_name: "B", status: "already_done", method: "one_click", detail: null, draft_id: null, link: null },
  { sender_key: "from:c@example.com", display_name: "C", status: "needs_user", method: "mailto", detail: "This connection cannot create drafts. To unsubscribe, email leave@example.com with the word unsubscribe.", draft_id: null, link: null, mailto_address: "leave@example.com" },
];

function executedResult(backlog = { action: "archive", destination: "Archive", moved: 306, remaining: 0, has_more: false }) {
  return {
    content: [{ type: "text", text: "Cleanup done." }],
    structuredContent: planEnvelope({ state: "executed" }, { results: RESULTS, backlog }),
  };
}

// ---- the DOM, which is also the host ----------------------------------------

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
    pretendToBeVisual: true,
    url: "https://card.test/",
  });
  const w = dom.window;
  const calls = [];
  const tools = {};
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
async function card(env = planEnvelope()) {
  const host = installDom();
  const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
  const root = globalThis.document.getElementById("root");
  const until = Date.now() + 2000;
  while (Date.now() < until && !mod.getState().connected) await after(5);
  host.deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: env, content: [{ type: "text", text: "Scan done." }] },
  });
  await settle();
  const btn = (re) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent.trim())) ?? null;
  const boxes = () => [...root.querySelectorAll('input[type="checkbox"]')];
  return {
    ...host,
    root,
    btn,
    boxes,
    ticked: () => boxes().filter((b) => b.checked).length,
    text: () => root.textContent,
    contexts: () => host.sent.filter((m) => m.method === "ui/update-model-context").map((m) => m.params?.content?.[0]?.text ?? ""),
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
      sourcefile: "subscription-plan-entry.ts",
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

  group("1. the plan renders from the contract");
  {
    const c = await card();
    expect("header counts", /4 senders, 1,840 messages scanned, last 90 days/.test(c.text()), true);
    expect("one real checkbox per sender", c.boxes().length, 4);
    expect("every checkbox has a label", c.boxes().every((b) => !!c.root.querySelector(`label[for="${b.id}"]`)), true);
    const pills = [...c.root.querySelectorAll(".pill")].map((p) => p.textContent);
    expectJson("method pills", pills, ["One-click", "Draft for you to send", "Link to open", "Archive only"]);
    expect("counts and read share", /212 messages, 2% read/.test(c.text()), true);
    expect("unsafe sender says why and what ticking does", /Not safe to unsubscribe \(in Junk\): archive only\./.test(c.text()), true);
    expect("says nothing is sent", /Nothing is sent from your address/.test(c.text()), true);
    expect("backlog defaults to archive", c.root.querySelector("select")?.value, "archive");
    expect("no truncation line", /Only the newest/.test(c.text()), false);
    c.done();
  }
  {
    const c = await card(planEnvelope({}, { truncated: true }));
    expect("truncated scan is said", /Only the newest messages were scanned\./.test(c.text()), true);
    c.done();
  }

  group("2. suggested senders start ticked; Select all / none");
  {
    const c = await card();
    expectJson("pre-ticked = suggested", c.boxes().map((b) => b.checked), [true, true, false, false]);
    expect("button counts the ticked", c.btn(/^Clean up/)?.textContent, "Clean up 2 senders");
    c.btn(/^Select all$/).click();
    await settle();
    expect("select all ticks every sender", c.ticked(), 4);
    expect("button follows", c.btn(/^Clean up/)?.textContent, "Clean up 4 senders");
    c.btn(/^Select none$/).click();
    await settle();
    expect("select none clears", c.ticked(), 0);
    expect("button is off at 0", c.btn(/^Clean up/)?.disabled, true);
    c.done();
  }

  group("3. confirm sends only the ticked keys, once");
  {
    const c = await card();
    c.tools.subscriptions_cleanup = () => executedResult();
    c.boxes()[0].click(); // untick Example News
    c.boxes()[2].click(); // tick Weekly Digest
    const sel = c.root.querySelector("select");
    sel.value = "keep";
    sel.dispatchEvent(new c.w.Event("change", { bubbles: true }));
    await settle();
    c.btn(/^Clean up/).click();
    await settle();
    expect("one call", c.calls.length, 1);
    expect("to subscriptions_cleanup", c.calls[0]?.name, "subscriptions_cleanup");
    expectJson("plan id, ticked keys in plan order, chosen backlog", c.calls[0]?.args, {
      plan_id: PLAN,
      sender_keys: ["from:offers@shop.example.com", "from:digest@example.com"],
      backlog: "keep",
    });
    const line = c.contexts().at(-1) ?? "";
    expect("model hears counts", /Requested 1, drafts saved for the user to send \(not sent\) 1/.test(line), true);
    expect("model hears no sender names", /Example News|Deals|Digest/.test(line), false);
    c.done();
  }
  {
    const c = await card();
    let release;
    c.tools.subscriptions_cleanup = () => new Promise((r) => (release = () => r(executedResult())));
    const b = c.btn(/^Clean up/);
    b.click();
    b.click();
    await settle();
    b.click();
    expect("a double click sends once", c.calls.length, 1);
    expect("the button is busy and off in flight", c.btn(/^Cleaning up$/)?.disabled, true);
    release();
    await settle();
    expect("still once after the answer", c.calls.length, 1);
    c.done();
  }

  group("4. results view renders every status");
  {
    const c = await card();
    c.tools.subscriptions_cleanup = () => executedResult();
    c.btn(/^Clean up/).click();
    await settle();
    const row = (s) => c.root.querySelector(`li[data-status="${s}"]`)?.textContent ?? "";
    expect("requested", /Requested/.test(row("requested")), true);
    expect("draft ready, and where", /Draft ready\. Draft saved in your Drafts folder\./.test(row("draft_ready")), true);
    expect("needs user, with the host", /Open link to finish/.test(row("needs_user")) && /Open example\.com/.test(row("needs_user")), true);
    expect("failed, with detail", /Failed\. The sender answered 500\./.test(row("failed")), true);
    expect("skipped", /Skipped \(not safe to unsubscribe\)/.test(row("skipped_unsafe")), true);
    expect("already done", /Already done/.test(row("already_done")), true);
    const mailRow = c.root.querySelector('li[data-status="needs_user"]:last-child');
    expect("mailto needs_user shows the address as text", /Email leave@example\.com to unsubscribe/.test(mailRow?.textContent ?? ""), true);
    expect("the address is selectable text, not a link", mailRow?.querySelector(".sel")?.textContent, "leave@example.com");
    expect("no Open button for a mailto row", /Open /.test(mailRow?.textContent ?? ""), false);
    expect("no anchor anywhere in the results", c.root.querySelectorAll("a").length, 0);
    expect("backlog summary", /306 messages archived\./.test(c.text()), true);
    expect("follow-up note", /Senders usually stop within 2 days\. We check again in 3 days\./.test(c.text()), true);
    expect("no continue button when nothing is left", c.btn(/^Continue archiving/), null);
    expect("no raw URL as text", /unsub\?u=1/.test(c.text()), false);
    c.btn(/^Open example\.com$/).click();
    await settle();
    const open = c.sent.find((m) => m.method === "ui/open-link");
    expect("the link opens through the host", open?.params?.url, "https://example.com/unsub?u=1");
    c.done();
  }

  group("5. continue archiving");
  {
    const c = await card();
    c.tools.subscriptions_cleanup = (args) =>
      args.continue
        ? executedResult({ action: "archive", destination: "Archive", moved: 1200, remaining: 0, has_more: false })
        : executedResult({ action: "archive", destination: "Archive", moved: 1000, remaining: 120, has_more: true });
    c.btn(/^Clean up/).click();
    await settle();
    expect("remaining is said", /1,000 messages archived, 120 left\./.test(c.text()), true);
    const b = c.btn(/^Continue archiving \(120 left\)$/);
    expect("continue button shows what is left", !!b, true);
    b.click();
    b.click();
    await settle();
    expect("two calls in all (double click guarded)", c.calls.length, 2);
    expectJson("continue sends the plan and no sender keys", c.calls[1]?.args, {
      plan_id: PLAN,
      sender_keys: [],
      backlog: "archive",
      continue: true,
    });
    expect("done afterwards", c.btn(/^Continue archiving/), null);
    c.done();
  }

  group("6. expired, read-only and hostile input");
  {
    const c = await card(planEnvelope({ state: "expired", actor: { can_decide: false, reason: "expired" } }));
    expect("expired notice", /This list expired\. Nothing was changed\./.test(c.text()), true);
    expect("checkboxes off", c.boxes().every((b) => b.disabled), true);
    expect("button off", c.btn(/^Clean up/)?.disabled, true);
    c.done();
  }
  {
    const c = await card(planEnvelope({ actor: { can_decide: false, reason: "viewer_role" } }));
    expect("viewer role notice", /Your role can view this list but not act on it\./.test(c.text()), true);
    expect("button off", c.btn(/^Clean up/)?.disabled, true);
    c.done();
  }
  {
    const c = await card();
    expect("no element injected from a display name", c.root.querySelector("img"), null);
    expect("the name is shown as text", c.text().includes('<img src=x onerror="alert(1)">Deals'), true);
    c.done();
  }
  {
    // auth_unverified keeps its rung (a link here), not "Archive only".
    const c = await card(planEnvelope({}, {
      senders: [sender({ sender_key: "from:v@example.com", method: "link", safe: false, unsafe_reason: "auth_unverified", suggested: false })],
    }));
    const li = c.root.querySelector("ul.subs li");
    expect("unverified sender keeps its method pill", li?.querySelector(".pill")?.textContent, "Link to open");
    expect("and says it is not verified", /sender not verified/.test(li?.textContent ?? ""), true);
    c.done();
  }

  group("7. order, names, expiry label and no diagnostics line");
  {
    // Server order is volume only: a busy unsuggested sender comes first.
    const c = await card(planEnvelope({}, {
      senders: [
        sender({ sender_key: "from:busy@example.com", display_name: "Busy Unsuggested", suggested: false, message_count: 60 }),
        sender({ sender_key: "from:s1@example.com", display_name: "Suggested Small", suggested: true, message_count: 5 }),
        sender({ sender_key: "from:quiet@example.com", display_name: "Quiet Unsuggested", suggested: false, message_count: 2 }),
        sender({ sender_key: "from:s2@example.com", display_name: "Suggested Big", suggested: true, message_count: 40 }),
      ],
    }));
    const names = [...c.root.querySelectorAll("ul.subs .sub-name")].map((n) => n.textContent);
    expectJson("suggested first, each group by volume", names, ["Suggested Big", "Suggested Small", "Busy Unsuggested", "Quiet Unsuggested"]);
    expectJson("ticks follow the rows", c.boxes().map((b) => b.checked), [true, true, false, false]);
    c.done();
  }
  {
    const long = "A very long sender display name that will not fit on one line of the card at all";
    const c = await card(planEnvelope({}, { senders: [sender({ display_name: long })] }));
    expect("full name in the title", c.root.querySelector("ul.subs .sub-name")?.getAttribute("title"), long);
    expect("full name in the text", c.root.querySelector("ul.subs .sub-name")?.textContent, long);
    c.done();
  }
  {
    const c = await card(planEnvelope({}, { expires_at: new Date(Date.now() + 60 * 60_000 - 1000).toISOString() }));
    expect("60-minute plan reads 1h", /expires in 1h(?! \d)/.test(c.text()), true);
    c.done();
  }
  {
    const c = await card(planEnvelope({}, { expires_at: new Date(Date.now() + 45 * 60_000 - 1000).toISOString() }));
    expect("45-minute plan reads 45 min", /expires in 45 min/.test(c.text()), true);
    c.done();
  }
  {
    const c = await card(planEnvelope({ diagnostics: true }));
    expect("no diagnostics line even when the workspace has it on", c.root.querySelector(".diag"), null);
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
