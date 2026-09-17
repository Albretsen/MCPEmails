#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Resync: is the text in the box still describing what the server has?
//
//   node harness/draft-sync.test.mjs
//
// ── Why this file exists ───────────────────────────────────────────────────
// Two defects, both pre-existing at a376fa7 and both able to write a draft the
// user could not see being written.
//
//   1. STALE RESYNC. The editor keyed its resync on
//      `draft_id + last_saved_at + origin`. That triple is a proxy for "this is
//      a different version of the draft" and it is false in both directions:
//
//        too eager — every server path stamps `last_saved_at` with the clock at
//          RESPONSE time (`readStoredDraft` has no provider timestamp to use;
//          `ProviderDraft` carries none), so the key changed on every single
//          response. A refresh that brought back a byte-identical draft still
//          resynced, silently discarding whatever the user had typed. This is
//          the half that was live.
//        too lax — two responses agreeing on the triple while the CONTENT had
//          moved left `edit` describing the old body, while `server` was
//          recomputed from the new props on every render. The card then read as
//          dirty, and Save and the teardown saver wrote the stale editor
//          contents over the newer draft. Latent rather than live, because
//          nothing could emit a repeated `last_saved_at` — and it is exactly
//          what the field's own name promises it will start doing.
//
//   2. THE RESYNC WINDOW. The teardown-saver effect is declared second, and
//      both effects flush in one commit, so on the render that first carried a
//      new envelope the saver armed with a patch taken from the OLD `edit`
//      against the NEW `server`. `ui/resource-teardown` arrives as its own
//      task, so "one render" was long enough to land in. Reproduced against the
//      real component below, before the fix, on the first try.
//
// Both are closed by the same thing: a server-authored `draft.version`
// (`mcp-app-drafts.ts#draftContentVersion`) that moves when the content moves
// and only then, plus `editorPatch`, which refuses to diff an editor state
// against server content it was not derived from.
//
// ── Shape ──────────────────────────────────────────────────────────────────
// Sections 1-2 are the rules, driven directly, the way draft-body.test.mjs
// drives `applyMessageEdit`. Section 3 drives the REAL `DraftEditor` in a DOM,
// because the window in defect 2 was never visible in a pure function: it was
// an ordering between two effects, and only a mounted component has those.
//
// DEPENDENCIES. `esbuild` (via vite) and `jsdom` (a direct dependency of the
// apps/web workspace, hoisted to the root node_modules) are both resolved up
// out of the root install, neither declared here — the same arrangement, and
// the same caveat, that .github/workflows/ci.yml already records for esbuild.
// If this suite ever fails on `Cannot find package 'jsdom'`, that is why, and
// the fix is to declare it in apps/mcp-app's devDependencies.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-sync.bundle.mjs");

// ---- tiny harness -----------------------------------------------------------

const groups = [];
let current = null;

function group(name) {
  current = { name, checks: [] };
  groups.push(current);
}

/** Object.is, so a stray NaN or -0 cannot pass as equal. */
function expect(label, actual, wanted) {
  current.checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
}

/** For patches and other small objects: compared as canonical JSON. */
function expectJson(label, actual, wanted) {
  expect(label, JSON.stringify(actual), JSON.stringify(wanted));
}

const show = (s) => JSON.stringify(s);

// ---- fixtures ---------------------------------------------------------------

/**
 * One §8 draft block. `version` is left out by default on purpose: that is the
 * pre-field envelope, which is what a card restored from this browser's storage
 * is holding, so the fallback path is the one most of these tests exercise.
 */
