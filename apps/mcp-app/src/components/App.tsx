import type { VNode } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { HostBridge, ToolResultParams } from "../bridge";
import {
  isSupportedVersion,
  SCHEMA_VERSION,
  type Envelope,
  type Receipt as ReceiptData,
} from "../contract";
import { diagnosticsEnabled } from "../diagnostics";
import {
  endedFrom,
  loadEnded,
  rememberEnded,
  type EndedCopy,
  type OnScreen,
} from "../ended";
import {
  changesDraft,
  patchLanded,
  textRefusalCode,
  type DraftAction,
  type DraftFailure,
  type PatchFields,
  type Settled,
} from "../draft-failure";
import { bulkVerb } from "../format";
import {
  bulkCancelContextLine,
  bulkExecuteContextLine,
  draftActionContextLine,
  draftCallOutcome,
  draftSavedContextLine,
  outboundApproveOpenedContextLine,
  outboundRejectContextLine,
  type DraftCall as ModelDraftCall,
} from "../model-context";
import { cardKey, isRestoreStub, lastDashboardUrl } from "../persist";
import {
  acceptDeferredBody,
  acceptRehydration,
  adoptDeferredBody,
  adoptOwnAnswer,
  adoptRehydration,
  awaitsBodyOf,
  clearDraftError,
  deferredBodyCall,
  deferredBodyKey,
  envelopeFrom,
  getState,
  isBodyDeferred,
  isDepartedReceipt,
  isFailure,
  mergeEnvelope,
  rehydrationCall,
  REPLAY_AGE_MS,
  setState,
  subscribe,
} from "../store";
import { BulkPlan } from "./BulkPlan";
import { DraftEditor, type DraftPatch } from "./DraftEditor";
import { OutboundReview } from "./OutboundReview";
import { Receipt } from "./Receipt";
import { SentMessage } from "./SentMessage";
import { Loading, Notice, TextLink } from "./ui";

/**
 * `ui/open-link` requires an absolute URL, so the server sends one: contract §4
 * `receipt.dashboard_url`, built from its own APP_URL. Deliberately not resolved
 * against a hardcoded origin here — that would bake deployment config into a
 * bundle that ships inside the edge function and silently duplicate
 * NEXT_PUBLIC_APP_URL.
 *
 * Only https is accepted. The field is server-authored, but it is the argument
 * to a host navigation, so it gets validated like any other untrusted input.
 */
function absoluteUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  return url;
}

/**
 * One line of protocol facts at the bottom of a card. INTERNAL v1 ONLY, and
 * since 2026-09-16 that is enforced rather than asserted: `diagnosticsEnabled`
 * decides, it defaults to off, and its only per-workspace source is a
 * server-authored envelope field, which since 2026-09-17 the server really
 * does send, for a workspace with `workspaces.card_diagnostics`. See
 * diagnostics.ts.
 *
 * It exists because the remount bug is not reproducible from here: the card
 * runs inside claude.ai's sandbox, we cannot read the host's logs, and the one
 * question that decides whether the fix is right — does a re-mounted view get
 * tool-input, tool-result, or neither, and does `toolInfo` survive — can only
 * be answered by looking at a card in the real host. `result late` in
 * particular would say the host does deliver and the watchdog is simply too
 * short.
 *
 * Never carries content: host name and version, display mode, and four
 * yes/no/none facts about what arrived. Delete this and `.diag` together once
 * the answer is known.
 */
function Diagnostics(props: { bridge: HostBridge }) {
  const s = getState();
  const h = props.bridge.hostInfo ?? {};
  const line = [
    `host ${h.name ?? "?"} ${h.version ?? "?"}`,
    `mode ${props.bridge.hostContext.displayMode ?? "?"}`,
    `result ${
      s.resultArrival === "ontime"
        ? "yes"
        : s.resultArrival === "late"
          ? "late"
          : "none"
    }${s.resultAfterMs === null ? "" : ` ${s.resultAfterMs}ms`}`,
    `input ${s.toolInput ? "yes" : "no"}`,
    `restored ${s.restored === "storage" ? "storage" : "none"}`,
    `toolInfo ${s.toolInfo ? "yes" : "no"}`,
    // Handshake facts. `hs` is how many ui/initialize requests it took; `rx` is
    // accepted/foreign JSON-RPC messages. On a card that never connects these
    // are the whole diagnosis: rx 0/0 means the host never spoke, and a
    // non-zero foreign count would mean it spoke and we dropped it.
    `hs ${props.bridge.initializeAttempts}`,
    `rx ${props.bridge.rxAccepted}/${props.bridge.rxForeign}`,
    // Expected to be 0 forever. A non-zero count means the host pushed a
    // result belonging to a different call into this card (store.ts).
    ...(s.uncorrelatedResults ? [`xcall ${s.uncorrelatedResults}`] : []),
  ].join(" · ");
  return <p class="diag">{line}</p>;
}

/** The two ways a draft call can end without an answer that says what happened. */
type LostCode = "transport" | "unreadable";

/** One call from the draft editor: the applied envelope, or why there is none. */
interface DraftCall {
  env: Envelope | null;
  lost: LostCode | null;
  /** The code the server refused with, when it answered and did not act. */
  refused?: string | null;
  /** That refusal's headline. Only ever matched, never shown. */
  headline?: string | null;
  /**
   * The exchange as it happened, for the model-context line
   * (model-context.ts#draftCallOutcome): the envelope BEFORE it was merged,
   * the raw result for the answers that are not an envelope, and the message
   * of a call that threw.
   */
  call: ModelDraftCall;
}

/** Which way a draft the server cannot find is known to have ended, if it says. */
function closedHow(headline: string | null | undefined): "sent" | "discarded" | null {
  const h = String(headline ?? "");
  return /already sent/i.test(h) ? "sent" : /discarded/i.test(h) ? "discarded" : null;
}

/** `email_compose` -> `Email compose`. Falls back to the product name. */
function toolLabel(tool: string | null | undefined): string {
  if (!tool) return "MCP Emails";
  const words = tool.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "MCP Emails";
}

/**
 * What the person reads after hiding the draft editor card: what happened, and
 * where to undo it. The dashboard has one switch per inbox (Inboxes, in the
 * inbox's details) and one for the workspace (Settings), both labelled "Show
 * the draft editor card" (apps/web/messages/en/dashboard.json).
 */
export function hiddenDetail(scope: "inbox" | "workspace"): string {
  return scope === "workspace"
    ? 'The card will not appear for any inbox in this workspace. Drafts still work as before. To bring it back, turn on "Show the draft editor card" in the MCP Emails dashboard, under Settings.'
    : 'The card will not appear for this inbox. Drafts still work as before. To bring it back, turn on "Show the draft editor card" in the MCP Emails dashboard, under Inboxes, in this inbox\'s details.';
}

