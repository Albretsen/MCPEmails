/* Scripted assistant: every scenario of the design prototype, as an event
 * stream against the mock mailbox.
 *
 * It acts on the same MockMailApi the mail lists read from, so its effects are
 * real inside the mock: receipts really move to Receipts, a draft really lands
 * in Drafts, an approved reply really shows up in Sent, and `undo` really
 * moves things back. The client only ever sees `AssistantEvent`s, exactly as
 * it will from the server.
 *
 * Timing mirrors the prototype (read dwell, typing speed). Every wait goes
 * through `Run.wait`, so a run can be aborted mid-step: calls still in flight
 * are re-emitted as `cancelled`, and whatever was already written stays.
 */

import { diffWords } from "../../../lib/diffWords";
import type {
  ApprovalDecision,
  ApprovalDraft,
  AssistantCard,
  AssistantChip,
  AssistantEvent,
  AssistantRequest,
  AssistantToolCall,
  AssistantTransport,
  DiffSegment,
  ToolCallState,
  ToolName,
} from "../../assistant-api";
import { getMailApi } from "../../index";
import { FOLDER_ROLE_LABEL, type FolderRef, type MessageKey, isNameRef, isRoleRef, makeKey, parseAddressList } from "../../types";
import { getMockMailApi } from "../index";
import { abortError, sleep } from "../latency";
import { MockMailApi, type MockMessage } from "../mock-mail-api";
import { type AssistantHints, MOCK_INBOXES, MOCK_PROFILES, MOCK_USER } from "../seed";
import { EMAIL_KINDS, type ScenarioKind, editText, humanize, routeWithContext, searchWords } from "./route";

/** Milliseconds, from the prototype. Multiplied by the pace. */
export const TIMING = {
  /** Assistant text: 3 characters every 16 ms. */
  textChunk: 3,
  textTick: 16,
  /** Draft body: 2 characters every 14 ms. */
  draftChunk: 2,
  draftTick: 14,
  search: 550,
  /** How long a row stays highlighted while it is read. */
  read: 600,
  readNeeds: 650,
  readAbout: 550,
  readDraft: 500,
  readFirstRun: 480,
  sweep: 120,
  moveRead: 360,
  moveMove: 220,
  archiveOne: 500,
  senderSearch: 600,
  genericSearch: 650,
  firstRunSearch: 500,
  draftOpen: 250,
  editShowDiff: 550,
  editBeforeDrop: 250,
  editSettle: 650,
} as const;

let pace = 1;

/** 1 = prototype timing. 0 = no waiting at all (tests). */
export function setAssistantPace(p: number): void {
  pace = Math.max(0, p);
}
export function getAssistantPace(): number {
  return pace;
}

const INBOX_FOLDER = "INBOX";
const WEEK_MS = 7 * 86_400_000;
/** First run sweeps at most this many non-person emails row by row. */
const SWEEP_MAX = 24;

interface Em {
  key: MessageKey;
  m: MockMessage;
  h: AssistantHints;
  /** Sender's display name and first name. */
  from: string;
  first: string;
}

type CallEvent = Extract<AssistantEvent, { type: "tool_call" }>;
type Events = AsyncGenerator<AssistantEvent, void, undefined>;

interface CallInit {
  tool: ToolName;
  label: string;
  keys?: MessageKey[];
  action?: string;
  meta?: string;
  state?: ToolCallState;
  folder?: FolderRef;
}

let runSeq = 1;
let callSeq = 1;
let approvalSeq = 1;

const isActive = (s: ToolCallState) => s === "running" || s === "waiting" || s === "held";

