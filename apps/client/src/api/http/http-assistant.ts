/* The assistant over HTTP: `POST {API_BASE}/assistant/run`, answered with a
 * `text/event-stream` of AssistantEvent JSON (one `data:` line each).
 *
 * The server is stateless and never sends mail:
 * - the opaque `conversation` from each `done` event is sent back with the
 *   next run (the store keeps it per conversation);
 * - `approval_required` ends the turn. Approve sends the held draft as the
 *   human through the normal mail actions; Reject and Edit are local. The
 *   next run's `context.notes` tells the assistant what was decided;
 * - Undo reverses a run's `mail_effect`s client side (moves back to where
 *   they came from under the ids they have now, flags flipped back).
 */

import type {
  ApprovalDecision,
  ApprovalDraft,
  AssistantContextNote,
  AssistantEvent,
  AssistantRequest,
  AssistantTransport,
  MailEffect,
} from "../assistant-api";
import { type FolderRef, type MessageFlags, type MessageKey, type MoveResult, makeKey, parseKey } from "../types";
import { ApiClient, ApiError, isAbortError } from "./client";
import { readSse } from "./sse";

export interface HttpAssistantDeps {
  client: ApiClient;
  /** Approve: send this draft as the signed-in human. Throws when it could
   *  not even be queued (nothing is sent then). */
  sendApproved(draft: ApprovalDraft): void | Promise<void>;
  /** Undo: the normal mail mutations. */
  moveMessages(keys: MessageKey[], to: FolderRef): Promise<MoveResult>;
  setFlags(keys: MessageKey[], flags: MessageFlags): Promise<void>;
  /** A move reported new ids (assistant move, or its undo). */
  onMoved?(pairs: { key: MessageKey; new_key: MessageKey }[]): void;
  /** The provider folder id a message is in, when the client knows it. Sent
   *  with each context key: without it the server cannot say where an
   *  attached email was moved FROM, and that move could not be undone. */
  folderOf?(key: MessageKey): string | undefined;
}

type WireKey = string | { inbox_id?: string; message_id?: string; id?: string };

function toKey(k: WireKey): MessageKey | null {
  if (typeof k === "string") return k.indexOf(":") > 0 ? (k as MessageKey) : null;
  const id = k?.message_id ?? k?.id;
  return k?.inbox_id && id ? makeKey(k.inbox_id, id) : null;
}

function toKeys(list: unknown): MessageKey[] {
  if (!Array.isArray(list)) return [];
  const out: MessageKey[] = [];
  for (const k of list as WireKey[]) {
    const key = toKey(k);
    if (key) out.push(key);
  }
  return out;
}

const wireKey = (key: MessageKey, folder?: string) => {
  const { inbox_id, id } = parseKey(key);
  return folder ? { inbox_id, message_id: id, folder } : { inbox_id, message_id: id };
};

/** Accepts keys as "inbox:id" strings or `{ inbox_id, message_id }` objects
 *  and returns the event in the client's shape. Null for anything that is
 *  not an event this client knows. */
export function normalizeAssistantEvent(raw: unknown): AssistantEvent | null {
  if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") return null;
  const ev = raw as Record<string, unknown> & { type: string };
  switch (ev.type) {
    case "tool_call": {
      const call = ev.call as Record<string, unknown> | undefined;
      if (!call) return null;
      return { ...ev, call: { ...call, keys: toKeys(call.keys) } } as unknown as AssistantEvent;
    }
    case "mail_effect": {
      const effect = ev.effect as Record<string, unknown> | undefined;
      if (!effect) return null;
      const keys = toKeys(effect.keys);
      const fresh = toKeys(effect.new_keys);
      const next = { ...effect, keys } as Record<string, unknown>;
      if (fresh.length === keys.length && fresh.length) next.new_keys = fresh;
      else delete next.new_keys;
      return { type: "mail_effect", effect: next as unknown as MailEffect };
    }
    case "row_label":
      return { ...ev, keys: toKeys(ev.keys) } as unknown as AssistantEvent;
    case "draft_stream": {
      const reply = ev.reply_to == null ? undefined : (toKey(ev.reply_to as WireKey) ?? undefined);
      return { ...ev, reply_to: reply } as unknown as AssistantEvent;
    }
    case "approval_required": {
      const draft = ev.draft as (Record<string, unknown> & { reply_to?: WireKey }) | undefined;
      if (!draft || typeof ev.approval_id !== "string") return null;
      const reply = draft.reply_to == null ? undefined : (toKey(draft.reply_to) ?? undefined);
      return { ...ev, external: ev.external === true, draft: { ...draft, reply_to: reply } } as unknown as AssistantEvent;
    }
    case "chips": {
      const chips = Array.isArray(ev.chips) ? (ev.chips as Record<string, unknown>[]) : [];
      return {
        ...ev,
        chips: chips.map((c) => (c.kind === "email" ? { ...c, key: toKey(c.key as WireKey) } : c)).filter((c) => c.kind !== "email" || c.key),
      } as unknown as AssistantEvent;
    }
    case "run_started":
    case "status":
    case "text_delta":
    case "cards":
    case "done":
    case "error":
      return ev as unknown as AssistantEvent;
    default:
      return null;
  }
}

