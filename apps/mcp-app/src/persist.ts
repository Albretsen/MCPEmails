// ---------------------------------------------------------------------------
// Remount recovery: a POINTER to the last card, in web storage. Never content.
//
// Why this exists: `ui/notifications/tool-result` is only promised "if the View
// is displayed during tool execution" (SEP-1865, 2026-01-26). A view that mounts
// AFTER the call finished is owed nothing, and the spec defines no replay. On
// Claude that is not exotic — leaving a conversation and coming back lazy-mounts
// every widget cell whose tool call finished minutes or days ago — and the card
// had no way to render anything but a loading state for them.
//
// The one thing the spec DOES promise a re-mounted view is
// `ui/notifications/tool-input` with the full arguments, plus (optionally)
// `hostContext.toolInfo`. Either is enough to recognise "this is the same call
// as last time", so the card remembers enough to ASK THE SERVER AGAIN for that
// call, and puts the answer back.
//
// ── What changed on 2026-09-16 (WS-1b), and why ──────────────────────────────
//
// This file used to store the whole envelope. For a `draft_editor` card that is
// the decrypted body text, the HTML part, the subject and the full bcc list —
// the three things contract.md §7 names as "kept out" — under a fixed key, with
// no TTL, twenty entries at a time. Three separate properties made that wrong:
//
//   1. localStorage is DURABLE. It outlives the conversation, the tab and the
//      session; nothing in the old code ever deleted an entry.
//   2. It is not scoped to a conversation or an account. The key was
//      `toolInfo.id` (`i42` — and JSON-RPC ids restart at 1 in every
//      conversation) or a 32-bit hash of the tool arguments, so two calls that
//      look alike in two different chats, or on two different accounts sharing
//      a browser profile, restored each other's envelope.
//   3. Whether the sandbox gives each MCP App its own ORIGIN is a host
//      implementation detail we cannot read from inside the frame (the empty
//      CSP constrains what WE may reach, not who may read our storage). If the
//      origin is shared, every other installed MCP App could read this blob.
//
// The fix is to make (3) not matter, which also disposes of (1) and (2): what
// is stored is a REDACTED STUB — the card kind, the state, the dashboard URL,
// and for a draft the two opaque identifiers (`inbox_id`, `draft_id`) needed to
// re-request it. A reader of this origin learns that somebody has a draft, not
// what is in it, and the identifiers are useless without the bearer token the
// server authorises every `draft_read` against. Content comes back over the
// wire, authenticated, or it does not come back at all.
//
// Storage is OPTIONAL, always. The sandbox MUST have `allow-scripts` and
// `allow-same-origin`, so web storage exists, but its persistence across
// remounts is host-defined and a host is free to hand out a fresh partition
// every time. Every access is wrapped; a card in a host that keeps nothing must
// behave exactly as it did before this file existed.
// ---------------------------------------------------------------------------

import type {
  CardKind,
  CardState,
  Envelope,
  Identity,
  Outbound,
  Receipt,
} from "./contract";
import { isEnvelope } from "./contract";
import { neutralizeDeep } from "./sanitize";
import { fnv1a } from "./hash";
import type { ToolInfoSummary } from "./store";

/** Bumped when the stored shape changes, so old entries are simply unreadable. */
const STORE_KEY = "mcpemails.card.v3";

/**
 * Keys earlier builds wrote.
 *
 * `v1` held decrypted bodies and bcc lists. Nothing reads it any more, and
 * "nothing reads it" is not the same as "it is gone": every browser that ever
 * rendered a draft card still has that blob. So the first read of every mount
 * deletes it. This is the only way the card can reach data it already leaked
 * into a durable sink.
 *
 * `v2` held the redacted stub, but with UNSALTED fingerprints and unsalted
 * argument-hash keys (see `salt`). Those are the offline-reproducible oracle
 * the salt exists to remove, so they are not merely left to expire — an
 * orphaned key is never read again and therefore never hits the TTL branch in
 * `loadEnvelope`, which would leave it sitting there until twenty writes pushed
 * it out. Listing it here deletes the whole blob on the next mount, which is
 * also why the shape bump is a rename rather than an in-place migration:
 * migrating the entries would mean keeping the very values being retired.
 */
const LEGACY_KEYS = ["mcpemails.card.v1", "mcpemails.card.v2"];

