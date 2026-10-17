#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Where Save and Send are, in REAL Chrome, at every width and in every state.
//
//   npm run build -w apps/mcp-app            (it measures dist/index.html)
//   node apps/mcp-app/harness/footer-geometry.mjs
//   CHROME_PATH=/path/to/chrome node apps/mcp-app/harness/footer-geometry.mjs
//
// NOT part of verify.mjs, on purpose: it needs a Chrome binary, and CI has
// none. jsdom has no layout, so draft-send-safety.test.mjs can only pin the
// footer's DOM (same elements, same order, same labels, `.btn.slot`); this is
// the half that needs pixels.
//
// Why it exists (verifier, 2026-10-15): the footer row wrapped, and its left
// links change width with their state ("Refresh" / "Refreshing" / "Up to date",
// "Show formatting" / "Edit plain text"), so the wrap point moved. At 420px
// Save slid into Send's old place and Send dropped to a row of its own. A click
// aimed at Save landing on Send is the accident this card's footer exists to
// prevent, so the check is: at each width, Save's and Send's rectangles are
// IDENTICAL across every state, and nothing in the left cluster overlaps them.
//
// Inline and fullscreen are separate layouts (fullscreen pins the action row
// to the bottom of the frame), so each is compared with itself.
//
// Extended after the live claude.ai QA of 2026-10-17 (`layoutChecks`), at
// every width, inline:
//   - the header's controls (Expand, Hide, ⋯) do not move when the status
//     text beside them changes, the From address gives way before the
//     status, the status is never clipped, and (narrow: on a line of its
//     own) the header's height does not change with it;
//   - opening the ⋯ menu, and the turn-off confirm it leads to, moves none of
//     To, Subject, the message, Save or Send (it is an overlay);
//   - the delete confirm puts "Keep draft" under the point that pressed
//     "Delete draft", and neither answer overlaps Save or Send;
//   - the left links are on one line, or (narrow) not in the row at all and
//     in the ⋯ menu instead;
//   - "No subject. Send anyway?" keeps the Subject row's height and Send's
//     place, so the second press is on the same button.
//
// No dependencies: Chrome is driven over the DevTools protocol with Node's own
// WebSocket, and the card is served by mini-host.mjs, the same host a person
// would use to look at it. Nothing is sent anywhere: mini-host answers every
// tool call itself, and the countdown is undone before it can run out.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const WIDTHS = [280, 300, 320, 360, 400, 420, 480, 600];
const HOST_PORT = Number(process.env.GEOMETRY_HOST_PORT ?? 3019);
const CDP_PORT = Number(process.env.GEOMETRY_CDP_PORT ?? 9339);
const CHROME =
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

const after = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) {
  console.error("footer-geometry: no Chrome found. Set CHROME_PATH.");
  process.exit(2);
}
if (!existsSync(resolve(appRoot, "dist/index.html"))) {
  console.error("footer-geometry: dist/index.html is missing. Run `npm run build -w apps/mcp-app` first.");
  process.exit(2);
}

// ---- processes --------------------------------------------------------------

const children = [];
const profile = mkdtempSync(join(tmpdir(), "footer-geometry-"));
function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(profile, { recursive: true, force: true });
}
process.on("exit", cleanup);

children.push(
  spawn(process.execPath, [resolve(here, "mini-host.mjs")], {
    env: { ...process.env, MINI_HOST_PORT: String(HOST_PORT) },
    stdio: "ignore",
  }),
);
children.push(
  spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ], { stdio: "ignore" }),
);

async function waitFor(fn, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error("timed out");
    await after(100);
  }
}

// ---- a minimal DevTools client ---------------------------------------------

async function connect() {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === "page");
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  /** Evaluate an async function body in the page and return its value. */
  const run = async (body) => {
    const m = await send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400));
    return m.result?.result?.value;
  };
  return { send, run, close: () => ws.close() };
}

// ---- in the page -------------------------------------------------------------

