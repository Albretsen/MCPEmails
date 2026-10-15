import { isOpenInReader } from "./conversation-store";
import { create } from "zustand";
import { getAssistantTransport } from "../api";
import type {
  ApprovalDecision,
  ApprovalDraft,
  AssistantCard,
  AssistantChip,
  AssistantEvent,
  AssistantToolCall,
  DraftFields,
  MailEffect,
  ToolCallState,
  ToolName,
} from "../api/assistant-api";
import {
  type AssistantAllowance,
  type FolderRef,
  type MessageKey,
  type MessageRow,
  folderRefId,
  isAllowanceExhausted,
  parseKey,
} from "../api/types";
import { applyFlags, findRow, refreshFolders, refreshLists, removeMovedRows } from "../data/cache";
import { keys } from "../data/keys";
import { queryClient } from "../data/query-client";
import { onKeyRemap } from "../data/remap";
import { getPlatform } from "../platform";
import { useComposeStore } from "./compose-store";
import { refuseWrite } from "./permissions";
import { useSelectionStore } from "./selection-store";
import { showToast } from "./toast-store";
import { useUiStore } from "./ui-store";

/* The assistant's transcript and everything it makes visible in the mail UI:
 * which rows it is touching, what it moved, what it labelled.
 *
 * `run()` consumes an AssistantTransport event stream and feeds each event to
 * `applyEvent`, the generic reducer. The reducer is the whole client side of
 * the assistant: a scripted mock and the real server drive the same code.
 */

export interface AssistantCardView extends AssistantCard {
  /** The user pressed it. */
  done: boolean;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  calls: AssistantToolCall[];
  cards: AssistantCardView[];
  chips: AssistantChip[];
  run_id: string | null;
  /** Which request this belongs to (1, 2, 3...). The user's message and every
   *  reply to it share one, so earlier requests can be collapsed. */
  turn: number;
  /** User messages: the emails that were attached as a chip. */
  context: { keys: MessageKey[]; label: string } | null;
  /** An error the server called retryable: the panel offers "Try again". */
  retryable?: boolean;
}

export interface TouchInfo {
  tool: ToolName;
  call_id: string;
  message_id: string;
  state: ToolCallState;
}

/** A row the assistant moved, kept faded in place until cleared. */
export interface Ghost {
  from: FolderRef | null;
  to: FolderRef;
  /** The row as it was, so the list can keep showing it after a refetch. */
  row: MessageRow | null;
  run_id: string | null;
}

/** In-app version of the "assistant wants to send" push notification. */
export interface PushNotice {
  approval_id: string | null;
  text: string;
  draft: ApprovalDraft;
  external?: boolean;
}

/** What the assistant last did with an email. Drives the follow-up suggestions. */
export type LastAct = "draft" | "about" | "sender" | "sent" | "archived";

export interface RunOptions {
  /** Emails attached as context. Empty or omitted = all mail. */
  keys?: MessageKey[];
  /** Chip label shown on the user's message. */
  contextLabel?: string;
  intent?: string;
  /** Do not check the allowance (first-run walkthrough). */
  free?: boolean;
  /** Do not add a user bubble (the run was started by a button). */
  silent?: boolean;
}

export interface AssistantState {
  messages: AssistantMessage[];
  busy: boolean;
  status: string;
  progress: { i: number; n: number } | null;
  /** Id of the run in flight, or of the last one. */
  runId: string | null;
  conversationId: string;
  /** HTTP transport: the server's opaque state of each conversation, from
   *  its last `done` event. Sent back with the next run of that conversation. */
  conversations: Record<string, unknown>;
  /** The month's allowance is used up (the server said so, or the cached
   *  allowance does). The panel shows when it resets; nothing is retried. */
  allowanceBlocked: boolean;
  /** Rows a tool call is touching right now. */
  aiTouch: Record<MessageKey, TouchInfo>;
  ghosts: Record<MessageKey, Ghost>;
  /** Rows animating out. */
  leaving: Record<MessageKey, true>;
  /** Rows that just arrived (highlighted for ~1.4 s). */
  fresh: Record<MessageKey, true>;
  /** Short tags on rows, e.g. "needs reply". */
  labels: Record<MessageKey, string>;
  /** The last call that touched a row, for the row -> transcript link. */
  lastTrace: Record<MessageKey, { tool: ToolName; call_id: string; message_id: string }>;
  /** "+N" next to a folder, keyed by folderRefId. Clears itself after 2.4 s. */
  folderBump: Record<string, number>;
  /** Transcript call highlighted because its row is hovered. */
  linkCall: string | null;
  /** Row highlighted because its call or chip is hovered. */
  linkEmail: MessageKey | null;
  /** Rows highlighted because the context chip is hovered. */
  hoverKeys: MessageKey[];
  /** New mail held back while the pointer is over the list. */
  pendingNew: MessageRow[];
  push: PushNotice | null;
  /** The assistant wrote something while the transcript was scrolled up. */
  newBelow: boolean;
  /** Result of the last finished run, with whether it can be undone. */
  lastSummary: { text: string; undoable: boolean; run_id: string | null } | null;
  /** A change to the list is waiting for the pointer to leave it. */
  holdNote: boolean;
  /** Number of the request in flight, or of the last one. */
  turn: number;
  /** Requests older than the last three are shown too. */
  showEarlier: boolean;
  lastAct: Record<MessageKey, LastAct>;