/**
 * How many calls are remembered. The card is mounted once per conversation
 * cell, so this is "how far back can you scroll and still see your draft", and
 * 20 covers a normal thread without turning the origin's storage into an index
 * of everything the user has drafted. Oldest-first eviction, by last write.
 */
const MAX_ENTRIES = 20;

/**
 * How long an entry stays readable, measured from its last write.
 *
 * A pointer is not content, so this is not what stops a leak — the redaction is.
 * It is a bound on how long ANY identifier of ours sits in a storage area we do
 * not control, and it answers the "no TTL" half of the audit. 24h keeps the
 * case this file exists for (leave the chat, come back, the draft still opens)
 * and drops everything older on the next read rather than on a schedule.
 */
export const STORE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The fingerprint written when the arguments were not known at write time.
 *
 * It is a VALUE, not an absent field, and that is the whole point: an entry
 * with no fingerprint at all was compared against nothing, so any later mount
 * that happened to land on the same key restored it — which is exactly the
 * cross-conversation case the fingerprint exists to stop. `hash()` never
 * produces this string (it is two base-36 numbers concatenated), so a read that
 * HAS arguments always mismatches and refuses; a read that has none skips the
 * comparison exactly as before, which is the first-mount case.
 */
const NO_ARGS = "-";

interface Entry {
  /** ms epoch of the last write. Eviction and TTL key. */
  t: number;
  /**
   * Hash of the call ARGUMENTS at write time, or `NO_ARGS` when they were not
   * known yet. Compared on read: it is what stops `i42` in this conversation
   * from restoring `i42` from another one. HASHED, not stored verbatim,
   * because the arguments of `draft{action:"create"}` contain the body the
   * agent composed — the fingerprint must not reintroduce exactly what the
   * redaction removes.
   */
  f?: string;
  /** The REDACTED envelope. See `redact`. */
  e: Envelope;
}

interface Store {
  /**
   * The last https dashboard URL any envelope carried. Kept OUTSIDE the
   * per-call entries because the one moment it is needed is the moment there is
   * no entry at all: a card that recognises nothing still has to offer a way
   * out, and the URL is server-authored deployment config the card must never
   * hardcode (see App.tsx#absoluteUrl).
   */
  d?: string;
  /** The per-browser hash salt. See `salt`. */
  s?: string;
  k: Record<string, Entry>;
}

function read(): Store {
  try {
    // Purge before anything else, so a mount that restores nothing still
    // cleans up after the build that leaked.
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { k: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { k: {} };
    const s = parsed as Store;
    return {
      d: typeof s.d === "string" ? s.d : undefined,
      s: SALT.test(String(s.s)) ? s.s : undefined,
      k: s.k ?? {},
    };
  } catch {
    // Disabled storage, a quota-less partition, corrupt JSON: all the same
    // answer, which is "there is nothing to restore".
    return { k: {} };
  }
}

/**
 * Drop every entry past its TTL, wherever the store is next written.
 *
 * `loadEnvelope` also expires an entry on the way out, and that is not enough:
 * it only ever looks at ONE key, so an entry nothing looks up again never
 * reaches that branch at all. Two ordinary things produce exactly that:
 *
 *   - the `a<hash>` branch (the one that runs on Claude) keys on the ARGUMENTS,
 *     so every distinct draft gets its own key and the previous one is never
 *     asked for again;
 *   - a salt change orphans every key at once. `salt()` mints a new one
 *     whenever the stored value is missing or fails `SALT`, and two first
 *     mounts racing in a fresh browser each mint one, so the loser's entries
 *     become unreachable — which is the same fact the `v2` purge relies on,
 *     stated from the other side.
 *
 * Unreachable is not gone. Without this, up to `MAX_ENTRIES` stubs sit in a
 * durable sink indefinitely — long past the 24 hours the TTL promises — and
 * only ever leave when twenty newer writes push them out. Each one carries a
 * write timestamp, an `inbox_id` and, on IMAP, a draft ordinal. Sweeping on
 * write costs one pass over at most twenty entries and makes the TTL mean what
 * `loadEnvelope`'s own docstring already says it means.
 */
function sweepExpired(store: Store): void {
  const now = Date.now();
  for (const [k, entry] of Object.entries(store.k)) {
    if (typeof entry?.t !== "number" || now - entry.t > STORE_TTL_MS) delete store.k[k];
  }
}

function write(store: Store): void {
  sweepExpired(store);
  // The salt is re-attached on EVERY write rather than by each caller, because
  // the callers read the store before `hash()` is first called and would
  // therefore write back an object that predates the salt's creation and
  // silently drop it — after which the next mount invents a different one and
  // every key and fingerprint it computes misses. One line here, and ordering
  // stops mattering.
  if (saltCache !== null) store.s = saltCache;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // A stub is small, so a quota error here is somebody else's data filling
    // the origin rather than ours. Drop everything but the newest entry and
    // try once more; if that still fails, storage is simply not available.
    try {
      const newest = Object.entries(store.k).sort((a, b) => b[1].t - a[1].t)[0];
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          d: store.d,
          s: store.s,
          k: newest ? { [newest[0]]: newest[1] } : {},
        }),
      );
    } catch {
      /* optional by design */
    }
  }
}

