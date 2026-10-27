// ---------------------------------------------------------------------------
// Tiny observable store.
//
// Exists because of phase-0 Q7.12: `ui/notifications/tool-input` and
// `-result` are one-shot events that can land before the UI has mounted, so
// the handlers must be registered BEFORE the handshake. main.tsx wires the
// bridge into this store immediately; the Preact tree subscribes whenever it
// gets around to mounting and reads whatever already arrived.
// ---------------------------------------------------------------------------

import type {
  HostBridge,
  HostContext,
  ToolCancelledParams,
  ToolResultParams,
} from "./bridge";
import { DRAFT_BODY_META_KEY, isEnvelope, type Envelope } from "./contract";
import {
  cardKey,
  isRestoreStub,
  loadEnvelope,
  saveEnvelope,
  stripStubMarker,
} from "./persist";
import { neutralizeDeep, neutralizeText } from "./sanitize";
import { type AutomationSeed, automationSeed, plainResultNote, plainResultReceipt } from "./plain-result";
import { announceDraft } from "./draft-signal";
import { draftShownContextLine } from "./model-context";

/**
 * What the last tool result was, which is NOT the same question as "did it
 * parse".
 *
 * `_meta.ui` is per-TOOL, not per-call: a host renders this card for every
 * result of a UI-bearing tool, including results that were never meant for it.
 * Two of those happen in production today — an API key spanning one opted-in
 * and one opted-out inbox gets the card metadata on `email_delete`, and
 * `email_organize`'s non-plannable actions (`copy_batch`, `flag`, `archive`)
 * never produce a plan. Both return today's ordinary payload, which is not an
 * envelope and is not supposed to be.
 *
 * So the card distinguishes two failures that used to be one:
 *
 *   foreign   — not our payload. The tool succeeded, the host is showing its
 *               text result, and the card has nothing to add. Render NOTHING.
 *               A scary "this review could not be displayed" warning under a
 *               perfectly successful delete is worse than no card at all.
 *   malformed — our payload (it carries `schema_version`), but unreadable.
 *               That is a real defect on our side and stays loud.
 *
 * Two more states exist for the case where there is no tool result at all,
 * which used to be indistinguishable from "the result has not landed yet" and
 * therefore pinned the card on its loading skeleton forever:
 *
 *   cancelled — the host sent `ui/notifications/tool-cancelled`. The call was
 *               abandoned (user action, sampling error, classifier
 *               intervention) and there will never be a result. Render
 *               NOTHING: the host displays its own cancellation message, and a
 *               second one from us would just be noise.
 *   absent    — the watchdog fired: connect() resolved and no result or
 *               cancellation followed. Overwhelmingly this is the remount case
 *               (see `armResultWatchdog`). Render NOTHING, for exactly the
 *               reason `foreign` renders nothing.
 *
 * `cancelled` and `absent` render identically today, and they are still two
 * values rather than one, because they are two different facts about the world:
 * one is a call that was stopped, the other is a card that was never told
 * anything. Collapsing them would throw that away at the only layer that still
 * knows the difference. Neither is `foreign` either, for the same reason.
 */
export type ResultStatus =
  | "waiting"
  | "envelope"
  | "foreign"
  | "malformed"
  | "cancelled"
  | "absent";

/**
 * The `tools/call` that instantiated this app, flattened out of
 * `hostContext.toolInfo` for diagnostics.
 *
 * Both halves are useful the next time a card renders empty: `tool` says which
 * of our tools was supposed to produce an envelope (and so whether an absent
 * result is even surprising), and `callId` is the JSON-RPC id that correlates
 * the frame with a row in the server's activity log.
 */
export interface ToolInfoSummary {
  tool: string | null;
  callId: string | number | null;
}

/**
 * Whether a tool result arrived, and whether it beat the watchdog.
 *
 * Distinct from `ResultStatus` because it answers a question about the HOST
 * rather than about the payload: "none" on a card that restored itself from
 * storage is the remount case working as designed, and "late" says the host
 * does deliver to a re-mounted view, only slower than the watchdog allows. We
 * cannot read Claude's logs, so the diagnostics line is how that gets measured.
 */
export type ResultArrival = "none" | "ontime" | "late";

/**
 * Whether the draft on screen is known to be the draft the server has.
 *
 *   trusted    — it came from the server just now: a first mount's own result,
 *                or the answer to a call this card made.
 *   pending    — it is a REPLAY (see `isReplayedDraft`) and nothing has checked
 *                it yet. App.tsx reads this and starts the re-read.
 *   checking   — that re-read is in flight.
 *   unverified — the re-read did not settle it, or a write the card started
 *                ended without an answer, so what the server holds is unknown.
 *
 * Save and Send are offered in `trusted` only. That is the whole point of the
 * field: a re-mounted card is handed the ORIGINAL tool result, and sending from
 * it sends whatever the draft said before every edit since.
 */
export type DraftCheck = "trusted" | "pending" | "checking" | "unverified";

export interface CardStore {
  envelope: Envelope | null;
  /** See `DraftCheck`. Meaningful only while a draft editor is on screen. */
  draftCheck: DraftCheck;
  /**
   * A draft id NEWER than the one in a replayed envelope: the id this card last
   * held, read back out of its restore stub at the moment the replay replaced
   * it. On a server without draft lineage it is the only id that still
   * resolves, so the re-read asks with it first. Null once a read has settled.
   */
  draftIdHint: string | null;
  /**
   * A read found a newer version of this draft that the assistant wrote after
   * this card last saw it, so a newer card for it exists. See `supersededBy`.
   * Cleared by this card's own save, which makes it the newest writer again.
   */
  draftSuperseded: boolean;
  /**
   * Where the card that is current for this draft sits, and why, while
   * `draftSuperseded` is true; the folded line says it (DraftEditor#Superseded).
   * `newer`: the assistant wrote a newer version, whose card is below.
   * `taken`: another card took the draft over (a Save or "Open here" there,
   * draft-signal.ts#claimDraft), above or below this one, or `other` when the
   * order is not known. Meaningless while `draftSuperseded` is false.
   */
  supersededAt: SupersededAt;
  /**
   * The draft revision of the result this card was MOUNTED for, or null. A
   * later tool call has a higher revision, so comparing two cards' values says
   * which is further down the chat (draft-signal.ts, "A CLAIM").
   */
  mountedRevision: number | null;
  /**
   * The terminal receipt this card had ended on (restored from storage) when a
   * replayed draft result replaced it. Held until the replay is checked: a
   * draft that was sent, discarded or hidden here does not come back as an
   * editor unless the server says it is still a draft. Null otherwise.
   */
  priorReceipt: Envelope | null;
  /** Classification of the most recent tool result. See `ResultStatus`. */
  resultStatus: ResultStatus;
  /**
   * For a `foreign` FIRST result: what the card can say about it in one line
   * (plain-result.ts#plainResultNote), or null for the generic line.
   */
  resultNote: string | null;
  /** For a `foreign` FIRST result: an automation the card can show. */
  automation: AutomationSeed | null;
  hostContext: HostContext;
  connected: boolean;
  connectError: string | null;
  /** Diagnostics only, never rendered. Absent on hosts that omit it (Q6). */
  toolInfo: ToolInfoSummary | null;
  /**
   * The arguments of the originating `tools/call`, from
   * `ui/notifications/tool-input`. NEVER rendered: they are agent-authored and
   * carry no field the envelope lacks. Kept only as cache-key material for a
   * host that omits `toolInfo` (persist.ts#cardKey).
   */
  toolInput: Record<string, unknown> | null;
  /** Did the host deliver a result at all, and was it late? */
  resultArrival: ResultArrival;
  /**
   * Milliseconds from the handshake resolving to the tool result landing, or
   * null when none has. Diagnostics only, and internal-only: it is how
   * RESULT_WATCHDOG_MS gets set from the real host's timing instead of the
   * reference host's. Goes when the diagnostics line goes.
   */
  resultAfterMs: number | null;
  /**
   * Bumped once per `ui/initialize` attempt, purely to wake subscribers so the
   * diagnostics line re-reads the bridge's live counters. Rendered by nothing.
   * Goes when the diagnostics line goes.
   */
  handshakeTick: number;
  /**
   * `null` until a restore has been attempted, then what it found. The card
   * must not draw its "nothing to show" placeholder while this is still null,
   * because that is the state in which the answer is genuinely not known yet.
   */
  restored: "storage" | "none" | null;
  /**
   * How many pushed tool results were refused because they did not belong to
   * the call this card is showing. Diagnostics only, and expected to be 0 on
   * every host forever: it is the counter that would say otherwise.
   */
  uncorrelatedResults: number;
  /**
   * `true` when the result this card was MOUNTED for is the model's own
   * `draft_read` (a pushed draft envelope with `origin: "read"`), false for any
   * other first result, null before one arrived.
   *
   * Only a push can say this: the card's own `draft_read` calls (restore,
   * Refresh, the deferred-body fallback, the attention check) come back as
   * answers to its requests, never as the pushed result. A model that reads a
   * draft back used to get a second full editor under the first, so one draft
   * piled up as three cards in a thread (QA 2026-10-15); App.tsx draws this
   * one as a single line instead, with a way to open the editor.
   */
  mountedForRead: boolean | null;
}