// Helpers defined once in the page, then called per state.
const PAGE_HELPERS = `
window.__g = {
  doc: () => document.getElementById("card").contentDocument,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  async mount(width) {
    const f = document.getElementById("card");
    f.style.width = width + "px";
    document.getElementById("btn-mount-draft").click();
    for (let i = 0; i < 100; i++) {
      await this.wait(50);
      const d = f.contentDocument;
      if (d && d.getElementById("d-body") && d.querySelectorAll(".acts > .acts-r > .btn, .acts > .btn").length === 2) return true;
    }
    return false;
  },
  buttons() {
    const d = this.doc();
    return [...d.querySelectorAll(".acts .btn.slot")];
  },
  rect(el) {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  },
  hits(a, b) {
    const x = a.getBoundingClientRect();
    const y = b.getBoundingClientRect();
    return x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
  },
  drawn(el) {
    return !!el && el.getClientRects().length > 0;
  },
  measure() {
    const d = this.doc();
    const [save, send] = this.buttons();
    const left = d.querySelector(".acts > .acts-l");
    let overlap = false;
    if (left) {
      for (const el of left.querySelectorAll("*")) {
        const a = el.getBoundingClientRect();
        if (a.width === 0 || a.height === 0) continue;
        for (const b of [save, send]) if (this.hits(el, b)) overlap = true;
      }
    }
    return { save: this.rect(save), send: this.rect(send), labels: [save.textContent.trim(), send.textContent.trim()], overlap };
  },
  /** The header's controls (Expand or Collapse, Hide, the menu button). */
  controls() {
    return [...this.doc().querySelectorAll(".ed-hdr > .hdr-r button.link")].map((b) => this.rect(b));
  },
  /** The rows under the header that an in-flow panel used to push down. */
  fields() {
    const d = this.doc();
    return ["d-to", "d-subject", "d-body"].map((id) => this.rect(d.getElementById(id)));
  },
  link(re) {
    return [...this.doc().querySelectorAll(".ed-links > .link")].find((l) => re.test(l.textContent.trim())) ?? null;
  },
  button(re) {
    return [...this.doc().querySelectorAll("button")].find((b) => re.test(b.textContent.trim())) ?? null;
  },
  /** The formatting toggle. This fixture has no HTML part, so one is added for the measurement. */
  formatLink() {
    const d = this.doc();
    let l = [...d.querySelectorAll(".ed-links > .link")].find((x) => /formatting|plain text/.test(x.textContent));
    if (!l) {
      l = d.createElement("button");
      l.type = "button";
      l.className = "link";
      l.dataset.geometry = "added";
      l.textContent = "Show formatting";
      d.querySelector(".ed-links")?.append(l);
    }
    return l;
  },
  dropAdded() {
    for (const l of this.doc().querySelectorAll("[data-geometry=added]")) l.remove();
  },
  /** Every left-cluster label and status-line combination, measured. */
  labelStates(prefix) {
    const out = [];
    const line = this.doc().getElementById("d-status");
    const original = line ? line.textContent : null;
    for (const fmt of [null, "Show formatting", "Edit plain text"]) {
      if (fmt) this.formatLink().textContent = fmt;
      for (const word of ["128 words · Saved to Drafts", "Refreshing… · Unsaved changes", "Updated from your mailbox · Unsaved changes", "Still saving. Your mail provider can take a moment."]) {
        if (line) line.textContent = word;
        out.push({ state: prefix + (fmt ? " + " + fmt : "") + " + " + word, ...this.measure() });
      }
      this.dropAdded();
    }
    if (line && original !== null) line.textContent = original;
    return out;
  },
  /** Do the visible left links sit on one line? (A ragged wrap is the bug.) */
  linksOneLine() {
    this.formatLink();
    const links = [...this.doc().querySelectorAll(".ed-links > .link")].filter((l) => this.drawn(l));
    const tops = new Set(links.map((l) => Math.round(l.getBoundingClientRect().top)));
    const shown = links.length;
    this.dropAdded();
    return { shown, oneLine: tops.size <= 1 };
  },
  async type(text) {
    const b = this.doc().getElementById("d-body");
    const w = this.doc().defaultView;
    b.value = text;
    b.dispatchEvent(new w.Event("input", { bubbles: true }));
    await this.wait(80);
  },
  async subject(text) {
    const b = this.doc().getElementById("d-subject");
    const w = this.doc().defaultView;
    b.value = text;
    b.dispatchEvent(new w.Event("input", { bubbles: true }));
    await this.wait(80);
  },
  async press(i) {
    this.buttons()[i].click();
    await this.wait(80);
  },
  async click(el) {
    el.focus();
    el.click();
    await this.wait(80);
  },
  async escape() {
    const d = this.doc();
    const w = d.defaultView;
    d.activeElement.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await this.wait(80);
  },
  async mode(m) {
    const f = document.getElementById("card");
    f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: m } }, "*");
    await this.wait(150);
  },
  /**
   * The layout checks of the live QA of 2026-10-17, one list of failures.
   * Run on a clean, inline card.
   */
  async layoutChecks() {
    const bad = [];
    const d = this.doc();
    const same = (label, a, b) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(label + ": " + JSON.stringify(a) + " -> " + JSON.stringify(b));
    };
    const footer = () => this.buttons().map((b) => this.rect(b));

    // 1. Header: the controls do not move when the status changes.
    const ctl = this.controls();
    const status = d.querySelector(".ed-hdr .hdr-status");
    const was = status.textContent;
    for (const text of ["Unsaved changes", "Saving…", "Saved Oct 9, 2025, 14:02 by the assistant", ""]) {
      status.textContent = text;
      same("header controls with status " + JSON.stringify(text), ctl, this.controls());
    }
    // The address gives way before the status (re-test, 2026-10-17: "Saved
    // 15:15 by you" was cut to "Saved 15:15 …" at 300px). Narrow (a card
    // under 380px of content) the status always has a line of its own, so the
    // header is the same height whatever it says; wider, the everyday
    // statuses fit on the one line. Never clipped either way.
    const hdr = d.querySelector(".ed-hdr");
    const draftTop = hdr.querySelector(".hdr-l > b").getBoundingClientRect().top;
    const narrow = d.querySelector(".card").clientWidth - 24 < 380;
    const heights = new Set();
    for (const text of ["Saved 15:15 by you", "Unsaved changes", "Saving…", "Saved 3:43 PM by the assistant", "Saved Oct 9, 3:43 PM by the assistant"]) {
      status.textContent = text;
      const below = status.getBoundingClientRect().top > draftTop + 4;
      heights.add(Math.round(hdr.getBoundingClientRect().height));
      if (status.scrollWidth > status.clientWidth + 1) bad.push("status clipped: " + JSON.stringify(text));
      if (narrow !== below) bad.push("status " + (below ? "under" : "beside") + " Draft: " + JSON.stringify(text));
    }
    if (heights.size > 1) bad.push("header height changes with the status: " + JSON.stringify([...heights]));
    status.textContent = was;

    // 2. The menu and the turn-off confirm cover the fields, never push them.
    const rows = this.fields();
    const before = footer();
    await this.click(this.button(/^⋯$/));
    if (!d.querySelector(".pop [role=menu]")) bad.push("menu did not open");
    same("fields with the menu open", rows, this.fields());
    same("Save and Send with the menu open", before, footer());
    const pop = d.querySelector(".pop");
    if (pop && pop.getBoundingClientRect().bottom > d.documentElement.clientHeight + 1) bad.push("menu runs past the frame");
    await this.click(this.button(/^Turn off draft cards/));
    same("fields with the turn-off confirm open", rows, this.fields());
    await this.escape();
    if (d.querySelector(".pop")) bad.push("Escape left the overlay open");

    // 3. Footer delete confirm: "Keep draft" is where "Delete draft" was, and
    //    nothing in it is where Save or Send are.
    const del = this.link(/^Delete draft$/);
    if (this.drawn(del)) {
      const r = del.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      await this.click(del);
      const keep = this.button(/^Keep draft$/);
      const yes = this.button(/^Yes, delete$/);
      if (!keep || !yes) bad.push("delete confirm has no buttons");
      else {
        if (d.elementFromPoint(cx, cy)?.closest("button") !== keep) bad.push("Keep draft is not under the pointer that pressed Delete draft");
        const [save, send] = this.buttons();
        if (this.hits(yes, save) || this.hits(yes, send) || this.hits(keep, save) || this.hits(keep, send)) bad.push("a delete answer overlaps Save or Send");
      }
      same("Save and Send with the delete confirm open", before, footer());
      await this.click(keep);
    }

    // 4. Narrow: the left links are on one line, or not in the row at all.
    const one = this.linksOneLine();
    if (!one.oneLine) bad.push("left links wrap onto two lines");
    if (one.shown === 0) {
      // Then they are in the menu.
      await this.click(this.button(/^⋯$/));
      const items = [...d.querySelectorAll(".pop [role=menuitem]")].filter((el) => this.drawn(el)).map((el) => el.textContent.trim());
      if (!items.includes("Refresh") || !items.includes("Delete draft…")) bad.push("narrow menu lacks the footer links: " + JSON.stringify(items));
      await this.escape();
    }

    // 5. No subject: the warning keeps Subject's row and Send where they were.
    const subj = d.getElementById("d-subject").value;
    const subjRow = this.rect(d.getElementById("d-subject").parentElement);
    await this.wait(600);
    await this.subject("");
    await this.press(1);
    if (!d.getElementById("d-subject-warn")) bad.push("no subject warning");
    same("Subject row with the warning", subjRow, this.rect(d.getElementById("d-subject").parentElement));
    same("Save and Send with the warning", before, footer());
    await this.subject(subj);
    return bad;
  },
};
true;
`;