/**
 * The per-browser hash salt, created on first use and kept with the entries.
 *
 * ── WHY THE FINGERPRINT NEEDED SALTING ──────────────────────────────────────
 *
 * `hash()` is taken over `JSON.stringify(args)`, and for the call this card is
 * most often mounted for — `draft{action:"create"}` — the arguments ARE the
 * message the agent composed: subject, body, recipients. The digest is not
 * reversible, but ~64 bits of it is an excellent CONFIRMATION ORACLE: anybody
 * who can guess the exact arguments can recompute the value and check. FNV-1a
 * is public, seeded with published constants, so unsalted that check was
 * reproducible by anyone, offline, with no access to this browser — and one
 * precomputed table of candidate messages would have answered it for every
 * browser at once. The same is true of the KEY on its `a<hash>` branch, which
 * is the branch that actually runs in production (Claude omits `toolInfo`), so
 * the salt covers `hash()` itself rather than just the `f` field.
 *
 * ── WHAT SALTING DOES NOT FIX, STATED RATHER THAN IMPLIED ───────────────────
 *
 * The salt lives in the same storage area as the hashes. A reader who takes
 * this whole blob takes the salt with it and can resume testing candidate
 * messages against it. So this does NOT make the fingerprint opaque to the
 * attacker the redaction is aimed at; it removes the cheaper forms of the same
 * attack, which is worth the eight lines it costs:
 *
 *   - no precomputation. A table built against the published FNV constants is
 *     worthless; an attacker must first read THIS origin and then do the work
 *     per browser.
 *   - no cross-browser correlation. The same message drafted on two machines,
 *     or under two profiles, no longer produces the same fingerprint, so the
 *     value cannot be used as a join key between two stores.
 *   - nothing leaks to somebody who sees a fingerprint WITHOUT the blob — a
 *     log, a screenshot, a bug report, a synced storage backup read in part.
 *
 * What it costs is nothing the fingerprint is for: its only job is comparing
 * two values computed in the same browser, and the salt is stable there.
 *
 * Bounded and character-checked on the way back in, like every other value read
 * out of this sink: a salt is a cache input, but it is still a string that came
 * from storage we do not control, and an unbounded one would land in a key.
 */
const SALT = /^[a-z0-9]{8,32}$/;

let saltCache: string | null = null;

/**
 * 16 characters drawn 5 bits at a time from a 32-symbol alphabet: 80 bits, and
 * no modulo bias, since 32 divides 256 exactly. `crypto.getRandomValues` where
 * it exists (it does in every browser that has `localStorage`), `Math.random`
 * only so that a harness or a stripped-down runtime still gets a value — the
 * salt is a cache input, not a key, and a predictable one degrades to exactly
 * the unsalted behaviour rather than to something worse.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuv";

function newSalt(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } })
    .crypto;
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

function salt(): string {
  if (saltCache !== null) return saltCache;
  const store = read();
  if (typeof store.s === "string" && SALT.test(store.s)) {
    saltCache = store.s;
    return saltCache;
  }
  saltCache = newSalt();
  // Written immediately, not on the next save: a salt that is only in memory
  // would change on every mount and no entry would ever be readable again.
  write(store);
  return saltCache;
}

/**
 * Two independently seeded FNV passes, concatenated.
 *
 * 32 bits is about 65k values before a birthday collision, which is fine for a
 * cache and not fine for a thing whose job is to say "this entry belongs to a
 * DIFFERENT call". Two passes is cheap and puts collisions out of reach for the
 * twenty entries this store ever holds.
 *
 * SALTED, per browser. The material is the call arguments, which on the most
 * common call are the composed message, so an unsalted digest of them is an
 * offline confirmation oracle for a guessed message — and one that a
 * precomputed table answers for every browser at once. `salt()` says exactly
 * what that buys and what it does not.
 */