/** See `CardStore#supersededAt`. */
export interface SupersededAt {
  why: "newer" | "taken";
  where: "above" | "below" | "other";
}

let state: CardStore = {
  envelope: null,
  draftCheck: "trusted",
  draftIdHint: null,
  draftSuperseded: false,
  supersededAt: { why: "newer", where: "below" },
  mountedRevision: null,
  priorReceipt: null,
  resultStatus: "waiting",
  resultNote: null,
  automation: null,
  hostContext: {},
  connected: false,
  connectError: null,
  toolInfo: null,
  toolInput: null,
  resultArrival: "none",
  resultAfterMs: null,
  handshakeTick: 0,
  restored: null,
  uncorrelatedResults: 0,
  mountedForRead: null,
};

const listeners = new Set<() => void>();

export function getState(): CardStore {
  return state;
}

export function setState(patch: Partial<CardStore>) {
  state = { ...state, ...patch };
  // Every state change that carries an envelope updates the cache, not just the
  // mounting result: the envelope the user is looking at after a save, a send
  // or a local cancel is the one they should see again on remount, and it is
  // the only one the server will not hand back (an IMAP save retires the id).
  if (patch.envelope) persist(state);
  for (const l of listeners) l();
}

function persist(s: CardStore) {
  if (!s.envelope) return;
  const key = cardKey(s.toolInfo, s.toolInput);
  // The arguments go with it: persist.ts fingerprints them into the entry so
  // that the same key in a DIFFERENT conversation reads as a miss rather than
  // as this card. It stores a HASH of them, never the arguments themselves —
  // a `draft{action:"create"}` call carries the body the agent composed.
  if (key) saveEnvelope(key, s.envelope, s.toolInput);
}

/**
 * Put back the envelope this call last rendered, if this host kept it.
 *
 * Idempotent and one-shot: `restored` going non-null is what stops it running
 * again, and an envelope that has already arrived wins outright — restoring
 * over a live result would replace the truth with a memory of it.
 *
 * `quiet` is for the tool-input trigger, which fires while a result may still
 * be milliseconds away: it restores a hit but does not record a miss, so a
 * perfectly normal first mount is not pushed into its "nothing found" rendering
 * one tick before the result lands. The watchdog calls it without `quiet` and
 * that is what finally settles the question.
 */
export function attemptRestore(quiet = false): void {
  if (state.envelope || state.restored !== null) return;
  const key = cardKey(state.toolInfo, state.toolInput);
  const found = key ? loadEnvelope(key, state.toolInput) : null;
  if (found) setState({ envelope: found, restored: "storage" });
  else if (!quiet) setState({ restored: "none" });
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Unsaved work at teardown
//
// `ui/resource-teardown` is handled in main.tsx, outside the Preact tree, but
// the only thing that knows whether there is unsaved work is a component. This
// is the one-slot handoff between them: the draft editor registers a saver
// while it is dirty and clears it as soon as it is not, so main.tsx can await
// "whatever still needs writing" without knowing what a draft is.
//
// Deliberately one slot, not a set: one card is mounted per frame.
// ---------------------------------------------------------------------------

let teardownSaver: (() => Promise<unknown>) | null = null;

/** Register (or clear, with `null`) the work to finish before teardown. */
export function setTeardownSaver(fn: (() => Promise<unknown>) | null) {
  teardownSaver = fn;
}

/**
 * Run the registered saver, if any. Never throws: the teardown reply is owed
 * to the host whether or not the save worked. The bridge caps how long this is
 * allowed to take (`TEARDOWN_TIMEOUT_MS`).
 */
export async function runTeardownSaver(): Promise<void> {
  const fn = teardownSaver;
  if (!fn) return;
  // Cleared first: teardown happens once, and a retry on a frame that is going
  // away would only be a second write nobody can see the result of.
  teardownSaver = null;
  try {
    await fn();
  } catch {
    /* nothing left to tell the user: the card is being torn down */
  }
}

// ---------------------------------------------------------------------------
// A send still inside its undo window at teardown
//
// DraftEditor holds Send for a few seconds with Undo in its place
// (`SEND_UNDO_MS`). A frame torn down inside that window CANCELS the send, it
// never hurries it: a send nobody is left to see, from a card that is going
// away, is exactly the accident the window exists to prevent. The unmount
// clears the timer too; this slot is for the host's `ui/resource-teardown`,
// which can arrive before anything unmounts. One slot, like the saver above.
// ---------------------------------------------------------------------------

let pendingSendCancel: (() => void) | null = null;

/** Register (or clear, with `null`) how to cancel a send that is counting down. */
export function setPendingSendCancel(fn: (() => void) | null) {
  pendingSendCancel = fn;
}

/** Cancel a send that is counting down, if there is one. Never throws. */
export function cancelPendingSend(): void {
  const fn = pendingSendCancel;
  pendingSendCancel = null;
  try {
    fn?.();
  } catch {
    /* the card is going away either way */
  }
}

/**
 * Does this payload claim to be ours?
 *
 * The key presence of `schema_version` is the discriminator, deliberately
 * looser than `isEnvelope`. No other tool result in this server carries that
 * key, so:
 *   - absent  -> somebody else's payload; the card must stay quiet.
 *   - present but unreadable -> ours and broken; the card must complain.
 * The type of the value is not checked, because `{ schema_version: 2 }` is
 * still unmistakably an attempt at our envelope.
 */
function claimsToBeOurs(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "schema_version" in (value as Record<string, unknown>)
  );
}

export interface ClassifiedResult {
  envelope: Envelope | null;
  status: ResultStatus;
}

/**
 * Pull the contract envelope out of a tool result, and say what happened when
 * there isn't one.
 *
 * `structuredContent` is the card channel (contract §7). The `content` array is
 * the model-visible prose fallback; we parse it only if a host delivers
 * structured content in some other shape, so that a degraded host still renders
 * something rather than an empty card.
 */
export function classifyResult(result: ToolResultParams | undefined): ClassifiedResult {
  if (!result) return { envelope: null, status: "waiting" };

  const sc = result.structuredContent;
  // Every string in the payload is neutralised once, here, at the boundary:
  // bidi overrides and zero-width characters in a subject, display name or
  // attachment filename can make the card display something other than what
  // will be sent. See sanitize.ts#neutralizeText.
  //
  // `stripStubMarker` is the same idea for a key rather than a character:
  // `_stub` means "this is a local pointer, re-request it", and a wire payload
  // that carried it would wedge the cell on a spinner the one-shot re-request
  // can no longer clear. Applied to BOTH channels and on the single path every
  // envelope takes — the pushed notification and the card's own tool calls both
  // land here — so there is no second place to forget it.
  //
  // `admit` is those two steps plus the third thing that belongs at this
  // boundary for the same reason: a deferred draft body is filled in from the
  // result's own `_meta` here, so that on a host which delivers it nothing
  // downstream ever sees the placeholder.
  if (isEnvelope(sc)) {
    return { envelope: admit(sc as Envelope, result), status: "envelope" };
  }
  if (claimsToBeOurs(sc)) return { envelope: null, status: "malformed" };

  const text = result.content?.find((c) => c?.type === "text")?.text;
  if (typeof text === "string" && text.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEnvelope(parsed)) {
        return { envelope: admit(parsed, result), status: "envelope" };
      }
      if (claimsToBeOurs(parsed)) return { envelope: null, status: "malformed" };
    } catch {
      /* prose, not JSON — expected */
    }
  }

  // Not our payload. The tool did whatever it does, the host is showing its
  // own text result, and this card has nothing to say about it.
  return { envelope: null, status: "foreign" };
}

/** Everything an envelope goes through on its way in. See `classifyResult`. */
function admit(env: Envelope, result: ToolResultParams): Envelope {
  return resolveDeferredBody(stripStubMarker(neutralizeDeep(env)), result);
}

// ---------------------------------------------------------------------------
// A deferred draft body (contract §8, 2026-10-13)
//
// `draft{action:"create"|"reply"|"update"}` no longer puts the body in
// `structuredContent`: `draft.body` arrives as `{ text: null, html: null,
// truncated, deferred: true }` and the real one rides in the tool RESULT's
// `_meta["mcpemails/draft_body"]`. There are two ways the card gets it, tried
// in this order:
//
//   1. FROM THE RESULT ITSELF. Both ways a result reaches this file hand over
//      the whole `CallToolResult` (bridge.ts passes the notification's params
//      and the `tools/call` response through untouched), so if the host
//      forwarded `_meta` it is right here and `resolveDeferredBody` fills the
//      body in before anything else sees the envelope.
//   2. BY ASKING. A host may drop result `_meta` on the way to a view, and the
//      card cannot find out in advance whether this one does. The envelope then
//      stays deferred, App.tsx shows the loading line, and its effect calls
//      `draft_read` (`deferredBodyCall`), which returns the body inline.
//
// The one rule both serve: A DEFERRED BODY IS NEVER RENDERED AS A BODY.
// `text: null` reads as an empty string through every `?? ""` in the
// components, and an editor mounted on it would hold an empty body under the
// real draft's `version` — so nothing would ever resync it, Save would light up
// on the first keystroke, and that save would write the blank over the draft.
// ---------------------------------------------------------------------------

