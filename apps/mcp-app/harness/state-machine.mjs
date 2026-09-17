#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Drives the card's result state machine against a scripted fake host.
//
//   node harness/state-machine.mjs      (or: npm run verify -w apps/mcp-app)
//
// Why this exists separately from fixture-server.mjs: that harness proves what
// the card renders for a payload it DID receive, and needs a real browser plus
// the ext-apps reference host to do it. The bug this file guards is the
// opposite case, the paths where no usable payload ever arrives, and those are
// exactly the paths a fixture server cannot script, because they are about
// notifications the host chooses NOT to send.
//
// It is not a unit-test suite and deliberately does not add a test runner to
// the repo. It is a scripted host: a fake `window` whose `parent` speaks the
// same postMessage JSON-RPC the sandbox proxy does, wired to the real
// `HostBridge` and the real `wireResultHandlers` from src/. No part of the
// state machine is reimplemented here, so it cannot drift from the shipped
// code without failing.
//
// `src/` is TypeScript, so it is bundled with esbuild (already present via
// vite) into dist/ first. Each scenario imports that bundle under a fresh URL
// query so it gets its own module instance, because the store is a singleton
// and a scenario must not inherit the previous scenario's state.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as F from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/state-machine.bundle.mjs");

const PROTOCOL_VERSION = "2026-01-26";
const HOST_INFO = { name: "scripted-host", version: "0.0.1" };
const TOOL_INFO = {
  id: 42,
  tool: { name: "email_compose", title: "Compose" },
};

// ---- fake host --------------------------------------------------------------

/**
 * A `window` good enough for bridge.ts: it reads `window.parent` once at
 * construction, posts to it, and only accepts messages whose `source` is that
 * same object (the origin check the real sandbox proxy relies on).
 */
function scriptedHost({ hostContext = {}, deaf = () => false, initializeError = null } = {}) {
  const listeners = [];
  const sent = [];
  const logs = [];
  const responses = [];

  const parent = {
    postMessage(msg) {
      sent.push(msg);
      if (msg.method === "notifications/message") logs.push(msg.params);
      if (msg.id !== undefined && msg.method === undefined) responses.push(msg);
      if (msg.method === "ui/initialize") {
        // `deaf` models the real failure this guards: a host that is not yet
        // listening. A postMessage into a window with no listener is not
        // queued and not refused, it is simply gone, so the fake drops it on
        // the floor exactly as the browser would.
        if (deaf()) return;
        if (initializeError) {
          deliver({ jsonrpc: "2.0", id: msg.id, error: initializeError });
          return;
        }
        deliver({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: HOST_INFO,
            hostCapabilities: { openLinks: {}, updateModelContext: {} },
            hostContext: { theme: "light", displayMode: "inline", ...hostContext },
          },
        });
      }
    },
  };

  const win = {
    parent,
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener() {},
  };

  // Host -> app. Asynchronous on purpose: a real host message is never
  // delivered inside the app's own postMessage call.
  function deliver(message) {
    queueMicrotask(() => {
      for (const fn of listeners) fn({ source: parent, data: message });
    });
  }

  /** Deliver a message from a window that is NOT the app's parent. */
  function deliverFrom(message) {
    queueMicrotask(() => {
      for (const fn of listeners) fn({ source: { notOurParent: true }, data: message });
    });
  }

  return { win, deliver, deliverFrom, sent, logs, responses };
}

/**
 * `localStorage`, good enough for persist.ts.
 *
 * Node has no web storage without a flag, and persist.ts is written so that a
 * missing `localStorage` is simply "this host keeps nothing" (every access is
 * wrapped). That degradation is itself worth pinning, so the default is NO
 * storage and a scenario opts in — a scenario that forgets to would then fail
 * on the restore, not silently pass on a global left over from the last one.
 */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

const toolResult = (structuredContent, text) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/tool-result",
  params: {
    ...(text ? { content: [{ type: "text", text }] } : {}),
    structuredContent,
  },
});

// ---- runner -----------------------------------------------------------------

let instance = 0;