function hash(s: string): string {
  const k = `${salt()} ${s}`;
  return `${fnv1a(k)}${fnv1a(k, 0x01000193)}`;
}

/**
 * The fingerprint material: the ARGUMENTS ONLY.
 *
 * Deliberately not the tool name, which the key hash does include. The tool
 * name comes from `hostContext.toolInfo`, which is a host MAY and which Claude
 * omits: a fingerprint that depended on it would compare "absent" on the write
 * and "present" on the read (or the reverse) and turn every remount into a
 * miss. The arguments are a host MUST, re-sent to every view on `tool-input`,
 * so both sides always see the same thing or neither does.
 */
function argsSignature(args: Record<string, unknown> | null | undefined): string | null {
  if (!args) return null;
  try {
    return JSON.stringify(args);
  } catch {
    return null;
  }
}

/**
 * The exact string the key hash is taken over: the tool name, ONE SPACE, and
 * the JSON of the arguments.
 *
 * ── WHY THE SEPARATOR IS WRITTEN DOWN, AND EXPORTED ─────────────────────────
 *
 * It used to be a literal NUL. `a${fnv1a(`${tool}\0${JSON.stringify(args)}`)}`
 * is what shipped on `main` until the WS-1b storage rewrite, and a raw 0x00
 * byte sitting in a TypeScript source file is a hazard in its own right: it is
 * invisible in every editor and in most diffs, `grep` skips the file as binary
 * unless told not to (`git show | grep` reports "Binary file matches" and shows
 * you nothing), and a copy/paste or a formatter can drop it without a single
 * visible character changing. That is why it became a space. The change was
 * correct and it was also UNDOCUMENTED AND UNPINNED — the round-3 verification
 * pass had to reconstruct it from the bytes — so both halves are fixed here.
 *
 * What the separator has to do is keep `(tool, args)` pairs apart that would
 * otherwise concatenate to the same string. A space is enough for that on the
 * real inputs: `JSON.stringify` of an arguments OBJECT always starts with `{`,
 * which a tool name cannot contain (`toolInfoFrom` neutralises it and slices it
 * to 64, and every tool this server declares is `[a-z_]+`), so the split point
 * is unambiguous. It was probed for a reachable collision and none exists; this
 * is a cosmetic change to a cache key, not a security boundary — see the salt
 * comment on `hash` for the part that is.
 *
 * EXPORTED so that `storage-audit.mjs` can pin the separator directly instead
 * of asserting on a hash that hides it. The pin is what stops it drifting back
 * to a control byte: a NUL here would once again be invisible to everything
 * that reads this file.
 */
export function callSignature(
  info: ToolInfoSummary | null | undefined,
  args: Record<string, unknown> | null | undefined,
): string | null {
  if (!args) return null;
  try {
    return `${info?.tool ?? ""} ${JSON.stringify(args)}`;
  } catch {
    // Circular arguments cannot come off the wire, but JSON.stringify is the
    // only thing here that can throw and a cache key is never worth an error.
    return null;
  }
}

/**
 * The most stable identity available for "the call this card was mounted for".
 *
 * `toolInfo.id` first: it is the JSON-RPC id of the originating `tools/call`,
 * which the host reads back out of the stored conversation, so it is the same
 * value on every remount of the same cell. It is also a host MAY — phase-0
 * recorded the reference host omitting `toolInfo` entirely, and Claude does the
 * same today, so the argument-hash fallback is the branch that actually runs in
 * production.
 *
 * NEITHER branch is unique across conversations on its own: ids restart at 1
 * per conversation, and two identical calls hash identically by construction.
 * That is why the key is only half the lookup — `loadEnvelope` also compares
 * the stored fingerprint and the stored inbox. See there.
 */