/** The draft of a draft-editor envelope; undefined for every other card. */
export function editorDraft(env: Envelope | null | undefined): Envelope["draft"] {
  return env?.card === "draft_editor" ? env.draft : undefined;
}

/** Is this a draft envelope whose body the card does not have yet? */
export function isBodyDeferred(env: Envelope | null | undefined): boolean {
  return !!env && env.card === "draft_editor" && env.draft?.body?.deferred === true;
}

/**
 * Fill a deferred body from the result's `_meta`, when the host delivered it.
 *
 * Returns the envelope unchanged when there is nothing usable there, which is
 * the signal for path 2 above; a malformed value is treated exactly like an
 * absent one rather than guessed at. `text` and `html` may each be null (an
 * HTML-only draft has no text part), so "usable" means the key is an object
 * that says what the body is, not that the body is non-empty.
 *
 * Neutralised like every other string that crosses this boundary. The inline
 * body always was, because it sits inside the envelope `neutralizeDeep` walks;
 * this one arrives beside the envelope and would otherwise be the only body
 * the card shows without that pass.
 */
function resolveDeferredBody(env: Envelope, result: ToolResultParams): Envelope {
  if (!isBodyDeferred(env) || !env.draft) return env;
  const meta = result._meta;
  const raw =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)[DRAFT_BODY_META_KEY]
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return env;
  const b = raw as Record<string, unknown>;
  if (!("text" in b)) return env;
  if (typeof b.text !== "string" && b.text !== null) return env;
  if (typeof b.html !== "string" && b.html !== null && b.html !== undefined) return env;
  return {
    ...env,
    draft: {
      ...env.draft,
      body: neutralizeDeep({
        text: b.text ?? "",
        html: b.html ?? null,
        truncated:
          typeof b.truncated === "boolean" ? b.truncated : env.draft.body?.truncated === true,
        // Where the reply's quoted original starts (contract.ts#Body.quoted).
        // Shape-checked again where it is used (format.ts#splitQuote).
        ...(b.quoted && typeof b.quoted === "object" && !Array.isArray(b.quoted)
          ? { quoted: b.quoted as { line: number } }
          : {}),
      }),
    },
  };
}

/** The read that returns a deferred body. Null when there is nothing to ask. */
export function deferredBodyCall(env: Envelope | null | undefined): RehydrationCall | null {
  if (!env || !isBodyDeferred(env) || !env.draft?.draft_id) return null;
  return {
    tool: "draft_read",
    args: {
      inbox_id: env.draft.identity?.inbox_id,
      draft_id: env.draft.draft_id,
    },
  };
}

/**
 * Names one deferred envelope, so App.tsx asks for each body exactly once and
 * a failure is remembered against the envelope it happened to, not against
 * whichever one is on screen later. Local to the frame, never stored or sent.
 */
export function deferredBodyKey(env: Envelope | null | undefined): string | null {
  if (!env || !isBodyDeferred(env) || !env.draft) return null;
  return JSON.stringify([
    env.draft.identity?.inbox_id ?? null,
    env.draft.draft_id,
    env.draft.version ?? null,
  ]);
}

/**
 * Validate the `draft_read` answer to a deferred body.
 *
 * `acceptRehydration` first, unchanged, because this is the same event as a
 * restored stub being re-requested: a server answer about one specific id,
 * arriving into a card that is showing a placeholder for it. Same shape rule,
 * same identity rule, same `gone` for a draft that has since left Drafts, same
 * short list of receipts that mean the editor must stop.
 *
 * Two things are added, both about the body:
 *
 *  - AN ANSWER THAT IS ITSELF DEFERRED IS A FAILURE. `draft_read` returns the
 *    body inline by contract. If it ever does not, adopting the answer would
 *    put the card straight back where it started and ask again, forever.
 *  - WHICH ENVELOPE IS KEPT. When the answer's `version` equals the one the
 *    deferred envelope carried, the two describe the same content, and only the
 *    body is taken: the original envelope is the richer one (`in_reply_to` is
 *    populated on a reply and null on every read, and `origin` says who wrote
 *    it). When they differ, or either is missing, the draft has changed since
 *    the envelope was built, and the answer is adopted whole: a body grafted
 *    under a version that does not describe it is exactly the mismatch the
 *    editor's resync rule cannot see.
 */
export function acceptDeferredBody(
  asked: Envelope | null | undefined,
  next: Envelope | null,
): Rehydration {
  const decided = acceptRehydration(asked, next);
  if (decided.kind !== "adopt" || decided.envelope.card !== "draft_editor") return decided;
  const answer = decided.envelope;
  if (isBodyDeferred(answer) || !asked?.draft || !answer.draft) return { kind: "failed" };
  const mine = asked.draft.version;
  if (typeof mine === "string" && mine.length > 0 && answer.draft.version === mine) {
    return {
      kind: "adopt",
      envelope: { ...asked, draft: { ...asked.draft, body: answer.draft.body } },
    };
  }
  return decided;
}

/**
 * Is the card still waiting for the body of exactly this envelope?
 *
 * The answer to a `draft_read` lands a round trip after it was asked, and the
 * store may have moved on: a pushed result may have replaced the envelope, or
 * resolved it. An answer to a question nobody is asking any more is dropped.
 */
export function awaitsBodyOf(asked: Envelope | null | undefined): boolean {
  const key = deferredBodyKey(asked);
  return key !== null && key === deferredBodyKey(state.envelope);
}

/** Put a fetched body on screen, if it is still the one being waited for. */
export function adoptDeferredBody(asked: Envelope, envelope: Envelope): boolean {
  if (!awaitsBodyOf(asked)) return false;
  setState({ envelope });
  return true;
}

/**
 * A deferred envelope that describes the content the card ALREADY HAS keeps the
 * body it has.
 *
 * Same draft, same mailbox, same `version`: by the server's own definition that
 * is the same content, so the body on screen is the body the placeholder stands
 * for. Without this, a host that drops `_meta` and delivers the same result
 * twice would take a mounted editor down to its loading line and back, and the
 * remount would discard whatever the user had typed in between.
 */
function keepKnownBody(current: Envelope | null | undefined, next: Envelope): Envelope {
  if (!isBodyDeferred(next) || !next.draft) return next;
  if (!current || current.card !== "draft_editor" || !current.draft?.body) return next;
  if (isRestoreStub(current) || isBodyDeferred(current)) return next;
  const version = next.draft.version;
  if (typeof version !== "string" || !version || current.draft.version !== version) return next;
  const mine = envelopeSubject(current);
  const theirs = envelopeSubject(next);
  if (!mine || !theirs || !sameSubject(mine, theirs)) return next;
  return { ...next, draft: { ...next.draft, body: current.draft.body } };
}

/** Convenience wrapper for callers that only need the envelope. */
export function envelopeFrom(result: ToolResultParams | undefined): Envelope | null {
  return classifyResult(result).envelope;
}

// ---------------------------------------------------------------------------
// Applying an envelope over the one already on screen
//
// Both paths that produce an envelope end here: the card's own `tools/call`
// responses (App.tsx) and the host's pushed `ui/notifications/tool-result`.
// They used to disagree — App.tsx guarded "an error envelope must not take the
// editor away" and the push path did not — and the asymmetry is the defect,
// not either rule. One function, two callers, no drift.
// ---------------------------------------------------------------------------

/** Does this envelope carry the payload its own discriminator promises? */
export function isRenderable(env: Envelope | null | undefined): boolean {
  if (!env) return false;
  switch (env.card) {
    case "draft_editor":
      return !!env.draft;
    case "outbound_review":
      return !!env.outbound;
    case "bulk_plan":
      return !!env.plan;
    case "subscription_plan":
      return !!env.subscriptions;
    case "receipt":
      return !!env.receipt;
    default:
      return false;
  }
}

/**
 * Is this the receipt for a message that actually left, as opposed to one that
 * was discarded, refused, or never went anywhere?
 *
 * Exported because two places need the same answer and must not drift: this
 * file decides whether to carry the draft across, and App.tsx decides whether
 * to render it. `state: "error"` is excluded explicitly as well as by outcome —
 * §4 says the envelope state and the receipt outcome describe the same
 * condition from two levels, and a disagreement between them is not a send.
 */
export function isDepartedReceipt(env: Envelope | null | undefined): boolean {
  if (!env || env.card !== "receipt" || !env.receipt) return false;
  if (env.state === "error") return false;
  return env.receipt.outcome === "sent" || env.receipt.outcome === "scheduled";
}

/**
 * Does this envelope report that something FAILED?
 *
 * §4 says the envelope state and the receipt outcome describe the same
 * condition from two levels; either one saying so is enough, for the same
 * reason `isDepartedReceipt` requires both to agree before calling it a send.
 */
export function isFailure(env: Envelope | null | undefined): boolean {
  return !!env && (env.state === "error" || env.receipt?.outcome === "failed");
}

/** A draft editor with real content in it, as opposed to a restore stub. */
function isLiveEditor(env: Envelope | null | undefined): env is Envelope {
  return !!env && env.card === "draft_editor" && !!env.draft && !isRestoreStub(env);
}