function draftData(over = {}) {
  const { body, recipients, ...rest } = over;
  return {
    draft_id: "INBOX:42",
    id_is_stable: false,
    origin: "read",
    last_saved_at: "2026-09-17T10:00:00.000Z",
    last_saved_by: "agent",
    identity: { inbox_id: "ib-1", email_address: "you@example.com", provider: "imap" },
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

/** An `EditState`, as the component builds one from a draft block. */
function editState(over = {}) {
  return {
    to: ["dana@x.example"],
    cc: [],
    bcc: [],
    subject: "Quarterly numbers",
    bodyText: "Here they are.",
    typed: { to: "", cc: "", bcc: "" },
    ...over,
  };
}

// ---- the DOM ----------------------------------------------------------------

/**
 * Enough of a browser to mount Preact into.
 *
 * `ResizeObserver` is stubbed rather than shimmed: `AutoTextarea` uses it to
 * size itself, which is a layout concern and jsdom has no layout. Nothing below
 * asserts on a height.
 */
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (
    const key of [
      "window",
      "document",
      "Node",
      "Event",
      "MessageChannel",
      "ResizeObserver",
    ]
  ) {
    globalThis[key] = w[key];
  }
  for (const key of ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
    globalThis[key] = w[key].bind(w);
  }
  return dom;
}

/** Let Preact flush its effects, and any re-render they schedule. */
const settle = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    // The card's own modules, not copies.
    stdin: {
      contents:
        'export { DraftEditor, draftVersion, editorPatch, draftPatch }' +
        ' from "./src/components/DraftEditor";\n' +
        'export { runTeardownSaver } from "./src/store";\n' +
        'export { h, render } from "preact";\n',
      resolveDir: appRoot,
      sourcefile: "draft-sync-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    outfile: OUT,
  });

  const dom = installDom();
  const mod = await import(pathToFileURL(OUT).href);
  const { DraftEditor, draftVersion, editorPatch, runTeardownSaver, h, render } = mod;

  // ── 1. draftVersion: what counts as a different version ───────────────────
  // The server's marker when there is one, and the card's own serialisation of
  // its content when there is not. Either way the rule is the same: it moves
  // when the content moves, and not when the response does.

  group("the version moves with the content, not with the response");
  const base = draftVersion(draftData());
  expect("the same content twice is the same version", draftVersion(draftData()), base);
  // The three fields the old syncKey was built from. Every one of them changes
  // on a response that changed nothing, which is why the key was a nonce.
  expect(
    "a new last_saved_at alone does NOT move it",
    draftVersion(draftData({ last_saved_at: "2031-01-01T00:00:00.000Z" })),
    base,
  );
  expect(
    "a new origin alone does NOT move it",
    draftVersion(draftData({ origin: "save" })),
    base,
  );
  expect(
    "last_saved_by does NOT move it",
    draftVersion(draftData({ last_saved_by: "user" })),
    base,
  );
  // And the content, in every field the editor can write.
  const moved = {
    draft_id: draftData({ draft_id: "INBOX:43" }),
    to: draftData({ recipients: { to: ["dana@x.example", "sam@x.example"] } }),
    cc: draftData({ recipients: { cc: ["sam@x.example"] } }),
    bcc: draftData({ recipients: { bcc: ["sam@x.example"] } }),
    subject: draftData({ subject: "Quarterly numbers." }),
    body: draftData({ body: { text: "Here they are!" } }),
    html: draftData({ body: { html: "<p>Here they are.</p>" } }),
    truncated: draftData({ body: { truncated: true } }),
  };
  for (const [label, d] of Object.entries(moved)) {
    expect(`${label} DOES move it`, draftVersion(d) !== base, true);
  }
  // The server's marker wins outright when present, and is used verbatim.
  expect(
    "a server version is taken as-is",
    draftVersion(draftData({ version: "1:2a:deadbeefcafef00d" })),
    "1:2a:deadbeefcafef00d",
  );
  expect(
    "and it is what decides, not the content beside it",
    draftVersion(draftData({ version: "1:2a:deadbeefcafef00d", subject: "anything" })),
    draftVersion(draftData({ version: "1:2a:deadbeefcafef00d" })),
  );
  // A malformed one falls back rather than comparing garbage to garbage: two
  // different drafts that both carried `version: ""` would otherwise look like
  // one version, which is the exact failure this field removes.
  expect("an empty version falls back", draftVersion(draftData({ version: "" })), base);
  expect("a non-string version falls back", draftVersion(draftData({ version: 7 })), base);

  // ── 2. editorPatch: never diff across two versions ────────────────────────

  group("a patch is only ever taken within one version");
  const stored = editState();
  const typed = editState({ bodyText: "Here they are, finally." });
  expectJson(
    "within one version, an edit patches normally",
    editorPatch("v1", "v1", typed, stored),
    { body_text: "Here they are, finally." },
  );
  expectJson(
    "within one version, no edit means no patch",
    editorPatch("v1", "v1", stored, stored),
    {},
  );
  // The window. `edit` still describes v1, `server` already describes v2, so
  // the only honest patch is none: the card knows of no edit relative to what
  // the server now has, and anything else it sent would be a change nobody
  // made.
  expectJson(
    "across two versions, the patch is empty however different they look",
    editorPatch("v1", "v2", typed, editState({ bodyText: "changed on the phone" })),
    {},
  );
  expectJson(
    "even when every field differs",
    editorPatch(
      "v1",
      "v2",
      editState({ to: ["a@x.example"], subject: "mine", bodyText: "mine" }),
      editState({ to: ["b@x.example"], subject: "theirs", bodyText: "theirs" }),
    ),
    {},
  );
  expectJson(
    "a null edit version is out of sync, not a wildcard",
    editorPatch(null, "v2", typed, stored),
    {},
  );

  // ── 3. The component ──────────────────────────────────────────────────────
  // Everything above is a rule. This is the card.

  const root = document.getElementById("root");

  /** Mount / re-render the editor with one draft block, and record every save. */
  function mountEditor() {
    const saves = [];
    const actions = {
      save: async (patch) => {
        saves.push(patch);
        return true;
      },
      send: (patch) => saves.push({ __send: patch }),
      discard: () => {},
      refresh: () => {},
      hide: () => {},
      setFullscreen: () => {},
    };
    const draw = (d) =>
      render(
        h(DraftEditor, {
          env: {
            schema_version: "review-card-v1",
            card: "draft_editor",
            state: "editing",
            actor: { can_edit: true },
          },
          draft: d,
          provider: undefined,
          fullscreen: false,
          canExpand: false,
          busy: null,
          error: null,
          actions,
        }),
        root,
      );
    return { saves, draw };
  }

  /** Type into the message box the way a person does. */
  function typeBody(text) {
    const ta = document.getElementById("d-body");
    ta.value = text;
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }

  const bodyValue = () => document.getElementById("d-body").value;

  // ---- 3a. the eager half of defect 1 --------------------------------------

  group("a refresh that changed nothing keeps what the user typed");
  {
    const { saves, draw } = mountEditor();
    draw(draftData());
    await settle();
    typeBody("Here they are, finally.");
    await settle();
    expect("the box holds the edit", bodyValue(), "Here they are, finally.");

    // A refresh. Byte-identical draft, new response stamp — which is what EVERY
    // read returns, because `last_saved_at` is the response clock.
    draw(draftData({ last_saved_at: "2026-09-17T11:00:00.000Z" }));
    await settle();
    expect("the edit survives it", bodyValue(), "Here they are, finally.");
    // And is still the thing that would be written at teardown.
    await runTeardownSaver();
    await settle();
    expectJson("teardown writes the edit, once", saves, [
      { body_text: "Here they are, finally." },
    ]);
    render(null, root);
  }

  // ---- 3b. the lax half of defect 1 ----------------------------------------

  group("a draft changed elsewhere resyncs, even when the response looks the same");
  {
    const { saves, draw } = mountEditor();
    draw(draftData());
    await settle();
    typeBody("my local edit");
    await settle();

    // The response the old key could not tell apart from the previous one:
    // same draft_id, same last_saved_at, same origin, different body.
    draw(draftData({ body: { text: "changed on the phone" } }));
    await settle();
    expect("the box shows the newer body", bodyValue(), "changed on the phone");
    await runTeardownSaver();
    await settle();
    expectJson("and nothing stale was written", saves, []);
    render(null, root);
  }

  // ---- 3c. defect 2, the window --------------------------------------------

  group("a teardown during a resync writes nothing");
  {
    const { saves, draw } = mountEditor();
    draw(draftData());
    await settle();
    typeBody("my local edit");
    await settle();

    // The new envelope lands. Deliberately NOT settled: the teardown is
    // delivered as its own task, between the commit that armed the saver and
    // the render that would have disarmed it. That is the whole window.
    draw(draftData({
      body: { text: "changed on the phone" },
      last_saved_at: "2026-09-17T11:00:00.000Z",
    }));
    await new Promise((r) => setTimeout(r, 0));
    await runTeardownSaver();
    await settle();
    expectJson("the pre-refresh contents are not written over the new body", saves, []);
    expect("and the resync still happened", bodyValue(), "changed on the phone");
    render(null, root);
  }

  // ---- 3d. Send takes the same guard ---------------------------------------
  //
  // Save is disabled while out of sync (it is gated on `dirty`), but Send is
  // gated on `can_send` and computes its own patch in the click handler. It has
  // to go through the same rule or it is a second way out for the same stale
  // patch.

  group("Send during a resync carries no cross-version patch");
  {
    const { saves, draw } = mountEditor();
    draw(draftData());
    await settle();
    typeBody("my local edit");
    await settle();

    draw(draftData({ body: { text: "changed on the phone" } }));
    // Same un-settled instant as 3c: the click lands inside the window.
    await new Promise((r) => setTimeout(r, 0));
    const send = [...document.querySelectorAll("button")].find((b) =>
      /^(Send|Save and send)$/.test(b.textContent.trim())
    );
    expect("the Send button is there to click", !!send, true);
    send.click();
    await settle();
    expectJson("it sends the stored draft, with no patch", saves, [{ __send: null }]);
    render(null, root);
  }

  // ---- 3e. the regression guard --------------------------------------------
  //
  // Everything above is a way of writing less. The failure mode of a fix like
  // this is a card that has stopped writing at all, so: an ordinary edit, saved
  // the ordinary way, still goes out.

  group("an ordinary edit still saves");
  {
    const { saves, draw } = mountEditor();
    draw(draftData());
    await settle();
    typeBody("Here they are, finally.");
    await settle();
    const save = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.trim() === "Save"
    );
    expect("Save is enabled by a real edit", save.disabled, false);
    save.click();
    await settle();
    expectJson("and sends exactly the field that changed", saves, [
      { body_text: "Here they are, finally." },
    ]);

    // Then the save's own response comes back carrying the new content and, on
    // IMAP, a NEW id. Adopting it is the whole reason the resync exists.
    draw(draftData({
      draft_id: "INBOX:43",
      origin: "save",
      last_saved_by: "user",
      body: { text: "Here they are, finally." },
      last_saved_at: "2026-09-17T11:00:00.000Z",
    }));
    await settle();
    expect("the box holds the saved text", bodyValue(), "Here they are, finally.");
    await runTeardownSaver();
    await settle();
    expect("and the card is clean again: no second write", saves.length, 1);
    render(null, root);
  }

  // ---- 3f. an error response must not resync -------------------------------

  group("an error response does not take the user's edits away");
  {
    const { saves, draw } = mountEditor();
    draw(draftData());
    await settle();
    typeBody("my local edit");
    await settle();
    // App keeps the current draft block when an error envelope carries none
    // (see its callDraft), so the version does not move and neither does `edit`.
    draw(draftData());
    await settle();
    expect("the edit is still there", bodyValue(), "my local edit");
    await runTeardownSaver();
    await settle();
    expectJson("and is still what teardown would write", saves, [
      { body_text: "my local edit" },
    ]);
    render(null, root);
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