export function cardKey(
  info: ToolInfoSummary | null,
  args: Record<string, unknown> | null,
): string | null {
  const id = info?.callId;
  if (typeof id === "string" || typeof id === "number") return `i${String(id)}`;
  const sig = callSignature(info, args);
  return sig === null ? null : `a${hash(sig)}`;
}

/**
 * Marker for "this envelope came out of storage and carries no content".
 *
 * Deliberately a field on the object rather than a parallel store flag: it
 * travels with the envelope through `setState`, through a re-save, and into
 * App.tsx, so there is no way to hold a stub and not know it. It is not part of
 * the wire contract and the server never sends it; `isRestoreStub` is the only
 * reader.
 */
const STUB = "_stub" as const;

export function isRestoreStub(env: Envelope | null | undefined): boolean {
  return !!env && (env as unknown as Record<string, unknown>)[STUB] === true;
}

/**
 * Take the marker OFF anything that came in over the wire.
 *
 * `_stub` is a plain JSON key, so "the server never sends it" is a statement
 * about our server and not about what can arrive. A payload carrying
 * `"_stub": true` is treated by App.tsx as a restored pointer: it renders
 * `<Loading/>` while the re-request runs, and the re-request has already run —
 * `refreshed.current` is true and the effect is one-shot — so the cell waits
 * forever on a spinner that nothing will ever clear. A hostile server is not
 * the interesting case (it can simply send an empty envelope); a server bug
 * that echoed a stored envelope back would be, and the answer to both is that
 * the marker is LOCAL and gets stripped at the boundary the same way every
 * string there is neutralised.
 *
 * Returns the same object when there is nothing to strip, so the common path
 * allocates nothing.
 */
export function stripStubMarker<T>(env: T): T {
  if (!env || typeof env !== "object") return env;
  if (!(STUB in (env as Record<string, unknown>))) return env;
  const out = { ...(env as Record<string, unknown>) };
  delete out[STUB];
  return out as unknown as T;
}

/**
 * Everything that may be written down, and nothing else.
 *
 * The rule is "could this line be read out loud to a stranger": a card kind and
 * a state could, a subject could not. What survives is either structural (card,
 * state, schema_version), a server-authored URL that is the same for every
 * customer (dashboard_url), or an opaque identifier that the server will
 * re-authorise before it returns anything (inbox_id, draft_id, approval_id).
 *
 * Note what is NOT here, in every card kind: `body`, `subject`, `recipients`,
 * `attachments`, `in_reply_to`, `plan.sample`, `plan.scope`, `receipt`,
 * `identity.email_address` and `identity.display_name`. The bulk sample rows
 * and the plan scope description are message content as much as a body is
 * ("unread from news@ received before 1 Jul"), and the mailbox address is the
 * user's own identity; none of them is needed to re-request anything.
 *
 * ── WHAT A SAME-ORIGIN READER LEARNS, STATED PLAINLY ────────────────────────
 *
 * "No content" is not "nothing". What is left is a CORRELATABLE ACTIVITY LOG,
 * and it is worth writing down as such rather than filed under "learns nothing
 * actionable". This list is the WHOLE stored blob, field by field, because an
 * earlier version of this paragraph named only the envelope fields and stopped
 * — and the two things it skipped, the entry key and the fingerprint, are the
 * most content-derived values in the file.
 *
 *   t   a write timestamp, to the millisecond.
 *   card, state
 *       what kind of card this was and how far it had got.
 *   dashboard_url
 *       server-authored deployment config, identical for every customer.
 *   identity.inbox_id + identity.provider
 *       for a draft: a workspace-scoped UUID, the SAME one across every draft
 *       in that mailbox, so entries join on it, plus which provider it is.
 *   outbound.approval_id
 *       for a queued send: a UUID, with no mailbox attached.
 *   draft.draft_id
 *       provider-defined, and on IMAP it is `Drafts:<n>` — an ORDINAL. A reader
 *       who sees `Drafts:41` learns roughly how many drafts that mailbox holds,
 *       and two entries say which came first. Bounded and character-checked, so
 *       it cannot carry a sentence, but it is not contentless.
 *   receipt.outcome + receipt.headline
 *       an enum, and one of the nine sentences `neutralHeadline` writes. The
 *       server's own headline names people and is never stored.
 *   the entry KEY
 *       `i<host JSON-RPC id>` where the host sends `toolInfo`, and otherwise
 *       `a<hash>` over the tool name and the arguments — which is the branch
 *       that runs on Claude today, and is therefore a digest of the composed
 *       message on a `draft{action:"create"}` call.
 *   f   the argument fingerprint: `hash()` over `JSON.stringify(args)`, ~64
 *       bits. On that same call the arguments ARE the subject, body and
 *       recipients, so this is a CONFIRMATION ORACLE for a guessed exact
 *       message rather than an opaque tag. It is salted per browser so that it
 *       is not answerable offline or across browsers; `salt()` sets out both
 *       what that removes and what it leaves in place, which is a reader who
 *       has already taken this blob.
 *   s   that salt. Random, and about nothing.
 *
 * Over the store's bounds — 20 entries, 24 hours — the total is: how many
 * drafts this person composed and when, how many were against the same mailbox,
 * which provider it is, roughly how many drafts that mailbox holds, the mix of
 * sends, bulk plans and completed receipts, and a per-browser check value for
 * any message an attacker can guess verbatim.
 *
 * That is metadata plus one salted digest, not content: no address, no subject,
 * no body, no counterpart — and `inbox_id` is opaque outside our own database.
 * It is an accepted trade, because the alternative is a card that cannot
 * recover a remounted draft at all, and because every id here is inert without
 * the bearer token the server re-authorises on each `draft_read` /
 * `approval_review` (gateDraftTool resolves the inbox against the CALLER's key,
 * then the workspace). It is documented here so that the next person to add a
 * field to the stub weighs it against this paragraph rather than against "the
 * stub is empty" — and so that the next person to add a field to the ENTRY,
 * which is not the envelope and was the gap here, adds a line to this list.
 */