/**
 * A read or save of the same reply draft keeps the "Replying to" context the
 * card already has (live re-test, 2026-10-17).
 *
 * The server knows the original as a server message id on the reply path only,
 * so every `draft_read` and `draft_editor_save` answers `in_reply_to: null`
 * with `threaded: true`. Adopting that took the "Replying to Dana · <subject>"
 * line away on the first Save (and on the read a reloaded card makes), and the
 * card jumped up by a line. The draft still answers the same message, so the
 * held context stays until an answer says the draft no longer answers one.
 */
function keepReplyContext(current: Envelope | null | undefined, next: Envelope): Envelope {
  const held = editorDraft(current)?.in_reply_to;
  const n = editorDraft(next);
  // Since 2026-10-19 those answers carry a context read back from the stored
  // draft (`message_id: null`, mcp-app-drafts.ts#storedReplyContext). The one
  // already held came from the reply itself and is the better copy, so it
  // still wins: the line must not change wording under the person on a Save.
  if (!held || !n || n.in_reply_to?.message_id || n.threaded !== true) return next;
  const was = current!.draft!;
  if (was.identity?.inbox_id !== n.identity?.inbox_id) return next;
  const same = n.draft_id === was.draft_id ||
    (!!n.resolved_from && (n.resolved_from === was.draft_id || n.resolved_from === was.resolved_from)) ||
    n.origin === "save";
  return same ? { ...next, draft: { ...n, in_reply_to: held } } : next;
}

/** Rule 0 above: keep the sent message on screen under its receipt. */
function carrySentDraft(current: Envelope | null | undefined, next: Envelope): Envelope {
  if (!current || current.card !== "draft_editor" || !current.draft) return next;
  if (isRestoreStub(current)) return next;
  // Nor from an editor whose body never arrived: the copy would render as a
  // sent message with nothing in it.
  if (isBodyDeferred(current)) return next;
  if (!isDepartedReceipt(next) || next.draft) return next;
  return { ...next, draft: current.draft };
}

/**
 * Merge a new envelope onto the current one.
 *
 * `isEnvelope` is structural: `{schema_version, card}` and nothing else passes
 * it, reaches every card branch in App.tsx without matching one, and lands on
 * the "This review is missing its details" notice. If the user was typing a
 * reply at the time, their text went with it. Today's server always populates
 * `draft`, so this is defence in depth — and it is the kind of defence that has
 * to exist BEFORE the server change that needs it, because the failure is
 * silent and destroys work.
 *
 * Two rules, in order:
 *
 *  1. Same card kind, new envelope has no payload, current one does: keep the
 *     payload and take everything else from the new envelope. This is what
 *     makes `state: "error"` render as an error AROUND the editor rather than
 *     instead of it — the server changed nothing, so neither do we.
 *  2. Nothing renderable in the new envelope at all, and something renderable
 *     on screen: ignore it outright. A payload-less `bulk_plan` is not a
 *     reason to take away a send the user is reviewing.
 *
 * Anything renderable replaces, unconditionally. A receipt over a draft is a
 * send completing, and that must always win.
 *
 * ── RULE 0: A COMPLETED SEND KEEPS WHAT WAS SENT ────────────────────────────
 * The receipt still wins — it is the authoritative envelope and every field
 * comes from it — but the draft payload the card was already holding is carried
 * across onto it, so the message survives the transition. Without this, pressing
 * Send replaced a screen full of the user's own words with the single line
 * "Sent.", and the only copy of what had just gone out was in a mailbox the card
 * cannot open. That was the top complaint about the editor.
 *
 * Narrow on purpose:
 *
 *   - only onto a receipt whose outcome is a SUCCESSFUL DEPARTURE (`sent`,
 *     `scheduled`). A `failed` receipt is an error the editor renders around
 *     itself, a `discarded` one is a deletion, and neither wants a read-only
 *     copy of the message pinned under it;
 *   - only from a real draft_editor envelope, never from a restore stub, which
 *     is empty by design and would render as a blank message;
 *   - never over a `draft` the server itself put on the receipt. Today it sends
 *     none, and if it ever does, its copy is the better one.
 *
 * Nothing is stored: `persist.ts#redact` keeps `draft` for a `draft_editor`
 * card only, so a receipt carrying one still persists as an outcome word and a
 * neutral headline. The message lives in this tab's memory until the frame goes
 * away, which is exactly as long as the user is looking at it.
 *
 * (Since 2026-10-14 a send made from the card's own Send button also leaves a
 * plain-text copy in sessionStorage, for the "Show" link a reopened card
 * offers. That is App.tsx and ended.ts, not this carry, and it never touches
 * the localStorage stub.)
 *
 * "Always" is scoped to what reaches here. The card's own calls (App.tsx
 * #callDraft) reach this function directly, so a send the user pressed always
 * flips the card to its receipt. A PUSHED receipt is filtered first by
 * `envelopeSubject` / `sameSubject` above, which admits a receipt that names
 * this draft and refuses one that names another — or names nothing at all,
 * which is where the server gap in `receiptSubject` bites. That asymmetry is
 * deliberate: this function decides how to merge, not whether the result
 * belongs to this card.
 */
export function mergeEnvelope(
  current: Envelope | null | undefined,
  incoming: Envelope,
): Envelope {
  const next = keepReplyContext(current, keepKnownBody(current, incoming));
  // ── RULE -1: A FAILURE NEVER TAKES THE EDITOR AWAY ────────────────────────
  // "Anything renderable replaces" was written when the only receipt that
  // could follow a draft was a send completing. It is not: every draft tool
  // answers a refusal with `card: "receipt"`, `outcome: "failed"`
  // (mcp-app-drafts.ts#draftFailure), which is renderable, so a stale id on
  // Save replaced a screen of the user's typing with "That draft could not be
  // found." and no way back (QA, 2026-10-13). Rule 1 below already had the
  // right idea and could not reach this case, because it keys on the card kind
  // being the SAME and a failure arrives as a different one.
  //
  // So a failed receipt over a live editor becomes what rule 1 produces: the
  // editor, with `state: "error"` and the receipt around it, which DraftEditor
  // renders as a notice. Only an outcome that ends the draft (sent, scheduled,
  // discarded, a held send) replaces the editor.
  if (isLiveEditor(current) && next.card === "receipt" && isFailure(next)) {
    return { ...current, state: "error", receipt: next.receipt };
  }
  if (isRenderable(next) || !current) {
    return carrySentDraft(current, next);
  }
  // A RESTORE STUB is renderable by shape (a draft stub has a `draft`) and
  // empty by design (no subject, no body, no recipients). Grafting it onto a
  // fresh envelope would strip the `_stub` marker with it, and App.tsx gates on
  // that marker alone: the result is a full DraftEditor with blank fields
  // sitting over a real server draft, whose first Save writes the blanks back.
  // There is nothing in a stub worth preserving, so rule 1 does not apply to
  // one and rule 2 below keeps the stub itself, marker intact.
  if (next.card === current.card && isRenderable(current) && !isRestoreStub(current)) {
    switch (current.card) {
      case "draft_editor":
        return { ...next, draft: current.draft };
      case "outbound_review":
        return { ...next, outbound: current.outbound };
      case "bulk_plan":
        return { ...next, plan: current.plan };
      case "subscription_plan":
        return { ...next, subscriptions: current.subscriptions };
      case "receipt":
        return { ...next, receipt: current.receipt };
    }
  }
  return isRenderable(current) ? current : next;
}

// ---------------------------------------------------------------------------
// Re-requesting a restored stub
//
// Both halves of this live here rather than inside App.tsx's effect, because
// both are decisions rather than rendering: WHICH read a card kind has, and
// WHETHER what came back may be adopted. In the component they were reachable
// only through a browser, so the one thing that most needed pinning — "a
// bulk_plan has no reader and must not get one" — was a comment. Here the
// harnesses drive the shipped functions directly.
// ---------------------------------------------------------------------------

/** The read a restored stub needs, or null when its card kind has none. */
export interface RehydrationCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Which server read puts the content back, for a stub of this card kind.
 *
 * Checked against the shipped tool definitions on 2026-09-16, not assumed:
 *
 *   draft_editor    `draft_read` (mcp-app-drafts.ts) — read-only, inbox_id +
 *                   draft_id.
 *   outbound_review `approval_review` (mcp-app-approvals.ts) — read-only,
 *                   `approval_id` alone, `readOnlyHint: true`, and its own
 *                   description ends "so it can be shown in the review card".
 *                   It shipped with the card and was simply never called, which
 *                   is what cost a re-mounted pending send its Reject button —
 *                   Approve was already only `openLink(review_url)`.
 *   bulk_plan       NONE, and deliberately none. mcp-app-bulk.ts declares
 *                   exactly `bulk_execute` and `bulk_cancel`; both DECIDE, and
 *                   reading a plan by running it is not a read. Plans are also
 *                   server-held with a 15-minute TTL, so a card scrolled back
 *                   to is usually looking at something already expired. This is
 *                   settled: do not add a case for it.
 *   receipt         Terminal. persist.ts rewrites the headline from the outcome
 *                   and it renders straight from the stub.
 */