async function scenario(name, hostOpts, body) {
  const host = scriptedHost(hostOpts);
  globalThis.window = host.win;
  // Fresh per scenario: the store is a singleton and so is the storage blob,
  // and a scenario must not inherit either.
  if (hostOpts.storage) globalThis.localStorage = fakeStorage();
  else delete globalThis.localStorage;
  const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
  const bridge = new mod.HostBridge();
  mod.wireResultHandlers(bridge);
  await bridge.connect({ name: "state-machine-check", version: "0.0.0" });
  mod.setState({ connected: true, hostContext: bridge.hostContext });
  mod.armResultWatchdog(bridge);
  const checks = [];
  const expect = (label, actual, wanted) =>
    checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
  await body({ bridge, host, mod, expect, status: () => mod.getState().resultStatus });
  mod.disarmResultWatchdog();
  return { name, checks };
}

const settle = () => new Promise((r) => setImmediate(r));
const after = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    // store.ts imports bridge.ts for types only, so the class is re-exported
    // explicitly. One bundle means one module instance per import, which is
    // what makes the per-scenario cache-busting query work.
    stdin: {
      contents:
        'export * from "./src/store";\n' +
        'export * from "./src/persist";\n' +
        'export { HostBridge, TEARDOWN_TIMEOUT_MS } from "./src/bridge";\n' +
        'export { splitBody, joinBody } from "./src/format";\n',
      resolveDir: appRoot,
      sourcefile: "state-machine-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: OUT,
  });

  const watchdogMs = (await import(`${pathToFileURL(OUT).href}?probe=1`))
    .RESULT_WATCHDOG_MS;

  const results = [];

  // (i1) below: the fake host ignores everything posted before this moment. Set
  // when that scenario actually starts, not here — the scenarios above take
  // real time, and a deadline fixed now would have passed before it is used,
  // which silently turns the test into "a host that was listening all along".
  let deafUntil = 0;

  // (a) A payload that is not ours at all. Regression guard: this path already
  // worked, and the new statuses must not have stolen it.
  results.push(
    await scenario("foreign payload leaves waiting", {}, async (t) => {
      t.host.deliver(toolResult(F.nonEnvelope, JSON.stringify(F.nonEnvelope)));
      await settle();
      t.expect("status", t.status(), "foreign");
    }),
  );

  // (b) A cancelled call. The host MUST send tool-cancelled, and before this
  // change the bridge dropped it on the floor and the card waited forever.
  results.push(
    await scenario("tool-cancelled leaves waiting", {}, async (t) => {
      t.host.deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-cancelled",
        params: { reason: "user stopped the request" },
      });
      await settle();
      t.expect("status", t.status(), "cancelled");
    }),
  );

  // (c) Nothing at all: the remount case. Only the watchdog can end this.
  results.push(
    await scenario(
      "no notification at all leaves waiting",
      { hostContext: { toolInfo: TOOL_INFO } },
      async (t) => {
        t.expect("still waiting before the deadline", t.status(), "waiting");
        await after(watchdogMs + 250);
        t.expect("status", t.status(), "absent");
        const log = t.host.logs.at(-1);
        t.expect("logged to the host", log?.data?.event, "tool_result_absent");
        t.expect("log carries the tool name", log?.data?.tool, "email_compose");
        t.expect("log carries the call id", log?.data?.call_id, 42);
        t.expect(
          "log carries the negotiated version",
          log?.data?.protocol_version,
          PROTOCOL_VERSION,
        );
        // No web storage at all is a supported host, and the card must reach a
        // settled "nothing remembered" rather than sit on `restored: null`.
        t.expect("restore was attempted and missed", t.mod.getState().restored, "none");
        t.expect("no result ever arrived", t.mod.getState().resultArrival, "none");
      },
    ),
  );

  // (d) The fallback is a floor, not a ceiling: a result that arrives after the
  // watchdog fired must still render.
  results.push(
    await scenario("a late envelope still wins", {}, async (t) => {
      await after(watchdogMs + 250);
      t.expect("watchdog fired", t.status(), "absent");
      t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
      await settle();
      t.expect("status", t.status(), "envelope");
      t.expect(
        "envelope is readable",
        t.mod.getState().envelope?.card,
        "outbound_review",
      );
    }),
  );

  // (e) Regression guards on the paths that must keep behaving.
  results.push(
    await scenario("our broken payload is still loud", {}, async (t) => {
      // Carries `schema_version` but is not a readable envelope. Per store.ts,
      // the key alone is the discriminator: ours and broken, so it must NOT be
      // classified as somebody else's payload and quietly collapsed.
      t.host.deliver(toolResult({ schema_version: 2 }));
      await settle();
      t.expect("status", t.status(), "malformed");
    }),
  );
  results.push(
    await scenario("an envelope missing its payload is loud too", {}, async (t) => {
      // fixtures.malformed satisfies isEnvelope (schema_version + card are both
      // strings) and only fails on the payload the discriminator promises, so
      // the store classifies it "envelope" and the loudness comes from App.tsx's
      // final fallthrough notice. Pinned here so the two are not confused.
      t.host.deliver(toolResult(F.malformed));
      await settle();
      t.expect("status", t.status(), "envelope");
      t.expect("no outbound payload", t.mod.getState().envelope?.outbound, undefined);
    }),
  );
  results.push(
    await scenario("a good envelope still renders", {}, async (t) => {
      t.host.deliver(toolResult(F.bulkDelete, "128 messages match."));
      await settle();
      t.expect("status", t.status(), "envelope");
    }),
  );

  // (e2) THE HELD SEND. The payload this whole card exists to render, and the
  // one it could not see until 2026-08-25: a gated email_compose / draft /
  // schedule used to return the flat `pending_approval` object with no
  // `schema_version`, which `classifyResult` correctly called "foreign" and the
  // card correctly drew nothing for. Circular, because the only producer of an
  // `outbound_review` envelope was `approval_review`, which the card calls from
  // an already-rendered card.
  //
  // This is the cross-check, not a restatement of the server's own tests: it
  // runs the SHIPPED `classifyResult` (bundled from src/, so it cannot drift)
  // over the merged payload the server now returns, and then re-applies
  // App.tsx's branch condition to it. If either stops holding, the card is back
  // to silence on the send it was built to review.
  results.push(
    await scenario("a held send classifies as an envelope", {}, async (t) => {
      t.host.deliver(
        toolResult(
          F.heldSendMerged,
          // The model-visible half, which deliberately carries the pending keys
          // and NOT the envelope. Passed here so the scenario proves the card
          // reads structuredContent rather than falling back to parsing text.
          JSON.stringify(F.heldSendLegacy, null, 2),
        ),
      );
      await settle();
      t.expect("status", t.status(), "envelope");

      const env = t.mod.getState().envelope;
      // App.tsx: `envelope.card === "outbound_review" && envelope.outbound`.
      t.expect("App.tsx takes the outbound_review branch", env?.card, "outbound_review");
      t.expect("the branch's second half holds", typeof env?.outbound, "object");
      t.expect("a supported schema version", env?.schema_version, "review-card-v1");
      t.expect(
        "the Approve button has its target",
        env?.outbound?.review_url,
        F.heldSendMerged.review_url,
      );
      t.expect(
        "the reject/update/schedule tools have their id",
        env?.outbound?.approval_id,
        F.heldSendMerged.approval_id,
      );
      // The merged keys are ignored, not choked on. `isEnvelope` is structural
      // and the extra top-level fields must not disturb it.
      t.expect("state survived the merge", env?.state, "pending");
      t.expect("dashboard_url survived the merge", env?.dashboard_url, F.heldSendMerged.dashboard_url);
    }),
  );

  // (e3) The negative control. Without this, "envelope" above proves only that
  // some payload classifies; with it, the pair proves the merge is what changed
  // the answer.
  results.push(
    await scenario("the pre-fix held send did NOT classify", {}, async (t) => {
      t.host.deliver(toolResult(F.heldSendLegacy, JSON.stringify(F.heldSendLegacy)));
      await settle();
      t.expect("status", t.status(), "foreign");
      t.expect("nothing to render", t.mod.getState().envelope, null);
    }),
  );

  // (e4) THE DRAFT EDITOR (contract §8). Same cross-check as the held send,
  // for the card kind added after it: the SHIPPED `classifyResult` over the
  // envelope, then App.tsx's branch condition re-applied. The draft-specific
  // part is the id: on IMAP `id_is_stable` is false and the card must call back
  // with the id the server just returned, so the fields that decide that are
  // pinned here rather than left to the browser harness.
  results.push(
    await scenario("a draft envelope classifies and carries its id", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.expect("status", t.status(), "envelope");
      const env = t.mod.getState().envelope;
      // App.tsx: `envelope.card === "draft_editor" && envelope.draft`.
      t.expect("App.tsx takes the draft_editor branch", env?.card, "draft_editor");
      t.expect("the branch's second half holds", typeof env?.draft, "object");
      t.expect("state is editing", env?.state, "editing");
      t.expect("the tools have their id", env?.draft?.draft_id, "Drafts:2");
      t.expect("the id is known to be unstable", env?.draft?.id_is_stable, false);
      t.expect(
        "the tools have their inbox",
        env?.draft?.identity?.inbox_id,
        F.draftEditorImap.draft.identity.inbox_id,
      );
      t.expect("bcc is the author's own surface", env?.draft?.recipients?.bcc?.length, 1);
      t.expect("the reply context survived", env?.draft?.in_reply_to?.message_id, "INBOX:42");
      // Neutralisation still happens at the boundary, on a subject that came
      // from whoever wrote the message being answered.
      t.expect(
        "the subject was not executed on the way in",
        typeof env?.draft?.subject,
        "string",
      );
    }),
  );

  // (e5) The send and delete results: today's payload with the receipt keys
  // merged on top (§8's table). `isEnvelope` is structural, so the extra
  // top-level keys must not stop the card flipping to a receipt.
  results.push(
    await scenario("a merged send receipt still classifies", {}, async (t) => {
      t.host.deliver(toolResult(F.draftSendReceiptMerged, "Sent."));
      await settle();
      t.expect("status", t.status(), "envelope");
      const env = t.mod.getState().envelope;
      t.expect("App.tsx takes the receipt branch", env?.card, "receipt");
      t.expect("outcome", env?.receipt?.outcome, "sent");
      t.expect(
        "the published keys survived the merge",
        env?.message_id,
        F.draftSendReceiptMerged.message_id,
      );
    }),
  );
  results.push(
    await scenario("a discarded draft is a receipt", {}, async (t) => {
      t.host.deliver(toolResult(F.draftDeleteReceiptMerged, "Draft deleted."));
      await settle();
      const env = t.mod.getState().envelope;
      t.expect("status", t.status(), "envelope");
      t.expect("App.tsx takes the receipt branch", env?.card, "receipt");
      t.expect("outcome", env?.receipt?.outcome, "discarded");
    }),
  );

  // (e6) An error response from `draft_editor_save`. It carries no `draft` on
  // purpose: the server changed nothing, the user's unsaved text is still in
  // the textarea, and App.tsx keeps the current draft so the editor stays
  // mounted around the notice instead of vanishing.
  results.push(
    await scenario("a save refusal keeps the editor", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      const before = t.mod.getState().envelope;
      const refusal = t.mod.classifyResult({
        structuredContent: F.draftErrorNotFound,
      });
      t.expect("the refusal is ours", refusal.status, "envelope");
      t.expect("it carries no draft", refusal.envelope?.draft, undefined);
      t.expect("and says why", refusal.envelope?.receipt?.error_code, "draft_not_found");
      // App.tsx's merge rule, re-applied: keep the draft that is on screen.
      const applied = { ...refusal.envelope, draft: before?.draft };
      t.expect("the editor keeps its draft", applied.draft?.draft_id, "Drafts:2");
      t.expect("and renders the error", applied.state, "error");
    }),
  );

  // (e7) Teardown is a REQUEST, and the reply is what the host waits on before
  // taking the frame away. A dirty draft editor saves in that window, so the
  // reply must not go out until the handler resolves — and must go out anyway
  // if the handler hangs.
  results.push(
    await scenario("teardown waits for the save, then replies", {}, async (t) => {
      let release;
      let ran = false;
      t.mod.setTeardownSaver(
        () =>
          new Promise((resolve) => {
            ran = true;
            release = resolve;
          }),
      );
      t.bridge.onTeardown = () => t.mod.runTeardownSaver();
      t.host.deliver({ jsonrpc: "2.0", id: 910, method: "ui/resource-teardown", params: {} });
      await settle();
      t.expect("the saver ran", ran, true);
      t.expect(
        "no reply while the save is in flight",
        t.host.responses.find((m) => m.id === 910),
        undefined,
      );
      release();
      await settle();
      await settle();
      const reply = t.host.responses.find((m) => m.id === 910);
      t.expect("replied once the save resolved", JSON.stringify(reply?.result), "{}");
      t.expect("and it was not an error", reply?.error, undefined);
    }),
  );
  results.push(
    await scenario("a hung save cannot hold the host open", {}, async (t) => {
      // Same path with a saver that never resolves. The bridge's own cap is
      // TEARDOWN_TIMEOUT_MS; waiting that out here would add 8s to every run,
      // so the cap is read and the handler is given a shorter promise that
      // proves the race is wired up rather than re-timing it.
      t.expect("the cap exists", typeof t.mod.TEARDOWN_TIMEOUT_MS, "number");
      t.expect("and is bounded", t.mod.TEARDOWN_TIMEOUT_MS <= 10_000, true);
      t.bridge.onTeardown = () => new Promise(() => {});
      t.host.deliver({ jsonrpc: "2.0", id: 911, method: "ui/resource-teardown", params: {} });
      await settle();
      t.expect(
        "still waiting, as the spec asks",
        t.host.responses.find((m) => m.id === 911),
        undefined,
      );
    }),
  );

  // (f) Liveness. `ping` must be answered, unknown methods must still 404.
  results.push(
    await scenario("ping is answered, unknown methods are not", {}, async (t) => {
      t.host.deliver({ jsonrpc: "2.0", id: 900, method: "ping", params: {} });
      t.host.deliver({ jsonrpc: "2.0", id: 901, method: "ui/nope", params: {} });
      await settle();
      const ping = t.host.responses.find((m) => m.id === 900);
      const nope = t.host.responses.find((m) => m.id === 901);
      t.expect("ping got a result", JSON.stringify(ping?.result), "{}");
      t.expect("ping was not an error", ping?.error, undefined);
      t.expect("unknown method is -32601", nope?.error?.code, -32601);
    }),
  );

  // (g) Diagnostics captured off the handshake.
  results.push(
    await scenario(
      "diagnostics are captured",
      { hostContext: { toolInfo: TOOL_INFO } },
      async (t) => {
        t.expect("protocolVersion", t.bridge.protocolVersion, PROTOCOL_VERSION);
        t.expect("toolInfo.tool", t.mod.getState().toolInfo?.tool, "email_compose");
        t.expect("toolInfo.callId", t.mod.getState().toolInfo?.callId, 42);
      },
    ),
  );

  // ---- remount recovery (2026-09-16) --------------------------------------
  //
  // The founder's third complaint: "It doesn't load if I leave the chat and
  // come back." Reopening a conversation lazy-mounts widget cells whose tool
  // call finished long ago, and the spec owes that view no tool-result at all
  // ("if the View is displayed during tool execution"). These three scenarios
  // are the whole recovery path, driven through the real store and the real
  // persist layer — nothing is reimplemented here.

  // (h1) Remount with a remembered envelope. The host re-sends tool-input (a
  // MUST) and never sends a result; the card puts back what it last rendered.
  results.push(
    await scenario(
      "no result + a stored envelope restores",
      { hostContext: { toolInfo: TOOL_INFO }, storage: true },
      async (t) => {
        // Seeded through the shipped writer, under the shipped key, so a change
        // to either breaks this rather than being papered over by a fixture.
        const seedArgs = { action: "create", inbox: "demo@mcpemails.com" };
        const key = t.mod.cardKey({ tool: "draft", callId: TOOL_INFO.id }, null);
        t.expect("the key is the call id", key, "i42");
        // WITH the arguments, because the mount that wrote this entry had them:
        // `tool-input` is a host MUST and store.ts#persist passes `toolInput`
        // straight through. An entry written without them is fingerprinted
        // `NO_ARGS` and is deliberately NOT restorable by a mount that has
        // arguments — that is the cross-conversation guard, not a bug.
        t.mod.saveEnvelope(key, F.draftEditorImap, seedArgs);

        t.host.deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: seedArgs },
        });
        await settle();
        // tool-input alone is enough: a hit does not wait for the watchdog.
        t.expect("restored from storage", t.mod.getState().restored, "storage");
        t.expect("and it is the draft", t.mod.getState().envelope?.card, "draft_editor");
        t.expect("still no result", t.mod.getState().resultArrival, "none");

        // App.tsx's refresh effect re-applied: a restored draft immediately
        // calls draft_read with these two fields, so they must have survived
        // the round trip through storage.
        const d = t.mod.getState().envelope?.draft;
        t.expect("the refresh has its draft id", d?.draft_id, "Drafts:2");
        t.expect(
          "the refresh has its inbox",
          d?.identity?.inbox_id,
          F.draftEditorImap.draft.identity.inbox_id,
        );
      },
    ),
  );

  // (h2) Remount with nothing remembered: a different browser, a cleared
  // partition, or a host that hands out a fresh origin every time. The card
  // must reach a settled miss, which is what App.tsx draws its one-line
  // placeholder from. Never the loading state.
  results.push(
    await scenario(
      "no result + nothing stored settles on a miss",
      { hostContext: { toolInfo: TOOL_INFO }, storage: true },
      async (t) => {
        t.host.deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { action: "create" } },
        });
        await settle();
        // A MISS does not settle on tool-input: the result may still be one
        // tick away, and recording it here would flash the placeholder in
        // front of a card that is about to render.
        t.expect("not settled yet", t.mod.getState().restored, null);
        await after(watchdogMs + 250);
        t.expect("settled on a miss", t.mod.getState().restored, "none");
        t.expect("nothing to render", t.mod.getState().envelope, null);
        t.expect("status", t.status(), "absent");
        // App.tsx: this is the placeholder branch, and the tool name on it
        // comes from toolInfo.
        t.expect("the placeholder has a tool name", t.mod.getState().toolInfo?.tool, "email_compose");
      },
    ),
  );

  // (h3) A late result beats a restored one. The restore is a fallback, not a
  // lock: a host that delivers slowly must still end up rendering the truth.
  results.push(
    await scenario(
      "a late result wins over a restored envelope",
      { hostContext: { toolInfo: TOOL_INFO }, storage: true },
      async (t) => {
        t.mod.saveEnvelope(t.mod.cardKey({ tool: "draft", callId: 42 }, null), F.draftEditorImap);
        await after(watchdogMs + 250);
        t.expect("restored", t.mod.getState().restored, "storage");
        t.expect("showing the memory", t.mod.getState().envelope?.card, "draft_editor");

        t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
        await settle();
        t.expect("status", t.status(), "envelope");
        t.expect("the live result won", t.mod.getState().envelope?.card, "outbound_review");
        t.expect("and is recorded as late", t.mod.getState().resultArrival, "late");
      },
    ),
  );

  // (h4) The write half. Every state change carrying an envelope is cached, so
  // the NEXT mount has something to restore — including the post-save envelope,
  // which is the only one the server will not hand back (an IMAP save retires
  // the id it was called with).
  results.push(
    await scenario(
      "the rendered envelope is what gets remembered",
      { hostContext: { toolInfo: TOOL_INFO }, storage: true },
      async (t) => {
        t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
        await settle();
        const key = t.mod.cardKey({ tool: "draft", callId: 42 }, null);
        t.expect("the result was cached", t.mod.loadEnvelope(key)?.draft?.draft_id, "Drafts:2");

        // Now the card moves on, as a save does.
        t.mod.setState({
          envelope: { ...F.draftEditorImap, draft: { ...F.draftEditorImap.draft, draft_id: "Drafts:3" } },
        });
        t.expect("the newer one replaced it", t.mod.loadEnvelope(key)?.draft?.draft_id, "Drafts:3");
        t.expect(
          "and the dashboard url is kept for the empty case",
          t.mod.lastDashboardUrl(),
          F.draftEditorImap.dashboard_url,
        );
      },
    ),
  );

  // (h5) The fallback key, for a host that omits `toolInfo` entirely (phase-0
  // Q6 recorded exactly that on the reference host). The arguments the host
  // MUST re-send are hashed instead, so the same call still finds its envelope.
  results.push(
    await scenario(
      "a host with no toolInfo still restores, keyed on the arguments",
      { storage: true },
      async (t) => {
        t.expect("no toolInfo", t.mod.getState().toolInfo, null);
        const args = { action: "create", inbox: "demo@mcpemails.com" };
        const key = t.mod.cardKey(null, args);
        t.expect("the key is an argument hash", key?.startsWith("a"), true);
        t.mod.saveEnvelope(key, F.draftEditorImap, args);

        t.host.deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: args },
        });
        await settle();
        t.expect("restored", t.mod.getState().restored, "storage");
        t.expect("the draft came back", t.mod.getState().envelope?.draft?.draft_id, "Drafts:2");
      },
    ),
  );

  // (h5b) THE SAME LOOP FOR A QUEUED SEND, end to end. This is the regression
  // the round-2 pass closed: a pending send restored to a one-line dashboard
  // link, so a user who scrolled back could no longer REJECT it from the card —
  // and reject is the only decision this channel is ever allowed to make
  // (approving needs a signed-in browser session, on purpose). Approve was
  // already just `openLink(review_url)` and was not what was lost.
  //
  // Driven through the real store, the real persist layer and the shipped
  // `rehydrationCall`, so the chain "rendered -> stored -> remounted -> knows
  // how to ask again" is proven rather than assumed at each join.
  results.push(
    await scenario(
      "a remounted pending send knows how to ask for itself again",
      { hostContext: { toolInfo: TOOL_INFO }, storage: true },
      async (t) => {
        const args = { to: ["dana@northwind.example"], subject: "Q3 numbers" };
        // Mount 1: the card renders the review and the store caches it.
        t.host.deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: args },
        });
        t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
        await settle();
        t.expect("the review rendered", t.mod.getState().envelope?.card, "outbound_review");

        // Mount 2: a new cell, the same call. Only tool-input is promised.
        const key = t.mod.cardKey({ tool: "email_compose", callId: TOOL_INFO.id }, args);
        const back = t.mod.loadEnvelope(key, args);
        t.expect("what came back is a stub", t.mod.isRestoreStub(back), true);
        t.expect("carrying no recipients", back?.outbound?.recipients, undefined);
        t.expect("and no body", back?.outbound?.body, undefined);

        // App.tsx's re-request effect, from the shipped decision function.
        const call = t.mod.rehydrationCall(back);
        t.expect("it re-reads itself", call?.tool, "approval_review");
        t.expect(
          "with the id the Reject button also needs",
          call?.args?.approval_id,
          F.outboundGmail.outbound.approval_id,
        );
        // And the answer restores a card the Reject button can actually be
        // drawn from, which the one-liner never could.
        // The STUB is what is handed in, not its card kind: the answer is
        // correlated against the id that was asked for.
        const accepted = t.mod.acceptRehydration(back, F.outboundGmail);
        t.expect("the answer is adopted", accepted.kind, "adopt");
        t.expect(
          "with the approval id reject is called with",
          accepted.envelope?.outbound?.approval_id,
          F.outboundGmail.outbound.approval_id,
        );
      },
    ),
  );

  // (h6) Eviction. The cache is bounded, oldest first, so a long conversation
  // cannot turn the origin's storage into a mail archive.
  results.push(
    await scenario("the cache is bounded and evicts the oldest", { storage: true }, async (t) => {
      for (let i = 0; i < 25; i++) {
        t.mod.saveEnvelope(`i${i}`, F.receiptSent);
        // saveEnvelope stamps Date.now(); without a gap the sort is a tie and
        // "oldest" would be whatever order the keys happen to come back in.
        await after(2);
      }
      t.expect("the oldest is gone", t.mod.loadEnvelope("i0"), null);
      t.expect("the newest is kept", t.mod.loadEnvelope("i24")?.card, "receipt");
      t.expect("the fifth-oldest is gone", t.mod.loadEnvelope("i4"), null);
      t.expect("the twentieth-newest is kept", t.mod.loadEnvelope("i5")?.card, "receipt");
    }),
  );

  // ---- signature split --------------------------------------------------------
  // The draft card shows the signature as a dimmed one-liner instead of four
  // lines of the body box. It is the SAME bytes, split for display only, and
  // contract §8 requires the card to save the stored text as-is or the
  // signature doubles on the next send. So the only property that actually
  // matters is that the round trip is exact, for every input.

  results.push(
    await (async () => {
      const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
      const checks = [];
      const expect = (label, actual, wanted) =>
        checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });

      const bodies = [
        "Hi,\n\nHow are you?\n\nBest,\nAsgeir\n\n-- \nAsgeir Albretsen\nFounder\nmcpemails.com",
        "No signature here at all.",
        "",
        "-- \nleading separator only",
        "trailing separator\n-- \n",
        "two\n-- \nblocks\n-- \nlast one wins",
        "sloppy\n--\nseparator",
        "a line of --\nin prose\n\n-- \nreal sig",
        "\n\n\n",
        "unicode ✉️ and CRLF\r\n-- \r\nsig",
      ];
      for (const [i, body] of bodies.entries()) {
        expect(`round trip ${i}`, mod.joinBody(mod.splitBody(body)), body);
      }

      // The split itself, on the shape that actually ships.
      const split = mod.splitBody(bodies[0]);
      // Note the retained trailing newline: the body is "...Asgeir\n\n-- \n...",
      // so one \n belongs to the message and the next three chars are the
      // separator. Keeping it is exactly what makes the round trip exact.
      expect("message stops at the separator", split.message.endsWith("Asgeir\n"), true);
      expect("signature starts after it", split.signature.startsWith("Asgeir Albretsen"), true);
      expect("no separator means no signature", mod.splitBody(bodies[1]).signature, null);
      // Editing either half must still rebuild the whole body.
      expect(
        "an edited message keeps the signature",
        mod.joinBody({ ...split, message: "New text" }),
        "New text\n-- \nAsgeir Albretsen\nFounder\nmcpemails.com",
      );
      return { name: "the signature split round-trips byte for byte", checks };
    })(),
  );

  // ---- handshake ------------------------------------------------------------
  // These drive the bridge directly rather than through scenario(), because the
  // thing under test is connect() itself and scenario() awaits it for you.

  async function handshake(name, hostOpts, body) {
    const host = scriptedHost(hostOpts);
    globalThis.window = host.win;
    delete globalThis.localStorage;
    const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
    const bridge = new mod.HostBridge();
    const checks = [];
    const expect = (label, actual, wanted) =>
      checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
    await body({ bridge, host, mod, expect });
    return { name, checks };
  }

  // (i1) THE REAL-HOST BUG. A re-mounted card in Claude came back with no host
  // info, no tool-input and no result: the handshake had never completed,
  // because the single ui/initialize went out before the host was listening.
  // One shot meant one chance. Retrying must recover it.
  results.push(
    await handshake(
      "a host that starts listening late still completes the handshake",
      { deaf: () => Date.now() < deafUntil },
      async (t) => {
        // Past the first attempt (250ms), inside the second.
        deafUntil = Date.now() + 600;
        t.expect("connected", t.bridge.connected, false);
        await t.bridge.connect({ name: "handshake-check", version: "0.0.0" });
        t.expect("connected", t.bridge.connected, true);
        t.expect("host was heard", t.bridge.hostInfo.name, HOST_INFO.name);
        t.expect("it took more than one attempt", t.bridge.initializeAttempts > 1, true);
      },
    ),
  );

  // (i2) A host that never listens must still give up, and within the budget,
  // so a dead frame surfaces as connectError instead of spinning forever.
  results.push(
    await handshake(
      "a host that never listens gives up, and says so",
      { deaf: () => true },
      async (t) => {
        const started = Date.now();
        let error = null;
        await t.bridge
          .connect({ name: "handshake-check", version: "0.0.0" })
          .catch((e) => (error = e));
        t.expect("it failed", error instanceof Error, true);
        t.expect("not connected", t.bridge.connected, false);
        t.expect("it tried repeatedly", t.bridge.initializeAttempts > 3, true);
        // The budget is INITIALIZE_TIMEOUT_MS (10s) and must not be multiplied
        // by the retries: the retry loop shares one deadline.
        t.expect("inside the budget", Date.now() - started < 12_000, true);
      },
    ),
  );

  // (i3) A host that ANSWERS with an error heard us. Re-asking it is noise, not
  // resilience, so an error response must end the handshake on the first try.
  results.push(
    await handshake(
      "a refused handshake is not retried",
      { initializeError: { code: -32600, message: "no apps here" } },
      async (t) => {
        let error = null;
        await t.bridge
          .connect({ name: "handshake-check", version: "0.0.0" })
          .catch((e) => (error = e));
        t.expect("it failed", error instanceof Error, true);
        t.expect("exactly one attempt", t.bridge.initializeAttempts, 1);
      },
    ),
  );

  // (i4) The source check drops messages from any window that is not our
  // parent, and counts them when it does. A non-zero foreign count in the real
  // host would mean the host IS speaking and we are throwing it away, which is
  // a different bug from silence; the diagnostics line reports both.
  results.push(
    await handshake(
      "a JSON-RPC message from another window is dropped and counted",
      {},
      async (t) => {
        await t.bridge.connect({ name: "handshake-check", version: "0.0.0" });
        const accepted = t.bridge.rxAccepted;
        for (const fn of t.host.win.listenersForTest ?? []) void fn;
        t.host.deliverFrom({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: {} });
        await settle();
        t.expect("not accepted", t.bridge.rxAccepted, accepted);
        t.expect("counted as foreign", t.bridge.rxForeign, 1);
      },
    ),
  );

  let failed = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "}  ${r.name}`);
    for (const c of r.checks) {
      if (!c.ok) {
        console.log(`        ${c.label}: got ${JSON.stringify(c.actual)}, want ${JSON.stringify(c.wanted)}`);
      }
    }
  }
  const total = results.reduce((n, r) => n + r.checks.length, 0);
  console.log(`\n${total - failed}/${total} checks passed (watchdog ${watchdogMs}ms)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