  run(text: string, opts?: RunOptions): Promise<void>;
  /** Asks the last request again (after a retryable error). No new user bubble. */
  retry(): Promise<void>;
  /** Why the last run ended early (`done.stopped`), or null. */
  lastStopped: string | null;
  stop(): void;
  /** New conversation. */
  clear(): void;
  applyEvent(event: AssistantEvent): void;
  /** Answers the approval the compose view is holding. */
  resolveApproval(decision: ApprovalDecision): Promise<void>;
  undoRun(run_id?: string): Promise<void>;
  markCardDone(message_id: string, card_id: string): void;

  setTouch(key: MessageKey, info: TouchInfo | null): void;
  addGhost(key: MessageKey, ghost: Omit<Ghost, "row" | "run_id"> & { row?: MessageRow | null }): void;
  /** Drops the faded rows from the lists for good. */
  clearGhosts(): void;
  setLeaving(keys: MessageKey[], leaving: boolean): void;
  markFresh(keys: MessageKey[]): void;
  setLabel(keys: MessageKey[], label: string | null): void;
  bumpFolder(folder: FolderRef | string, n?: number): void;
  setLinkCall(call_id: string | null): void;
  setLinkEmail(key: MessageKey | null): void;
  setHoverKeys(keys: MessageKey[]): void;
  addPendingNew(rows: MessageRow[]): void;
  /** Empties `pendingNew` and returns what was in it. */
  takePendingNew(): MessageRow[];
  setPush(push: PushNotice | null): void;
  setNewBelow(v: boolean): void;
  setHoldNote(v: boolean): void;
  setShowEarlier(v: boolean): void;
  /** Brings a tool call into view in the transcript (opens the panel if needed). */
  showCall(call_id: string): void;
  /** "Review" on the wants-to-send notice: opens the held draft under its email. */
  reviewPush(): void;
  /** Back to a blank assistant (profile switch in the Scenes menu). */
  reset(): void;
}

export const FOLDER_BUMP_MS = 2400;
export const FRESH_MS = 1400;
/** How long a moved row fades out before it settles as a ghost. */
export const LEAVING_MS = 200;
/** After the pointer leaves the list, how long before held changes apply. */
export const HOLD_RELEASE_MS = 150;

let seq = 1;
const nextId = (p: string) => `${p}${seq++}`;
const newConversationId = () => `conv_${Date.now().toString(36)}_${seq++}`;

let controller: AbortController | null = null;
let lastRequest: { text: string; opts: RunOptions } | null = null;
const bumpTimers = new Map<string, ReturnType<typeof setTimeout>>();

const ACTIVE: ReadonlySet<ToolCallState> = new Set<ToolCallState>(["running", "waiting", "held"]);

function emptyMessage(id: string, role: AssistantMessage["role"], run_id: string | null, turn: number): AssistantMessage {
  return { id, role, text: "", streaming: false, calls: [], cards: [], chips: [], run_id, turn, context: null };
}

/* ---- "nothing moves under the pointer" ----
 * Changes that would shift or fade rows are queued while the pointer is on the
 * list and applied shortly after it leaves. The backend has already made the
 * change; only showing it waits. */
interface HeldChange {
  run_id: string | null;
  /** Show the "waits until your pointer leaves" note for this one. */
  note: boolean;
  apply: () => void;
}
let heldChanges: HeldChange[] = [];
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function pointerOnList(): boolean {
  const ui = useUiStore.getState();
  return ui.listHover && ui.viewport !== "phone";
}
const hasHeldNote = () => heldChanges.some((h) => h.note);

/** What a finished request did, from its tool calls. */
function classifyAct(calls: AssistantToolCall[], single: boolean): LastAct | null {
  const done = calls.filter((c) => c.state === "done");
  if (done.some((c) => c.tool === "email_compose")) return "sent";
  if (calls.some((c) => c.tool === "draft" || c.tool === "email_compose")) return "draft";
  if (done.some((c) => c.tool === "email_organize" || c.tool === "email_search_and_move")) return "archived";
  if (done.some((c) => c.tool === "email_read")) return "about";
  if (single && done.some((c) => c.tool === "email_search")) return "sender";
  return null;
}

function pushText(d: ApprovalDraft): string {
  const parts = d.body.split("\n\n");
  const line = parts[1] ?? parts[0] ?? "";
  return `To ${d.to}: "${line.replace(/\s+/g, " ").trim()}"`;
}