export function rehydrationCall(env: Envelope | null | undefined): RehydrationCall | null {
  if (!env || !isRestoreStub(env)) return null;
  if (env.card === "draft_editor" && env.draft?.draft_id) {
    return {
      tool: "draft_read",
      args: {
        inbox_id: env.draft.identity?.inbox_id,
        draft_id: env.draft.draft_id,
      },
    };
  }
  if (env.card === "outbound_review" && env.outbound?.approval_id) {
    return {
      tool: "approval_review",
      args: { approval_id: env.outbound.approval_id },
    };
  }
  return null;
}

/**
 * What to do with the answer. `gone` names a subject, not a sentence: the copy
 * belongs to the component.
 */
export type Rehydration =
  | { kind: "adopt"; envelope: Envelope }
  | { kind: "gone"; subject: "draft" | "send" }
  | { kind: "failed" };

/**
 * Receipt error codes that mean THIS EDITOR MUST STOP RENDERING.
 *
 * An allow-list, and deliberately not its complement ("anything but
 * `provider_error`"). `runDraftRead` answers a transient IMAP blip with a
 * `provider_error` receipt, and a receipt is exactly the same event as the
 * thrown error the effect's own `.catch()` arm was written to tolerate — so
 * adopting receipts by default would let one bad remount replace a restored
 * draft with a one-line error. The complement also adopts every code nobody has
 * written yet, which is the same bet made blind.
 *
 * What is on the list is durable rather than transient, and in every case the
 * server's own copy is the right thing to show: it carries the headline, the
 * detail and the way back. `draft_editor_hidden` is the user's own opt-out and
 * is the reason this list exists — without it the card kept rendering a
 * live-looking editor for a mailbox the user had switched off, over a body held
 * only in this browser. `draft_editor_disabled` is the identical shape for a
 * workspace de-rolled-out mid-session. `insufficient_scope` and
 * `inbox_not_found` say this caller or this inbox can never render this card,
 * which no retry changes either.
 *
 * NOTE for whoever edits the copy: the strings come from the server
 * (mcp-app-drafts.ts#gateDraftTool), and as of ws2/round3 they no longer
 * promise a dashboard control, because there is not one yet. Do not reintroduce
 * that promise on the card side.
 */
const EDITOR_STOP_CODES: readonly string[] = [
  "draft_editor_hidden",
  "draft_editor_disabled",
  "insufficient_scope",
  "inbox_not_found",
];

/**
 * Validate a re-request answer before anything is rendered from it.
 *
 * Held to the same standard as a pushed result, because it is the same kind of
 * thing: a server payload arriving into a card that is already showing
 * something. That standard has two halves and this function used to apply only
 * the first:
 *
 *  1. SHAPE. The card kind must be the one that was asked for AND carry its
 *     payload, or it must be a terminal receipt on a path where a receipt is a
 *     real answer. The stub is never rendered as a fallback: an editor with a
 *     blank subject over a draft that has one is an invitation to overwrite the
 *     real thing, and a decision row drawn from a stub is a Reject button with
 *     nothing behind it.
 *  2. IDENTITY. The answer must be about the id that was ASKED FOR. This is why
 *     `asked` is the stub envelope rather than its card kind: `rehydrationCall`
 *     already had the id, and comparing it costs one `sameSubject`.
 *
 * Without (2) an `approval_review` answer naming a DIFFERENT `approval_id`, or
 * a `draft_read` answer naming a different `draft_id`, was adopted and drew a
 * live Reject bound to whichever id the answer chose. Measured on 2026-09-17
 * by the round-2 verification pass, which also noted the bound: this is
 * server-trust, not privilege escalation, because `approval_decide` re-
 * authorises the id against the caller's key. It is still a server BUG rather
 * than a case to tolerate — we asked about one thing and were told about
 * another — so it fails closed, and the comment no longer claims a standard the
 * code was not applying.
 */
export function acceptRehydration(
  asked: Envelope | null | undefined,
  next: Envelope | null,
): Rehydration {
  // BOTH sides, not just `next`. Round 3 changed `asked` from a card-kind
  // STRING to the stub envelope, and `"draft_editor".card` is a harmless
  // `undefined` where `null.card` throws — so the same call that used to
  // return `failed` now takes the function out. App.tsx cannot reach it (the
  // effect returns on `!env`, captures the value before the await, and its
  // `.catch()` would swallow a throw anyway), but this is an exported boundary
  // the harnesses drive directly, and one of them found it: state-machine.mjs
  // hands in whatever `loadEnvelope` returned, which is `null` on any miss.
  // A re-request with nothing to correlate against IS a failed re-request.
  if (!next || !asked) return { kind: "failed" };
  const kind = asked.card;

  // "There is no such thing any more." One quiet line, never a red notice:
  // re-requesting is what just failed, and a wall of warning over a draft the
  // user deliberately sent, or a send somebody already decided, is the scare
  // this card refuses to raise. `not_found` deliberately also covers the
  // wrong-workspace case, which the server makes indistinguishable on purpose,
  // so the line it maps to has to stay neutral.
  //
  // Correlation does not apply here and must not: these refusals carry no id BY
  // DESIGN. `draftFailure` publishes none at all, and ws2/round3's
  // `approval_id` is explicitly `null` on a not-found, because echoing an
  // unverified id back would turn a deliberately indistinguishable refusal into
  // an existence oracle. So a `null` id reads as UNNAMED, which is refused on
  // the push path and lands here as `gone` — which is the same answer the card
  // gave before, for a better reason.
  const code = next.receipt?.error_code;
  if (code === "draft_not_found") return { kind: "gone", subject: "draft" };
  if (
    kind === "outbound_review" &&
    (code === "not_found" || code === "invalid_approval_id")
  ) {
    return { kind: "gone", subject: "send" };
  }

  if (next.card === kind && isRenderable(next)) {
    // Both sides always name an id on this path — a draft envelope carries
    // `draft_id`, an outbound one `approval_id` — so an answer that cannot be
    // placed is a defect, not the tolerated absence `sameSubject` allows for a
    // receipt's missing scope.
    const mine = envelopeSubject(asked);
    const theirs = envelopeSubject(next);
    if (!mine || !theirs) return { kind: "failed" };
    // DRAFT LINEAGE (2026-10-13). `draft_read` now accepts any EARLIER id of a
    // draft and answers with the current one, so on this path a different
    // `draft_id` is the designed answer rather than the mislabelled one this
    // check was written against. What still has to hold is the mailbox: the
    // answer must be a draft in the inbox that was asked about. An approval
    // has no lineage and is still compared id for id.
    //
    // And the server says so: an answer under a different id names the id it
    // was asked with in `resolved_from`. One that names neither the asked id
    // nor resolves from it is about some other draft and is not adopted.
    const same = kind === "draft_editor"
      ? theirs.kind === "draft" &&
        (mine.scope === null || theirs.scope === null || mine.scope === theirs.scope) &&
        (theirs.id === mine.id || next.draft?.resolved_from === mine.id)
      : sameSubject(mine, theirs);
    if (!same) return { kind: "failed" };
    return { kind: "adopt", envelope: next };
  }

  // A queued send that expired, or that was decided in the dashboard while the
  // card was scrolled away, comes back as a terminal receipt. It is
  // server-authored, carries no mail content (the headline names no recipient
  // and no subject) and is the truthful rendering, so it is adopted rather than
  // collapsed into "open the dashboard to see this".
  //
  // On the DRAFT path the same is now true of the few refusals that mean this
  // editor must stop existing — the opt-out above all. Everything else there
  // still falls to the one-liner: `draft_read` answers a missing draft with a
  // `draft_editor` error envelope rather than a receipt, so an unrecognised
  // receipt is a shape nobody has seen.
  if (
    next.card === "receipt" &&
    next.receipt &&
    (kind === "outbound_review" ||
      (kind === "draft_editor" && EDITOR_STOP_CODES.includes(String(code))))
  ) {
    // A receipt is exempt from (2) when it names NOTHING, and only then. That
    // is not laxity: an unnamed receipt is the shape the draft failures still
    // have (`draftFailure` publishes no `draft_id`) and the shape every approval
    // receipt had before ws2/round3, so requiring an id would refuse the very
    // answers this branch exists for. A receipt that DOES name something and
    // names the wrong thing is a mislabelled answer and fails closed.
    const theirs = envelopeSubject(next);
    const mine = envelopeSubject(asked);
    const named = !!theirs && theirs.id !== "";
    if (named && mine && !sameSubject(mine, theirs)) return { kind: "failed" };
    return { kind: "adopt", envelope: next };
  }

  return { kind: "failed" };
}

/**
 * Adopt a re-request answer as the rendered envelope.
 *
 * Exists so that App.tsx cannot do this with a bare `setState`, which is what
 * it used to do — and which left `pushAccepted` false, so exactly one later
 * PUSHED result bypassed correlation entirely and could rebind the card to a
 * foreign draft or approval.
 *
 * The line between this and a restore is the whole point, and it is why the
 * flag is not simply set wherever an envelope appears. A RESTORE is a memory of
 * a call; the real result is measured seconds late on Claude and must still be
 * able to beat it, which is the allowance pinned by hardening.mjs's "a late
 * result still wins over a RESTORED envelope". A REHYDRATION is a server answer
 * to a call the card itself made about a specific id — from that moment the
 * card knows what it is showing, and a later push about something else is the
 * ordinary uncorrelated case rather than the arrival the recovery was waiting
 * for.
 */
