#!/usr/bin/env node
// ---------------------------------------------------------------------------
// What is actually on screen, for every state in which there is no draft to
// draw.
//
//   node harness/card-render.test.mjs
//
// ── Why this file exists ───────────────────────────────────────────────────
// The founder's complaint, 2026-10-12: "while it loads it is a thin sliver",
// and "sometimes the card never appears at all". Both are the same defect seen
// twice — a card that renders NOTHING, reports height 0, and leaves Claude
// drawing its own "Widget from MCP Emails draft" header over an empty box. The
// design had assumed an empty frame is an invisible frame (`.card:empty {
// display: none }`). It is not, in this host, and that single wrong premise is
// what every branch checked below was written against.
//
// ── IT RUNS `main.tsx`, NOT A COPY OF IT ──────────────────────────────────
// The first draft of this suite restated main.tsx's three lines — render,
// observeSize, connect — in the harness, and that made it blind to the exact
// defect it was written for: moving `observeSize()` back into connect()'s
// `.then()`, which is where the bug was, changed nothing, because the harness
// was calling it itself. So the bundle's entry is a side-effect import of the
// real module, and the only handles into it are the ones a browser would have:
// the DOM it rendered into, the messages it posted, and the store it writes.
// If the composition in main.tsx changes, this suite changes with it.
//
// THE CHECK IS `.card` NOT BEING EMPTY, not a pixel height. jsdom has no
// layout, so `getBoundingClientRect()` is 0 for everything and a height
// assertion here would be theatre. `.card:empty` is the actual mechanism that
// collapses the shell, so "the root has at least one child" is the real
// condition, measured where it is real. For the size reports, what is pinned is
// WHETHER one goes out and when — never the number in it.
//
// The suites next to this one own the state MACHINE (state-machine.mjs: what
// `resultStatus` becomes, and the handshake) and the EDITOR
// (draft-sync.test.mjs: what a mounted DraftEditor saves).
//
// DEPENDENCIES: esbuild (via vite) and jsdom (via the apps/web workspace), both
// resolved up out of the root node_modules. Same arrangement, and same caveat,
// as draft-sync.test.mjs.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/card-render.bundle.mjs");

const PROTOCOL_VERSION = "2026-01-26";
const HOST_INFO = { name: "scripted-host", version: "0.0.1" };

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

const show = (s) => JSON.stringify(s);
const after = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the DOM, which is also the host ----------------------------------------

/**
 * A browser the card can mount into AND a host it can talk to, in one object.
 *
 * `window.parent` is the bridge's target, read once in a class field
 * initialiser, and in jsdom `window.parent` is the window itself. So the host
 * side is installed by replacing `window.postMessage`: everything the card
 * posts arrives here, and `deliver()` dispatches the host's half back as a
 * `message` event whose `source` is that same window, which is what the
 * bridge's source check demands.
 *
 * `rafRuns: false` models the state two of the checks below were written for: a
 * frame the host has mounted but not painted, which gets no animation frames at
 * all.
 */
function installDom({ rafRuns = true, answerInitialize = true, initializeError = null } = {}) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=root></div></body></html>",
    { pretendToBeVisual: true },
  );
  const w = dom.window;

  const sent = [];
  const settings = { answerInitialize, initializeError };

  w.postMessage = (message) => {
    sent.push(message);
    if (message.method !== "ui/initialize") return;
    if (!settings.answerInitialize) return;
    if (settings.initializeError) {
      deliver({ jsonrpc: "2.0", id: message.id, error: settings.initializeError });
      return;
    }
    deliver({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        hostInfo: HOST_INFO,
        hostCapabilities: { openLinks: {}, updateModelContext: {} },
        hostContext: { theme: "light", displayMode: "inline" },
      },
    });
  };

  /**
   * Host -> card, asynchronously: a real host message is never delivered inside
   * the card's own postMessage call. `queueMicrotask` is the fastest a real one
   * could be, which is the timing the subscription race needs — see §3.
   */
  function deliver(message) {
    queueMicrotask(() => {
      w.dispatchEvent(new w.MessageEvent("message", { data: message, source: w }));
    });
  }

  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  for (
    const key of ["window", "document", "Node", "Event", "MessageChannel", "ResizeObserver"]
  ) {
    globalThis[key] = w[key];
  }
  // NOT `setTimeout`/`clearTimeout`: jsdom's own `window.setTimeout`
  // implementation calls the GLOBAL one, so installing it as the global makes
  // it call itself until the stack runs out. Node's timers are what the card's
  // own `setTimeout` calls resolve to, which is what a browser gives it anyway.
  for (const key of ["cancelAnimationFrame", "getComputedStyle"]) {
    globalThis[key] = w[key].bind(w);
  }
  // A callback that is accepted and never called, the way an unpainted frame
  // behaves. Returning an id keeps the signature honest.
  globalThis.requestAnimationFrame = rafRuns ? w.requestAnimationFrame.bind(w) : () => 0;

  const sizes = () => sent.filter((m) => m.method === "ui/notifications/size-changed");

  return { dom, w, sent, sizes, deliver, settings };
}