export const useAssistantStore = create<AssistantState>((set, get) => {
  /** Finds an assistant message by id, creating it at the end if missing. */
  const upsertMessage = (id: string, fn: (m: AssistantMessage) => AssistantMessage) => {
    const { messages, runId, turn } = get();
    const i = messages.findIndex((m) => m.id === id);
    if (i < 0) set({ messages: [...messages, fn(emptyMessage(id, "assistant", runId, turn))] });
    else set({ messages: messages.map((m, j) => (j === i ? fn(m) : m)) });
  };

  /** Runs `apply` now, or once the pointer has left the list. */
  const whenListIdle = (note: boolean, apply: () => void) => {
    if (!pointerOnList() && !heldChanges.length) {
      apply();
      return;
    }
    heldChanges.push({ run_id: get().runId, note, apply });
    if (note && !get().holdNote) set({ holdNote: true });
  };

  const applyMoved = (effect: MailEffect, to: FolderRef, run_id: string | null) => {
    const s = get();
    const ghosts = { ...s.ghosts };
    const leaving = { ...s.leaving };
    for (const key of effect.keys) {
      ghosts[key] = { from: effect.from ?? null, to, row: findRow(key) ?? null, run_id };
      leaving[key] = true;
    }
    // The row fades out, then settles as a faded "Moved to X" row in place
    // until `clearGhosts`. Nothing below it shifts.
    set({ ghosts, leaving });
    setTimeout(() => get().setLeaving(effect.keys, false), LEAVING_MS);
    s.bumpFolder(to, effect.keys.length);
    refreshFolders();
    refreshLists((meta) => meta.folder === folderRefId(to));
  };

  const applyMailEffect = (effect: MailEffect) => {
    const s = get();
    switch (effect.kind) {
      case "read":
        // The assistant read it. A highlight only: the row is not marked read.
        break;
      case "moved": {
        const to = effect.to;
        if (!to) break;
        const run_id = s.runId;
        whenListIdle(true, () => applyMoved(effect, to, run_id));
        break;
      }
      case "flagged":
        if (effect.flags) applyFlags(effect.keys, effect.flags);
        refreshFolders();
        break;
      case "drafted":
        s.bumpFolder({ role: "drafts" });
        void queryClient.invalidateQueries({ queryKey: keys.draftsRoot });
        whenListIdle(false, () => refreshLists((meta) => meta.folder === "drafts"));
        refreshFolders();
        break;
      case "sent": {
        s.bumpFolder({ role: "sent" });
        s.setLabel(effect.keys, null);
        whenListIdle(false, () => refreshLists((meta) => meta.folder === "sent" || meta.folder === "drafts"));
        refreshFolders();
        // An approved send leaves nothing to edit: close the draft it came from.
        const c = useComposeStore.getState().compose;
        if (c && (c.held || (c.ai && (!c.replyTo || effect.keys.includes(c.replyTo))))) {
          useComposeStore.getState().discard();
        }
        break;
      }
    }
  };

  /** Bcc of the draft the current run was started with, and what it answers. */
  let runBcc: { reply_to: MessageKey | undefined; bcc: string } | null = null;

  const applyDraftStream = (ev: Extract<AssistantEvent, { type: "draft_stream" }>) => {
    const store = useComposeStore.getState();
    let c = store.compose;
    const sameTarget = !!c && (ev.reply_to ? c.replyTo === ev.reply_to : !c.replyTo);
    if (!c || !sameTarget) {
      const inbox_id =
        ev.fields.inbox_id ?? (ev.reply_to ? parseKey(ev.reply_to).inbox_id : (c?.inbox_id ?? ""));
      if (ev.reply_to && !isOpenInReader(ev.reply_to, useSelectionStore.getState().selectedKey)) {
        useSelectionStore.getState().select(ev.reply_to);
      }
      store.open({
        mode: ev.reply_to ? (ev.kind === "reply_all" || ev.kind === "forward" ? ev.kind : "reply") : "new",
        inbox_id,
        to: ev.fields.to,
        cc: ev.fields.cc ?? "",
        bcc: runBcc && runBcc.reply_to === ev.reply_to ? runBcc.bcc : "",
        subject: ev.fields.subject,
        body: "",
        replyTo: ev.reply_to,
        ai: true,
      });
      c = useComposeStore.getState().compose;
    }
    if (!c) return;
    // Bcc is never in `patch`: the server does not carry it, so a Bcc the
    // person typed stays exactly as it is across anything the assistant does.
    const patch: Partial<typeof c> = { ai: true };
    const fields = ev.fields as Partial<DraftFields>;
    if (ev.phase === "editing") {
      // An edit says what the draft's header is NOW. A field that is present
      // is taken as it stands, empty included (the assistant removed the last
      // recipient: the line is cleared); a field that is absent was not
      // touched.
      if (typeof fields.to === "string") patch.to = fields.to;
      if (typeof fields.cc === "string") patch.cc = fields.cc;
      if (typeof fields.subject === "string") patch.subject = fields.subject;
    } else {
      // Writing: the header streams in piece by piece, and an empty field
      // only means "not there yet".
      patch.to = fields.to || c.to;
      patch.subject = fields.subject || c.subject;
      if (fields.cc) patch.cc = fields.cc;
    }
    if (ev.call_id && ev.message_id) patch.draftCall = { call_id: ev.call_id, message_id: ev.message_id };
    if (ev.done && ev.draft_id) patch.draft_id = ev.draft_id;
    if (ev.done) {
      const body =
        ev.body ??
        (c.streaming === "editing" && c.segments
          ? c.segments
              .filter((g) => g.k !== "del")
              .map((g) => g.t)
              .join("")
          : c.body + (ev.body_delta ?? ""));
      Object.assign(patch, { body, aiOriginal: body, streaming: null, segments: undefined, preEdit: undefined });
    } else if (ev.phase === "writing") {
      Object.assign(patch, { streaming: "writing", body: c.body + (ev.body_delta ?? ""), segments: undefined });
    } else {
      Object.assign(patch, {
        streaming: "editing",
        preEdit: c.streaming === "editing" ? c.preEdit : c.body,
        segments: ev.segments ?? c.segments,
      });
    }
    store.patch(patch);
  };

  /** Leaves the UI consistent after Stop or a broken stream. */
  const settle = (cancelMeta: string | null) => {
    const store = useComposeStore.getState();
    const c = store.compose;
    if (c?.streaming) {
      const body = c.streaming === "editing" ? (c.preEdit ?? c.body) : c.body;
      store.patch({ streaming: null, segments: undefined, preEdit: undefined, body, aiOriginal: body });
    }
    // HTTP: a run ENDS by asking for approval, and the answer comes later.
    // The hold survives a normal end; Stop or a failure is still a denial.
    const keepApproval = cancelMeta == null && getAssistantTransport().approvalsOutliveRun === true;
    if (c?.held && !keepApproval) store.patch({ held: undefined });
    set((s) => {
      const waitingKeys = new Set<MessageKey>();
      if (keepApproval) {
        for (const m of s.messages) for (const x of m.calls) if (x.state === "waiting") for (const k of x.keys) waitingKeys.add(k);
      }
      const aiTouch: Record<MessageKey, TouchInfo> = {};
      for (const k of waitingKeys) {
        const t = s.aiTouch[k];
        if (t) aiTouch[k] = t;
      }
      return {
        aiTouch,
        leaving: {},
        holdNote: hasHeldNote(),
        // An approval nobody answered is a denial: its notice goes with it.
        push: s.push?.approval_id && !keepApproval ? null : s.push,
        messages: s.messages.map((m) => ({
          ...m,
          streaming: false,
          calls:
            cancelMeta == null
              ? m.calls
              : m.calls.map((x) => (ACTIVE.has(x.state) ? { ...x, state: "cancelled" as const, meta: cancelMeta } : x)),
        })),
      };
    });
  };

  return {
    messages: [],
    busy: false,
    status: "",
    progress: null,
    runId: null,
    conversationId: newConversationId(),
    conversations: {},
    allowanceBlocked: false,
    aiTouch: {},
    ghosts: {},
    leaving: {},
    fresh: {},
    labels: {},
    lastTrace: {},
    folderBump: {},
    linkCall: null,
    linkEmail: null,
    hoverKeys: [],
    pendingNew: [],
    push: null,
    newBelow: false,
    lastSummary: null,
    holdNote: false,
    turn: 0,
    showEarlier: false,
    lastAct: {},

    run: async (text, opts = {}) => {
      if (get().busy) return;
      const allowance = queryClient.getQueryData<AssistantAllowance>(keys.allowance);
      if (!opts.free && allowance && isAllowanceExhausted(allowance)) {
        // No request, no retry: the panel says when the allowance resets.
        if (!get().allowanceBlocked) set({ allowanceBlocked: true });
        showToast(`You've used all ${(allowance.cap ?? 0).toLocaleString("en-US")} assistant actions this month.`);
        return;
      }
      if (get().allowanceBlocked) set({ allowanceBlocked: false });
      // A send still waiting for approval when the next request starts was
      // not approved (fail closed). The transport tells the assistant.
      if (getAssistantTransport().approvalsOutliveRun) {
        if (useComposeStore.getState().compose?.held) useComposeStore.getState().patch({ held: undefined });
        if (get().push?.approval_id) set({ push: null });
        // Its call in the transcript is closed too: no event of the old run
        // will ever do it, and a call left "waiting" would keep its row tagged.
        if (get().messages.some((m) => m.calls.some((x) => x.state === "waiting"))) {
          set((s) => {
            const aiTouch = { ...s.aiTouch };
            const messages = s.messages.map((m) =>
              m.calls.some((x) => x.state === "waiting")
                ? {
                    ...m,
                    calls: m.calls.map((x) => {
                      if (x.state !== "waiting") return x;
                      for (const k of x.keys) if (aiTouch[k]?.call_id === x.id) delete aiTouch[k];
                      return { ...x, state: "cancelled" as const, meta: "not sent" };
                    }),
                  }
                : m,
            );
            return { aiTouch, messages };
          });
        }
      }
      lastRequest = { text, opts };
      const ctxKeys = opts.keys ?? [];
      const abort = new AbortController();
      controller = abort;
      const c = useComposeStore.getState().compose;
      // The server does not know about Bcc: if the assistant reopens this
      // draft after the form was closed, the Bcc typed on it comes back.
      runBcc = c?.bcc.trim() ? { reply_to: c.replyTo, bcc: c.bcc } : null;
      const turn = get().turn + 1;
      // Counted now, so the meter moves with the click. The server's number
      // replaces it when the run ends.
      if (!opts.free && allowance) {
        queryClient.setQueryData<AssistantAllowance>(keys.allowance, {
          ...allowance,
          used: allowance.used + 1,
          remaining: allowance.remaining == null ? null : Math.max(0, allowance.remaining - 1),
        });
      }

      set((s) => ({
        busy: true,
        status: "Working",
        progress: null,
        lastSummary: null,
        lastStopped: null,
        runId: null,
        turn,
        showEarlier: false,
        messages:
          text && !opts.silent
            ? [
                ...s.messages,
                {
                  ...emptyMessage(nextId("um_"), "user", null, turn),
                  text,
                  context: ctxKeys.length ? { keys: ctxKeys, label: opts.contextLabel ?? "" } : null,
                },
              ]
            : s.messages,
      }));

      try {
        const stream = getAssistantTransport().run(
          {
            text,
            context: { keys: ctxKeys },
            conversation_id: get().conversationId,
            conversation: get().conversations[get().conversationId] ?? null,
            intent: opts.intent,
            draft: c
              ? {
                  inbox_id: c.inbox_id,
                  kind: c.mode,
                  to: c.to,
                  cc: c.cc,
                  bcc: c.bcc,
                  subject: c.subject,
                  body: c.body,
                  reply_to: c.replyTo,
                  draft_id: c.draft_id,
                }
              : undefined,
          },
          { signal: abort.signal },
        );
        for await (const event of stream) {
          if (abort.signal.aborted) break;
          get().applyEvent(event);
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          get().applyEvent({ type: "error", message: err instanceof Error ? err.message : "Something went wrong." });
        }
      } finally {
        if (abort.signal.aborted) {
          settle("stopped");
          set((s) => ({
            messages: [
              ...s.messages,
              { ...emptyMessage(nextId("am_"), "assistant", s.runId, turn), text: "Stopped. Nothing else was changed." },
            ],
          }));
        } else {
          settle(null);
        }
        if (controller === abort) controller = null;
        // Remember what was done with the email, for the follow-up suggestions.
        const calls = get()
          .messages.filter((m) => m.turn === turn)
          .flatMap((m) => m.calls);
        const touched = [...new Set(calls.flatMap((x) => x.keys))];
        const target = ctxKeys.length === 1 ? ctxKeys[0] : touched.length === 1 ? touched[0] : undefined;
        const act = classifyAct(calls, ctxKeys.length === 1);
        set((s) => ({
          busy: false,
          status: "",
          progress: null,
          holdNote: hasHeldNote(),
          lastAct: target && act ? { ...s.lastAct, [target]: act } : s.lastAct,
        }));
        void queryClient.invalidateQueries({ queryKey: keys.allowance });
      }
    },

    retry: async () => {
      const last = lastRequest;
      if (!last || get().busy) return;
      // The failed attempt's "Try again" is spent.
      set((s) => ({ messages: s.messages.map((m) => (m.retryable ? { ...m, retryable: false } : m)) }));
      await get().run(last.text, { ...last.opts, silent: true });
    },

    lastStopped: null,

    stop: () => {
      const approval_id = useComposeStore.getState().compose?.held?.approval_id ?? get().push?.approval_id;
      // Fail closed: stopping while a send is held is a denial.
      if (approval_id) void getAssistantTransport().resolveApproval(approval_id, "reject").catch(() => {});
      controller?.abort();
    },

    clear: () => {
      if (get().busy) return;
      set({
        messages: [],
        lastSummary: null,
        newBelow: false,
        linkCall: null,
        linkEmail: null,
        showEarlier: false,
        conversationId: newConversationId(),
        conversations: {},
      });
    },

    applyEvent: (event) => {
      switch (event.type) {
        case "run_started":
          set({ runId: event.run_id });
          break;
        case "status":
          set({ status: event.text, progress: event.progress ?? null });
          break;
        case "text_delta":
          upsertMessage(event.message_id, (m) => ({ ...m, text: m.text + event.delta, streaming: !event.done }));
          break;
        case "tool_call": {
          const call = event.call;
          upsertMessage(event.message_id, (m) => {
            const i = m.calls.findIndex((x) => x.id === call.id);
            return { ...m, calls: i < 0 ? [...m.calls, call] : m.calls.map((x, j) => (j === i ? call : x)) };
          });
          const s = get();
          const aiTouch = { ...s.aiTouch };
          const lastTrace = { ...s.lastTrace };
          // A call can move on to other emails: drop the rows it has left.
          for (const key of Object.keys(aiTouch) as MessageKey[]) {
            if (aiTouch[key]?.call_id === call.id && !call.keys.includes(key)) delete aiTouch[key];
          }
          for (const key of call.keys) {
            if (ACTIVE.has(call.state)) {
              aiTouch[key] = { tool: call.tool, call_id: call.id, message_id: event.message_id, state: call.state };
            } else if (aiTouch[key]?.call_id === call.id) {
              delete aiTouch[key];
            }
            lastTrace[key] = { tool: call.tool, call_id: call.id, message_id: event.message_id };
          }
          set({
            aiTouch,
            lastTrace,
            holdNote: call.state === "held" || hasHeldNote() || (s.holdNote && call.state !== "running"),
          });
          break;
        }
        case "mail_effect":
          applyMailEffect(event.effect);
          break;
        case "row_label":
          get().setLabel(event.keys, event.label);
          break;
        case "draft_stream":
          applyDraftStream(event);
          break;
        case "approval_required": {
          const store = useComposeStore.getState();
          const d = event.draft;
          const c = store.compose;
          // The draft the user is looking at is held where it is.
          const same = !!c && (d.reply_to ? c.replyTo === d.reply_to : !c.replyTo);
          if (same) store.patch({ held: { approval_id: event.approval_id, external: event.external } });
          set({ status: "Waiting for your approval" });
          const ui = useUiStore.getState();
          const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
          const looking =
            same &&
            (!d.reply_to || isOpenInReader(d.reply_to, useSelectionStore.getState().selectedKey)) &&
            (ui.viewport !== "phone" || (ui.screen !== "list" && !ui.chatFull));
          // Anywhere else, the app is never taken over: a notice asks instead.
          if (!looking || hidden) {
            set({ push: { approval_id: event.approval_id, text: pushText(d), draft: d, external: event.external } });
          }
          if (hidden) {
            const notifications = getPlatform().notifications;
            if (notifications.supported && notifications.permission() === "granted") {
              void notifications
                .show({
                  title: "Assistant wants to send",
                  body: pushText(d),
                  tag: `approval-${event.approval_id}`,
                  url: d.reply_to ? `/all/inbox/${encodeURIComponent(d.reply_to)}` : "/",
                  data: { approval_id: event.approval_id },
                })
                .catch(() => {});
            }
          }
          break;
        }
        case "cards":
          upsertMessage(event.message_id, (m) => ({
            ...m,
            cards: event.cards.map((card) => ({ ...card, done: m.cards.find((x) => x.id === card.id)?.done ?? false })),
          }));
          break;
        case "chips":
          upsertMessage(event.message_id, (m) => ({ ...m, chips: event.chips }));
          break;
        case "done":
          set((s) => ({
            messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
            lastSummary: event.summary ? { ...event.summary, run_id: s.runId } : s.lastSummary,
            lastStopped: event.stopped ?? null,
            conversations:
              event.conversation !== undefined ? { ...s.conversations, [s.conversationId]: event.conversation } : s.conversations,
          }));
          break;
        case "error":
          settle("failed");
          if (event.code === "allowance_exhausted") {
            // An inline state in the panel (with the reset date), not a chat
            // bubble and not something to try again.
            const a = queryClient.getQueryData<AssistantAllowance>(keys.allowance);
            if (a && a.cap != null) {
              queryClient.setQueryData<AssistantAllowance>(keys.allowance, {
                ...a,
                used: Math.max(a.used, a.cap),
                remaining: 0,
                resets_at: event.resets_at ?? a.resets_at,
              });
            }
            set({ allowanceBlocked: true });
            break;
          }
          set((s) => ({
            messages: [
              ...s.messages,
              { ...emptyMessage(nextId("am_"), "assistant", s.runId, s.turn), text: event.message, retryable: event.retryable === true },
            ],
          }));
          break;
      }
      // Tell the panel there is something new if it is not looking.
      if (
        (event.type === "text_delta" || event.type === "tool_call" || event.type === "cards" || event.type === "chips") &&
        !get().newBelow &&
        !assistantPinned
      ) {
        set({ newBelow: true });
      }
    },

    resolveApproval: async (decision) => {
      const store = useComposeStore.getState();
      const held = store.compose?.held;
      // Held in the compose view, or only announced by the notice.
      const approval_id = held?.approval_id ?? get().push?.approval_id;
      if (!approval_id) return;
      // A read-only member cannot send: approving explains, rejecting works.
      if (decision !== "reject" && refuseWrite()) return;
      if (held) store.patch({ held: undefined });
      if (get().push?.approval_id === approval_id) set({ push: null });
      const transport = getAssistantTransport();
      let ok = true;
      try {
        await transport.resolveApproval(approval_id, decision);
      } catch {
        ok = false;
        showToast({ text: "Could not reach the assistant. Nothing was sent.", kind: "error" });
      }
      if (!transport.approvalsOutliveRun) return;
      // The run is over, so no event will close the call that was waiting.
      const sent = ok && decision === "approve";
      set((s) => {
        const aiTouch = { ...s.aiTouch };
        const messages = s.messages.map((m) => {
          if (!m.calls.some((x) => x.state === "waiting")) return m;
          return {
            ...m,
            calls: m.calls.map((x) => {
              if (x.state !== "waiting") return x;
              for (const k of x.keys) if (aiTouch[k]?.call_id === x.id) delete aiTouch[k];
              return sent
                ? { ...x, state: "done" as const, meta: "approved" }
                : { ...x, state: "cancelled" as const, meta: decision === "edit" ? "editing" : "not sent" };
            }),
          };
        });
        return { aiTouch, messages, status: "" };
      });
    },

    undoRun: async (run_id) => {
      const id = run_id ?? get().lastSummary?.run_id ?? get().runId;
      if (!id) return;
      if (refuseWrite()) return;
      // Moves of this run that were still waiting for the pointer never show.
      heldChanges = heldChanges.filter((h) => h.run_id !== id);
      const mine = Object.entries(get().ghosts).filter(([, g]) => g.run_id === id);
      set((s) => {
        const ghosts = { ...s.ghosts };
        for (const [key] of mine) delete ghosts[key as MessageKey];
        return { ghosts, lastSummary: null, holdNote: hasHeldNote() };
      });
      try {
        await getAssistantTransport().undo(id);
        showToast(mine.length ? `Moved ${mine.length} ${mine.length === 1 ? "email" : "emails"} back` : "Undone");
      } catch {
        showToast({ text: "Could not undo that.", kind: "error" });
      }
      refreshLists();
      refreshFolders();
    },

    markCardDone: (message_id, card_id) =>
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === message_id ? { ...m, cards: m.cards.map((k) => (k.id === card_id ? { ...k, done: true } : k)) } : m,
        ),
      })),

    setTouch: (key, info) =>
      set((s) => {
        const aiTouch = { ...s.aiTouch };
        if (info) aiTouch[key] = info;
        else delete aiTouch[key];
        return { aiTouch };
      }),

    addGhost: (key, ghost) =>
      set((s) => ({
        ghosts: {
          ...s.ghosts,
          [key]: { from: ghost.from, to: ghost.to, row: ghost.row ?? findRow(key) ?? null, run_id: s.runId },
        },
      })),

    clearGhosts: () => {
      const ghosts = get().ghosts;
      const all = Object.keys(ghosts) as MessageKey[];
      if (!all.length) return;
      set({ ghosts: {} });
      const byDest = new Map<string, { to: FolderRef; keys: MessageKey[] }>();
      for (const key of all) {
        const g = ghosts[key];
        if (!g) continue;
        const id = folderRefId(g.to);
        const entry = byDest.get(id) ?? { to: g.to, keys: [] };
        entry.keys.push(key);
        byDest.set(id, entry);
      }
      for (const { to, keys: moved } of byDest.values()) removeMovedRows(moved, to);
      refreshLists();
    },

    setLeaving: (target, leaving) =>
      set((s) => {
        const next = { ...s.leaving };
        for (const k of target) {
          if (leaving) next[k] = true;
          else delete next[k];
        }
        return { leaving: next };
      }),

    markFresh: (target) => {
      if (!target.length) return;
      set((s) => {
        const fresh = { ...s.fresh };
        for (const k of target) fresh[k] = true;
        return { fresh };
      });
      setTimeout(() => {
        set((s) => {
          const fresh = { ...s.fresh };
          for (const k of target) delete fresh[k];
          return { fresh };
        });
      }, FRESH_MS);
    },

    setLabel: (target, label) =>
      set((s) => {
        const labels = { ...s.labels };
        for (const k of target) {
          if (label) labels[k] = label;
          else delete labels[k];
        }
        return { labels };
      }),

    bumpFolder: (folder, n = 1) => {
      const id = typeof folder === "string" ? folder : folderRefId(folder);
      set((s) => ({ folderBump: { ...s.folderBump, [id]: (s.folderBump[id] ?? 0) + n } }));
      const old = bumpTimers.get(id);
      if (old) clearTimeout(old);
      bumpTimers.set(
        id,
        setTimeout(() => {
          bumpTimers.delete(id);
          set((s) => {
            const folderBump = { ...s.folderBump };
            delete folderBump[id];
            return { folderBump };
          });
        }, FOLDER_BUMP_MS),
      );
    },

    setLinkCall: (linkCall) => {
      if (get().linkCall !== linkCall) set({ linkCall });
    },
    setLinkEmail: (linkEmail) => {
      if (get().linkEmail !== linkEmail) set({ linkEmail });
    },
    setHoverKeys: (hoverKeys) => {
      if (get().hoverKeys.length || hoverKeys.length) set({ hoverKeys });
    },
    addPendingNew: (rows) => set((s) => ({ pendingNew: [...s.pendingNew, ...rows] })),
    takePendingNew: () => {
      const rows = get().pendingNew;
      if (rows.length) set({ pendingNew: [] });
      return rows;
    },
    setPush: (push) => set({ push }),
    setNewBelow: (newBelow) => {
      if (get().newBelow !== newBelow) set({ newBelow });
    },
    setHoldNote: (holdNote) => {
      if (get().holdNote !== holdNote) set({ holdNote });
    },
    setShowEarlier: (showEarlier) => {
      if (get().showEarlier !== showEarlier) set({ showEarlier });
    },

    showCall: (call_id) => {
      revealAssistant();
      set({ linkCall: call_id });
    },

    reviewPush: () => {
      const p = get().push;
      if (!p) return;
      set({ push: null });
      const d = p.draft;
      const ui = useUiStore.getState();
      if (ui.viewport === "phone") ui.setChatFull(false);
      if (d.reply_to && !isOpenInReader(d.reply_to, useSelectionStore.getState().selectedKey)) {
        useSelectionStore.getState().select(d.reply_to);
      } else if (ui.viewport === "phone" && d.reply_to) {
        ui.setScreen("reader");
      }
      const store = useComposeStore.getState();
      const c = store.compose;
      const same = !!c && (d.reply_to ? c.replyTo === d.reply_to : !c.replyTo);
      if (!same) {
        store.open({
          mode: d.reply_to ? (d.kind === "reply_all" || d.kind === "forward" ? d.kind : "reply") : "new",
          inbox_id: d.inbox_id,
          to: d.to,
          cc: d.cc ?? "",
          subject: d.subject,
          body: d.body,
          replyTo: d.reply_to,
          ai: true,
          aiOriginal: d.body,
        });
      }
      if (p.approval_id) {
        useComposeStore.getState().patch({ held: { approval_id: p.approval_id, external: !!p.external } });
      }
    },

    reset: () => {
      get().stop();
      heldChanges = [];
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      for (const t of bumpTimers.values()) clearTimeout(t);
      bumpTimers.clear();
      set({
        messages: [],
        status: "",
        progress: null,
        aiTouch: {},
        ghosts: {},
        leaving: {},
        fresh: {},
        labels: {},
        lastTrace: {},
        folderBump: {},
        linkCall: null,
        linkEmail: null,
        hoverKeys: [],
        pendingNew: [],
        push: null,
        newBelow: false,
        lastSummary: null,
        holdNote: false,
        showEarlier: false,
        lastAct: {},
        conversationId: newConversationId(),
        conversations: {},
        allowanceBlocked: false,
        busy: false,
        runId: null,
        turn: 0,
        lastStopped: null,
      });
      lastRequest = null;
    },
  };
});