export function adoptRehydration(envelope: Envelope): void {
  pushAccepted = true;
  ownAnswer = true;
  setState({ envelope, draftCheck: "trusted", draftIdHint: null, priorReceipt: null });
}

/**
 * How much later than the copy on screen a save has to be before it counts as
 * a different write, when neither side has a revision to compare. A write
 * stamps its own response and the lineage stamps its record, a moment apart.
 */
export const SUPERSEDE_SLACK_MS = 5_000;

/**
 * Did the ASSISTANT write this draft after the copy this card holds?
 *
 * A card is never told about a later tool call, so this is read off the one
 * thing it does get: a `draft_read` answer, whose `revision` and
 * `last_saved_by` come from the server's draft lineage. A read that reports a
 * higher revision, last written by the assistant, means a later
 * `draft{action:"update"}` (or reply) wrote it, and that call mounted its own
 * card further down. The person's own saves never count: they are
 * `last_saved_by: "user"`, and this card may well be where they were made.
 *
 * Without a revision on the held copy (a draft with no line when this card
 * loaded it) the save times decide instead, with slack.
 */
export function supersededBy(
  held: Envelope["draft"] | null | undefined,
  next: Envelope["draft"] | null | undefined,
): boolean {
  if (!held || !next || next.origin !== "read" || next.last_saved_by !== "agent") return false;
  const now = typeof next.revision === "number" ? next.revision : 0;
  if (now < 1) return false;
  const was = typeof held.revision === "number" ? held.revision : 0;
  if (was >= 1) return now > was;
  const a = Date.parse(String(held.last_saved_at ?? ""));
  const b = Date.parse(String(next.last_saved_at ?? ""));
  return Number.isFinite(a) && Number.isFinite(b) && b - a > SUPERSEDE_SLACK_MS;
}

/**
 * Apply the answer to a call THIS CARD made from its draft editor.
 *
 * The one door for App.tsx#callDraft, for the reason `adoptRehydration` is the
 * one door for a re-request: both are the moment the card knows more than the
 * host does. From here on a pushed draft envelope can only be the mounting
 * call's result arriving late, which is older than what is on screen by
 * construction, so `wireResultHandlers` stops letting one replace it.
 *
 * A successful draft envelope is also what makes the draft `trusted` again. A
 * failure leaves `draftCheck` alone: it says nothing about what the server
 * holds, and the caller knows which failures mean "unknown".
 */
export function adoptOwnAnswer(next: Envelope): Envelope {
  const applied = mergeEnvelope(state.envelope, next);
  pushAccepted = true;
  ownAnswer = true;
  const fresh = next.card === "draft_editor" && !!next.draft && !isFailure(next);
  const held = isLiveEditor(state.envelope) ? state.envelope.draft : null;
  setState({
    envelope: applied,
    ...(fresh
      ? {
        draftCheck: "trusted" as const,
        draftIdHint: null,
        priorReceipt: null,
        ...(next.draft?.origin === "save"
          ? { draftSuperseded: false }
          : state.draftSuperseded
          ? {}
          : supersededBy(held, next.draft)
          ? { draftSuperseded: true, supersededAt: { why: "newer" as const, where: "below" as const } }
          : {}),
      }
      : {}),
  });
  return applied;
}

/**
 * Take a previous failure's notice off the editor before the next call starts,
 * so a retry is not read under the error it is retrying.
 */
export function clearDraftError(): void {
  const env = state.envelope;
  if (!isLiveEditor(env) || env.state !== "error") return;
  const { receipt: _old, ...rest } = env;
  setState({ envelope: { ...rest, state: "editing" } });
}

/**
 * How old a first-mount result can be before it is treated as a replay.
 *
 * Claude delivers a first mount's result at the end of the assistant's turn
 * (measured 4.5s). 30s covers an ordinary turn. Past it the card re-reads,
 * which costs one `draft_read` and is also right on the merits: a turn that
 * long has usually made more tool calls, and one of them may have changed this
 * draft.
 *
 * ── WHAT THE STAMP MEANS NOW (2026-10-13) ──────────────────────────────────
 * `last_saved_at` used to be the server's clock at RESPONSE time on every path.
 * Since draft lineage it is the time of the last real SAVE: a write still
 * stamps its own time, but a `draft_read` reports when the draft was last
 * saved (or null). The age test is still SOUND — a response is never older
 * than the save it reports, so a replay, which arrives more than 30s after its
 * response, is still always more than 30s past its stamp — but it is no longer
 * TIGHT: a model's fresh `draft_read` of a draft saved an hour ago also reads
 * as old. That costs exactly one verifying re-read, never a loop: the re-read
 * is the card's own answer (`adoptOwnAnswer`), which makes the draft `trusted`
 * without consulting this test, and every later push is ignored behind it.
 * structuredContent carries no response timestamp a tighter test could use,
 * and `restored === "storage"` cannot be the only signal because a second
 * device, an evicted entry or a host without storage would then trust a stale
 * replay with Send on. Pinned in harness/draft-polish.test.mjs.
 */
export const REPLAY_AGE_MS = 30_000;

/**
 * Is this pushed draft a REPLAY of an old result rather than a fresh one?
 *
 * The host hands a re-mounted view the original tool result with nothing to
 * mark it as old, so this is inferred from the only two things the card has:
 *
 *   - `restored === "storage"`: a stub for this very call was already in
 *     storage, so the card has rendered it before. Exact, when storage works.
 *   - the save stamp is not recent by this browser's clock. Covers a host
 *     that keeps no storage (see `REPLAY_AGE_MS` for why a save stamp works). A wrong clock, a missing stamp or an unparseable
 *     one all read as "replay", which is the direction that costs one read
 *     instead of a send from stale text.
 */
export function isReplayedDraft(
  env: Envelope,
  restored: CardStore["restored"],
  now = Date.now(),
): boolean {
  if (restored === "storage") return true;
  const at = Date.parse(String(env.draft?.last_saved_at ?? ""));
  return !Number.isFinite(at) || Math.abs(now - at) > REPLAY_AGE_MS;
}

/**
 * What a rendered envelope is ABOUT.
 *
 * Used for one thing only: deciding whether a SECOND pushed tool result is the
 * same call as the first. Never rendered, never stored.
 *
 * `scope` is the mailbox an id lives in, and it is a separate field rather than
 * part of the id because the two sides do not always both know it. Provider
 * draft ids are per-mailbox and collide freely across them — `Drafts:2` is the
 * second draft in EVERY IMAP account — so a draft envelope, which carries the
 * inbox, must compare it. A receipt carries no identity block, so it names the
 * id and nothing else; see `sameSubject`.
 */
interface Subject {
  kind: "draft" | "approval" | "plan" | "receipt";
  id: string;
  scope: string | null;
}

/**
 * A receipt that names nothing it could be a receipt FOR.
 *
 * Every approval and bulk receipt in the server is built by a `receiptEnvelope`
 * helper that emits `{schema_version, card, dashboard_url, state, receipt,
 * actor}` and no id at all (mcp-app-approvals.ts#receiptEnvelope,
 * mcp-app-bulk.ts#receiptEnvelope), so today this is what most of them produce.
 * Its `kind` is its own, so it equals no draft, approval or plan — which keeps
 * an uncorrelatable receipt REFUSED, exactly as before this refinement.
 *
 * That refusal is the fail-safe direction and is chosen deliberately: the
 * alternative, exempting receipts from correlation, trades "a terminal receipt
 * for this card is wrongly refused" for "a foreign receipt replaces a draft the
 * user is typing in", which is the worse failure and is not recoverable.
 */
const UNNAMED_RECEIPT: Subject = { kind: "receipt", id: "", scope: null };

/**
 * What a RECEIPT is a receipt for, read off the merged top-level ids.
 *
 * A receipt envelope has no payload of its own to look at — `receipt` is an
 * outcome and a headline. What it does have, on the draft path, is contract
 * §8's merge: `draft{action:"send"}` and `draft{action:"delete"}` publish
 * today's flat payload with the envelope keys laid on top, so `draft_id` sits
 * at the top level beside `schema_version`. That is the correlating material,
 * and it is read here rather than assumed.
 *
 * SERVER GAP, CLOSED 2026-09-17 (ws2/round3, a3cd89a): the approval and bulk
 * `receiptEnvelope` helpers now publish `approval_id` / `plan_id` at the top
 * level, so this function correlates them. The id is the VERIFIED row id and is
 * `null` wherever nothing was verified — a malformed uuid, or one naming no row
 * this key may see — because echoing an unverified id back would turn the
 * deliberately indistinguishable not-found refusal into an existence oracle.
 * That shape is what this function wants: `typeof === "string"` rejects `null`,
 * so an unverified receipt reads as UNNAMED and stays refused on the push path,
 * which is the fail-safe direction and exactly what it was before.
 *
 * ORDER IS A PRECEDENCE, not a search: `draft_id` first, then `approval_id`,
 * then `plan_id`. A receipt carrying two of them would be read as the draft
 * one, which shadows the approval side — so a hypothetical approval receipt
 * that also named a draft would fail to correlate against an approval card and
 * be refused. That is the safe direction and it is why the order is written
 * down rather than left to whichever key was added last. The three are disjoint
 * in every builder today (`draft{action:"send"|"delete"}` merges `draft_id`
 * only; the two `receiptEnvelope`s publish one id each) and there is no reason
 * to make them overlap.
 */