export function App(props: { bridge: HostBridge }) {
  const { bridge } = props;
  const [, force] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveOpened, setApproveOpened] = useState(false);
  // The draft editor's last action failing with no envelope to carry it. A
  // code, never a message: DraftEditor owns the wording (draft-failure.ts).
  const [failure, setFailure] = useState<DraftFailure | null>(null);
  // A send whose answer was lost (the call threw, or came back unreadable).
  // It may have gone out, so Send stays off until the person says otherwise,
  // whatever a re-read finds: a draft still in Drafts after a lost send is
  // "probably not sent", never "not sent" (review, 2026-10-13: the re-read made
  // the draft trusted again and Send could deliver it twice).
  const [sendDoubt, setSendDoubt] = useState(false);

  // The store is the single source of truth for the envelope. Keeping a copy in
  // component state looks harmless and is not: the host pushes
  // host-context-changed on every iframe resize, that writes to the store, and
  // the resulting sync would clobber a post-decision envelope with the original
  // one from the tool result.
  //
  // SUBSCRIBED DURING THE FIRST RENDER, NOT IN AN EFFECT. An effect runs after
  // the first frame, and `main.tsx` starts the handshake the moment `render()`
  // returns, so a host that answered `ui/initialize` within that frame set
  // `connected` (and delivered tool-input) before anything was listening. The
  // card then sat on its first, empty render and told the host its height was
  // 0 until the tool result arrived seconds later: a sliver where the loading
  // line belongs. Measured on build 9d48a45f766d in a cross-origin frame: 13 of
  // 20 mounts stayed blank when the host answered at once, 0 of 10 when it
  // took 150ms. The listener only schedules a re-render, so registering it
  // before the component has committed is safe.
  const unsubscribe = useRef<(() => void) | null>(null);
  if (unsubscribe.current === null) {
    unsubscribe.current = subscribe(() => force((n) => n + 1));
  }
  useEffect(() => () => unsubscribe.current?.(), []);

  const store = getState();
  // The draft editor's stash scope (unsaved.ts): the identity of the call this
  // card was mounted for. Recomputed only when the call's identity changes.
  const draftScope = useMemo(
    () => cardKey(store.toolInfo, store.toolInput),
    [store.toolInfo, store.toolInput],
  );
  const envelope = store.envelope;
  const setEnvelope = (next: Envelope) => setState({ envelope: next });

  // ---- the message a draft card ended on -----------------------------------
  //
  // What "Show" on the ended line opens (SentMessage.tsx). `kept` is the copy
  // this mount kept at the moment it ended, `fresh` because only a send made
  // here opens on arrival. `remembered` is the copy an earlier mount of this
  // same card kept in this tab (ended.ts), which is all a reopened chat has.
  // Neither is ever the tool result the card was mounted with: on a reopen
  // that is the assistant's original text, not what was sent or discarded.
  const [kept, setKept] = useState<{ copy: EndedCopy; fresh: boolean } | null>(null);
  const mountedInbox =
    typeof store.toolInput?.inbox_id === "string" ? store.toolInput.inbox_id : null;
  const remembered = useMemo(
    () => (envelope?.card === "receipt" || store.priorReceipt ? loadEnded(draftScope, mountedInbox) : null),
    [draftScope, mountedInbox, envelope?.card, store.priorReceipt],
  );
  const keepEnded = (copy: EndedCopy, inbox: string | null | undefined) => {
    setKept({ copy, fresh: true });
    rememberEnded(draftScope, inbox ?? mountedInbox, copy);
  };
  /** The copy to offer under this receipt, if the card has one it can stand behind. */
  const endedView = (env: Envelope): { copy: EndedCopy; startOpen: boolean } | null => {
    const r = env.receipt;
    if (env.card !== "receipt" || !r || isFailure(env)) return null;
    if (kept && kept.copy.outcome === r.outcome) {
      const sent = kept.copy.how === "sent" || kept.copy.how === "scheduled";
      return { copy: kept.copy, startOpen: kept.fresh && sent };
    }
    // A receipt carrying the draft it sent (store.ts#carrySentDraft) that did
    // not come through this card's own Send: a pushed result for this draft.
    if (isDepartedReceipt(env) && env.draft) {
      const how = r.outcome === "scheduled" ? "scheduled" : "sent";
      return {
        copy: endedFrom(env.draft, how, how, { sent_at: env.sent_at, provider: env.provider?.label }),
        startOpen: true,
      };
    }
    if (remembered && remembered.outcome === r.outcome) return { copy: remembered, startOpen: false };
    return null;
  };
  const ctx = bridge.hostContext;
  const fullscreen = ctx.displayMode === "fullscreen";
  const canExpand = (ctx.availableDisplayModes ?? ["inline"]).includes(
    "fullscreen",
  );

  // The root element carries the display mode so the CSS can widen padding and
  // cap the measure without any JS-driven layout.
  useEffect(() => {
    document
      .getElementById("root")
      ?.setAttribute("data-mode", fullscreen ? "fullscreen" : "inline");
  }, [fullscreen]);

  const setFullscreen = (on: boolean) => {
    bridge
      .requestDisplayMode(on ? "fullscreen" : "inline")
      .then(() => force((n) => n + 1))
      .catch(() => force((n) => n + 1));
  };

  /**
   * `contextLine` is a FUNCTION OF THE ANSWER, not a string decided before the
   * call. It used to be the latter, sent whatever came back, so "the user
   * rejected the queued send" went to the model for a send the server had just
   * said was already decided elsewhere. Null means there is nothing true to
   * add. See model-context.ts.
   */
  const run = async (
    key: string,
    tool: string,
    args: Record<string, unknown>,
    contextLine?: (answer: Envelope | null) => string | null,
  ) => {
    setBusy(key);
    setError(null);
    try {
      const result = await bridge.callServerTool(tool, args);
      const next = envelopeFrom(result);
      if (next) {
        setEnvelope(mergeEnvelope(getState().envelope, next));
      } else {
        setError("The server sent a response this card could not read.");
      }
      const line = contextLine?.(next);
      if (line) void bridge.updateModelContext(line);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * One tool call from the draft editor.
   *
   * Differs from `run` in two ways that matter, both from contract §8:
   *
   *  - it hands the resulting envelope back, because the editor's own flows
   *    need it. A save on IMAP returns a NEW draft_id, and the send that
   *    follows a save must use that one, not the id this card mounted with.
   *  - an error envelope must not take the editor away. `state: "error"` means
   *    the server changed nothing, and the user's unsaved text is still in the
   *    textarea, so if the error carries no `draft` the current one is kept and
   *    the editor renders the error as a notice around it. Replacing the
   *    envelope wholesale would answer "that address was rejected" by deleting
   *    the message the user was writing.
   *
   * That second rule now lives in `store.ts#mergeEnvelope`, because the PUSH
   * path needed exactly the same one and having it in only one of the two
   * places was the bug (WS-1b defect B).
   *
   * `tellModel` hands the whole exchange to whoever writes the model-context
   * line: the envelope as the server sent it, the raw result, and the message
   * of a call that threw. The line used to be written from the returned
   * envelope alone, and most of what a send or a discard can answer with is
   * not an envelope (model-context.ts#draftCallOutcome lists them), so those
   * outcomes reached the model as silence over a stale sentence.
   */
  //
  // ── AND NO FAILURE DOES, WHATEVER SHAPE IT ARRIVES IN (2026-10-13) ────────
  // That rule covered one shape of failure out of three, and QA found the
  // other two the same afternoon:
  //
  //   a failed RECEIPT   every draft tool's refusal. Renderable, so it replaced
  //                      the editor. Now merged around it (mergeEnvelope's
  //                      rule -1).
  //   a THROWN call      offline, a host timeout, a JSON-RPC error. It printed
  //                      the raw `-32603: Failed to fetch`. Now a code.
  //   an unreadable one  an answer that is not an envelope. Same.
  //
  // The second is the dangerous one, because "the call threw" does not mean
  // "nothing happened": the save QA lost the response to HAD been stored, under
  // a new id. So a write that ends without an answer leaves the draft
  // `unverified` (Save and Send off) until a re-read settles what the server
  // holds. Re-saving blind would be a second write against an id that may
  // already be retired; `readDraft` below is the recovery, and DraftEditor
  // keeps the user's edits across it (`rebaseEdit`).
  const callDraft = async (
    key: DraftAction,
    tool: string,
    args: Record<string, unknown>,
    opts: { failAs?: DraftAction; quiet?: boolean } = {},
  ): Promise<DraftCall> => {
    // `failAs`: the action the user sees as failed, when it is not the one the
    // busy state names (the save half of "Save and send" is a save).
    // `quiet`: a reconciling re-read, which must not wipe the notice of the
    // failure it is reconciling.
    const action = opts.failAs ?? key;
    let result: ToolResultParams | null = null;
    let raw: Envelope | null = null;
    let thrown: string | null = null;
    const told = (r: Omit<DraftCall, "call">): DraftCall => ({
      ...r,
      call: { envelope: raw, result, thrown },
    });
    callSeq.current += 1;
    const lose = (code: LostCode): DraftCall => {
      setFailure({ action, code, at: Date.now() });
      if (changesDraft(action)) setState({ draftCheck: "unverified" });
      return told({ env: null, lost: code });
    };
    setBusy(key);
    setError(null);
    if (!opts.quiet) {
      setFailure(null);
      clearDraftError();
    }
    try {
      result = await bridge.callServerTool(tool, args);
      const next = envelopeFrom(result);
      raw = next;
      lastAnswer.current = Date.now();
      if (!next) {
        // A bare `isError` sentence IS an answer: the server refused and did
        // not act (draft not found, sending quota, a mailbox to reconnect, the
        // approval queue). Said in a person's words, and Send is left as it
        // was; only a draft that cannot be found stops the editor offering to
        // write until a re-read. A send whose delivery the server itself calls
        // unknown, and an answer that is not even that, stay a lost answer:
        // the server may have acted (review 2 of 2026-10-13).
        const refused = tool === "draft" ? textRefusalCode(result) : null;
        if (refused === null) return lose("unreadable");
        setFailure({ action, code: refused, at: Date.now() });
        if (refused === "draft_not_found") setState({ draftCheck: "unverified" });
        return told({ env: null, lost: null, refused });
      }
      const applied = adoptOwnAnswer(next);
      if (isFailure(applied)) {
        const code = String(applied.receipt?.error_code ?? "");
        setFailure({ action, code, headline: applied.receipt?.headline ?? null, at: Date.now() });
        // The id on screen names nothing the server can find, or the copy on
        // screen is older than the draft (`draft_changed`), or the draft was
        // already sent. Nothing can be written from it, so stop offering to
        // until a re-read ("Load the newer version", Check again) settles it.
        if (
          code === "draft_not_found" || code === "draft_changed" ||
          code === "draft_already_sent"
        ) {
          setState({ draftCheck: "unverified" });
        }
        return told({ env: applied, lost: null, refused: code, headline: applied.receipt?.headline ?? null });
      }
      return told({ env: applied, lost: null });
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
      return lose("transport");
    } finally {
      setBusy(null);
    }
  };

  /** A save that actually stored something, as opposed to a refusal. */
  const draftStored = (env: Envelope | null): boolean =>
    !!env && env.card === "draft_editor" && env.state !== "error" && !!env.draft;

  /**
   * Re-read the draft and reconcile: Refresh, "Check again", the automatic
   * check of a replayed mount, and the re-read after a lost answer are all
   * this one function.
   *
   * Asks with the newest id the card knows first (`draftIdHint`, read out of
   * the restore stub) and then with the one on screen. With draft lineage on
   * the server either resolves to the current draft, and whatever id the
   * answer carries is adopted; without it the hint is the one that still
   * exists. A read that brings back a draft makes it `trusted`
   * (store.ts#adoptOwnAnswer); one that does not, while the draft was in doubt,
   * leaves it `unverified` with the reason on screen.
   */
  //
  // `auto`: the check of a replayed mount, which nobody asked for and which
  // runs before the person has touched the card. Only there may the answer
  // close the card: a draft the server says was sent or discarded becomes that
  // one-line receipt instead of an editor over text that no longer exists, and
  // a card that had already ended on a receipt (`priorReceipt`) goes back to it
  // unless the read brings a live draft. A check the person asked for keeps the
  // editor, because by then it may hold text they want to copy.
  const readDraft = async (
    opts: { quiet?: boolean; failAs?: DraftAction; auto?: boolean } = {},
  ): Promise<Envelope | null> => {
    const s = getState();
    const d = s.envelope?.draft;
    if (!d || s.envelope?.card !== "draft_editor") return null;
    if (s.draftCheck !== "trusted") setState({ draftCheck: "checking" });
    const ids = [...new Set([s.draftIdHint, d.draft_id])].filter(
      (id): id is string => !!id,
    );
    let applied: Envelope | null = null;
    let headline: string | null = null;
    for (const id of ids) {
      const r = await callDraft(
        "refresh",
        "draft_read",
        { inbox_id: d.identity?.inbox_id, draft_id: id },
        opts,
      );
      applied = r.env;
      headline = r.refused === "draft_not_found" ? r.headline ?? null : null;
      if (r.lost) break;
      const missing = !!applied && isFailure(applied) &&
        applied.receipt?.error_code === "draft_not_found";
      if (!missing) break;
    }
    if (!draftStored(applied) && opts.auto) {
      const prior = getState().priorReceipt;
      const how = closedHow(headline);
      if (prior) {
        setFailure(null);
        setState({ envelope: prior, priorReceipt: null, draftCheck: "trusted", draftIdHint: null });
        return null;
      }
      if (how) {
        closeDraft(how);
        return null;
      }
    }
    if (!draftStored(applied) && getState().draftCheck === "checking") {
      setState({ draftCheck: "unverified", draftIdHint: null });
    }
    return draftStored(applied) ? applied : null;
  };

  /**
   * End the card on a one-line receipt for a draft that no longer exists: the
   * same place a successful discard or send leaves it. `gone` is a draft the
   * server could not find without knowing why.
   */
  const closeDraft = (how: "sent" | "discarded" | "gone", copy?: EndedCopy) => {
    const env = getState().envelope;
    if (copy) keepEnded(copy, env?.draft?.identity?.inbox_id);
    const receipt: ReceiptData = how === "sent"
      ? {
        outcome: "sent",
        headline: "This draft was already sent.",
        detail: "It is in your Sent folder.",
        affected_count: 0,
        dashboard_url: null,
      }
      : {
        outcome: "discarded",
        headline: how === "discarded"
          ? "This draft was discarded."
          : "This draft is no longer in Drafts.",
        detail: how === "discarded"
          ? "It was removed from Drafts and nothing was sent."
          : "It was probably sent or deleted already. Nothing else was changed.",
        affected_count: 0,
        dashboard_url: null,
      };
    setFailure(null);
    setState({
      envelope: {
        schema_version: env?.schema_version ?? SCHEMA_VERSION,
        card: "receipt",
        state: how === "sent" ? "sent" : "rejected",
        dashboard_url: env?.dashboard_url,
        receipt,
      },
      draftCheck: "trusted",
      draftIdHint: null,
      priorReceipt: null,
      draftSuperseded: false,
    });
  };

  // ---- noticing a newer version when the person comes back to the card ------
  //
  // Nothing tells a mounted card that a later tool call rewrote its draft, so
  // an older card would sit there as a live editor over old text. When focus
  // comes into the frame and the last answer from the server is not recent, the
  // draft is read once more, silently: no busy state, no notice on failure. A
  // read that brings the draft back is adopted like any Refresh (unsaved edits
  // stay on top), and store.ts#supersededBy decides whether a newer card
  // exists. Dropped if the person started anything meanwhile.
  const callSeq = useRef(0);
  const lastAnswer = useRef(Date.now());
  const busyNow = useRef<string | null>(null);
  busyNow.current = busy;
  const attentionCheck = async () => {
    const s = getState();
    const d = s.envelope?.draft;
    if (!d || s.envelope?.card !== "draft_editor" || isRestoreStub(s.envelope)) return;
    if (s.draftCheck !== "trusted" || s.draftSuperseded || busyNow.current !== null) return;
    if (Date.now() - lastAnswer.current < REPLAY_AGE_MS) return;
    lastAnswer.current = Date.now();
    const seq = callSeq.current;
    const asked = d.draft_id;
    try {
      const next = envelopeFrom(
        await bridge.callServerTool("draft_read", {
          inbox_id: d.identity?.inbox_id,
          draft_id: asked,
        }),
      );
      if (seq !== callSeq.current || busyNow.current !== null) return;
      if (!draftStored(next) || isFailure(next)) return;
      const got = next!.draft!;
      if (got.draft_id !== asked && got.resolved_from !== asked) return;
      adoptOwnAnswer(next!);
    } catch {
      /* a check nobody asked for: the next action will say what is wrong */
    }
  };
  const onAttention = useRef(attentionCheck);
  onAttention.current = attentionCheck;
  useEffect(() => {
    const onFocus = () => void onAttention.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /**
   * After a write whose answer was LOST (transport error, unreadable answer),
   * find out what the server actually holds instead of guessing. QA's case: a
   * save answered `-32603: Failed to fetch` had in fact been stored, under a
   * new id, and the retry against the old id then failed as not found.
   *
   * The re-read is `quiet`, so the notice keeps saying what failed until this
   * can say how it ended; with draft lineage on the server it finds the draft
   * under its new id, and DraftEditor keeps the user's text across it either
   * way (`rebaseEdit`).
   */
  const reconcile = async (
    action: DraftAction,
    code: LostCode,
    patch: PatchFields | null,
  ) => {
    if (!changesDraft(action)) return;
    const env = await readDraft({ quiet: true, failAs: action });
    if (!env?.draft) return;
    const settled: Settled = action === "save"
      ? patch && patchLanded(patch, env.draft) ? "landed" : "not_landed"
      : "still_there";
    setFailure({ action, code, settled });
    if (settled === "landed") tellSaved(env.draft, patch);
  };

  /**
   * The model-context line for a save that stored. `bodyEdited` is sticky
   * until the agent writes the draft again (see the draft branch below), so a
   * subject-only save after a body edit still says the body is not the agent's.
   */
  const tellSaved = (draft: NonNullable<Envelope["draft"]>, patch: PatchFields | null) => {
    if (patch?.body_text !== undefined) bodyEdited.current = true;
    void bridge.updateModelContext(
      draftSavedContextLine(draft, { bodyEdited: bodyEdited.current }),
    );
  };

  const openDashboard = (path: string | null | undefined) => {
    const url = path ? absoluteUrl(path) : null;
    if (!url) return;
    setBusy("dashboard");
    bridge
      .openLink(url)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  // ---- restore recovery ---------------------------------------------------
  //
  // A card that restored from storage is holding a POINTER, not a copy: since
  // WS-1b, persist.ts keeps the card kind, the state and the opaque id the
  // server's own reader is called with — `inbox_id` + `draft_id` for a draft,
  // `approval_id` for a queued send — and nothing else. No subject, no body,
  // no recipients. So the restore is only half the recovery; this effect is
  // the other half, and until it lands there is nothing but a loading line.
  //
  // It runs exactly once, adopts whatever comes back, and on failure says so in
  // one line. It deliberately does NOT fall back to rendering the stub: an
  // editor with an empty subject and an empty body, sitting over a draft that
  // has both, is an invitation to overwrite the real thing — and a decision row
  // drawn from a stub would be a Reject button with nothing behind it.
  //
  // WHICH CARDS HAVE A READER, checked against the shipped tool definitions
  // rather than assumed (2026-09-16):
  //
  //   draft_editor    `draft_read`      — read-only, takes inbox_id + draft_id.
  //   outbound_review `approval_review` — read-only, takes approval_id, and its
  //                   own description says "so it can be shown in the review
  //                   card". It has existed since the card shipped; the card
  //                   simply never called it, which is what cost a remounted
  //                   pending send its Reject button. Approve was already only
  //                   `openLink(review_url)` and is not what was lost.
  //   bulk_plan       NOTHING. `mcp-app-bulk.ts` declares exactly two tools,
  //                   `bulk_execute` and `bulk_cancel`, and both DECIDE — there
  //                   is no reader for a plan, and inventing one out of a
  //                   decision tool would mean running the thing we wanted to
  //                   show. A plan is also server-held with a 15-minute TTL, so
  //                   a remount minutes later is usually looking at something
  //                   that has already expired. It stays on the one-liner, on
  //                   purpose: this is settled, do not re-litigate it.
  //   receipt         Terminal. Nothing to re-request; persist.ts rewrites the
  //                   headline from the outcome alone and it renders directly.
  //
  // Both decisions — which read a card kind has, and whether the answer may be
  // adopted — live in store.ts (`rehydrationCall`, `acceptRehydration`) rather
  // than inline here, so the harnesses can drive the shipped functions instead
  // of restating them. This effect is the wiring and the copy, nothing else.
  //
  // THE OPT-OUT'S HALF OF THIS, added 2026-09-17. `draft_read` refuses a
  // switched-off editor with a `card: "receipt"` envelope carrying
  // `error_code: "draft_editor_hidden"`. That matched neither of the two arms
  // below — it is not `draft_not_found`, and it is not a draft envelope — so it
  // fell through to `stubFailed` and the card answered a deliberate opt-out
  // with a generic "open the dashboard to see this". The receipt already says
  // the true thing, in the server's own words, with the way back in it; it is
  // now adopted (store.ts#EDITOR_STOP_CODES) and the ordinary receipt renderer
  // prints it for free. Deliberately NOT extended to every receipt:
  // `runDraftRead` also answers a transient IMAP blip with one, and adopting
  // that would replace a good restored draft with a one-line error — the same
  // event the `.catch()` arm below exists to tolerate, by a different route.
  const [gone, setGone] = useState<string | null>(null);
  // Model-context bookkeeping for the draft card. See the draft branch below.
  const bodyEdited = useRef(false);
  const agentWrote = useRef<string | null>(null);
  const [stubFailed, setStubFailed] = useState(false);

  // A card that has ended (sent, discarded, hidden, decided, gone) is one line.
  // In fullscreen that is one line on an empty page, so it asks for inline
  // again. Once, on arrival: the sent message can still be expanded afterwards.
  const ended = !!gone || (envelope?.card === "receipt" && !!envelope.receipt);
  useEffect(() => {
    if (ended && fullscreen) setFullscreen(false);
  }, [ended]);
  const refreshed = useRef(false);
  /** The stub's own re-request is still in flight. See the effect below it. */
  const stubRead = useRef(false);

  // A re-mounted DRAFT usually gets both halves at once: the stub out of
  // storage, whose re-request starts here, and a few milliseconds later the
  // host's replay of the original result, which replaces the stub with a full
  // (and stale) editor before the re-request has answered. The answer is then
  // about an editor, not a stub, and the stub rules below are the wrong ones
  // for it: "gone" would replace the editor with one line. So it is settled as
  // what it now is, the verification of that replay.
  const settleOverEditor = (asked: Envelope, result: unknown) => {
    const next = envelopeFrom(result as Parameters<typeof envelopeFrom>[0]);
    const decided = acceptRehydration(asked, next);
    if (decided.kind === "adopt" && decided.envelope.card === "draft_editor") {
      adoptOwnAnswer(decided.envelope);
      return;
    }
    // The stub's id did not bring the draft back. The replayed id still might.
    setState({ draftIdHint: null });
    if (getState().draftCheck !== "trusted") void readDraft({ auto: true });
  };
  useEffect(() => {
    if (store.restored !== "storage" || refreshed.current) return;
    const env = store.envelope;
    const call = rehydrationCall(env);
    if (!env || !call) return;

    // The STUB itself, not just its card kind: `acceptRehydration` correlates
    // the answer against the id this call asked about, and the stub is where
    // that id lives. Captured before the await so a later store write cannot
    // change what "asked" means.
    const asked = env;
    refreshed.current = true;
    stubRead.current = true;
    const overEditor = () => {
      const now = getState().envelope;
      return asked.card === "draft_editor" && !!now && !isRestoreStub(now);
    };
    bridge
      .callServerTool(call.tool, call.args)
      .then((result) => {
        stubRead.current = false;
        if (overEditor()) return settleOverEditor(asked, result);
        const decided = acceptRehydration(asked, envelopeFrom(result));
        // `adoptRehydration`, never a bare setState: a server answer about a
        // known id is the moment this card stops being a memory, and the push
        // path has to start correlating from here. A plain setState left
        // `pushAccepted` false and gave exactly one later pushed result a free
        // pass to rebind the card to a foreign draft or approval.
        if (decided.kind === "adopt") adoptRehydration(decided.envelope);
        else if (decided.kind === "gone") {
          setGone(
            decided.subject === "draft"
              ? "This draft is no longer in Drafts."
              : "This send is no longer pending.",
          );
        } else setStubFailed(true);
      })
      .catch(() => {
        stubRead.current = false;
        if (overEditor()) return settleOverEditor(asked, undefined);
        // Offline, or the host refused the call. There is nothing to show: the
        // stub has no content in it, by design.
        setStubFailed(true);
      });
  }, [store.restored, store.envelope]);

  // ---- a deferred draft body ----------------------------------------------
  //
  // `draft{action:"create"|"reply"|"update"}` leaves the body out of
  // `structuredContent` and puts it in the result's `_meta`. When the host
  // forwarded that, store.ts has already filled it in and none of this runs.
  // When it did not, the envelope on screen has a placeholder where its body
  // should be, and this effect asks `draft_read` for the real one.
  //
  // The shape is the restore recovery's, on purpose: the decisions (which read,
  // whether the answer may be adopted, which envelope is kept) live in store.ts
  // where the harness can drive them, and this is the wiring and the copy.
  //
  // Asked ONCE PER ENVELOPE, keyed on the draft and its version, so a second
  // deferred envelope for a different draft gets its own read and a failure is
  // remembered against the envelope it happened to. While it is in flight, and
  // after it has failed, the editor is NOT drawn: see the gate in the render
  // below.
  const bodyKey = deferredBodyKey(store.envelope);
  const askedBody = useRef<string | null>(null);
  const [bodyFailed, setBodyFailed] = useState<string | null>(null);
  useEffect(() => {
    if (bodyKey === null || askedBody.current === bodyKey) return;
    // A REPLAYED draft is re-read anyway (the check below, merged from main),
    // and that `draft_read` brings the body inline. Asking twice would double
    // every remount of a model-written draft card, so this read waits for that
    // one and only runs if it ended without a draft on screen.
    if (store.draftCheck === "pending" || store.draftCheck === "checking") return;
    const asked = getState().envelope;
    const call = deferredBodyCall(asked);
    if (!asked || !call) return;
    askedBody.current = bodyKey;
    bridge
      .callServerTool(call.tool, call.args)
      .then((result) => {
        // The store may have moved on while this was in flight; an answer to a
        // body nobody is waiting for any more changes nothing, in any arm.
        if (!awaitsBodyOf(asked)) return;
        const decided = acceptDeferredBody(asked, envelopeFrom(result));
        if (decided.kind === "adopt") adoptDeferredBody(asked, decided.envelope);
        else if (decided.kind === "gone") setGone("This draft is no longer in Drafts.");
        else setBodyFailed(bodyKey);
      })
      .catch(() => {
        if (awaitsBodyOf(asked)) setBodyFailed(bodyKey);
      });
  }, [bodyKey, store.draftCheck]);

  // ---- a replayed draft is checked before it is trusted ---------------------
  //
  // store.ts marks a pushed draft `pending` when it is a replay
  // (`isReplayedDraft`). This starts the re-read, unless the stub's own is
  // already on its way, in which case that one settles it. Declared after the
  // stub effect so that on the commit where both become true the stub's read
  // has been started first.
  useEffect(() => {
    if (store.draftCheck !== "pending") return;
    if (stubRead.current) setState({ draftCheck: "checking" });
    else void readDraft({ auto: true });
  }, [store.draftCheck]);

  /**
   * The envelope's own dashboard URL when there is one on screen, else the last
   * https one any envelope carried (persist.ts). The stored one is only written
   * once a cache key exists, which needs `tool-input`, so a card that has an
   * envelope in hand should not depend on it.
   */
  const fallbackDashboard = () => {
    const url = absoluteUrl(getState().envelope?.dashboard_url) ?? lastDashboardUrl();
    if (!url) return null;
    return (
      <div class="hdr-r">
        <TextLink onClick={() => openDashboard(url)}>Open dashboard</TextLink>
      </div>
    );
  };

  /** One line, a dot and a link. Never a wall, never a skeleton. */
  const oneLine = (text: string) => (
    <div class="hdr">
      <div class="hdr-l">
        <span class="dot" data-tone="neutral" aria-hidden="true" />
        <b>{text}</b>
      </div>
      {fallbackDashboard()}
    </div>
  );

  const body = ((): VNode | null => {
    // ---- connection / loading ----------------------------------------------

    // The host never completed `ui/initialize`, even across retries. The
    // message above this card already carries every fact, so this is a quiet
    // one-liner with a way out rather than a red block announcing a failure the
    // user cannot act on and that cost them nothing.
    if (store.connectError) {
      return oneLine(`${toolLabel(store.toolInfo?.tool)}: not shown here.`);
    }

    // A restored card whose subject the server says is gone. One line, not the
    // editor's Refresh notice: see the re-request effect above.
    if (gone) return oneLine(gone);

    if (!envelope) {
      // NOT OUR PAYLOAD -> SILENCE. `_meta.ui` is per-tool, so the host renders
      // this card for every result of a UI-bearing tool, including ones that were
      // never going to produce an envelope: a delete on an inbox that has not
      // opted into bulk previews, or `email_organize` doing copy_batch / flag /
      // archive. Those operations succeeded. The host is already showing their
      // text result. A warning underneath it would invent a problem, so the card
      // renders nothing at all and lets the text stand.
      //
      // (`.card:empty` in styles.css collapses the shell so this leaves no empty
      // box and reports a zero height to the host's auto-fit.)
      //
      // The same judgement covers the two ways there is no payload at all:
      //
      //   cancelled — the host sent tool-cancelled. The call was abandoned and
      //               the host is already telling the user so. Adding our own
      //               notice under it would just be a second voice.
      //   absent    — the watchdog fired: connect() resolved and nothing
      //               followed. On Claude this is almost always a re-mount of an
      //               old conversation cell, where the tool call succeeded days
      //               ago and the spec simply owes a late-mounting view nothing
      //               (see store.ts). The send happened. Announcing "this review
      //               could not be displayed" over a send that went through is
      //               the exact scare this card refuses to raise. Silence.
      //
      // Three separate statuses, one rendering, on purpose: the distinction is
      // real and is kept where it is still known, and the fact that it does not
      // change what the user sees is the point rather than a redundancy.
      //
      // CORRECTION, 2026-10-12: silence is not what the user gets. Claude keeps
      // its own "Widget from ..." header and an empty container over a frame
      // that reports height 0, so "nothing at all" reads as a card that failed
      // to load. It is also not only the benign cases: a draft whose editor
      // could not be built server-side arrives here as `foreign` too. So both
      // now say so in one quiet line, the same shape as every other
      // nothing-to-show state. Still never a warning: the operation succeeded
      // and the message above carries it.
      if (store.resultStatus === "foreign") {
        return oneLine(`${toolLabel(store.toolInfo?.tool)}: no preview for this result.`);
      }
      if (store.resultStatus === "cancelled") {
        return oneLine(`${toolLabel(store.toolInfo?.tool)}: cancelled.`);
      }

      // OUR PAYLOAD, UNREADABLE -> LOUD. Something that identified itself as our
      // envelope could not be parsed. That is a real defect and a reviewer who
      // was expecting to see a send needs to know they are not seeing it.
      if (store.resultStatus === "malformed") {
        return (
          <Notice tone="warning">
            This review could not be displayed. Use the summary in the message
            above, or open the dashboard.
          </Notice>
        );
      }
      // NOTHING AT ALL, AND NOTHING REMEMBERED. `restored: "none"` is only set
      // once the watchdog has fired and the lookup has actually missed, so this
      // is a settled fact rather than "not yet". Before the storage cache this
      // path rendered silence, on the theory that a send which already happened
      // should not be second-guessed; with the cache in place, silence now
      // means "this host keeps nothing", and a user who scrolled back to a card
      // deserves to be told which tool it was and where the record lives.
      if (store.restored === "none") {
        return oneLine(`${toolLabel(store.toolInfo?.tool)}: nothing to show here.`);
      }

      // Still genuinely waiting. At most RESULT_WATCHDOG_MS of this.
      //
      // Gated on `connected`, which is the difference between "waiting" and
      // "never started". Measured in Claude on 2026-09-16: a RE-MOUNTED card
      // paints once and then never executes again — its diagnostics line reads
      // `hs 0`, and `initializeAttempts` is incremented synchronously inside
      // connect() in the same tick as this very render, so a painted 0 is the
      // pre-connect first paint and nothing after it ever ran. No microtask, no
      // timer, no handshake.
      //
      // A spinner is a promise that something is coming. In that frame nothing
      // is, and it is the only frame the user will ever see, so the promise is
      // a lie that sits on screen forever: "simply not loading". Rendering
      // nothing instead lets `.card:empty` collapse the shell, leaving the
      // host's own header and the message text below it to carry the result,
      // which they already do in full.
      //
      // This does not fix the remount. Nothing on this side can: the card is
      // not running. It stops the failure from being loud.
      //
      // CORRECTION, 2026-10-12: the gate is gone, and the paragraph above is
      // why rather than in spite of itself. Its whole case for `null` rests on
      // "`.card:empty` collapses the shell, leaving the host's own header and
      // the message text below it to carry the result" — and that premise is
      // false in Claude, measured the same day as the subscription race above:
      // the host keeps its "Widget from ..." header and an empty container over
      // a frame reporting height 0, so the pre-handshake frame is not invisible,
      // it is the sliver the founder complained about. Given that the frame is
      // on screen either way, one line is the honest content for it.
      //
      // It is also BOUNDED, which the "a lie that sits on screen forever"
      // objection assumed it was not: connect() shares one
      // INITIALIZE_TIMEOUT_MS deadline across its retries, so a host that never
      // answers rejects within 10s and `store.connectError` replaces this with
      // the "not shown here" one-liner. The only way this line can persist is a
      // frame whose timers never run at all, and in that frame there is nothing
      // else the card could have drawn instead.
      return <Loading />;
    }

    // ---- version gate -------------------------------------------------------

    if (!isSupportedVersion(envelope.schema_version)) {
      return (
        <>
          <div class="hdr">
            <div class="hdr-l">
              <span class="dot" data-tone="neutral" aria-hidden="true" />
              <b>Update the MCP Emails connector</b>
            </div>
            <div class="hdr-r">
              <TextLink onClick={() => openDashboard(envelope.dashboard_url)}>
                Open dashboard
              </TextLink>
            </div>
          </div>
          <p class="line">
            This card understands <span class="mono">{SCHEMA_VERSION}</span>, but
            the server sent{" "}
            <span class="mono">{String(envelope.schema_version).slice(0, 40)}</span>
            . Rather than guess at the contents, it will not render them.
          </p>
        </>
      );
    }

    // ---- a restored card is a pointer, not a copy ---------------------------
    //
    // Everything that is not a receipt has to be fetched again before it can be
    // rendered, because the stub has no content in it. A draft and a queued
    // send are both fetched by the effect above, and this is the line the user
    // sees while that is in flight.
    //
    // A BULK PLAN is the one card that genuinely has nowhere to go, and that is
    // a deliberate trade rather than an oversight: there is no reader for a
    // plan (see the effect above — `bulk_execute` and `bulk_cancel` are the
    // only two tools and both DECIDE), the plan is server-held with a 15-minute
    // TTL so a remount is usually looking at something already expired, and the
    // stub was a MEMORY of a decision the server may already have made. One
    // line and a link to the place that knows the truth is the honest
    // rendering. Settled 2026-09-16 against the shipped tool list; do not
    // re-open it by inventing a read out of a decision tool.
    //
    // A receipt stub is exempt: it is terminal, there is nothing to re-request,
    // and persist.ts rewrites its headline from the outcome alone.
    if (isRestoreStub(envelope) && envelope.card !== "receipt") {
      const hydrating =
        !stubFailed &&
        ((envelope.card === "draft_editor" && !!envelope.draft?.draft_id) ||
          (envelope.card === "outbound_review" && !!envelope.outbound?.approval_id));
      return hydrating ? (
        <Loading />
      ) : (
        oneLine(`${toolLabel(store.toolInfo?.tool)}: open the dashboard to see this.`)
      );
    }

    // ---- a draft whose body has not arrived ---------------------------------
    //
    // The host dropped the result's `_meta`, so the body is being fetched (the
    // effect above). Until it lands this is the loading line and NOT the
    // editor, for the same reason a restore stub is never drawn as one: the
    // placeholder reads as an empty body, the envelope's `version` already
    // describes the real one, so an editor mounted now would never resync and
    // its first Save would write the blank over the draft. No Save, no Send, no
    // textarea exists in this state, which is the only way to be sure of that.
    //
    // If the fetch fails it ends on the same one line a failed restore does,
    // with the dashboard link. The draft itself is fine: it is in Drafts, and
    // the message above this card says so.
    if (isBodyDeferred(envelope)) {
      return bodyFailed === bodyKey
        ? oneLine(`${toolLabel(store.toolInfo?.tool)}: open the dashboard to see this.`)
        : <Loading />;
    }

    // ---- variants -----------------------------------------------------------

    if (envelope.card === "outbound_review" && envelope.outbound) {
      const o = envelope.outbound;
      return (
        <>
          <OutboundReview
            env={envelope}
            outbound={o}
            provider={envelope.provider}
            fullscreen={fullscreen}
            canExpand={canExpand}
            busy={busy}
            error={error}
            actions={{
              reject: () =>
                run(
                  "reject",
                  "approval_decide",
                  { approval_id: o.approval_id, decision: "reject" },
                  (answer) => outboundRejectContextLine(o, answer),
                ),
              approve: () => {
                const url = o.review_url;
                if (!url || !/^https:\/\//i.test(url)) {
                  setError("This send has no valid approval link.");
                  return;
                }
                setBusy("approve");
                setError(null);
                bridge
                  .openLink(url)
                  .then(() => {
                    setApproveOpened(true);
                    void bridge.updateModelContext(outboundApproveOpenedContextLine(o));
                  })
                  .catch((e) =>
                    setError(e instanceof Error ? e.message : String(e)),
                  )
                  .finally(() => setBusy(null));
              },
              update: (patch) =>
                run("update", "approval_update", {
                  approval_id: o.approval_id,
                  ...patch,
                }),
              schedule: (sendAtIso) =>
                run("schedule", "approval_schedule", {
                  approval_id: o.approval_id,
                  send_at: sendAtIso,
                }),
              openDashboard: () => openDashboard(envelope.dashboard_url),
              setFullscreen,
            }}
          />
          {approveOpened && (
            <Notice tone="success">
              Approval page opened in your browser. This card updates the next time
              the agent checks.
            </Notice>
          )}
        </>
      );
    }

    if (envelope.card === "bulk_plan" && envelope.plan) {
      const plan = envelope.plan;
      return (
        <BulkPlan
          env={envelope}
          plan={plan}
          provider={envelope.provider}
          fullscreen={fullscreen}
          canExpand={canExpand}
          busy={busy}
          error={error}
          actions={{
            execute: () =>
              run(
                "execute",
                "bulk_execute",
                { plan_id: plan.plan_id },
                (answer) => bulkExecuteContextLine(plan, answer),
              ),
            cancel: () => {
              // Cancelling is purely local: the card stops offering the button
              // and the plan expires on its own (server-held, 15 min TTL).
              //
              // Corrected 2026-09-16: this comment used to claim contract v1
              // has no `bulk_cancel` tool. It does (mcp-app-bulk.ts, takes only
              // `plan_id`). Whether the card should call it to RECORD the
              // decision instead of letting the plan lapse is a real question
              // and is open; the behaviour is unchanged here because a server
              // write is not a comment fix.
              const receipt: ReceiptData = {
                outcome: "cancelled",
                headline: "Cancelled. Nothing was changed.",
                detail: `The plan to ${bulkVerb(plan.action).toLowerCase()} ${plan.match_count} messages was not run. It expires on its own.`,
                affected_count: 0,
                dashboard_url: null,
              };
              setEnvelope({
                schema_version: envelope.schema_version,
                card: "receipt",
                state: "rejected",
                receipt,
              });
              void bridge.updateModelContext(bulkCancelContextLine(plan));
            },
            setFullscreen,
          }}
        />
      );
    }

    // A card that had ended on a receipt stays on it while the replayed draft
    // is checked (store.ts#priorReceipt), instead of flashing an editor.
    //
    // Not only `pending` and `checking`: a check whose answer is "not found"
    // passes through `unverified` for one render before readDraft puts the
    // receipt back, and that render drew the editor over the assistant's
    // original text for a frame (and threw away an open "Show"). The receipt
    // is held for as long as `priorReceipt` is, which readDraft always settles.
    if (
      envelope.card === "draft_editor" && store.priorReceipt?.receipt &&
      store.draftCheck !== "trusted"
    ) {
      const view = endedView(store.priorReceipt);
      if (view) {
        return (
          <SentMessage
            receipt={store.priorReceipt.receipt}
            copy={view.copy}
            startOpen={view.startOpen}
            fullscreen={fullscreen}
            canExpand={canExpand}
            busy={busy}
            onOpenDashboard={() => openDashboard(store.priorReceipt?.receipt?.dashboard_url)}
            setFullscreen={setFullscreen}
          />
        );
      }
      return (
        <Receipt
          receipt={store.priorReceipt.receipt}
          busy={busy}
          onOpenDashboard={() => openDashboard(store.priorReceipt?.receipt?.dashboard_url)}
        />
      );
    }

    if (envelope.card === "draft_editor" && envelope.draft) {
      const d = envelope.draft;
      // Read at call time, never closed over: on IMAP every save retires the id
      // and returns a new one, and the next call has to use the live one (§8,
      // `id_is_stable: false`). The store already holds whatever the last
      // response adopted.
      const target = () => ({
        inbox_id: d.identity?.inbox_id,
        draft_id: getState().envelope?.draft?.draft_id ?? d.draft_id,
      });
      // Which revision of the draft the person is looking at, read at call time
      // like the id. Sent with every save and send so the server refuses a
      // write against a draft rewritten since (`draft_changed`) instead of
      // following its lineage to a version this card never showed. 0 when the
      // server records no revision for this draft.
      const writeTarget = () => {
        const rev = getState().envelope?.draft?.revision;
        return {
          ...target(),
          base_revision: typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? rev : 0,
        };
      };

      // Has a save from THIS card changed the body since the agent last wrote
      // it? Kept across saves because each model-context line replaces the last:
      // a body edit followed by a subject-only save must still say the body is
      // no longer the agent's. Cleared when an agent-authored envelope arrives
      // (`origin` create, reply or update), which is the agent writing the body
      // again. A read does not clear it: `draft_read` cannot know who wrote
      // what it returns and stamps every answer "agent".
      const agentKey = `${d.draft_id} ${d.version ?? ""}`;
      if (
        (d.origin === "create" || d.origin === "reply" || d.origin === "update") &&
        agentWrote.current !== agentKey
      ) {
        agentWrote.current = agentKey;
        bodyEdited.current = false;
      }

      const save = async (patch: DraftPatch): Promise<boolean> => {
        if (Object.keys(patch).length === 0) return true;
        const r = await callDraft("save", "draft_editor_save", {
          ...writeTarget(),
          ...patch,
        });
        // Started, not awaited: the editor drops its record of what it sent
        // when this resolves false, and the re-read must land after that, or
        // its old content would be taken for the save's own answer.
        if (r.lost) {
          void reconcile("save", r.lost, patch);
          return false;
        }
        if (!draftStored(r.env)) return false;
        tellSaved(r.env!.draft!, patch);
        return true;
      };

      /**
       * Tell the model what became of one draft action, from what the server
       * actually answered (model-context.ts#draftCallOutcome). `aimedAt` is the
       * draft as it was when the button was pressed, after any save that ran
       * first: the live id for every outcome in which the draft still exists,
       * and the last id it had in the two in which it does not.
       */
      const tellAction = (
        action: "send" | "discard" | "hide",
        aimedAt: typeof d,
        r: DraftCall,
        scope?: "inbox" | "workspace",
      ) => {
        void bridge.updateModelContext(
          draftActionContextLine(action, aimedAt, draftCallOutcome(action, r.call), {
            bodyEdited: bodyEdited.current,
            scope,
          }),
        );
      };

      return (
        <DraftEditor
          env={envelope}
          draft={d}
          provider={envelope.provider}
          fullscreen={fullscreen}
          canExpand={canExpand}
          busy={busy}
          error={error}
          failure={failure}
          check={store.draftCheck}
          idHint={store.draftIdHint}
          scope={draftScope}
          sendDoubt={sendDoubt}
          superseded={store.draftSuperseded}
          actions={{
            save,
            allowSend: () => setSendDoubt(false),
            send: async (patch) => {
              // Unsaved changes are written first and the send is abandoned if
              // that write fails, so a send never puts the stored draft on the
              // wire when the user is looking at a newer one.
              if (sendDoubt) return;
              if (patch && Object.keys(patch).length > 0) {
                const saved = await callDraft(
                  "send",
                  "draft_editor_save",
                  { ...writeTarget(), ...patch },
                  { failAs: "save" },
                );
                if (saved.lost) {
                  void reconcile("save", saved.lost, patch);
                  return;
                }
                if (!draftStored(saved.env)) return;
                tellSaved(saved.env!.draft!, patch);
                // No "the save followed an older id" stop here any more: the
                // server refuses such a save as `draft_changed` (contract §8),
                // so a stored save never carries `resolved_from`.
              }
              const aimedAt = getState().envelope?.draft ?? d;
              const sent = await callDraft("send", "draft", { action: "send", ...writeTarget() });
              // Said for a lost answer too: "the card does not know whether it
              // was sent" is true, and silence would leave the last line (a
              // save) standing as if nothing had been pressed.
              tellAction("send", aimedAt, sent);
              if (sent.lost) {
                setSendDoubt(true);
                void reconcile("send", sent.lost, null);
                return;
              }
              // What went out: the draft the send was made from, which the
              // save above (if any) has already made the screen's.
              const done = sent.env;
              if (done && isDepartedReceipt(done) && done.draft) {
                const how = done.receipt?.outcome === "scheduled" ? "scheduled" : "sent";
                keepEnded(
                  endedFrom(done.draft, how, how, { sent_at: done.sent_at, provider: envelope.provider?.label }),
                  done.draft.identity?.inbox_id,
                );
              }
            },
            discard: async (screen?: OnScreen) => {
              // The copy the person was looking at, taken before the call: the
              // answer replaces it. Kept only once the draft is known to be gone.
              const held = getState().envelope?.draft ?? d;
              const copyOf = (
                how: "discarded" | "gone" | "sent_elsewhere",
                outcome: "discarded" | "sent",
              ) => endedFrom(held, how, outcome, { screen, provider: envelope.provider?.label });
              const r = await callDraft("discard", "draft", {
                action: "delete",
                ...target(),
              });
              if (r.lost) {
                tellAction("discard", held, r);
                void reconcile("discard", r.lost, null);
                return;
              }
              // Already gone is where Discard was going. It used to leave the
              // same "could not be found" notice on screen, so the click
              // looked like it did nothing (QA, 2026-10-13).
              if (r.refused === "draft_not_found" || r.refused === "draft_already_sent") {
                const how = closedHow(r.headline) ??
                  (r.refused === "draft_already_sent" ? "sent" : "gone");
                closeDraft(
                  how,
                  how === "sent" ? copyOf("sent_elsewhere", "sent") : copyOf(how, "discarded"),
                );
                const id = held.draft_id || "unknown";
                void bridge.updateModelContext(
                  how === "sent"
                    ? `The user pressed Discard on draft ${id} in the MCP Emails card, but that draft had already been sent. Nothing was deleted, and that draft_id no longer resolves.`
                    : `The user pressed Discard on draft ${id} in the MCP Emails card. It was already gone from Drafts, so that draft_id no longer resolves.`,
                );
                return;
              }
              tellAction("discard", held, r);
              if (
                r.env?.card === "receipt" && !isFailure(r.env) &&
                r.env.receipt?.outcome === "discarded"
              ) {
                keepEnded(copyOf("discarded", "discarded"), held.identity?.inbox_id);
              }
            },
            refresh: () => void readDraft(),
            loadCurrent: () => readDraft().then((env) => !!env),
            // The opt-out. `scope` is passed through from the card's confirm
            // row rather than defaulted here, because "hide this" is ambiguous
            // between this mailbox and every mailbox and the two are different
            // wishes. The result is a receipt, so the card flips to one line
            // the way it does for send and discard. The server reuses the
            // outcome word `discarded` for it, which is why the model-context
            // line is chosen by ACTION: nothing was discarded.
            hide: async (scope) => {
              const aimedAt = getState().envelope?.draft ?? d;
              const r = await callDraft("hide", "draft_editor_hide", {
                ...target(),
                scope,
              });
              tellAction("hide", aimedAt, r, scope);
              // The server's detail ends with how the MODEL turns the card back
              // on ("Call draft_editor_hide again with scope... hidden:false"),
              // which is no use to the person reading it. The card says where
              // THEY turn it back on: the dashboard's own switch, named as the
              // dashboard names it (apps/web messages, "draftEditor.show").
              const done = r.env;
              if (
                done?.card === "receipt" && done.state !== "error" &&
                done.receipt && done.receipt.outcome !== "failed"
              ) {
                setEnvelope({
                  ...done,
                  receipt: { ...done.receipt, detail: hiddenDetail(scope) },
                });
              }
            },
            setFullscreen,
          }}
        />
      );
    }

    if (envelope.card === "receipt" && envelope.receipt) {
      // A DRAFT THAT ENDED, still holding the message it had.
      //
      // `endedView` decides whether there is a copy the card can stand behind:
      // the draft its own Send went out with (also on the receipt, through
      // `store.ts#carrySentDraft`), the text on screen at its own Discard, or
      // the copy an earlier mount of this card kept in this tab (ended.ts). A
      // refusal, the assistant's own send, and a receipt restored with nothing
      // kept get none, and fall through to `Receipt`, which is the normal case
      // for every other receipt there is.
      //
      // The receipt is still what is true: `SentMessage` takes its headline,
      // its detail and its dashboard link from it, and the copy is rendered
      // underneath as a read-only record, folded behind "Show" except right
      // after a send made here.
      const view = endedView(envelope);
      if (view) {
        return (
          <SentMessage
            receipt={envelope.receipt}
            copy={view.copy}
            startOpen={view.startOpen}
            fullscreen={fullscreen}
            canExpand={canExpand}
            busy={busy}
            onOpenDashboard={() =>
              openDashboard(envelope.receipt?.dashboard_url ?? envelope.dashboard_url)
            }
            setFullscreen={setFullscreen}
          />
        );
      }
      return (
        <Receipt
          receipt={envelope.receipt}
          busy={busy}
          onOpenDashboard={() => openDashboard(envelope.receipt?.dashboard_url ?? envelope.dashboard_url)}
        />
      );
    }

    // Known schema version, but the payload does not match its own discriminator.
    return (
      <Notice tone="warning">
        This review is missing its details. Open the dashboard to see the full
        request.
      </Notice>
    );
  })();

  // The diagnostics line rides along with whatever the card rendered, and
  // never alone: the paths that render nothing (a foreign payload, a cancelled
  // call) must keep rendering nothing, or every successful delete on an
  // opted-out inbox grows a stray line of protocol trivia underneath it.
  if (body === null) return null;
  if (!diagnosticsEnabled(envelope)) return body;
  return (
    <>
      {body}
      <Diagnostics bridge={bridge} />
    </>
  );
}