/* Pointer left the list: show what was held, unless it comes straight back. */
function releaseHeldChanges(): void {
  const queue = heldChanges;
  heldChanges = [];
  for (const h of queue) h.apply();
  useAssistantStore.getState().setHoldNote(false);
}
useUiStore.subscribe((s, prev) => {
  if (s.listHover === prev.listHover && s.viewport === prev.viewport) return;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (pointerOnList() || !heldChanges.length) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (!pointerOnList()) releaseHeldChanges();
  }, HOLD_RELEASE_MS);
});

/* Whether the transcript is scrolled to the bottom. Written by the panel on
 * scroll; not state, because nothing renders from it. */
let assistantPinned = true;
export function setAssistantPinned(pinned: boolean): void {
  assistantPinned = pinned;
  if (pinned) useAssistantStore.getState().setNewBelow(false);
}
export function isAssistantPinned(): boolean {
  return assistantPinned;
}

/* A move gave messages new ids: what is keyed by message follows them. */
onKeyRemap((map) => {
  const move = <T,>(rec: Record<MessageKey, T>): Record<MessageKey, T> => {
    let out: Record<MessageKey, T> | null = null;
    for (const [old, next] of map) {
      if (!(old in rec)) continue;
      out ??= { ...rec };
      out[next] = out[old] as T;
      delete out[old];
    }
    return out ?? rec;
  };
  useAssistantStore.setState((s) => ({ labels: move(s.labels), lastTrace: move(s.lastTrace), lastAct: move(s.lastAct) }));
});