function receiptSubject(env: Envelope): Subject {
  const top = env as unknown as Record<string, unknown>;
  const draftId = top.draft_id;
  if (typeof draftId === "string" && draftId) {
    const inbox = top.inbox_id;
    return {
      kind: "draft",
      id: draftId,
      scope: typeof inbox === "string" && inbox ? inbox : null,
    };
  }
  const approvalId = top.approval_id;
  if (typeof approvalId === "string" && approvalId) {
    return { kind: "approval", id: approvalId, scope: null };
  }
  const planId = top.plan_id;
  if (typeof planId === "string" && planId) {
    return { kind: "plan", id: planId, scope: null };
  }
  return UNNAMED_RECEIPT;
}

function envelopeSubject(env: Envelope | null | undefined): Subject | null {
  if (!env) return null;
  if (env.draft?.draft_id) {
    return {
      kind: "draft",
      id: env.draft.draft_id,
      scope: env.draft.identity?.inbox_id ?? null,
    };
  }
  if (env.outbound?.approval_id) {
    return { kind: "approval", id: env.outbound.approval_id, scope: null };
  }
  if (env.plan?.plan_id) return { kind: "plan", id: env.plan.plan_id, scope: null };
  if (env.subscriptions?.plan_id) {
    return { kind: "plan", id: env.subscriptions.plan_id, scope: null };
  }
  if (env.receipt) return receiptSubject(env);
  return null;
}

/**
 * Are these two envelopes about the same thing?
 *
 * The scope comparison is deliberately "differ only when BOTH sides name one".
 * A receipt that omits `inbox_id` is not thereby a receipt for a different
 * mailbox — it simply does not say — and refusing it on an absence would put
 * the whole draft-send path back where D4 found it. The id still has to match
 * exactly, and a provider draft id is not guessable from outside the account
 * that holds it.
 */
function sameSubject(a: Subject, b: Subject): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.scope !== null && b.scope !== null && a.scope !== b.scope) return false;
  return true;
}

/**
 * A call id on a pushed result, when the host puts one there.
 *
 * The 2026-01-26 shape of `ui/notifications/tool-result` carries `content` and
 * `structuredContent` and no id, so this is usually null and the correlation
 * below cannot lean on it. It is read anyway because a host that DOES label its
 * notifications gives us an exact answer, and an exact answer beats a
 * heuristic on the one path where being wrong costs the user their typing.
 */
function pushedCallId(params: ToolResultParams | undefined): string | null {
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  const candidate =
    params?.callId ?? params?.toolCallId ?? meta.callId ?? meta["ui/callId"];
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : null;
}

// ---------------------------------------------------------------------------
// Getting off "waiting"
//
// `waiting` is the only non-terminal status, and until the watchdog below
// existed there was exactly one thing in the entire card that could end it:
// `ui/notifications/tool-result`. That is a bad single point of failure,
// because the spec does not promise the notification at all. It says the host
// "MUST send this notification when tool execution completes (if the View is
// displayed during tool execution)". The parenthetical is the bug: a view that
// mounts AFTER execution finished is owed nothing, and the spec defines no
// replay for a re-mounted view (state persistence and restoration are
// explicitly deferred out of the MVP; the matching upstream issue,
// openai/openai-apps-sdk-examples#195, is open with no official workaround).
//
// On Claude specifically this is routine rather than exotic: reopening a stored
// conversation lazy-mounts widget cells as they scroll into view, so every
// scroll-back through an old thread re-instantiates a card whose tool call
// finished days ago. Graceful degradation is the only answer available.
// ---------------------------------------------------------------------------

/**
 * How long after a successful handshake the card will keep waiting for a
 * result before deciding it is never getting one.
 *
 * Claude's supersession guidance says the host delivers the mounting tool
 * result "shortly after connect() resolves", and phase-0 saw tool-input and
 * tool-result land effectively in the same tick as the handshake (Q7.12) which
 * is why every handler is registered before connect() rather than after. So the
 * honest expectation is single-digit milliseconds and this budget is roughly
 * three orders of magnitude of headroom.
 *
 * MEASURED on Claude, 2026-09-16: `result late 4487ms`. The host delivers the
 * mounting tool result about four and a half seconds after the handshake, which
 * is almost certainly the end of the assistant's turn rather than the end of the
 * tool call. Every budget below 4.5s therefore fired on a host that was working,
 * which is what `late` meant each time. 9s is that measurement with headroom for
 * a longer turn, and the cost of being generous is only a longer loading line on
 * a card that is genuinely getting nothing.
 *
 * Was 3s, cut to 1.5s, raised to 4s on 2026-09-16 once the real host could
 * finally be read. The 1.5s was set against phase-0's reference-host timing
 * (tool-input and tool-result in effectively the same tick as the handshake,
 * Q7.12) on the theory that the honest expectation was single-digit
 * milliseconds and the rest was headroom. The first diagnostics line out of
 * Claude says otherwise: `result late`. The host DOES deliver to a freshly
 * mounted view, just not within 1.5s, so the budget was cutting off a host that
 * was working — and the visible cost is a "nothing to show" placeholder
 * flashing in front of a card that then renders perfectly well, on every single
 * card.
 *
 * The asymmetry that justified cutting it still holds and now points the other
 * way. Firing late costs loading state on a card that is never getting a
 * result; firing early costs a flash on every card that is. Claude is the host
 * we have, and it is late, so the budget follows it.
 *
 * Still deliberately well inside `INITIALIZE_TIMEOUT_MS` (10s), which covers
 * the other half of the problem: a host that never completes the handshake at
 * all surfaces as `connectError`, not as this. How late Claude actually is,
 * How late Claude is, is now known and is the first paragraph above.
 */
export const RESULT_WATCHDOG_MS = 9_000;

let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * When the watchdog was armed, i.e. when the handshake resolved. Null until
 * then, which is also the answer to "how late was a result that arrived before
 * we were ready for one": unknowable, and not interesting.
 */
let armedAt: number | null = null;

/** Stop the watchdog. Idempotent, and safe to call when it never started. */
export function disarmResultWatchdog() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Start the watchdog. MUST be called after `connect()` resolves, never at
 * module load: before the handshake completes there is no host to be late, and
 * a timer started at load would be racing the host's own startup instead of its
 * delivery.
 *
 * The fallback state is a floor, not a ceiling. `absent` only ever replaces
 * `waiting`, and a result that arrives after the deadline still overwrites it
 * through the normal `onToolResult` path, so a very late envelope renders
 * exactly as if it had been on time.
 */
export function armResultWatchdog(bridge: HostBridge): () => void {
  disarmResultWatchdog();

  // Read at arm time, which is immediately post-connect: this is the moment
  // `hostContext` is populated and the moment the fields are worth recording.
  setState({ toolInfo: toolInfoFrom(bridge.hostContext) });

  const startedAt = Date.now();
  // Same instant the watchdog is measured from, so "result after 2340ms" and
  // "the watchdog fired at 4000ms" are on one clock and directly comparable.
  armedAt = startedAt;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    // Anything already terminal wins. The watchdog exists to break a deadlock,
    // not to have an opinion about a result that did arrive.
    if (getState().resultStatus !== "waiting") return;

    setState({ resultStatus: "absent" });
    // The deadline is also the last moment the question "is there a remembered
    // envelope for this call" is still open, so it is answered here rather than
    // left to a component: this is the path the founder's "it doesn't load if I
    // leave the chat and come back" actually takes.
    attemptRestore();

    // Fire-and-forget, after the state is already committed, so a host with no
    // log channel cannot affect what the user sees. Protocol facts only.
    const s = getState();
    bridge.log("warning", {
      event: "tool_result_absent",
      waited_ms: Date.now() - startedAt,
      protocol_version: bridge.protocolVersion,
      host: bridge.hostInfo?.name ?? null,
      tool: s.toolInfo?.tool ?? null,
      call_id: s.toolInfo?.callId ?? null,
      had_tool_input: s.toolInput !== null,
      restored: s.restored,
      note:
        "No ui/notifications/tool-result or -cancelled after connect. " +
        "Card fell back to its stored envelope, or to a one-line placeholder.",
    });
  }, RESULT_WATCHDOG_MS);

  return disarmResultWatchdog;
}

/** Flatten `hostContext.toolInfo` into the two fields worth keeping. */
export function toolInfoFrom(ctx: HostContext | undefined): ToolInfoSummary | null {
  const info = ctx?.toolInfo;
  if (!info || typeof info !== "object") return null;
  const name = info.tool?.name;
  const id = info.id;
  return {
    // Server-authored in practice, but it reaches us through the host, and it
    // costs nothing to put it through the same boundary as everything else.
    tool: typeof name === "string" ? neutralizeText(name).slice(0, 64) : null,
    callId: typeof id === "string" || typeof id === "number" ? id : null,
  };
}