function folderLabel(ref: FolderRef): string {
  if (isRoleRef(ref)) return FOLDER_ROLE_LABEL[ref.role];
  if (isNameRef(ref)) return ref.name;
  return ref.folder_id;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** State of one run: its calls, what it moved, and the abort signal. */
class Run {
  readonly id = `run_${runSeq++}`;
  private msgSeq = 1;
  private calls = new Map<string, { message_id: string; call: AssistantToolCall; label: string }>();
  readonly moves: { key: MessageKey; from: FolderRef }[] = [];
  summary: { text: string; undoable: boolean } | undefined;
  /** Server draft this run created or updated. */
  draftId: string | undefined;

  constructor(
    readonly api: MockMailApi,
    readonly req: AssistantRequest,
    readonly signal: AbortSignal,
  ) {
    this.draftId = req.draft?.draft_id;
  }

  /** A new assistant message id. */
  msg(): string {
    return `${this.id}_m${this.msgSeq++}`;
  }

  check(): void {
    if (this.signal.aborted) throw abortError();
  }

  wait(ms: number): Promise<void> {
    return sleep(ms * pace, this.signal);
  }

  call(message_id: string, init: CallInit): CallEvent {
    const state = init.state ?? "running";
    const call: AssistantToolCall = {
      id: `c${callSeq++}`,
      tool: init.tool,
      action: init.action,
      human: humanize(init.tool, init.label, state, init.action),
      meta: init.meta ?? "",
      state,
      keys: init.keys ?? [],
      folder: init.folder,
    };
    this.calls.set(call.id, { message_id, call, label: init.label });
    return { type: "tool_call", message_id, call };
  }

  update(ev: CallEvent, patch: Partial<Pick<AssistantToolCall, "state" | "meta" | "tool" | "keys">> & { label?: string }): CallEvent {
    const entry = this.calls.get(ev.call.id);
    if (!entry) return ev;
    const { label, ...rest } = patch;
    if (label != null) entry.label = label;
    const call = { ...entry.call, ...rest };
    call.human = humanize(call.tool, entry.label, call.state, call.action);
    entry.call = call;
    return { type: "tool_call", message_id: entry.message_id, call };
  }

  /** Calls still in flight, re-emitted as cancelled (after an abort). */
  cancelActive(): CallEvent[] {
    const out: CallEvent[] = [];
    for (const entry of this.calls.values()) {
      if (!isActive(entry.call.state)) continue;
      entry.call = { ...entry.call, state: "cancelled", meta: "stopped" };
      out.push({ type: "tool_call", message_id: entry.message_id, call: entry.call });
    }
    return out;
  }

  em(key: MessageKey | undefined | null): Em | null {
    if (!key) return null;
    const m = this.api.getMessage(key);
    if (!m) return null;
    const from = m.from.name || m.from.email;
    return { key, m, h: this.api.getHints(key) ?? {}, from, first: from.split(" ")[0] ?? from };
  }

  all(): Em[] {
    return this.api
      .allMessages()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((m) => this.em(makeKey(m.inbox_id, m.id)) as Em);
  }

  /** Inbox, newest first. */
  inbox(): Em[] {
    return this.all().filter((e) => e.m.folder === INBOX_FOLDER);
  }

  targetFromText(text: string): Em | null {
    const s = (text || "").toLowerCase();
    if (!s) return null;
    return this.inbox().find((e) => e.h.person && s.includes(e.first.toLowerCase())) ?? null;
  }

  /** The email a single-email scenario is about. */
  target(): Em | null {
    const keys = this.req.context.keys;
    const inbox = this.inbox();
    return (
      (keys.length === 1 ? this.em(keys[0]) : null) ??
      this.targetFromText(this.req.text) ??
      this.em(this.req.draft?.reply_to) ??
      inbox.find((e) => e.h.ask) ??
      inbox[0] ??
      null
    );
  }
}

export interface ScriptedAssistantOptions {
  /** The mock mailbox to act on. Default: whatever `getMailApi()` returns. */
  api?: () => MockMailApi;
}

export class ScriptedAssistantTransport implements AssistantTransport {
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  private undoLog = new Map<string, { key: MessageKey; from: FolderRef }[]>();
  private getApi: () => MockMailApi;

  constructor(opts: ScriptedAssistantOptions = {}) {
    this.getApi =
      opts.api ??
      (() => {
        const api = getMailApi();
        return api instanceof MockMailApi ? api : getMockMailApi();
      });
  }

  async *run(req: AssistantRequest, opts: { signal: AbortSignal }): AsyncIterable<AssistantEvent> {
    const run = new Run(this.getApi(), req, opts.signal);
    const kind = routeWithContext(req.text, req.intent, req.context.keys.length === 1);
    yield { type: "run_started", run_id: run.id };
    yield { type: "status", text: "Working" };
    // The first-run walkthrough is free.
    if (kind !== "firstrun") run.api.consumeAssistantAction();
    try {
      run.check();
      yield* this.scenario(kind, run);
      if (run.moves.length) this.undoLog.set(run.id, run.moves);
      yield { type: "done", summary: run.summary };
    } catch (err) {
      if (run.moves.length) this.undoLog.set(run.id, run.moves);
      if (isAbort(err) || opts.signal.aborted) {
        // Stopped: mark what was in flight, keep everything already written.
        yield* run.cancelActive();
        return;
      }
      yield* run.cancelActive();
      yield { type: "error", message: err instanceof Error ? err.message : "Something went wrong." };
    }
  }

  async resolveApproval(approval_id: string, decision: ApprovalDecision): Promise<void> {
    const resolve = this.approvals.get(approval_id);
    if (!resolve) return; // unknown or already denied: fail closed
    this.approvals.delete(approval_id);
    resolve(decision);
  }

  async undo(run_id: string): Promise<void> {
    const moves = this.undoLog.get(run_id);
    if (!moves) return;
    this.undoLog.delete(run_id);
    const api = this.getApi();
    for (const mv of moves) api.moveNow([mv.key], mv.from);
  }

  /* ================= scenarios ================= */

  private scenario(kind: ScenarioKind, run: Run): AsyncGenerator<AssistantEvent, unknown, undefined> {
    if (kind === "generic" && run.req.context.keys.length > 1) return this.multi(run);
    const target = EMAIL_KINDS.includes(kind) ? run.target() : null;
    switch (kind) {
      case "firstrun":
        return this.firstRun(run);
      case "needs":
        return this.needs(run);
      case "receipts":
        return this.receipts(run);
      case "newsletters":
        return this.newsletters(run);
      case "draft":
        return this.draft(run, target);
      case "shorter":
      case "warmer":
        return this.edit(run, kind);
      case "send":
        return this.send(run, target, false);
      case "send_background":
        return this.send(run, target, true);
      case "summary":
        return this.summary(run, target);
      case "about":
        return this.about(run, target);
      case "sender":
        return this.sender(run, target);
      case "archiveOne":
        return this.archiveOne(run, target);
      default:
        return this.generic(run);
    }
  }

  private async *say(run: Run, message_id: string, text: string): Events {
    run.check();
    if (pace === 0) {
      yield { type: "text_delta", message_id, delta: text, done: true };
      return;
    }
    for (let i = 0; i < text.length; i += TIMING.textChunk) {
      yield { type: "text_delta", message_id, delta: text.slice(i, i + TIMING.textChunk) };
      await run.wait(TIMING.textTick);
    }
    yield { type: "text_delta", message_id, delta: "", done: true };
  }

  private async *readStep(run: Run, message_id: string, e: Em, ms: number): AsyncGenerator<AssistantEvent, CallEvent, undefined> {
    const c = run.call(message_id, { tool: "email_read", label: `${e.from} · ${e.m.subject}`, keys: [e.key] });
    yield c;
    await run.wait(ms);
    yield { type: "mail_effect", effect: { kind: "read", keys: [e.key], call_id: c.call.id } };
    const done = run.update(c, { state: "done" });
    yield done;
    return done;
  }

  private async *noTarget(run: Run): Events {
    yield* this.say(run, run.msg(), "I could not find an email to work on. Open one, or tell me who it is from.");
  }

  private async *firstRun(run: Run): Events {
    const m = run.msg();
    const boxes = MOCK_PROFILES[run.api.profile].boxes;
    const provider = boxes.length === 1 && boxes[0] ? MOCK_INBOXES[boxes[0]].provider : null;
    const connected =
      boxes.length > 1 ? "Your mailboxes are connected." : `${provider === "gmail" ? "Gmail" : provider === "outlook" ? "Outlook" : "Your mailbox"} is connected.`;
    yield { type: "status", text: "Reading your inbox" };
    yield* this.say(run, m, `${connected} I'm reading the last 7 days so I can show you what needs you. I won't move or send anything without asking.`);

    const since = new Date(Date.now() - WEEK_MS).toISOString();
    const inbox = run.inbox().filter((e) => e.m.date >= since);
    const c1 = run.call(m, { tool: "email_search", label: "newer_than:7d in:inbox" });
    yield c1;
    await run.wait(TIMING.firstRunSearch);
    yield run.update(c1, { state: "done", meta: `${inbox.length} emails` });

    const people = inbox.filter((e) => e.h.ask);
    // Sweep the emails it knows something about first, then recent filler.
    const others = inbox.filter((e) => !e.h.ask);
    const known = others.filter((e) => e.h.receipt || e.h.newsletter);
    const rest = [...known, ...others.filter((e) => !known.includes(e))].slice(0, SWEEP_MAX);
    const n = people.length + rest.length;
    let i = 0;
    for (const e of people) {
      i++;
      yield { type: "status", text: `Reading ${e.from}`, progress: { i, n } };
      yield* this.readStep(run, m, e, TIMING.readFirstRun);
      yield { type: "row_label", keys: [e.key], label: "needs reply" };
    }
    if (rest.length) {
      const c2 = run.call(m, { tool: "email_read", label: `${rest.length} more emails` });
      yield c2;
      for (const e of rest) {
        i++;
        yield { type: "status", text: `Reading ${e.from}`, progress: { i, n } };
        yield run.update(c2, { keys: [e.key] });
        await run.wait(TIMING.sweep);
      }
      yield run.update(c2, { state: "done", keys: [] });
    }

    const rc = inbox.filter((e) => e.h.receipt);
    const nl = inbox.filter((e) => e.h.newsletter && !e.m.is_read);
    const total = rc.reduce((a, e) => a + (e.h.amount ?? 0), 0);
    const m2 = run.msg();
    yield* this.say(run, m2, people.length || rc.length || nl.length ? "Here's what I found." : "Nothing in the last 7 days needs you.");

    const cards: AssistantCard[] = [];
    const p0 = people[0];
    if (p0) {
      cards.push({
        id: "cr",
        icon: "reply",
        title: `${people.length} ${people.length === 1 ? "email is" : "emails are"} waiting on you`,
        sub: people.map((e) => `${e.first}: ${(e.h.ask ?? "").toLowerCase()}`).join(" · "),
        action: `Draft a reply to ${p0.first}`,
        prompt: `Draft a reply to ${p0.from}`,
        intent: "draft",
      });
    }
    if (rc.length) {
      const names = rc.slice(0, 3).map((e) => e.from).join(", ");
      cards.push({
        id: "cf",
        icon: "receipt",
        title: `${rc.length} receipts and invoices`,
        sub: `$${total.toFixed(2)} from ${names}${rc.length > 3 ? ` and ${rc.length - 3} more` : ""}`,
        action: "File them in Receipts",
        prompt: "File them in Receipts",
        intent: "receipts",
      });
    }
    if (nl.length) {
      cards.push({
        id: "cn",
        icon: "newspaper",
        title: `${nl.length} ${nl.length === 1 ? "newsletter" : "newsletters"} you haven't opened`,
        sub: nl.map((e) => e.from).join(", "),
        action: "Archive them",
        prompt: "Archive the unopened newsletters",
        intent: "newsletters",
      });
    }
    if (!cards.length) return;
    yield { type: "cards", message_id: m2, cards };
    const cap = run.api.consumeAssistantAction(0).cap;
    yield* this.say(
      run,
      run.msg(),
      cap == null ? "Pick one to start." : `Pick one to start. Each uses 1 of your ${cap.toLocaleString("en-US")} free assistant actions this month.`,
    );
  }

  /** Reads, then moves, each email in turn. Records what it moved for undo. */
  private async *bulkMove(run: Run, m: string, list: Em[], to: FolderRef, verb: string): Events {
    const dest = folderLabel(to);
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as Em;
      yield { type: "status", text: `${verb} ${e.from}`, progress: { i: i + 1, n: list.length } };
      const c = run.call(m, { tool: "email_read", label: `${e.from} → ${dest}`, keys: [e.key], folder: to });
      yield c;
      await run.wait(TIMING.moveRead);
      yield run.update(c, { tool: "email_organize" });
      await run.wait(TIMING.moveMove);
      const from: FolderRef = { inbox_id: e.m.inbox_id, folder_id: e.m.folder };
      const res = run.api.moveNow([e.key], to);
      const moved = res.moved[0];
      if (moved) {
        run.moves.push({ key: moved.new_key, from });
        yield { type: "mail_effect", effect: { kind: "moved", keys: [e.key], from, to, call_id: c.call.id } };
      }
      yield run.update(c, { state: "done" });
    }
    const archived = isRoleRef(to) && to.role === "archive";
    run.summary = {
      text: `${archived ? "Archived" : "Filed"} ${list.length} ${list.length === 1 ? "email" : "emails"}${archived ? "" : ` in ${dest}`}`,
      undoable: run.moves.length > 0,
    };
  }

  private async *receipts(run: Run): Events {
    const m = run.msg();
    const c1 = run.call(m, { tool: "email_search", label: "receipt OR invoice in:inbox" });
    yield c1;
    await run.wait(TIMING.search);
    const list = run.inbox().filter((e) => e.h.receipt);
    yield run.update(c1, { state: "done", meta: `${list.length} found` });
    if (!list.length) {
      yield* this.say(run, run.msg(), "No receipts left in your inbox.");
      return;
    }
    const to: FolderRef = { name: "Receipts" };
    yield* this.bulkMove(run, m, list, to, "Filing");
    const total = list.reduce((a, e) => a + (e.h.amount ?? 0), 0);
    const m2 = run.msg();
    const count = run.api.allMessages().filter((x) => x.folder === "Receipts").length;
    yield { type: "chips", message_id: m2, chips: [{ kind: "folder", folder: to, label: "Receipts", sub: `${count} emails` }] };
    yield* this.say(run, m2, `Filed ${list.length} receipts, $${total.toFixed(2)} in total. Undo is at the top of this conversation.`);
  }

  private async *newsletters(run: Run): Events {
    const m = run.msg();
    const c1 = run.call(m, { tool: "email_search", label: "category:newsletter is:unread" });
    yield c1;
    await run.wait(TIMING.search);
    const list = run.inbox().filter((e) => e.h.newsletter && !e.m.is_read);
    yield run.update(c1, { state: "done", meta: `${list.length} found` });
    if (!list.length) {
      yield* this.say(run, run.msg(), "No unopened newsletters in your inbox.");
      return;
    }
    const to: FolderRef = { role: "archive" };
    yield* this.bulkMove(run, m, list, to, "Archiving");
    const m2 = run.msg();
    const count = run.api.allMessages().filter((x) => x.folder === "Archive").length;
    yield { type: "chips", message_id: m2, chips: [{ kind: "folder", folder: to, label: "Archive", sub: `${count} emails` }] };
    yield* this.say(run, m2, `Archived ${list.length} newsletters. They're still searchable. Undo is at the top of this conversation.`);
  }

  private async *needs(run: Run): Events {
    const m = run.msg();
    const c1 = run.call(m, { tool: "email_search", label: "from:people in:inbox · 7d" });
    yield c1;
    await run.wait(TIMING.search);
    const hits = run.inbox().filter((e) => e.h.ask);
    yield run.update(c1, { state: "done", meta: `${hits.length} found` });
    let i = 0;
    for (const e of hits) {
      i++;
      yield { type: "status", text: `Reading ${e.from}`, progress: { i, n: hits.length } };
      yield* this.readStep(run, m, e, TIMING.readNeeds);
      yield { type: "row_label", keys: [e.key], label: "needs reply" };
    }
    const m2 = run.msg();
    if (hits.length) yield { type: "chips", message_id: m2, chips: hits.map((e) => this.emailChip(e, e.h.ask)) };
    yield* this.say(
      run,
      m2,
      hits.length
        ? `${hits.length} ${hits.length === 1 ? "email needs" : "emails need"} a reply from you. I've labelled them in the list.`
        : "Nothing is waiting on you right now.",
    );
  }

  private emailChip(e: Em, sub?: string): AssistantChip {
    const role = e.m.folder === INBOX_FOLDER ? null : e.m.folder;
    return { kind: "email", key: e.key, label: `${e.from} · ${e.m.subject}`, sub: sub ?? (role ? `in ${role}` : e.m.preview) };
  }

  /** Writes a reply into the compose view. Returns the draft, or null when the
   *  email does not call for one. */
  private async *draft(run: Run, e: Em | null): AsyncGenerator<AssistantEvent, ApprovalDraft | null, undefined> {
    if (!e) {
      yield* this.noTarget(run);
      return null;
    }
    if (!e.h.person) {
      const what = e.h.newsletter ? "This is a newsletter" : e.h.receipt ? "This is a receipt" : "This is an automated notification";
      yield* this.say(run, run.msg(), `${what} from ${e.from}. It doesn't need a reply.`);
      return null;
    }
    const m = run.msg();
    yield { type: "status", text: `Reading ${e.from}` };
    yield* this.readStep(run, m, e, TIMING.readDraft);
    const d = run.call(m, { tool: "draft", label: `Re: ${e.m.subject}`, keys: [e.key], meta: "below" });
    yield d;
    yield { type: "status", text: `Writing a reply to ${e.first}` };
    const fields = { inbox_id: e.m.inbox_id, to: e.m.from.email, subject: `Re: ${e.m.subject.replace(/^Re: /, "")}` };
    const body =
      e.h.reply ?? `Hi ${e.first},\n\nThanks for the note. I'll take a look and get back to you by end of day.\n\n${MOCK_USER.name.split(" ")[0]}`;
    const stream = { type: "draft_stream", phase: "writing", reply_to: e.key, fields, call_id: d.call.id, message_id: m } as const;

    // Saved to Drafts while it streams, so the finished draft has a real id.
    const saving = run.api
      .createDraft({ inbox_id: e.m.inbox_id, to: [e.m.from], subject: fields.subject, body_text: body, reply_to: e.key })
      .catch(() => null);
    try {
      yield { ...stream, body_delta: "" };
      await run.wait(TIMING.draftOpen);
      if (pace === 0) {
        yield { ...stream, body_delta: body };
      } else {
        for (let i = 0; i < body.length; i += TIMING.draftChunk) {
          yield { ...stream, body_delta: body.slice(i, i + TIMING.draftChunk) };
          await run.wait(TIMING.draftTick);
        }
      }
      run.check();
    } catch (err) {
      // Stopped mid-sentence: the partial text stays in the editor, unsaved.
      void saving.then((ref) => ref && run.api.deleteDraft(ref.inbox_id, ref.draft_id).catch(() => {}));
      throw err;
    }
    const ref = await saving;
    run.draftId = ref?.draft_id;
    yield { ...stream, body, draft_id: ref?.draft_id, done: true };
    if (ref) yield { type: "mail_effect", effect: { kind: "drafted", keys: [e.key], call_id: d.call.id } };
    yield run.update(d, { state: "done", meta: "under the email" });
    return { inbox_id: e.m.inbox_id, to: fields.to, subject: fields.subject, body, reply_to: e.key };
  }

  private async *edit(run: Run, kind: "shorter" | "warmer"): Events {
    const c = run.req.draft;
    if (!c) {
      yield* this.say(run, run.msg(), "There is no draft yet. Ask me to draft a reply first.");
      return;
    }
    const m = run.msg();
    const d = run.call(m, { tool: "draft", action: "edit", label: `edit · ${kind}`, keys: c.reply_to ? [c.reply_to] : [], meta: "editing below" });
    yield d;
    yield { type: "status", text: kind === "shorter" ? "Shortening the draft" : "Making the draft warmer" };

    const next = editText(c.body, kind, c.reply_to ? run.api.getHints(c.reply_to) : undefined);
    const fields = { inbox_id: c.inbox_id, to: c.to, subject: c.subject };
    const stream = { type: "draft_stream", phase: "editing", reply_to: c.reply_to, fields, call_id: d.call.id, message_id: m } as const;
    const segs = diffWords(c.body, next).map((o) => ({ k: o.k, full: o.t, t: o.k === "ins" ? "" : o.t }));
    const snapshot = (): DiffSegment[] => segs.map((x) => ({ k: x.k, t: x.t }));

    // Deletions struck through first, then the insertions type themselves in.
    yield { ...stream, segments: snapshot() };
    await run.wait(TIMING.editShowDiff);
    for (const sg of segs) {
      if (sg.k !== "ins") continue;
      if (pace > 0) {
        for (let i = 0; i < sg.full.length; i += TIMING.draftChunk) {
          sg.t = sg.full.slice(0, i);
          yield { ...stream, segments: snapshot() };
          await run.wait(TIMING.draftTick);
        }
      }
      sg.t = sg.full;
      yield { ...stream, segments: snapshot() };
    }
    await run.wait(TIMING.editBeforeDrop);
    for (const sg of segs) if (sg.k === "del") sg.t = "";
    yield { ...stream, segments: snapshot() };
    await run.wait(TIMING.editSettle);

    let draft_id = c.draft_id;
    if (draft_id) {
      try {
        const ref = await run.api.updateDraft(c.inbox_id, draft_id, {
          inbox_id: c.inbox_id,
          to: parseAddressList(c.to),
          cc: parseAddressList(c.cc ?? ""),
          bcc: parseAddressList(c.bcc ?? ""),
          subject: c.subject,
          body_text: next,
          reply_to: c.reply_to,
        });
        draft_id = ref.draft_id;
      } catch {
        /* the editor still has the new text; the next save retries */
      }
      run.check();
    }
    run.draftId = draft_id;
    yield { ...stream, body: next, draft_id, done: true };
    yield run.update(d, { state: "done", meta: "under the email" });
  }

  /** Drafts if needed, then holds the send for approval. Fails closed.
   *  `background`: nothing is put in the compose view; the client is expected
   *  to raise its "wants to send" notice. */
  private async *send(run: Run, e: Em | null, background: boolean): Events {
    if (!e) {
      yield* this.noTarget(run);
      return;
    }
    const c = run.req.draft;
    let draft: ApprovalDraft | null;
    if (background) {
      if (!e.h.person) {
        yield* this.say(run, run.msg(), `${e.from} sent an automated email. It doesn't need a reply.`);
        return;
      }
      const m0 = run.msg();
      yield { type: "status", text: `Reading ${e.from}` };
      yield* this.readStep(run, m0, e, TIMING.readDraft);
      draft = {
        inbox_id: e.m.inbox_id,
        to: e.m.from.email,
        subject: `Re: ${e.m.subject.replace(/^Re: /, "")}`,
        body: e.h.reply ?? `Hi ${e.first},\n\nThanks for the note. I'll get back to you by end of day.\n\n${MOCK_USER.name.split(" ")[0]}`,
        reply_to: e.key,
      };
    } else if (c && c.reply_to === e.key && c.body.trim()) {
      draft = { inbox_id: c.inbox_id, to: c.to, subject: c.subject, body: c.body, reply_to: c.reply_to };
    } else {
      draft = yield* this.draft(run, e);
    }
    if (!draft) return;

    const m = run.msg();
    const s = run.call(m, { tool: "email_compose", label: `to ${draft.to}`, keys: [e.key], state: "waiting", meta: "needs approval" });
    const approval_id = `ap_${approvalSeq++}`;
    const pending = this.awaitApproval(approval_id, run.signal);
    pending.catch(() => {});
    yield s;
    yield { type: "approval_required", approval_id, call_id: s.call.id, draft, external: !!e.h.external };
    yield { type: "status", text: "Waiting for your approval" };
    yield* this.say(
      run,
      m,
      background
        ? `I wrote a reply to ${e.first} and it is ready to go. Nothing is sent until you approve it.`
        : "I've held the reply under the email for your approval. Check the recipient, then approve. Nothing is sent until you do.",
    );

    const decision = await pending;
    const m2 = run.msg();
    if (decision === "approve") {
      try {
        await run.api.replyToMessage({ key: e.key, to: parseAddressList(draft.to), body_text: draft.body });
      } catch {
        yield run.update(s, { state: "cancelled", meta: "failed" });
        yield* this.say(run, m2, "Could not send. Nothing went out, and the draft is still there.");
        return;
      }
      if (run.draftId) await run.api.deleteDraft(draft.inbox_id, run.draftId).catch(() => {});
      yield { type: "mail_effect", effect: { kind: "sent", keys: [e.key], call_id: s.call.id } };
      yield { type: "row_label", keys: [e.key], label: null };
      yield run.update(s, { state: "done", meta: "approved" });
      yield* this.say(run, m2, `Sent to ${draft.to}. It's in Sent.`);
    } else if (decision === "edit") {
      yield run.update(s, { state: "cancelled", meta: "you are editing" });
      yield* this.say(run, m2, "Not sent. The draft is yours to edit and send.");
    } else {
      yield run.update(s, { state: "cancelled", meta: "declined" });
      yield* this.say(run, m2, background ? "Not sent." : "Not sent. The draft is still below.");
    }
  }

  /** Resolves with the user's decision; rejects (and forgets the approval) on abort. */
  private awaitApproval(approval_id: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        this.approvals.delete(approval_id);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(approval_id, (d) => {
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      });
    });
  }

  private async *summary(run: Run, e: Em | null): Events {
    if (!e) {
      yield* this.noTarget(run);
      return;
    }
    yield { type: "status", text: `Reading ${e.from}` };
    yield* this.readStep(run, run.msg(), e, TIMING.read);
    yield* this.say(run, run.msg(), e.h.summary ?? e.m.preview);
  }

  private async *about(run: Run, e: Em | null): Events {
    if (!e) {
      yield* this.noTarget(run);
      return;
    }
    yield { type: "status", text: `Reading ${e.from}` };
    yield* this.readStep(run, run.msg(), e, TIMING.readAbout);
    const t = (run.req.text || "").toLowerCase();
    let a: string;
    if (/need|ask|want/.test(t)) {
      const ask = e.h.ask;
      a = e.h.need || ask ? `${e.first} wants you to ${e.h.need ?? (ask as string).charAt(0).toLowerCase() + (ask as string).slice(1)}.` : "Nothing is asked of you in this email.";
    } else if (/deadline|when|due/.test(t)) {
      a = e.h.deadline ?? "No deadline is mentioned.";
    } else {
      a = e.h.answer ?? e.h.summary ?? `From this email: ${e.m.preview}`;
    }
    yield* this.say(run, run.msg(), a);
  }

  private async *archiveOne(run: Run, e: Em | null): Events {
    if (!e) {
      yield* this.noTarget(run);
      return;
    }
    const m = run.msg();
    const to: FolderRef = { role: "archive" };
    const c = run.call(m, { tool: "email_organize", label: `${e.from} → Archive`, keys: [e.key], folder: to });
    yield c;
    await run.wait(TIMING.archiveOne);
    const from: FolderRef = { inbox_id: e.m.inbox_id, folder_id: e.m.folder };
    const moved = run.api.moveNow([e.key], to).moved[0];
    if (moved) {
      run.moves.push({ key: moved.new_key, from });
      yield { type: "mail_effect", effect: { kind: "moved", keys: [e.key], from, to, call_id: c.call.id } };
    }
    yield run.update(c, { state: "done" });
    run.summary = { text: `Archived ${e.from}`, undoable: !!moved };
    yield* this.say(run, run.msg(), "Archived. Undo is at the top of this conversation.");
  }

  private async *sender(run: Run, e: Em | null): Events {
    if (!e) {
      yield* this.noTarget(run);
      return;
    }
    const m = run.msg();
    const c = run.call(m, { tool: "email_search", label: `from:${e.m.from.email}` });
    yield c;
    await run.wait(TIMING.senderSearch);
    const hits = run
      .all()
      .filter((x) => x.m.from.email === e.m.from.email && x.key !== e.key && x.m.folder !== "Trash")
      .slice(0, 4);
    yield run.update(c, { state: "done", meta: `${hits.length} found` });
    const m2 = run.msg();
    if (hits.length) yield { type: "chips", message_id: m2, chips: hits.map((x) => this.emailChip(x)) };
    yield* this.say(run, m2, hits.length ? `Earlier emails from ${e.first}:` : `This is the only email from ${e.first} in your mailboxes.`);
  }

  private async *generic(run: Run): Events {
    const text = run.req.text;
    const words = searchWords(text);
    const m = run.msg();
    const c1 = run.call(m, { tool: "email_search", label: `"${words.join(" ") || text}"` });
    yield c1;
    await run.wait(TIMING.genericSearch);
    const hits = words.length
      ? run
          .all()
          .filter((e) => e.m.folder !== "Trash" && e.m.folder !== "Spam")
          .filter((e) => {
            const hay = `${e.from} ${e.m.subject} ${e.m.body_text}`.toLowerCase();
            return words.some((w) => hay.includes(w));
          })
          .slice(0, 4)
      : [];
    yield run.update(c1, { state: "done", meta: `${hits.length} found` });
    const m2 = run.msg();
    if (hits.length) yield { type: "chips", message_id: m2, chips: hits.map((e) => this.emailChip(e)) };
    yield* this.say(
      run,
      m2,
      hits.length
        ? `Found ${hits.length} ${hits.length === 1 ? "email" : "emails"}.`
        : "Nothing matched. Try a sender or a subject, or ask me to file receipts or find what needs a reply.",
    );
  }

  /** Several emails attached and no specific request: read each, say what they are. */
  private async *multi(run: Run): Events {
    const list = run.req.context.keys.map((k) => run.em(k)).filter((e): e is Em => !!e);
    if (!list.length) {
      yield* this.noTarget(run);
      return;
    }
    const m = run.msg();
    let i = 0;
    for (const e of list) {
      i++;
      yield { type: "status", text: `Reading ${e.from}`, progress: { i, n: list.length } };
      yield* this.readStep(run, m, e, TIMING.readFirstRun);
    }
    const lines = list.map((e) => `${e.from}: ${(e.h.summary ?? e.m.preview).split("\n")[0]}`);
    yield* this.say(run, run.msg(), `I read ${list.length === 1 ? "it" : `all ${list.length}`}.\n\n${lines.join("\n\n")}`);
  }
}