const invert = (flags: MessageFlags): MessageFlags => {
  const out: MessageFlags = {};
  if (flags.read !== undefined) out.read = !flags.read;
  if (flags.starred !== undefined) out.starred = !flags.starred;
  return out;
};

const MAX_RUNS_KEPT = 20;

/** IANA zone of this browser, so "tomorrow at 9" means the person's 9. */
function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

export class HttpAssistantTransport implements AssistantTransport {
  readonly approvalsOutliveRun = true;
  private approvals = new Map<string, ApprovalDraft>();
  private notes: AssistantContextNote[] = [];
  private runs = new Map<string, MailEffect[]>();

  constructor(private readonly deps: HttpAssistantDeps) {}

  /** Forgets everything (sign-out). */
  reset(): void {
    this.approvals.clear();
    this.notes = [];
    this.runs.clear();
  }

  async *run(req: AssistantRequest, opts: { signal: AbortSignal }): AsyncGenerator<AssistantEvent, void, void> {
    const { signal } = opts;
    // A new request while a send still waits: fail closed, it was not approved.
    for (const approval_id of this.approvals.keys()) this.notes.push({ type: "approval", approval_id, decision: "rejected" });
    this.approvals.clear();
    const notes = [...this.notes, ...(req.context.notes ?? [])];
    const body = {
      text: req.text,
      ...(req.intent ? { intent: req.intent } : {}),
      context: {
        keys: req.context.keys.map((k) => wireKey(k, this.deps.folderOf?.(k))),
        ...(notes.length ? { notes } : {}),
        ...(timezone() ? { timezone: timezone() } : {}),
      },
      conversation: req.conversation ?? null,
      ...(req.draft
        ? { draft: { ...req.draft, reply_to: req.draft.reply_to ? wireKey(req.draft.reply_to) : undefined } }
        : {}),
    };

    let res: Response;
    try {
      res = await this.deps.client.stream("/assistant/run", body, signal);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      const code = err instanceof ApiError ? err.code : "network";
      yield { type: "error", code, message: assistantErrorText(code, err instanceof ApiError ? err.message : undefined) };
      return;
    }
    // The server has these notes now.
    this.notes = this.notes.filter((n) => !notes.includes(n));
    if (!res.body) {
      yield { type: "error", code: "invalid_response", message: assistantErrorText("invalid_response") };
      return;
    }

    let run_id: string | null = null;
    let finished = false;
    try {
      for await (const msg of readSse(res.body, signal)) {
        if (signal.aborted) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const ev = normalizeAssistantEvent(parsed);
        if (!ev) continue;
        if (ev.type === "run_started") {
          run_id = ev.run_id;
          this.runs.set(run_id, []);
          while (this.runs.size > MAX_RUNS_KEPT) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined) break;
            this.runs.delete(oldest);
          }
        } else if (ev.type === "mail_effect") {
          if (run_id) this.runs.get(run_id)?.push(ev.effect);
          const fresh = ev.effect.new_keys;
          if (ev.effect.kind === "moved" && fresh) {
            this.deps.onMoved?.(ev.effect.keys.map((key, i) => ({ key, new_key: fresh[i] ?? key })));
          }
        } else if (ev.type === "approval_required") {
          // The server ignores Bcc, so the draft it asks approval for has
          // none. If this is the draft the run was started with, the Bcc the
          // person typed on it goes out with it.
          const sent = req.draft;
          const same = !!sent && (ev.draft.reply_to ? sent.reply_to === ev.draft.reply_to : !sent.reply_to);
          const draft = same && sent?.bcc?.trim() ? { ...ev.draft, bcc: sent.bcc } : ev.draft;
          this.approvals.set(ev.approval_id, draft);
          finished = true;
          yield { ...ev, draft };
          continue;
        } else if (ev.type === "error") {
          finished = true;
          yield { ...ev, message: ev.code ? assistantErrorText(ev.code, ev.message) : ev.message };
          continue;
        } else if (ev.type === "done") {
          finished = true;
        }
        yield ev;
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) return;
      yield { type: "error", code: "network", message: assistantErrorText("network") };
      return;
    }
    if (!finished && !signal.aborted) {
      yield { type: "error", code: "interrupted", message: assistantErrorText("interrupted") };
    }
  }

  async resolveApproval(approval_id: string, decision: ApprovalDecision): Promise<void> {
    const draft = this.approvals.get(approval_id);
    this.approvals.delete(approval_id);
    if (decision !== "approve") {
      this.notes.push({ type: "approval", approval_id, decision: decision === "edit" ? "edited" : "rejected" });
      return;
    }
    // Fail closed: an approval this client does not hold is not sent.
    if (!draft) throw new Error("Unknown approval");
    try {
      await this.deps.sendApproved(draft);
    } catch (err) {
      this.notes.push({ type: "approval", approval_id, decision: "rejected" });
      throw err;
    }
    this.notes.push({ type: "approval", approval_id, decision: "approved" });
  }

  async undo(run_id: string): Promise<void> {
    const effects = this.runs.get(run_id) ?? [];
    this.runs.delete(run_id);
    let failed = 0;
    // Undoing a move can itself give a message a new id (IMAP): an earlier
    // effect of the same run that names the old one must follow it.
    const renamed = new Map<MessageKey, MessageKey>();
    const current = (key: MessageKey): MessageKey => {
      let k = key;
      for (let i = 0; i < 20 && renamed.has(k); i++) k = renamed.get(k) as MessageKey;
      return k;
    };
    // Newest first, so a message moved twice goes back the way it came.
    for (const effect of [...effects].reverse()) {
      try {
        if (effect.kind === "moved") {
          if (!effect.from) {
            failed++;
            continue;
          }
          const now = (effect.new_keys ?? effect.keys).map(current);
          const result = await this.deps.moveMessages(now, effect.from);
          for (const m of result.moved) {
            if (m.id_unknown) failed++;
            else if (m.new_key !== m.key) renamed.set(m.key, m.new_key);
          }
          const changed = result.moved.filter((m) => m.new_key !== m.key && !m.id_unknown);
          if (changed.length) this.deps.onMoved?.(changed);
        } else if (effect.kind === "flagged" && effect.flags) {
          await this.deps.setFlags(effect.keys.map(current), invert(effect.flags));
        }
      } catch {
        failed++;
      }
    }
    if (failed) throw new Error("Some changes could not be undone.");
  }
}

export function assistantErrorText(code: string, serverMessage?: string): string {
  switch (code) {
    case "allowance_exhausted":
      return "You have used this month's assistant allowance.";
    case "offline":
      return "You are offline. The assistant needs a connection.";
    case "rate_limited":
      return "The assistant is busy. Try again in a moment.";
    case "timeout":
      return "The assistant took too long to answer. Nothing else was changed.";
    case "unauthenticated":
      return "Your session ended. Sign in again.";
    case "forbidden":
    case "web_client_disabled":
      return "The assistant is not available for this workspace.";
    case "interrupted":
    case "network":
      return "The connection to the assistant was lost. Nothing else was changed.";
    default:
      return serverMessage || "The assistant ran into a problem. Nothing else was changed.";
  }
}