/**
 * Attach the result handlers to a bridge.
 *
 * Lives here rather than in main.tsx so that the whole waiting -> terminal
 * state machine is one DOM-free unit that can be driven directly, which is how
 * `harness/state-machine.mjs` proves the three no-result paths.
 */
/**
 * Has a PUSHED tool result already been accepted for this view?
 *
 * Module scope, like the watchdog timer: one card is mounted per frame, and
 * this is a fact about the frame rather than about the rendered state.
 */
let pushAccepted = false;

/** Has an answer to one of the card's OWN calls been adopted? See `adoptOwnAnswer`. */
let ownAnswer = false;

export function wireResultHandlers(bridge: HostBridge) {
  // The host MUST send tool-input with the full arguments after ui/initialize,
  // including to a view that mounts long after the call finished — which makes
  // it the only thing a re-mounted card is guaranteed to receive, and therefore
  // the trigger for putting the last envelope back. The arguments themselves
  // are never rendered; they are agent-authored and the envelope has every
  // field the card needs.
  bridge.onToolInput = (args: Record<string, unknown> | undefined) => {
    setState({ toolInput: args ?? {} });
    // `quiet`: a hit restores immediately, a miss waits for the watchdog. On a
    // first mount the result is usually a tick behind this notification, and
    // recording the miss here would flash a "nothing to show" line in front of
    // a card that is about to render perfectly well.
    attemptRestore(true);
  };

  bridge.onToolResult = (params: ToolResultParams) => {
    // ---- correlation ------------------------------------------------------
    //
    // A pushed result is supposed to be THE result of the call that
    // instantiated this view. The bridge's `event.source` check already limits
    // the sender to the real parent frame, so this is not a boundary against an
    // attacker; it is a guard against a host (or a future server) delivering a
    // second, unrelated result into a card the user is typing in. `DraftEditor`
    // resyncs on `draft_id` + `last_saved_at` + `origin`, so a foreign envelope
    // does not merely redraw: it discards unsaved text.
    //
    // The exact check first, when the host gives us one.
    const pushedId = pushedCallId(params);
    const mountedId = getState().toolInfo?.callId;
    if (pushedId !== null && mountedId != null && pushedId !== String(mountedId)) {
      setState({ uncorrelatedResults: getState().uncorrelatedResults + 1 });
      return;
    }

    // `status` matters as much as `envelope`: a result that is not ours at all
    // (an opted-out inbox, a non-plannable email_organize action) must leave
    // the card silent rather than warn under a successful operation.
    let { envelope, status } = classifyResult(params);
    // A plain send/schedule result as the MOUNTING call's answer becomes a
    // one-line receipt (plain-result.ts). Only the first push: a later plain
    // result must never replace a card the user is looking at, which is the
    // rule the `foreign` branch below keeps for everything else.
    let note: string | null = null;
    let automation: AutomationSeed | null = null;
    if (!envelope && status === "foreign" && !pushAccepted) {
      const receipt = plainResultReceipt(params);
      if (receipt) {
        envelope = receipt;
        status = "envelope";
      } else {
        note = plainResultNote(params);
        automation = automationSeed(params, getState().toolInput);
      }
    }
    // Recorded before the disarm, because "did this beat the watchdog" is
    // exactly the fact the diagnostics line exists to collect from the real
    // host: `late` would mean remounts DO get a result and the budget is wrong.
    const arrival: ResultArrival =
      getState().resultStatus === "absent" ? "late" : "ontime";
    const afterMs = armedAt === null ? null : Date.now() - armedAt;
    // Unconditional, including after the watchdog has already given up. A late
    // envelope is still a real envelope and must render, over a restored one.
    disarmResultWatchdog();
    const timing = { resultStatus: status, resultArrival: arrival, resultAfterMs: afterMs };
    if (!envelope) {
      // Unchanged and deliberately so: a foreign or malformed SECOND result
      // moves the status and leaves the card alone. App.tsx renders on
      // envelope presence, so nothing blanks.
      setState(pushAccepted ? timing : { ...timing, resultNote: note, automation });
      return;
    }

    const current = getState().envelope;
    // `pushAccepted`, not "is there an envelope": a RESTORED envelope is a
    // memory, not a result, and the first real result must always beat it
    // (state-machine.mjs h3, and every remount that is merely slow).
    //
    // ── A FIRST FOREIGN PUSH STILL WINS, AND THAT IS THE TRADE ──────────────
    //
    // Spelled out because it is otherwise only implicit in `pushAccepted`: with
    // a stub restored from storage and no result yet accepted, a pushed result
    // for a COMPLETELY DIFFERENT draft is accepted and rendered. Nothing here
    // refuses it, and nothing should. A restore is a memory of a call, not the
    // call's answer, and the case this whole file exists for is a host that
    // delivers the real result late — several seconds late, measured. Refusing
    // a first result because it disagrees with a memory would lock the card
    // onto the memory forever on exactly the hosts the recovery was built for.
    // The cost is bounded: there is no unsaved typing to destroy at that point
    // (a stub can never render as an editor — App.tsx re-requests first), and
    // the correlation below starts biting from the second result onwards.
    //
    // `isRenderable(envelope)` because only a PAYLOAD-BEARING envelope can
    // destroy anything. A payload-less one (a `state: "error"` refusal, say)
    // has no subject to compare and cannot take the draft away — mergeEnvelope
    // keeps it — so refusing those would only mean swallowing the error message
    // that belongs to this very card.
    if (pushAccepted && current && isRenderable(envelope)) {
      const theirs = envelopeSubject(envelope);
      const mine = envelopeSubject(current);
      if (theirs !== null && mine !== null && !sameSubject(mine, theirs)) {
        setState({ ...timing, uncorrelatedResults: getState().uncorrelatedResults + 1 });
        return;
      }
    }

    // ── A PUSHED DRAFT IS THE MOUNTING CALL'S RESULT, AND MAY BE OLD ────────
    let check: Partial<CardStore> = {};
    if (envelope.card === "draft_editor" && envelope.draft) {
      // The card has already asked the server itself (a re-request, a save, a
      // refresh). The push is the original result arriving after that, so it is
      // older than what is on screen and must not replace it. With a stable id
      // (Gmail, Outlook) it passes the correlation above, and used to resync
      // the editor back to the draft as first created.
      if (ownAnswer && isLiveEditor(current)) {
        setState(timing);
        return;
      }
      if (!pushAccepted && isReplayedDraft(envelope, getState().restored)) {
        // The stub this replay is about to replace remembers the LAST id the
        // card held, which after an IMAP save is not the replayed one.
        const stub = isRestoreStub(current) && current?.card === "draft_editor"
          ? current.draft
          : undefined;
        const a = stub?.identity?.inbox_id;
        const b = envelope.draft.identity?.inbox_id;
        const hint = stub?.draft_id && stub.draft_id !== envelope.draft.draft_id &&
            (!a || !b || a === b)
          ? stub.draft_id
          : null;
        // A card that had ended on a receipt keeps it until the replay has
        // been checked (App.tsx#readDraft).
        const prior = isRestoreStub(current) && current?.card === "receipt" ? current : null;
        check = { draftCheck: "pending", draftIdHint: hint, priorReceipt: prior ?? null };
      }
    }

    // Decided by the FIRST result accepted, which is the mounting call's.
    const firstResult = !pushAccepted;
    if (!pushAccepted) {
      const rev = editorDraft(envelope)?.revision;
      check = {
        ...check,
        mountedForRead: editorDraft(envelope)?.origin === "read",
        mountedRevision: typeof rev === "number" ? rev : null,
      };
    }
    pushAccepted = true;
    setState({ ...timing, ...check, envelope: mergeEnvelope(current, envelope) });
    // A FRESH draft result is a tool call the assistant just made, so any
    // older card for the same draft may now be out of date. Tell them; each
    // re-reads its own draft and decides (draft-signal.ts). A replay is not
    // fresh (`check` set it pending) and says nothing, which, with re-reads
    // never announcing, is what keeps this from looping.
    //
    // Not for a model's `draft_read` (2026-10-17): a read writes nothing, so
    // no card holds an older version because of it, and the card it mounts
    // (only on a host with a listing from before draft_read lost its card URI)
    // is the one-line DraftReadLine, which an older card must not fold toward.
    if (
      envelope.card === "draft_editor" && envelope.draft && !isFailure(envelope) &&
      check.draftCheck === undefined && envelope.draft.origin !== "read"
    ) {
      announceDraft(envelope.draft);
      // The model's only sign that the card rendered (model-context.ts). Once,
      // for the mounting call's own fresh result: a replay says nothing, so a
      // reloaded chat cannot replace a later save or send line with this one.
      if (firstResult) void bridge.updateModelContext(draftShownContextLine(envelope.draft));
    }
  };

  bridge.onToolCancelled = (_params: ToolCancelledParams) => {
    disarmResultWatchdog();
    // Only ever leaves `waiting`. If a result somehow already landed, it is the
    // better information and a cancellation arriving afterwards must not wipe
    // a card the user is looking at.
    if (getState().resultStatus !== "waiting") return;
    setState({ resultStatus: "cancelled" });
  };
}