const toolResult = (structuredContent, text) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/tool-result",
  params: {
    ...(text ? { content: [{ type: "text", text }] } : {}),
    structuredContent,
  },
});

/** §8 draft block, the shape `draft{action:"create"}` returns. */
const draftEnvelope = {
  schema_version: "review-card-v1",
  card: "draft_editor",
  state: "editing",
  actor: { can_edit: true },
  dashboard_url: "https://mcpemails.com/dashboard",
  draft: {
    draft_id: "Drafts:2",
    id_is_stable: false,
    origin: "create",
    last_saved_at: "2026-10-12T10:00:00.000Z",
    last_saved_by: "agent",
    identity: { inbox_id: "ib-1", email_address: "you@example.com", provider: "imap" },
    recipients: { to: ["dana@x.example"], cc: [], bcc: [] },
    subject: "Quarterly numbers",
    body: { text: "Here they are.", html: null, truncated: false },
    attachments: [],
    signature: { embedded: false },
    in_reply_to: null,
    can_send: true,
  },
};

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      // THE REAL ENTRY, imported for its side effects, exactly as the browser
      // loads it. The store is re-exported from the same bundle, so it is the
      // same module instance main.tsx is writing to.
      contents:
        'import "./src/main";\n' +
        'export { getState, setState, disarmResultWatchdog } from "./src/store";\n',
      resolveDir: appRoot,
      sourcefile: "card-render-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    // main.tsx imports styles.css for its side effect. Vite inlines it; here it
    // only needs to not be a resolve error, and the "ignoring this import"
    // warning that follows is the correct outcome rather than a finding — the
    // card's styles are not what this suite measures.
    loader: { ".css": "text" },
    logOverride: { "ignored-bare-import": "silent" },
    outfile: OUT,
  });

  let instance = 0;

  /**
   * Boot one card: install the DOM, then evaluate `main.tsx` into it.
   *
   * A fresh module instance per boot (`?i=`), because the store is a singleton
   * and a scenario must not inherit the previous one's envelope. The DOM is
   * fresh too, or the previous bridge would still be listening on it.
   */
  async function boot(opts = {}) {
    const host = installDom(opts);
    const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
    const root = globalThis.document.getElementById("root");

    /** Wait until the handshake has settled one way or the other. */
    const settled = async (ms = 2_000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const s = mod.getState();
        if (s.connected || s.connectError) return;
        await after(10);
      }
    };

    return {
      ...host,
      mod,
      root,
      settled,
      state: () => mod.getState(),
      text: () => root.textContent.trim(),
      filled: () => root.childElementCount > 0,
      /**
       * Stop the card so it cannot outlive its scenario. The watchdog is a 9s
       * timer and the handshake retry loop a 10s one, and a scenario that
       * withheld the handshake has to let it finish or the process hangs around
       * waiting for that budget to expire.
       */
      done: async () => {
        mod.disarmResultWatchdog();
        if (!host.settings.answerInitialize) {
          host.settings.answerInitialize = true;
          await settled();
        }
        host.w.dispatchEvent(new host.w.Event("pagehide"));
      },
    };
  }

  /** Let Preact flush, timers fire, and any re-render they schedule. */
  const settle = () => after(30);

  // ── 1. The loading line ──────────────────────────────────────────────────
  // The complaint's first half. There has been a one-line loading state since
  // the card shipped; the race in §3 meant it was mostly never reached.

  group("a host that answers the handshake at once still leaves a loading line");
  {
    const c = await boot();
    await c.settled();
    await settle();
    expect("connected", c.state().connected, true);
    expect("the card is not empty", c.filled(), true);
    expect("and it is the one-line loading state", c.text(), "Loading…");
    expect("no result arrived", c.state().resultStatus, "waiting");
    await c.done();
  }

  // The pre-handshake frame, which used to render `null` on purpose. Same
  // correction, same reason: an empty frame is a sliver in this host, not an
  // absence, so the honest content for it is the line it is about to show
  // anyway — and it is bounded, because connect() gives up after 10s.
  group("the frame before the handshake is a line, not nothing");
  {
    const c = await boot({ answerInitialize: false });
    await settle();
    expect("not connected yet", c.state().connected, false);
    expect("the card is not empty", c.filled(), true);
    expect("one line", c.text(), "Loading…");
    await c.done();
  }

  // ── 2. Size reporting ────────────────────────────────────────────────────
  // `observeSize()` used to be started inside connect()'s `.then()`, so the
  // host was told a height only on the success path — and the two states it
  // therefore never measured are the two this branch is about.

  group("a size is reported before the handshake completes");
  {
    const c = await boot({ answerInitialize: false });
    await after(120);
    expect("still not connected", c.state().connected, false);
    expect("the host was told a size anyway", c.sizes().length > 0, true);
    await c.done();
  }

  group("a card whose handshake was refused still shows a line, and reports it");
  {
    // An error response, not silence: the bridge ends the handshake on the
    // first attempt (state-machine.mjs i3), so this reaches `connectError` in
    // milliseconds instead of at the 10s budget. The budget itself is pinned
    // there, not here.
    const c = await boot({ initializeError: { code: -32600, message: "no apps here" } });
    await c.settled();
    await settle();
    expect("it failed", typeof c.state().connectError, "string");
    expect("the card is not empty", c.filled(), true);
    expect("one line", c.text(), "MCP Emails: not shown here.");
    expect("and the host was told its size", c.sizes().length > 0, true);
    await c.done();
  }

  group("a frame that gets no animation frames still reports its size");
  {
    // With rAF as the only scheduler, an unpainted frame never measured AND
    // never re-armed: `scheduled` stayed true, so every later ResizeObserver
    // callback returned early too and the card could not report a height for as
    // long as it stayed unpainted.
    const c = await boot({ rafRuns: false });
    await c.settled();
    await after(120); // past SIZE_FALLBACK_MS, the only scheduler left here
    expect("connected", c.state().connected, true);
    expect("a size still went out", c.sizes().length > 0, true);
    expect("and the line is on screen", c.text(), "Loading…");
    await c.done();
  }

  // ── 3. The nothing-to-show states, and the subscription race ─────────────
  // Two defects at once, which is why these are the strongest checks in the
  // file.
  //
  // THE RENDERING. Each of these used to render `null`. In Claude that is the
  // host's own header over an empty container: a card that looks like it
  // failed. One quiet line each, never a warning — the operation succeeded and
  // the message above the card already carries it.
  //
  // THE RACE. `App` subscribed to the store inside `useEffect`, and Preact
  // flushes effects after the first paint (via rAF, with a 100ms timer as its
  // own floor). Every result below is delivered in a MICROTASK, which is where
  // a real host's answer lands: before that flush. With the subscription
  // registered in an effect, nothing is listening when the store is written,
  // the App stays on its first render, and these checks come back reading
  // "Loading…" forever — including the last one, where a perfectly good draft
  // never reaches the screen. That is the complaint's second half, "sometimes
  // the card never appears at all", reproduced.

  group("a result that is not ours says so in one line");
  {
    const c = await boot();
    await c.settled();
    c.deliver(toolResult({ ok: true, moved: 3 }, '{"ok":true}'));
    await settle();
    expect("classified foreign", c.state().resultStatus, "foreign");
    expect("the card is not empty", c.filled(), true);
    expect("one line", c.text(), "MCP Emails: no preview for this result.");
    await c.done();
  }

  group("a cancelled call says so in one line");
  {
    const c = await boot();
    await c.settled();
    c.deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-cancelled",
      params: { reason: "user stopped the request" },
    });
    await settle();
    expect("classified cancelled", c.state().resultStatus, "cancelled");
    expect("the card is not empty", c.filled(), true);
    expect("one line", c.text(), "MCP Emails: cancelled.");
    await c.done();
  }

  // ── 4. The regression guard ──────────────────────────────────────────────
  // The point of all of the above is that nothing renders empty any more. A
  // real envelope must still render the editor rather than one of these lines.

  group("a real draft envelope still renders the editor");
  {
    const c = await boot();
    await c.settled();
    c.deliver(toolResult(draftEnvelope, "Draft Drafts:2."));
    await settle();
    expect("classified as an envelope", c.state().resultStatus, "envelope");
    expect("the card is not empty", c.filled(), true);
    expect("it is not a one-liner", c.text().includes("no preview"), false);
    expect("it is not still loading", c.text().includes("Loading"), false);
    expect(
      "the subject is in the box",
      globalThis.document.getElementById("d-subject")?.value,
      "Quarterly numbers",
    );
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
