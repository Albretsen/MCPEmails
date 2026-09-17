#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WS-1b hardening scenarios: what the card must NOT do.
//
//   node harness/hardening.mjs      (or: npm run verify, which chains it)
//
// Same shape and the same scripted-host technique as state-machine.mjs (read
// that file first: it explains why this is a scripted host rather than a unit
// test suite). It is a SEPARATE file, not extra scenarios in there, for two
// reasons: state-machine.mjs answers "does the card recover when the host tells
// it nothing", which is a liveness question, and every scenario in it is
// written from the host's point of view; these are adversarial — a hostile or
// merely buggy payload, and a storage sink read by something that is not us —
// and they are the four defects of one audit, which is worth keeping legible as
// a set.
//
// Nothing here reimplements card logic. Every assertion runs the SHIPPED
// modules out of src/, bundled by esbuild exactly as state-machine.mjs bundles
// them, so a fix that is reverted or drifts breaks these instead of being
// papered over.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as F from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/hardening.bundle.mjs");

const PROTOCOL_VERSION = "2026-01-26";
const HOST_INFO = { name: "scripted-host", version: "0.0.1" };

// ---- fake host (same contract as state-machine.mjs#scriptedHost) -----------

function scriptedHost({ hostContext = {} } = {}) {
  const listeners = [];
  const logs = [];
  const parent = {
    postMessage(msg) {
      if (msg.method === "notifications/message") logs.push(msg.params);
      if (msg.method === "ui/initialize") {
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
  function deliver(message) {
    queueMicrotask(() => {
      for (const fn of listeners) fn({ source: parent, data: message });
    });
  }
  return { win, deliver, logs };
}

/**
 * `localStorage`, good enough for persist.ts, and readable as raw text.
 *
 * `raw()` is the whole point of this variant: the storage defect is not about
 * what the card reads back, it is about what any OTHER reader of this origin
 * would find sitting there — so the assertions are made against the serialised
 * bytes, not against the parsed object the card hands itself.
 */
function fakeStorage(seed = new Map()) {
  const map = seed;
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    /** Everything this origin holds, as one string. The hostile reader's view. */
    raw: () => [...map.entries()].map(([k, v]) => `${k}=${v}`).join("\n"),
    keys: () => [...map.keys()],
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

const toolInput = (args) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/tool-input",
  params: { arguments: args },
});

// ---- runner ----------------------------------------------------------------

let instance = 0;

async function scenario(name, hostOpts, body) {
  const host = scriptedHost(hostOpts);
  globalThis.window = host.win;
  const storage = hostOpts.storage ? fakeStorage(hostOpts.seed) : null;
  if (storage) globalThis.localStorage = storage;
  else delete globalThis.localStorage;
  const mod = await import(`${pathToFileURL(OUT).href}?i=${++instance}`);
  const bridge = new mod.HostBridge();
  mod.wireResultHandlers(bridge);
  await bridge.connect({ name: "hardening-check", version: "0.0.0" });
  mod.setState({ connected: true, hostContext: bridge.hostContext });
  mod.armResultWatchdog(bridge);
  const checks = [];
  const expect = (label, actual, wanted) =>
    checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
  try {
    await body({ bridge, host, mod, storage, expect, state: () => mod.getState() });
  } catch (e) {
    // A scenario that throws is a failing scenario, not a dead run: the other
    // twenty still have something to say, and "it threw" is itself the finding.
    expect("scenario threw", String(e?.message ?? e), "no exception");
  }
  mod.disarmResultWatchdog();
  return { name, checks };
}

const settle = () => new Promise((r) => setImmediate(r));

/** Strings from the draft fixture that must never reach a durable sink. */
const SECRET = {
  bodyLine: "Here are the Q3 numbers",
  quoted: "Can you send the Q3 numbers?",
  bcc: "archive@mcpemails.example",
  subject: "Q3 numbers",
  signature: "Demo User",
};

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents:
        'export * from "./src/store";\n' +
        'export * from "./src/persist";\n' +
        'export * from "./src/diagnostics";\n' +
        'export { HostBridge } from "./src/bridge";\n',
      resolveDir: appRoot,
      sourcefile: "hardening-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: OUT,
  });

  const results = [];

  // ======================================================================
  // (A) Decrypted email must not reach web storage
  // ======================================================================
  //
  // contract.md §7 lists "decrypted body text and HTML", "bcc addresses" and
  // "the message sample rows" as the things kept out of the default flow. The
  // envelope cache wrote all three to `localStorage` under a fixed key, with no
  // TTL, for 20 calls at a time. localStorage is durable, it is not per
  // conversation, and whether it is per MCP App or per sandbox ORIGIN is a host
  // implementation detail we cannot read (see the report). So the card stores
  // only what it needs to RE-REQUEST the card, and the server's own
  // authorisation is what decides whether the re-request returns anything.

  results.push(
    await scenario(
      "a stored draft carries no body, no subject and no bcc",
      { storage: true },
      async (t) => {
        const key = t.mod.cardKey(null, { action: "create" });
        // The arguments go in as well as into the key: an entry written without
        // them is fingerprinted NO_ARGS and is refused by any later read that
        // HAS arguments, which is the cross-conversation guard.
        t.mod.saveEnvelope(key, F.draftEditorImap, { action: "create" });
        const raw = t.storage.raw();
        t.expect("something was stored", raw.length > 0, true);
        t.expect("no body text", raw.includes(SECRET.bodyLine), false);
        t.expect("no quoted original", raw.includes(SECRET.quoted), false);
        t.expect("no bcc address", raw.includes(SECRET.bcc), false);
        t.expect("no subject", raw.includes(SECRET.subject), false);
        t.expect("no signature block", raw.includes(SECRET.signature), false);
        // What IS kept: the two opaque identifiers the refresh needs, and
        // nothing that reads as content.
        const back = t.mod.loadEnvelope(key, { action: "create" });
        t.expect("the draft id survives", back?.draft?.draft_id, "Drafts:2");
        t.expect(
          "the inbox id survives",
          back?.draft?.identity?.inbox_id,
          F.draftEditorImap.draft.identity.inbox_id,
        );
        t.expect("and it is marked as a stub", t.mod.isRestoreStub(back), true);
      },
    ),
  );

  results.push(
    await scenario(
      "a stored outbound review carries no body, and no bulk sample rows",
      { storage: true },
      async (t) => {
        t.mod.saveEnvelope("k1", F.outboundGmail);
        t.mod.saveEnvelope("k2", F.bulkDelete);
        const raw = t.storage.raw();
        t.expect("no body text", raw.includes("Numbers for Q3 are attached"), false);
        t.expect("no html body", raw.includes("tracker.example.net"), false);
        t.expect("no recipient address", raw.includes("dana@northwind.example"), false);
        // fixtures.bulkDelete's sample rows: from/subject/date of real mail.
        t.expect("no sample row sender", raw.includes("news@example.com"), false);
        t.expect("no sample row subject", raw.includes("Your Monday briefing"), false);
        t.expect("no scope description", raw.includes("unread from news@ received"), false);
      },
    ),
  );

  results.push(
    await scenario(
      "the envelope written on every setState is redacted too",
      { storage: true },
      async (t) => {
        // The write path that matters most: store.setState persists ANY
        // envelope it is handed, including the post-save one the server will
        // never return again. That path must redact as hard as the explicit
        // save does.
        t.host.deliver(toolInput({ action: "create", inbox: "demo@mcpemails.com" }));
        t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
        await settle();
        t.expect("the card rendered it", t.state().envelope?.draft?.subject !== undefined, true);
        const raw = t.storage.raw();
        t.expect("but storage has no body", raw.includes(SECRET.bodyLine), false);
        t.expect("and no bcc", raw.includes(SECRET.bcc), false);
      },
    ),
  );

  results.push(
    await scenario(
      "the v1 blob, which held bodies, is deleted on sight",
      {
        storage: true,
        // A browser that already ran the old build carries this. Nothing reads
        // it any more, so unless it is actively removed it sits in the origin
        // forever with the bodies still in it.
        seed: new Map([
          [
            "mcpemails.card.v1",
            JSON.stringify({ k: { i1: { t: Date.now(), e: F.draftEditorImap } } }),
          ],
        ]),
      },
      async (t) => {
        t.expect("the old blob is there", t.storage.raw().includes(SECRET.bodyLine), true);
        // Any read of the store is enough; the card does one on every mount.
        t.mod.lastDashboardUrl();
        t.expect("the old key is gone", t.storage.getItem("mcpemails.card.v1"), null);
        t.expect("and with it the body", t.storage.raw().includes(SECRET.bodyLine), false);
      },
    ),
  );

  // The v2 blob held no bodies — it is the redacted stub — but it held UNSALTED
  // fingerprints and unsalted argument-hash keys, which is the offline oracle
  // the salt exists to remove. An orphaned key is never read again and so never
  // reaches the TTL branch, so leaving it to expire leaves it there; it is
  // purged like v1 instead.
  results.push(
    await scenario(
      "the unsalted v2 blob is deleted on sight too",
      {
        storage: true,
        seed: new Map([
          [
            "mcpemails.card.v2",
            JSON.stringify({ k: { a12ab34cd: { t: Date.now(), f: "9zz1x0", e: {} } } }),
          ],
        ]),
      },
      async (t) => {
        t.expect("the old blob is there", t.storage.raw().includes("a12ab34cd"), true);
        t.mod.lastDashboardUrl();
        t.expect("the old key is gone", t.storage.getItem("mcpemails.card.v2"), null);
        t.expect("and with it the unsalted digest", t.storage.raw().includes("9zz1x0"), false);
      },
    ),
  );

  // ======================================================================
  // (A2) The fingerprint must not be an offline oracle for a composed message
  // ======================================================================
  //
  // `hash()` is taken over `JSON.stringify(args)`, and on `draft{action:
  // "create"}` the arguments ARE the subject, body and recipients. Unsalted,
  // ~64 bits of FNV-1a over public constants is a confirmation oracle anybody
  // could answer offline, for every browser at once, from one precomputed
  // table. The salt does not hide the digest from a reader who takes this whole
  // blob — it is in the blob — but it removes precomputation and cross-browser
  // correlation, which is what these two checks pin.
  results.push(
    await scenario("the argument fingerprint is salted per browser", { storage: true }, async (t) => {
      const args = { action: "create", subject: "Q3 numbers", body: SECRET.bodyLine };
      const key = t.mod.cardKey(null, args);
      t.mod.saveEnvelope(key, F.draftEditorImap, args);
      const blob = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
      t.expect("a salt was written", typeof blob.s, "string");
      t.expect("and it is not trivial", blob.s.length >= 8, true);

      // The unsalted value, computed here exactly as an attacker would from the
      // published constants. It must not appear anywhere in the blob — not as
      // the fingerprint, and not inside the `a<hash>` key either, which is the
      // branch that runs in production.
      const fnv = (s, h = 0x811c9dc5) => {
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
      };
      const guess = JSON.stringify(args);
      t.expect(
        "the fingerprint is not the bare digest",
        t.storage.raw().includes(`${fnv(guess)}${fnv(guess, 0x01000193)}`),
        false,
      );
      const keyGuess = ` ${guess}`; // callSignature: `${tool ?? ""} ${args}`
      t.expect(
        "and neither is the key",
        t.storage.raw().includes(`${fnv(keyGuess)}${fnv(keyGuess, 0x01000193)}`),
        false,
      );
      // It still does its job: the same browser, the same arguments, a hit.
      t.expect("the same mount still restores", t.mod.loadEnvelope(key, args)?.card, "draft_editor");
    }),
  );

  results.push(
    await scenario("a different browser computes a different fingerprint", { storage: true }, async (t) => {
      const args = { action: "create", subject: "Q3 numbers" };
      t.mod.saveEnvelope(t.mod.cardKey(null, args), F.draftEditorImap, args);
      const mine = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
      // Another browser: the same arguments, a different salt. Forced by
      // clearing the store, which is also what a cleared-site-data browser is.
      t.storage.clear();
      const other = await import(`${pathToFileURL(OUT).href}?salt=${Date.now()}`);
      other.saveEnvelope(other.cardKey(null, args), F.draftEditorImap, args);
      const theirs = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
      t.expect("the salts differ", mine.s === theirs.s, false);
      t.expect(
        "so the fingerprints do not join",
        Object.values(mine.k)[0].f === Object.values(theirs.k)[0].f,
        false,
      );
      t.expect(
        "and neither do the keys",
        Object.keys(mine.k)[0] === Object.keys(theirs.k)[0],
        false,
      );
    }),
  );

  results.push(
    await scenario("stored entries expire", { storage: true }, async (t) => {
      const key = t.mod.cardKey(null, { action: "create" });
      t.mod.saveEnvelope(key, F.draftEditorImap, { action: "create" });
      t.expect("readable now", t.mod.loadEnvelope(key, { action: "create" })?.card, "draft_editor");
      t.expect("the TTL is bounded", t.mod.STORE_TTL_MS <= 24 * 3600_000, true);
      // Rewrite the entry with an old timestamp, through the same blob the card
      // reads, and check the reader refuses it AND drops it.
      const blob = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
      blob.k[key].t = Date.now() - t.mod.STORE_TTL_MS - 1000;
      t.storage.setItem("mcpemails.card.v3", JSON.stringify(blob));
      t.expect("expired reads as a miss", t.mod.loadEnvelope(key, { action: "create" }), null);
      t.expect(
        "and is pruned from the blob",
        JSON.parse(t.storage.getItem("mcpemails.card.v3")).k[key],
        undefined,
      );
    }),
  );

  // An entry nothing ever looks up again is the case `loadEnvelope`'s own TTL
  // branch CANNOT reach, because that branch only runs on the one key it was
  // handed. The `a<hash>` branch keys on the arguments, so every distinct draft
  // gets a key of its own and the previous one is orphaned by construction; a
  // salt change orphans all twenty at once. Found by the WS-1b round-3
  // verification pass, which drove a two-tab first-mount race and then read the
  // blob: unreachable entries were sitting there long past the TTL, with a
  // timestamp, an inbox_id and an IMAP draft ordinal in each.
  results.push(
    await scenario("an ORPHANED entry still expires", { storage: true }, async (t) => {
      const mine = { action: "create", subject: "mine" };
      const orphan = { action: "create", subject: "nobody asks for this again" };
      const orphanKey = t.mod.cardKey(null, orphan);
      t.mod.saveEnvelope(orphanKey, F.draftEditorImap, orphan);

      // Age it past the TTL, through the blob the card actually reads.
      const blob = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
      blob.k[orphanKey].t = Date.now() - t.mod.STORE_TTL_MS - 1000;
      t.storage.setItem("mcpemails.card.v3", JSON.stringify(blob));
      t.expect(
        "it is there and stale",
        !!JSON.parse(t.storage.getItem("mcpemails.card.v3")).k[orphanKey],
        true,
      );

      // Nothing ever calls loadEnvelope for it. A write for a DIFFERENT call is
      // all it takes.
      const liveKey = t.mod.cardKey(null, mine);
      t.mod.saveEnvelope(liveKey, F.draftEditorImap, mine);
      const after = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
      t.expect("a later write sweeps it", after.k[orphanKey], undefined);
      t.expect("and leaves the live one alone", !!after.k[liveKey], true);
      t.expect("so the blob holds exactly one entry", Object.keys(after.k).length, 1);
    }),
  );

  // Key strength. Claude sends no `toolInfo`, so the argument-hash branch is
  // the one that runs in production — but the callId branch is the one that
  // collides hardest when a host DOES send it, because JSON-RPC ids restart at
  // 1 in every conversation. `i42` in this chat and `i42` in yesterday's chat
  // are the same key.
  results.push(
    await scenario(
      "a call id from another conversation does not restore its envelope",
      { storage: true, hostContext: { toolInfo: { id: 42, tool: { name: "draft" } } } },
      async (t) => {
        // Conversation 1 stored a draft under call id 42 with ITS arguments.
        const other = t.mod.cardKey({ tool: "draft", callId: 42 }, {
          action: "create",
          inbox: "someone-else@example.com",
        });
        t.expect("same key shape as ours", other, "i42");
        t.mod.saveEnvelope(other, F.draftEditorImap, {
          action: "create",
          inbox: "someone-else@example.com",
        });

        // Conversation 2 mounts on the same call id with DIFFERENT arguments.
        t.host.deliver(toolInput({ action: "create", inbox: "me@example.com" }));
        await settle();
        t.expect("nothing was restored", t.state().envelope, null);
        t.expect("not even quietly", t.state().restored, null);
      },
    ),
  );

  results.push(
    await scenario(
      "the same call, remounted, still restores",
      { storage: true, hostContext: { toolInfo: { id: 42, tool: { name: "draft" } } } },
      async (t) => {
        const args = { action: "create", inbox: "me@example.com" };
        t.mod.saveEnvelope(t.mod.cardKey({ tool: "draft", callId: 42 }, args), F.draftEditorImap, args);
        t.host.deliver(toolInput(args));
        await settle();
        t.expect("restored", t.state().restored, "storage");
        t.expect("the draft id came back", t.state().envelope?.draft?.draft_id, "Drafts:2");
      },
    ),
  );

  results.push(
    await scenario(
      "an entry for another inbox is refused even on a key hit",
      { storage: true },
      async (t) => {
        const args = { action: "create" };
        const key = t.mod.cardKey(null, args);
        t.mod.saveEnvelope(key, F.draftEditorImap, args);
        // Same arguments, but this mount is bound to a different mailbox: the
        // tool-input names one and the stored envelope belongs to another.
        const hit = t.mod.loadEnvelope(key, { action: "create", inbox_id: "a-different-inbox" });
        t.expect("refused", hit, null);
      },
    ),
  );

  // ======================================================================
  // (B) A draft-less envelope must not blank a live editor (PUSH path)
  // ======================================================================
  //
  // App.tsx's callDraft (the REQUEST path) has guarded this since the draft
  // editor shipped: "an error envelope must not take the editor away". The push
  // path had no equivalent, and `isEnvelope` is structural enough that
  // {schema_version, card} alone passes it.

  results.push(
    await scenario("a draft-less envelope does not blank a live editor", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.expect("the editor is up", t.state().envelope?.draft?.draft_id, "Drafts:2");

      // The minimum thing that satisfies isEnvelope.
      t.host.deliver(toolResult({ schema_version: "review-card-v1", card: "draft_editor" }));
      await settle();
      t.expect("the draft survived", t.state().envelope?.draft?.draft_id, "Drafts:2");
      t.expect("as a draft_editor card", t.state().envelope?.card, "draft_editor");
    }),
  );

  results.push(
    await scenario("an error envelope shows its error AND keeps the draft", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.host.deliver(toolResult(F.draftErrorNotFound));
      await settle();
      t.expect("the draft survived", t.state().envelope?.draft?.draft_id, "Drafts:2");
      t.expect("the error is visible", t.state().envelope?.state, "error");
      t.expect(
        "with its code",
        t.state().envelope?.receipt?.error_code,
        "draft_not_found",
      );
    }),
  );

  results.push(
    await scenario("an envelope with no payload at all is not rendered over", {}, async (t) => {
      t.host.deliver(toolResult(F.outboundGmail, "Queued."));
      await settle();
      t.host.deliver(toolResult({ schema_version: "review-card-v1", card: "bulk_plan" }));
      await settle();
      t.expect("the review is still up", t.state().envelope?.card, "outbound_review");
      t.expect("with its payload", typeof t.state().envelope?.outbound, "object");
    }),
  );

  results.push(
    await scenario("a first payload-less envelope still renders (no regression)", {}, async (t) => {
      // Nothing to protect: `malformed` is the fixture whose loudness App.tsx's
      // final fallthrough notice provides, and it must keep arriving.
      t.host.deliver(toolResult(F.malformed));
      await settle();
      t.expect("classified", t.state().resultStatus, "envelope");
      t.expect("and kept", t.state().envelope?.card, F.malformed.card);
    }),
  );

  // ======================================================================
  // (C) A second, uncorrelated tool result must not discard unsaved typing
  // ======================================================================

  results.push(
    await scenario("someone else's draft does not replace mine", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      const mine = t.state().envelope?.draft?.draft_id;
      t.expect("mine is up", mine, "Drafts:2");

      const foreign = {
        ...F.draftEditorImap,
        draft: {
          ...F.draftEditorImap.draft,
          draft_id: "Drafts:999",
          subject: "SOMEONE ELSE'S CALL",
        },
      };
      t.host.deliver(toolResult(foreign, "Draft Drafts:999."));
      await settle();
      t.expect("mine is still up", t.state().envelope?.draft?.draft_id, "Drafts:2");
      t.expect("and it was counted", t.state().uncorrelatedResults, 1);
    }),
  );

  results.push(
    await scenario("a re-delivery of the SAME result is accepted", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      const updated = {
        ...F.draftEditorImap,
        draft: { ...F.draftEditorImap.draft, last_saved_at: "2026-09-16T10:00:00Z" },
      };
      t.host.deliver(toolResult(updated));
      await settle();
      t.expect("accepted", t.state().envelope?.draft?.last_saved_at, "2026-09-16T10:00:00Z");
      t.expect("nothing was dropped", t.state().uncorrelatedResults, 0);
    }),
  );

  results.push(
    await scenario(
      "a mismatched host call id is refused outright",
      { hostContext: { toolInfo: { id: 42, tool: { name: "draft" } } } },
      async (t) => {
        t.host.deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            callId: 43,
            structuredContent: F.draftEditorImap,
          },
        });
        await settle();
        t.expect("nothing rendered", t.state().envelope, null);
        t.expect("counted", t.state().uncorrelatedResults, 1);
      },
    ),
  );

  results.push(
    await scenario("a foreign SECOND result still flips the status only", {}, async (t) => {
      // The property the audit asked to KEEP: a non-envelope second result
      // records that it happened without taking the card away.
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.host.deliver(toolResult(F.nonEnvelope, "Deleted 3 messages."));
      await settle();
      t.expect("status moved", t.state().resultStatus, "foreign");
      t.expect("the card stayed", t.state().envelope?.draft?.draft_id, "Drafts:2");
    }),
  );

  results.push(
    await scenario(
      "a late result still wins over a RESTORED envelope",
      { storage: true, hostContext: { toolInfo: { id: 7, tool: { name: "draft" } } } },
      async (t) => {
        // The restore is not a result, so correlation must not lock it in:
        // state-machine.mjs (h3) depends on this and so does every remount.
        const args = { action: "create" };
        t.mod.saveEnvelope(t.mod.cardKey({ tool: "draft", callId: 7 }, args), F.draftEditorImap, args);
        t.host.deliver(toolInput(args));
        await settle();
        t.expect("restored", t.state().restored, "storage");
        t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
        await settle();
        t.expect("the live result won", t.state().envelope?.card, "outbound_review");
        t.expect("and was not counted as foreign", t.state().uncorrelatedResults, 0);
      },
    ),
  );

  // ======================================================================
  // (C2) Three holes the WS-1b verification pass found in the WS-1b fix
  // ======================================================================

  // A restore STUB is renderable by shape (a draft stub has a `draft`) and
  // empty by design. mergeEnvelope's rule 1 grafted that empty payload onto a
  // payload-less error envelope, and the `_stub` marker did not survive the
  // spread — so App.tsx's stub gate stopped firing and the card rendered a full
  // DraftEditor with a blank subject and a blank body over a real server draft,
  // whose first Save writes the blanks back.
  results.push(
    await scenario(
      "a payload-less error over a restored STUB stays a stub",
      { storage: true, hostContext: { toolInfo: { id: 9, tool: { name: "draft" } } } },
      async (t) => {
        const args = {
          action: "update",
          draft_id: "Drafts:2",
          inbox_id: F.draftEditorImap.draft.identity.inbox_id,
        };
        t.mod.saveEnvelope(t.mod.cardKey({ tool: "draft", callId: 9 }, args), F.draftEditorImap, args);
        t.host.deliver(toolInput(args));
        await settle();
        t.expect("restored a stub", t.mod.isRestoreStub(t.state().envelope), true);
        t.host.deliver(toolResult(F.draftErrorNotFound, "That draft no longer exists."));
        await settle();
        const env = t.state().envelope;
        t.expect("still marked as a stub", t.mod.isRestoreStub(env), true);
        t.expect("so it can never render as an editor", env?.draft?.subject, undefined);
      },
    ),
  );

  // An entry written before `tool-input` arrived used to carry NO fingerprint
  // at all, and `loadEnvelope` only compares when one is present — so on a host
  // that sends `toolInfo.id` (ids restart at 1 in every conversation) any later
  // mount on the same key restored it, whatever call it was for.
  results.push(
    await scenario(
      "an entry written before tool-input is still fingerprinted",
      { storage: true, hostContext: { toolInfo: { id: 42, tool: { name: "draft" } } } },
      async (t) => {
        // Result first, input second: the write happens with no arguments.
        t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
        await settle();
        const blob = JSON.parse(t.storage.getItem("mcpemails.card.v3"));
        const entries = Object.values(blob.k);
        t.expect("one entry was written", entries.length, 1);
        t.expect("and it carries a fingerprint", typeof entries[0].f, "string");
        t.expect(
          "which no other call can match",
          t.mod.loadEnvelope("i42", { action: "read", message_id: "someone-else" }),
          null,
        );
        // A host that sends no arguments at all still restores its own entry.
        t.expect("but the same argument-less mount still does", t.mod.loadEnvelope("i42")?.card, "draft_editor");
      },
    ),
  );

  // `isEnvelope` checks two fields for `typeof === "string"` and nothing more,
  // so `card`, `state`, `schema_version` and `receipt.outcome` are whatever the
  // wire says. redact() copied all four through verbatim, which puts an
  // arbitrary server-authored string into a durable, possibly shared-origin
  // sink — the exact class of defect this file was rewritten to close.
  results.push(
    await scenario("an unvalidated server string cannot reach storage", { storage: true }, async (t) => {
      const hostile = {
        schema_version: "review-card-v1",
        card: "receipt",
        state: "Sent to dana@northwind.example about the Q3 numbers",
        dashboard_url: "javascript:alert(1)",
        receipt: { outcome: "sent to dana@northwind.example", headline: "Sent to dana@…" },
      };
      t.mod.saveEnvelope("i1", hostile, { a: 1 });
      const raw = t.storage.raw();
      t.expect("no address from `state`", raw.includes("dana@northwind.example"), false);
      t.expect("no sentence in `state`", raw.includes("Q3 numbers"), false);
      t.expect("no non-https dashboard url", raw.includes("javascript:"), false);
      // An unknown card kind has nothing to restore, so it is not written at all.
      t.mod.saveEnvelope("i2", { ...hostile, card: "<img src=x onerror=1>" }, { a: 2 });
      t.expect("and an unknown card kind is not stored", t.mod.loadEnvelope("i2", { a: 2 }), null);
    }),
  );

  // ======================================================================
  // (E) A re-mounted pending send can still be rejected
  // ======================================================================
  //
  // The first WS-1b fix put every non-draft card on a one-line dashboard link
  // when it restored, on the stated ground that "everything else (a queued
  // send, a bulk plan) has no re-request in contract v1". For a queued send
  // that was FALSE: `approval_review` is declared in mcp-app-approvals.ts,
  // takes `approval_id` alone, is `readOnlyHint: true`, and its own description
  // ends "so it can be shown in the review card". The card just never called
  // it.
  //
  // What the one-liner actually cost: `Approve` was already only
  // `openLink(review_url)`, so nothing there. `Reject` was a genuine in-card
  // `approval_decide` call, and it is the one decision this channel is ever
  // allowed to make — approving requires a signed-in browser session, on
  // purpose. A user scrolling back to a pending send could no longer reject it,
  // and scrolling back is the ORDINARY case: every return to a conversation
  // lazy-mounts every widget cell.

  results.push(
    await scenario(
      "a stored pending send keeps its approval_id, and nothing else",
      { storage: true },
      async (t) => {
        const args = { to: ["dana@northwind.example"], subject: "Q3 numbers" };
        const key = t.mod.cardKey(null, args);
        t.mod.saveEnvelope(key, F.outboundGmail, args);
        const raw = t.storage.raw();

        // The redaction still holds: an approval_id is an opaque UUID, and
        // adding it must not drag the envelope it came from along with it.
        t.expect("no body text", raw.includes("Numbers for Q3 are attached"), false);
        t.expect("no recipient", raw.includes("dana@northwind.example"), false);
        t.expect("no subject", raw.includes("final"), false);
        t.expect("no attachment filename", raw.includes("q3.pdf"), false);
        t.expect("no mailbox address", raw.includes("asgeir@mcpemails.com"), false);
        // review_url embeds the approval id in a path, so it is not a secret —
        // but it is the Approve target and has no business in storage when the
        // id itself is what the re-request needs.
        t.expect("no review url", raw.includes("/approvals/"), false);

        const back = t.mod.loadEnvelope(key, args);
        t.expect("it is a stub", t.mod.isRestoreStub(back), true);
        t.expect(
          "the approval id survived",
          back?.outbound?.approval_id,
          F.outboundGmail.outbound.approval_id,
        );
        // Nothing a decision row could be drawn from. App.tsx's stub gate runs
        // before the outbound_review branch, but the stub must not be able to
        // furnish one even if that gate were ever moved.
        t.expect("no recipients on the stub", back?.outbound?.recipients, undefined);
        t.expect("no body on the stub", back?.outbound?.body, undefined);
        t.expect("no review url on the stub", back?.outbound?.review_url, undefined);
        t.expect("no identity on the stub", back?.outbound?.identity, undefined);
      },
    ),
  );

  results.push(
    await scenario("an approval id that is not a UUID is not stored", { storage: true }, async (t) => {
      // The server's own `APPROVAL_ID_PROPERTY` is `format: "uuid"` and
      // `loadPendingApproval` refuses anything else before it touches the
      // database, so a non-UUID here is a server-authored string rather than an
      // identifier — the exact class of value redact() exists to keep out.
      const hostile = {
        ...F.outboundGmail,
        outbound: {
          ...F.outboundGmail.outbound,
          approval_id: "pending send to dana@northwind.example about Q3",
        },
      };
      t.mod.saveEnvelope("i1", hostile, { a: 1 });
      t.expect("nothing leaked", t.storage.raw().includes("dana@northwind.example"), false);
      t.expect("and no id was kept", t.mod.loadEnvelope("i1", { a: 1 })?.outbound, undefined);
    }),
  );

  results.push(
    await scenario("an id that only STRINGIFIES to a UUID is not one", { storage: true }, async (t) => {
      // FOUND BY THE ROUND-2 VERIFICATION PASS, 2026-09-17. Both id guards read
      // `UUID.test(String(v))`, which coerces before it tests and then stores
      // the ORIGINAL value — so `["8f2a…"]`, which is ordinary well-formed JSON
      // and therefore something a server or a proxy can genuinely put on the
      // wire, stringified to exactly the uuid, passed, and went into storage as
      // an ARRAY. It then came back out as the `approval_id` argument of the
      // re-request, where `format: "uuid"` refuses it and the card tells the
      // user a live pending send "is no longer pending".
      //
      // Both sites, because the approval line was copied from the draft one.
      const U = F.outboundGmail.outbound.approval_id;

      const wrapped = {
        ...F.outboundGmail,
        outbound: { ...F.outboundGmail.outbound, approval_id: [U] },
      };
      t.mod.saveEnvelope("a", wrapped, { a: 1 });
      t.expect("a wrapped approval id is not kept", t.mod.loadEnvelope("a", { a: 1 })?.outbound, undefined);

      const inbox = F.draftEditorImap.draft.identity.inbox_id;
      const wrappedInbox = {
        ...F.draftEditorImap,
        draft: {
          ...F.draftEditorImap.draft,
          identity: { ...F.draftEditorImap.draft.identity, inbox_id: [inbox] },
        },
      };
      t.mod.saveEnvelope("b", wrappedInbox, { b: 1 });
      const back = t.mod.loadEnvelope("b", { b: 1 });
      t.expect("nor a wrapped inbox id", back?.draft?.identity?.inbox_id, undefined);
      // The draft itself still restores — dropping an unusable id must not cost
      // the card the pointer it CAN use.
      t.expect("the draft id survives regardless", back?.draft?.draft_id, "Drafts:2");

      // And the real values still go through, so this is a type check and not a
      // new refusal.
      t.mod.saveEnvelope("c", F.outboundGmail, { c: 1 });
      t.expect("a real uuid is still stored", t.mod.loadEnvelope("c", { c: 1 })?.outbound?.approval_id, U);
    }),
  );

  results.push(
    await scenario("each card kind asks for exactly the read it has", { storage: true }, async (t) => {
      const save = (key, env) => {
        t.mod.saveEnvelope(key, env, { k: key });
        return t.mod.loadEnvelope(key, { k: key });
      };

      const send = t.mod.rehydrationCall(save("s", F.outboundGmail));
      t.expect("a queued send re-reads itself", send?.tool, "approval_review");
      t.expect(
        "with the only argument that tool takes",
        JSON.stringify(send?.args),
        JSON.stringify({ approval_id: F.outboundGmail.outbound.approval_id }),
      );

      const draft = t.mod.rehydrationCall(save("d", F.draftEditorImap));
      t.expect("a draft re-reads itself", draft?.tool, "draft_read");
      t.expect("with its draft id", draft?.args?.draft_id, "Drafts:2");
      t.expect(
        "and its inbox",
        draft?.args?.inbox_id,
        F.draftEditorImap.draft.identity.inbox_id,
      );

      // SETTLED, and pinned so it stays settled: mcp-app-bulk.ts declares
      // `bulk_execute` and `bulk_cancel` and nothing else. Both DECIDE. There
      // is no reader for a plan, and reading one by running it is not a read.
      t.expect("a bulk plan has no reader", t.mod.rehydrationCall(save("b", F.bulkDelete)), null);
      // A receipt is terminal: persist.ts rewrites its headline from the
      // outcome and it renders straight from the stub.
      t.expect("a receipt needs none", t.mod.rehydrationCall(save("r", F.receiptSent)), null);
      // A LIVE envelope is not a stub and must never be re-requested over.
      t.expect("a live envelope is not re-read", t.mod.rehydrationCall(F.outboundGmail), null);
      t.expect("nor is nothing", t.mod.rehydrationCall(null), null);
    }),
  );

  results.push(
    await scenario("a re-request answer is validated before it is adopted", {}, async (t) => {
      // `asked` is the STUB, not its card kind: the answer is correlated
      // against the id the re-request was made with. The fixtures stand in for
      // their own stubs here, which carry the same ids.
      const SEND = F.outboundGmail;
      const DRAFT = F.draftEditorImap;
      const kind = (asked, env) => t.mod.acceptRehydration(asked, env).kind;
      const subject = (asked, env) => t.mod.acceptRehydration(asked, env).subject;

      // The happy paths.
      t.expect("a real pending send is adopted", kind(SEND, F.outboundGmail), "adopt");
      t.expect("a real draft is adopted", kind(DRAFT, F.draftEditorImap), "adopt");

      // Terminal answers. `approval_review` refuses a non-pending row with a
      // receipt, and that receipt is the truthful rendering: it is
      // server-authored, names no recipient and no subject, and is strictly
      // better than "open the dashboard to see this".
      t.expect(
        "an expired send shows its receipt",
        kind(SEND, F.receiptExpired),
        "adopt",
      );
      t.expect(
        "so does one decided elsewhere",
        kind(SEND, F.receiptDecidedElsewhere),
        "adopt",
      );

      // Gone, in both directions, each mapped to its own quiet line.
      t.expect("a deleted draft is gone", kind(DRAFT, F.draftErrorNotFound), "gone");
      t.expect("and says which", subject(DRAFT, F.draftErrorNotFound), "draft");
      t.expect("a missing approval is gone", kind(SEND, F.approvalNotFound), "gone");
      t.expect("and says which", subject(SEND, F.approvalNotFound), "send");

      // Everything else fails closed, and a failure renders the one-liner —
      // never the stub, which has no content in it.
      t.expect("nothing back at all", kind(SEND, null), "failed");
      t.expect(
        "the wrong card kind",
        kind(SEND, F.draftEditorImap),
        "failed",
      );
      t.expect(
        "the right kind with no payload",
        kind(SEND, { schema_version: "review-card-v1", card: "outbound_review" }),
        "failed",
      );
      // A receipt on the DRAFT path is not a shape `draft_read` produces for
      // anything but the handful of refusals that mean this editor must stop
      // existing, so an unrecognised one is something nobody has seen and the
      // honest answer is the one-liner.
      t.expect(
        "a receipt where a draft was asked for",
        kind(DRAFT, F.receiptDecidedElsewhere),
        "failed",
      );
    }),
  );

  // ======================================================================
  // (E2) A re-request answer must be about the id that was ASKED FOR
  // ======================================================================
  //
  // Found by the round-2 verification pass, 2026-09-17. `acceptRehydration`
  // compared KIND AND PAYLOAD only, while its own comment claimed it was "held
  // to the same standard as a pushed result" — and the push path does correlate
  // ids. So an `approval_review` answer naming a different approval, or a
  // `draft_read` answer naming a different draft, was adopted, and the card drew
  // a live Reject bound to whichever id the ANSWER chose. Bounded by
  // `approval_decide` re-authorising, and a server bug either way: we asked
  // about one thing and were told about another.

  results.push(
    await scenario("a re-request answer about another id is refused", {}, async (t) => {
      const kind = (asked, env) => t.mod.acceptRehydration(asked, env).kind;

      t.expect(
        "another approval's review",
        kind(F.outboundGmail, F.outboundOtherApproval),
        "failed",
      );
      t.expect(
        "another draft's read",
        kind(F.draftEditorImap, F.draftEditorOtherId),
        "failed",
      );
      // And the same id still goes through, so this is a correlation and not a
      // new blanket refusal.
      t.expect(
        "our own approval still adopts",
        kind(F.outboundGmail, F.outboundGmail),
        "adopt",
      );
      t.expect(
        "our own draft still adopts",
        kind(F.draftEditorImap, F.draftEditorImap),
        "adopt",
      );
      // A terminal receipt that NAMES an approval is correlated too — the
      // server publishes `approval_id` on those since ws2/round3 (a3cd89a).
      t.expect(
        "a receipt for our send",
        kind(F.outboundGmail, {
          ...F.receiptDecidedElsewhere,
          approval_id: F.outboundGmail.outbound.approval_id,
        }),
        "adopt",
      );
      t.expect(
        "a receipt for a different send",
        kind(F.outboundGmail, {
          ...F.receiptDecidedElsewhere,
          approval_id: "00000000-0000-4000-8000-000000000000",
        }),
        "failed",
      );
      // An UNNAMED receipt is still adopted, and must be: the draft failures
      // publish no id at all, and ws2/round3 publishes `null` wherever nothing
      // was verified precisely so that a not-found cannot be used as an
      // existence oracle. Requiring an id here would refuse the answers this
      // branch exists for.
      t.expect(
        "a receipt that names nothing",
        kind(F.outboundGmail, F.receiptWithNoId),
        "adopt",
      );
      t.expect(
        "a null id reads as unnamed, not as a match",
        kind(F.outboundGmail, { ...F.receiptWithNoId, approval_id: null }),
        "adopt",
      );
      // The other half of ws2/round3's shape, on the path that matters most:
      // a not-found refusal carries `approval_id: null` precisely so that it
      // cannot be used as an existence oracle, and it still reads as `gone`.
      t.expect(
        "a not-found with a null id is still gone",
        kind(F.outboundGmail, { ...F.approvalNotFound, approval_id: null }),
        "gone",
      );
      // BOTH sides. `asked` became an envelope in round 3, and `null.card`
      // throws where the old card-kind STRING merely read `undefined`. The
      // shipped effect cannot hand in a null, but this is an exported boundary
      // and state-machine.mjs passes whatever `loadEnvelope` returned, which is
      // `null` on any miss - so the function has to stay total.
      let threw = null;
      try {
        t.expect("a re-request with no question is failed", kind(null, F.outboundGmail), "failed");
        t.expect("and so is one with neither side", kind(null, null), "failed");
        t.expect("undefined too", kind(undefined, F.draftEditorImap), "failed");
      } catch (e) {
        threw = String(e?.message ?? e);
      }
      t.expect("and it does not throw", threw, null);
    }),
  );

  results.push(
    await scenario("a null id on a PUSHED receipt is unnamed, not a match", {}, async (t) => {
      // `receiptSubject` reads the id with `typeof === "string"`, so the
      // server's deliberate `null` cannot correlate with anything — which keeps
      // an unverified receipt refused rather than letting it replace the card.
      t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
      await settle();
      t.host.deliver(
        toolResult({ ...F.receiptWithNoId, approval_id: null }, "Already decided."),
      );
      await settle();
      t.expect("the review survived", t.state().envelope?.card, "outbound_review");
      t.expect("and it was counted", t.state().uncorrelatedResults, 1);
    }),
  );

  // ======================================================================
  // (E3) The opt-out's receipt must take the editor away
  // ======================================================================
  //
  // Handed over by the gating workstream. `draft_read` refuses a switched-off
  // editor with `card: "receipt"` + `error_code: "draft_editor_hidden"`, which
  // matched neither arm of App.tsx's effect, so a deliberate opt-out was
  // answered with a generic "open the dashboard to see this" instead of the
  // server's own sentence. Narrowed to the codes that mean this editor must
  // stop rendering — NOT to every receipt, because `provider_error` is a
  // transient blip and is the same event as the thrown error the `.catch()` arm
  // tolerates.

  results.push(
    await scenario("the hide receipt replaces the editor, a blip does not", {}, async (t) => {
      const kind = (asked, env) => t.mod.acceptRehydration(asked, env).kind;
      const DRAFT = F.draftEditorImap;

      t.expect("the opt-out is adopted", kind(DRAFT, F.draftEditorHidden), "adopt");
      t.expect("so is a de-rolled workspace", kind(DRAFT, F.draftEditorDisabled), "adopt");
      // The adopted envelope is the SERVER's, so the receipt renderer prints
      // the true headline and the way back rather than a card-authored guess.
      t.expect(
        "with the server's own headline",
        t.mod.acceptRehydration(DRAFT, F.draftEditorHidden).envelope?.receipt?.headline,
        F.draftEditorHidden.receipt.headline,
      );
      t.expect(
        "a provider blip is NOT adopted",
        kind(DRAFT, F.draftProviderError),
        "failed",
      );
      // The allow-list is a list, not "anything but provider_error": a code
      // nobody has written yet must not silently take a draft away.
      t.expect(
        "nor is an unknown code",
        kind(DRAFT, {
          ...F.draftProviderError,
          receipt: { ...F.draftProviderError.receipt, error_code: "rate_limited" },
        }),
        "failed",
      );
      // The outbound path is unchanged by any of this.
      t.expect(
        "a queued send still takes its terminal receipt",
        kind(F.outboundGmail, F.receiptExpired),
        "adopt",
      );
    }),
  );

  // ======================================================================
  // (E4) A wire payload may not claim to be a local restore stub
  // ======================================================================
  //
  // `_stub` is a plain JSON key. An envelope arriving with it set makes App.tsx
  // treat a live server answer as a pointer: it renders `<Loading/>` and waits
  // for a re-request that is one-shot and has already run, so the cell spins
  // forever. Stripped at the single boundary every envelope crosses.

  results.push(
    await scenario("a server answer cannot claim to be a stub", {}, async (t) => {
      t.expect(
        "the marker is gone off a pushed result",
        t.mod.isRestoreStub(
          t.mod.envelopeFrom({ structuredContent: F.draftEditorClaimingStub }),
        ),
        false,
      );
      // ...and the envelope is otherwise untouched.
      t.expect(
        "and the card still renders",
        t.mod.envelopeFrom({ structuredContent: F.draftEditorClaimingStub })?.draft?.draft_id,
        "Drafts:2",
      );
      // The other channel too: a host that hands us the envelope as JSON text.
      t.expect(
        "the text channel is stripped as well",
        t.mod.isRestoreStub(
          t.mod.envelopeFrom({
            content: [{ type: "text", text: JSON.stringify(F.draftEditorClaimingStub) }],
          }),
        ),
        false,
      );
      // Through the real push path, which is where it would have wedged.
      t.host.deliver(toolResult(F.draftEditorClaimingStub, "Draft Drafts:2."));
      await settle();
      t.expect("the rendered envelope is live", t.mod.isRestoreStub(t.state().envelope), false);
      // A rehydration answer is the other way in, and takes the same boundary.
      t.expect(
        "and so is a re-request answer",
        t.mod.isRestoreStub(
          t.mod.acceptRehydration(
            F.draftEditorImap,
            t.mod.envelopeFrom({ structuredContent: F.draftEditorClaimingStub }),
          ).envelope,
        ),
        false,
      );
    }),
  );

  // ======================================================================
  // (E5) After a REHYDRATION, the push path correlates again
  // ======================================================================
  //
  // The hydration race. App.tsx's effect adopted with a bare `setState`, which
  // never set `pushAccepted` — so after a re-request had put a real draft back,
  // exactly ONE later pushed result still bypassed correlation and could rebind
  // the card to a foreign draft or approval. `adoptRehydration` is the whole
  // fix: a restore stays a memory (a late result must still beat it) and a
  // server answer about a known id is where the card stops being one.

  results.push(
    await scenario(
      "a foreign push after a rehydration is refused",
      { storage: true, hostContext: { toolInfo: { id: 9, tool: { name: "draft" } } } },
      async (t) => {
        const args = { action: "create" };
        t.mod.saveEnvelope(t.mod.cardKey({ tool: "draft", callId: 9 }, args), F.draftEditorImap, args);
        t.host.deliver(toolInput(args));
        await settle();
        t.expect("a stub is up", t.mod.isRestoreStub(t.state().envelope), true);

        // What App.tsx's effect does with a good answer.
        const decided = t.mod.acceptRehydration(t.state().envelope, F.draftEditorImap);
        t.expect("the answer is adopted", decided.kind, "adopt");
        t.mod.adoptRehydration(decided.envelope);
        t.expect("the real draft is up", t.state().envelope?.draft?.draft_id, "Drafts:2");

        // And now a push for a DIFFERENT draft is the ordinary uncorrelated
        // case rather than the arrival the recovery was waiting for.
        t.host.deliver(
          toolResult(
            { ...F.draftEditorImap, draft: { ...F.draftEditorImap.draft, draft_id: "Drafts:777" } },
            "Draft Drafts:777.",
          ),
        );
        await settle();
        t.expect("the hydrated draft survived", t.state().envelope?.draft?.draft_id, "Drafts:2");
        t.expect("and it was counted", t.state().uncorrelatedResults, 1);
      },
    ),
  );

  results.push(
    await scenario(
      "the outbound path closes the same way",
      { storage: true, hostContext: { toolInfo: { id: 11, tool: { name: "email_compose" } } } },
      async (t) => {
        const args = { to: ["dana@northwind.example"] };
        t.mod.saveEnvelope(
          t.mod.cardKey({ tool: "email_compose", callId: 11 }, args),
          F.outboundGmail,
          args,
        );
        t.host.deliver(toolInput(args));
        await settle();
        const decided = t.mod.acceptRehydration(t.state().envelope, F.outboundGmail);
        t.mod.adoptRehydration(decided.envelope);
        t.expect(
          "the review is up",
          t.state().envelope?.outbound?.approval_id,
          F.outboundGmail.outbound.approval_id,
        );

        t.host.deliver(toolResult(F.outboundOtherApproval, "Queued for approval."));
        await settle();
        t.expect(
          "it was not rebound to a foreign approval",
          t.state().envelope?.outbound?.approval_id,
          F.outboundGmail.outbound.approval_id,
        );
        t.expect("and it was counted", t.state().uncorrelatedResults, 1);
      },
    ),
  );

  // ======================================================================
  // (F) A receipt must correlate on what it is a receipt FOR
  // ======================================================================
  //
  // D4. `envelopeIdentity` used to reduce every receipt to `receipt:${card}` —
  // the constant `"receipt:receipt"` — which can never equal a draft, approval
  // or plan identity. So the correlation guard refused exactly the transition
  // mergeEnvelope's own comment calls out as one that must always win, and the
  // repro was `before=draft_editor after=draft_editor xcall=1`.
  //
  // Exempting receipts from correlation was the wrong fix: it trades "a receipt
  // for this card is wrongly refused" for "a foreign receipt replaces a draft
  // the user is typing in", which is worse and unrecoverable. A receipt now
  // correlates on the id it NAMES instead, and an unnamed one stays refused.

  results.push(
    await scenario("a receipt for THIS draft replaces it", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.expect("the editor is up", t.state().envelope?.draft?.draft_id, "Drafts:2");

      // §8's merge: `draft{action:"send"}` publishes today's flat payload with
      // the envelope keys laid on top, so `draft_id` sits at the top level.
      // That is the only correlating material a receipt carries, and this is
      // the send of the very draft on screen.
      t.host.deliver(
        toolResult({ ...F.draftSendReceiptMerged, draft_id: "Drafts:2" }, "Sent."),
      );
      await settle();
      t.expect("the send completed on screen", t.state().envelope?.card, "receipt");
      t.expect("with its outcome", t.state().envelope?.receipt?.outcome, "sent");
      t.expect("and nothing was refused", t.state().uncorrelatedResults, 0);
    }),
  );

  results.push(
    await scenario("a receipt for SOMEBODY ELSE'S draft does not", {}, async (t) => {
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.host.deliver(
        toolResult({ ...F.draftSendReceiptMerged, draft_id: "Drafts:999" }, "Sent."),
      );
      await settle();
      t.expect("the editor survived", t.state().envelope?.draft?.draft_id, "Drafts:2");
      t.expect("and it was counted", t.state().uncorrelatedResults, 1);
    }),
  );

  results.push(
    await scenario("a receipt that names nothing is still refused", {}, async (t) => {
      // THE SERVER GAP, pinned as a fact rather than as a wish: every approval
      // and bulk receipt is built by a `receiptEnvelope` helper that emits no
      // id at all, so nothing here can be shown to belong to this card and the
      // fail-safe direction is to keep the card the user is looking at.
      // Closing the gap is one key in each helper (`approval_id: row.id`,
      // `plan_id: row.id`); this scenario flips to "accepted" when it lands,
      // which is the point of pinning it.
      t.host.deliver(toolResult(F.draftEditorImap, "Draft Drafts:2."));
      await settle();
      t.host.deliver(toolResult(F.receiptWithNoId, "Already decided."));
      await settle();
      t.expect("the editor survived", t.state().envelope?.draft?.draft_id, "Drafts:2");
      t.expect("and it was counted", t.state().uncorrelatedResults, 1);
    }),
  );

  results.push(
    await scenario("a receipt for THIS queued send replaces it", {}, async (t) => {
      // The transition a pushed `decided_elsewhere` would take once the server
      // publishes `approval_id` on its receipts. Driven here with the key in
      // place, so the card side is proven ready and the only thing left is the
      // one server line.
      t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
      await settle();
      t.expect("the review is up", t.state().envelope?.card, "outbound_review");
      t.host.deliver(
        toolResult(
          {
            ...F.receiptWithNoId,
            approval_id: F.outboundGmail.outbound.approval_id,
          },
          "Already decided.",
        ),
      );
      await settle();
      t.expect("it flipped to the receipt", t.state().envelope?.card, "receipt");
      t.expect("nothing was refused", t.state().uncorrelatedResults, 0);
    }),
  );

  results.push(
    await scenario("a receipt for another queued send does not", {}, async (t) => {
      t.host.deliver(toolResult(F.outboundGmail, "Queued for approval."));
      await settle();
      t.host.deliver(
        toolResult(
          { ...F.receiptWithNoId, approval_id: "00000000-0000-4000-8000-000000000000" },
          "Already decided.",
        ),
      );
      await settle();
      t.expect("the review survived", t.state().envelope?.card, "outbound_review");
      t.expect("and it was counted", t.state().uncorrelatedResults, 1);
    }),
  );

  results.push(
    await scenario("a first pushed result over a restored stub is accepted", { storage: true, hostContext: { toolInfo: { id: 5, tool: { name: "draft" } } } }, async (t) => {
      // WRITTEN DOWN because it is otherwise only implicit in `pushAccepted`,
      // and because it looks like a hole: with a stub restored and nothing yet
      // accepted, a result for a COMPLETELY DIFFERENT subject wins. That is the
      // deliberate trade. A restore is a memory of a call, not its answer, and
      // the measured host delivers the real result seconds late — refusing a
      // first result for disagreeing with a memory would lock the card onto the
      // memory on exactly the hosts the recovery exists for. There is no
      // unsaved typing to lose at that point: a stub can never render as an
      // editor.
      const args = { action: "create" };
      t.mod.saveEnvelope(t.mod.cardKey({ tool: "draft", callId: 5 }, args), F.draftEditorImap, args);
      t.host.deliver(toolInput(args));
      await settle();
      t.expect("a stub is up", t.mod.isRestoreStub(t.state().envelope), true);
      const foreign = {
        ...F.draftEditorImap,
        draft: { ...F.draftEditorImap.draft, draft_id: "Drafts:777" },
      };
      t.host.deliver(toolResult(foreign, "Draft Drafts:777."));
      await settle();
      t.expect("the live result won", t.state().envelope?.draft?.draft_id, "Drafts:777");
      t.expect("and was not counted as foreign", t.state().uncorrelatedResults, 0);
    }),
  );

  // ======================================================================
  // (D) Diagnostics are internal-only, and default to off
  // ======================================================================

  results.push(
    await scenario("diagnostics are off unless something turns them on", {}, async (t) => {
      t.expect("no envelope: off", t.mod.diagnosticsEnabled(null), false);
      t.expect("an ordinary card: off", t.mod.diagnosticsEnabled(F.outboundGmail), false);
      t.expect("a customer draft: off", t.mod.diagnosticsEnabled(F.draftEditorImap), false);
      t.expect(
        "a bulk plan on an opted-in inbox: off",
        t.mod.diagnosticsEnabled(F.bulkDelete),
        false,
      );
      // The server-authored opt-in. Nothing else in the envelope may turn it on.
      t.expect(
        "the envelope flag: on",
        t.mod.diagnosticsEnabled({ ...F.outboundGmail, diagnostics: true }),
        true,
      );
      t.expect(
        "and only when it is literally true",
        t.mod.diagnosticsEnabled({ ...F.outboundGmail, diagnostics: "yes" }),
        false,
      );
    }),
  );

  results.push(
    await scenario("the local opt-in is explicit and survives nothing else", { storage: true }, async (t) => {
      t.expect("off to begin with", t.mod.diagnosticsEnabled(F.outboundGmail), false);
      t.storage.setItem("mcpemails.card.diag", "1");
      t.expect("on for this browser", t.mod.diagnosticsEnabled(F.outboundGmail), true);
      t.storage.setItem("mcpemails.card.diag", "0");
      t.expect("off again", t.mod.diagnosticsEnabled(F.outboundGmail), false);
    }),
  );

  let failed = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "}  ${r.name}`);
    for (const c of r.checks) {
      if (!c.ok) {
        console.log(
          `        ${c.label}: got ${JSON.stringify(c.actual)}, want ${JSON.stringify(c.wanted)}`,
        );
      }
    }
  }
  const total = results.reduce((n, r) => n + r.checks.length, 0);
  console.log(`\n${total - failed}/${total} hardening checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