async function measureWidth(c, width) {
  await c.run(`return window.__g.mount(${width});`);
  await c.run(`await window.__g.wait(200); return true;`);
  const inline = [];
  const full = [];
  const take = async (into, prefix) => into.push(...(await c.run(`return window.__g.labelStates(${JSON.stringify(prefix)});`)));
  const original = await c.run(`return window.__g.doc().getElementById("d-body").value;`);

  const layout = await c.run(`return await window.__g.layoutChecks();`);
  await take(inline, "clean");
  await c.run(`await window.__g.type(${JSON.stringify(original + " edited")}); return true;`);
  await take(inline, "dirty");
  await c.run(`await window.__g.wait(600); await window.__g.press(1); return true;`); // Send: the countdown starts
  await take(inline, "countdown");
  await c.run(`await window.__g.press(1); return true;`); // Undo, long before 5 s
  await take(inline, "after undo");
  await c.run(`await window.__g.type(${JSON.stringify(original)}); return true;`);

  await c.run(`await window.__g.mode("fullscreen"); return true;`);
  await take(full, "fullscreen clean");
  await c.run(`await window.__g.type(${JSON.stringify(original + " edited")}); return true;`);
  await take(full, "fullscreen dirty");
  await c.run(`await window.__g.press(1); return true;`);
  await take(full, "fullscreen countdown");
  await c.run(`await window.__g.press(1); return true;`);
  await c.run(`await window.__g.mode("inline"); return true;`);
  return { inline, full, layout };
}