/**
 * A receipt headline the CARD wrote, from the outcome alone.
 *
 * The server's own headline is the better sentence and cannot be stored: it
 * names people ("Sent to dana@northwind.example"). A receipt is terminal, so
 * there is nothing to re-request and a remounted receipt would otherwise fall
 * all the way back to "nothing to show here" — which is a worse answer than
 * "Sent." for the single most common card to scroll back to.
 */
function neutralHeadline(outcome: Receipt["outcome"]): string {
  switch (outcome) {
    case "sent":
      return "Sent.";
    case "scheduled":
      return "Scheduled.";
    case "discarded":
      return "Draft discarded.";
    case "rejected":
      return "Rejected. Nothing was sent.";
    case "expired":
      return "This request expired.";
    case "decided_elsewhere":
      return "Already decided elsewhere.";
    case "executed":
      return "Done.";
    case "cancelled":
      return "Cancelled. Nothing was changed.";
    default:
      return "That did not go through.";
  }
}

/**
 * The four fields the stub keeps are structural, and "structural" has to mean
 * CHECKED rather than assumed.
 *
 * `isEnvelope` is deliberately loose — `typeof card === "string"` and nothing
 * else — so the type annotations on `Envelope` are a description of what the
 * server sends today, not a guarantee about what arrives. Copying `card`,
 * `state`, `schema_version` and `receipt.outcome` through on that basis puts an
 * arbitrary server-authored string into a durable, possibly shared-origin sink,
 * which is the exact class of defect this file was rewritten to close. An
 * unrecognised value is dropped, never stored and never truncated into
 * something that looks valid.
 */
const CARD_KINDS: readonly string[] = [
  "outbound_review",
  "bulk_plan",
  "receipt",
  "draft_editor",
  // Kept as a bare kind and state, like bulk_plan: nothing to re-request, so a
  // remount shows the one line with the dashboard link.
  "subscription_plan",
];
const CARD_STATES: readonly string[] = [
  "pending",
  "editing",
  "sent",
  "scheduled",
  "rejected",
  "expired",
  "decided_elsewhere",
  "executed",
  "error",
];
const OUTCOMES: readonly string[] = [
  "sent",
  "scheduled",
  "discarded",
  "rejected",
  "expired",
  "decided_elsewhere",
  "executed",
  "failed",
  "cancelled",
];
const PROVIDERS: readonly string[] = ["gmail", "outlook", "imap"];