/* Ghost rows belong to the view they were made in: leaving it drops them. */
useSelectionStore.subscribe((s, prev) => {
  if (s.folder !== prev.folder || s.scope !== prev.scope || s.query !== prev.query) {
    useAssistantStore.getState().clearGhosts();
  }
});

/* ---- selectors (granular: a row subscribes to its own key only) ---- */
export const selectTouch = (key: MessageKey) => (s: AssistantState) => s.aiTouch[key];
export const selectTrace = (key: MessageKey) => (s: AssistantState) => s.lastTrace[key];
export const selectGhost = (key: MessageKey) => (s: AssistantState) => s.ghosts[key];
export const selectLabel = (key: MessageKey) => (s: AssistantState) => s.labels[key];
export const selectIsFresh = (key: MessageKey) => (s: AssistantState) => s.fresh[key] === true;
export const selectIsLeaving = (key: MessageKey) => (s: AssistantState) => s.leaving[key] === true;
export const selectIsLinked = (key: MessageKey) => (s: AssistantState) =>
  s.linkEmail === key || s.hoverKeys.includes(key);
export const selectHasGhosts = (s: AssistantState) => {
  for (const _ in s.ghosts) return true;
  return false;
};
export const selectCanClear = (s: AssistantState) => s.messages.length > 0 && !s.busy;

/** Keeps the panel reachable when the assistant starts working on its own. */
export function revealAssistant(): void {
  const ui = useUiStore.getState();
  if (ui.viewport === "phone") ui.setChatFull(true);
  else if (!ui.panelOpen) ui.setPanelOpen(true);
}