function summarise(rows) {
  const key = (r) => JSON.stringify([r.save, r.send]);
  const distinct = [...new Set(rows.map(key))];
  return {
    distinct,
    overlap: rows.filter((r) => r.overlap).map((r) => r.state),
    first: rows[0],
  };
}

async function main() {
  await waitFor(async () => (await fetch(`http://localhost:${HOST_PORT}/`)).ok);
  const c = await connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: `http://localhost:${HOST_PORT}/` });
  await waitFor(() => c.run(`return !!document.getElementById("btn-mount-draft");`));
  await c.run(PAGE_HELPERS);

  let bad = 0;
  const table = [];
  for (const w of WIDTHS) {
    const { inline, full, layout } = await measureWidth(c, w);
    const i = summarise(inline);
    const f = summarise(full);
    const ok = i.distinct.length === 1 && f.distinct.length === 1 && i.overlap.length === 0 && f.overlap.length === 0 &&
      layout.length === 0;
    if (!ok) bad++;
    table.push({ w, ok, i, f, states: inline.length + full.length, layout });
    if (!ok) {
      for (const [mode, s, rows] of [["inline", i, inline], ["fullscreen", f, full]]) {
        if (s.distinct.length > 1) {
          for (const r of rows) console.log(`  ${w}px ${mode} ${r.state}: Save ${r.save} Send ${r.send}`);
        }
        if (s.overlap.length) console.log(`  ${w}px ${mode} overlaps: ${s.overlap.join("; ")}`);
      }
      for (const l of layout) console.log(`  ${w}px layout: ${l}`);
    }
  }
  c.close();

  console.log("width  states  inline Save [x,y,w,h]  inline Send [x,y,w,h]  fullscreen Save        fullscreen Send        same?");
  for (const t of table) {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(
      `${pad(t.w + "px", 7)}${pad(t.states, 8)}${pad(JSON.stringify(t.i.first.save), 23)}${pad(JSON.stringify(t.i.first.send), 23)}` +
        `${pad(JSON.stringify(t.f.first.save), 23)}${pad(JSON.stringify(t.f.first.send), 23)}` +
        `${t.ok ? "yes" : `NO (inline ${t.i.distinct.length}, fullscreen ${t.f.distinct.length} distinct, overlaps ${t.i.overlap.length + t.f.overlap.length}, layout ${t.layout.length})`}`,
    );
  }
  console.log(`\n${WIDTHS.length - bad}/${WIDTHS.length} widths stable`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