/**
 * A provider-defined draft id: `Drafts:2` on IMAP, a Graph or Gmail id
 * elsewhere. It is genuinely opaque, so it cannot be enumerated — but it can be
 * bounded and held to the character set an identifier has, which is enough to
 * keep a sentence out of it.
 */
const DRAFT_ID = /^[\w.:@+/=-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const oneOf = (v: unknown, set: readonly string[]): boolean =>
  typeof v === "string" && set.includes(v);

/**
 * A UUID, and a STRING that is one.
 *
 * `UUID.test(String(v))` was the shape both id guards used, and it is not the
 * same test: `String()` coerces first, so a single-element array
 * `["8f2a…"]` — which is ordinary, well-formed JSON and therefore something a
 * server or a proxy can actually put on the wire — stringifies to exactly the
 * uuid, passes, and is then written to storage AS AN ARRAY, because what is
 * stored is the original value and not the string that was tested. From there
 * it goes back out as the `approval_id` / `inbox_id` argument of the
 * re-request, where the server's `format: "uuid"` check refuses it and the card
 * tells the user their pending send "is no longer pending" about a send that
 * is. The same coercion admits any object with a `toString`, which is the
 * general form of the hole even though JSON cannot express one.
 *
 * So: type first, then pattern, exactly as the `draft_id` guard below already
 * did. Found by the round-2 verification pass, 2026-09-17.
 */
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

function redact(env: Envelope): Envelope | null {
  // An unrecognised card kind has nothing to re-request and nothing to render.
  if (!oneOf(env.card, CARD_KINDS)) return null;

  // A version string, not a sentence. Kept verbatim rather than forced to
  // SCHEMA_VERSION so that a restored card from a NEWER server still renders
  // the "update the connector" notice, which is the whole point of the field.
  if (!/^[\w.-]{1,40}$/.test(String(env.schema_version))) return null;

  const stub: Envelope & Record<string, unknown> = {
    schema_version: env.schema_version,
    card: env.card as CardKind,
    state: (oneOf(env.state, CARD_STATES) ? env.state : "pending") as CardState,
    [STUB]: true,
  };
  // https only, the same rule `absoluteUrl` applies before handing this to
  // `ui/open-link`. A value that could never be navigated to is not a URL, it
  // is just a string the server chose, and it does not belong in storage.
  if (typeof env.dashboard_url === "string" && /^https:\/\//i.test(env.dashboard_url)) {
    stub.dashboard_url = env.dashboard_url;
  }

  // ── The queued send's one identifier ──────────────────────────────────────
  //
  // Symmetric with the draft below, and for the same reason: `approval_review`
  // exists, is read-only, takes nothing but this id, and is already annotated
  // for this card. Without the id a remounted pending send loses its Reject
  // button, which was a real in-card `approval_decide` call and the only
  // decision this channel is ever allowed to make (approving requires a
  // signed-in browser session, by design). Remounts are the ordinary case, not
  // an edge: every return to a conversation lazy-mounts every widget cell.
  //
  // The cost, weighed: one more server identifier in a sink whose per-app
  // isolation we cannot verify from inside the frame. It is the SAME trade
  // already accepted for `inbox_id` + `draft_id`, and strictly the weaker half
  // of it — a UUID with no mailbox attached, which unlocks nothing without a
  // bearer token the server re-authorises on every call (workspace-scoped
  // query, then the key's `inbox_ids` allowlist, then `status = pending`; a
  // foreign reader has no key of ours and cannot call our tools at all). What
  // it adds to the residue is "this browser had a queued send at time T", which
  // is named in the disclosure paragraph above rather than waved past.
  //
  // UUID-checked, not merely bounded, because the server's own
  // `APPROVAL_ID_PROPERTY` is `format: "uuid"` and `loadPendingApproval`
  // refuses anything else before it touches the database. A value that could
  // never be a valid argument is not an identifier, it is a server-authored
  // string, and those do not go in here.
  const o = env.outbound;
  if (env.card === "outbound_review" && isUuid(o?.approval_id)) {
    stub.outbound = { approval_id: o.approval_id } as unknown as Outbound;
  }

  const d = env.draft;
  if (env.card === "draft_editor" && typeof d?.draft_id === "string" && DRAFT_ID.test(d.draft_id)) {
    stub.draft = {
      draft_id: d.draft_id,
      ...(typeof d.id_is_stable === "boolean" ? { id_is_stable: d.id_is_stable } : {}),
      // Only the two fields `draft_read` is called with. The cast is the honest
      // shape of a stub: `Identity` requires an address the stub deliberately
      // does not keep, and nothing renders a stub as an editor (App.tsx
      // re-requests it first, and shows one line if that fails).
      identity: {
        inbox_id: isUuid(d.identity?.inbox_id) ? d.identity.inbox_id : undefined,
        provider: oneOf(d.identity?.provider, PROVIDERS) ? d.identity?.provider : undefined,
      } as unknown as Identity,
    };
  }

  const r = env.receipt;
  if (r && oneOf(r.outcome, OUTCOMES)) {
    stub.receipt = { outcome: r.outcome, headline: neutralHeadline(r.outcome) };
  }
  return stub;
}

/**
 * Remember how to get this card back. Never throws, never stores content.
 *
 * `args` are the arguments `cardKey` was called with; they are fingerprinted
 * (hashed) so that a key collision across conversations reads as a miss rather
 * than as somebody else's card.
 */
export function saveEnvelope(
  key: string,
  envelope: Envelope,
  args?: Record<string, unknown> | null,
): void {
  const store = read();
  const sig = argsSignature(args);
  const stub = redact(envelope);
  // An envelope whose card kind we do not recognise has nothing to restore, so
  // it is not worth an entry — and writing one would mean writing an
  // unvalidated server string into a durable sink for no benefit at all.
  if (!stub) return;
  store.k[key] = {
    t: Date.now(),
    f: sig === null ? NO_ARGS : hash(sig),
    e: stub,
  };
  const keys = Object.keys(store.k);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys
      .sort((a, b) => store.k[a].t - store.k[b].t)
      .slice(0, keys.length - MAX_ENTRIES)) {
      delete store.k[k];
    }
  }
  const url = envelope.dashboard_url;
  if (typeof url === "string" && /^https:\/\//i.test(url)) store.d = url;
  write(store);
}

/** Forget one call outright. Used when a card reaches a terminal state. */
export function forgetEnvelope(key: string): void {
  const store = read();
  if (!store.k[key]) return;
  delete store.k[key];
  write(store);
}

/**
 * The stub last stored for this call, if this host kept it AND it is ours.
 *
 * Three ways this returns null on a key that exists, all of them deliberate:
 *
 *  - EXPIRED. Older than `STORE_TTL_MS`. Also deleted on the way out, so a
 *    stale pointer does not linger just because nothing happened to read it.
 *  - A DIFFERENT CALL. The stored fingerprint and this mount's disagree. This
 *    is the cross-conversation case: `i42` is a perfectly ordinary key in every
 *    conversation the host sends `toolInfo` for. Only compared when both sides
 *    have one — a stub written before `tool-input` arrived has no fingerprint,
 *    and refusing those would break the first mount of every card.
 *  - A DIFFERENT MAILBOX. The arguments name an inbox and the stub belongs to
 *    another one. Cheap, and the only account-crossing guard available from
 *    inside the frame: nothing in the protocol tells a card which workspace or
 *    which conversation it is in.
 */
export function loadEnvelope(
  key: string,
  args?: Record<string, unknown> | null,
): Envelope | null {
  const store = read();
  const entry = store.k[key];
  if (!entry || !isEnvelope(entry.e)) return null;

  if (!(typeof entry.t === "number") || Date.now() - entry.t > STORE_TTL_MS) {
    delete store.k[key];
    write(store);
    return null;
  }

  const sig = argsSignature(args);
  if (entry.f && sig !== null && entry.f !== hash(sig)) return null;

  const wantInbox = args?.inbox_id;
  const hasInbox = entry.e.draft?.identity?.inbox_id;
  if (
    typeof wantInbox === "string" &&
    typeof hasInbox === "string" &&
    wantInbox !== hasInbox
  ) {
    return null;
  }

  // Re-neutralised on the way out. It was neutralised on the way in, but this
  // crossed a storage boundary in between and the boundary is where that check
  // belongs (sanitize.ts#neutralizeText).
  return neutralizeDeep(entry.e);
}

/** Last known dashboard URL, for the case where nothing at all was recognised. */
export function lastDashboardUrl(): string | null {
  const url = read().d;
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
}
