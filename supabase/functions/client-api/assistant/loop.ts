/* The agent loop: one request in, a stream of AssistantEvents out.
 *
 * Order of a run:
 *   run_started, status            immediately, before anything can block
 *   provider resolved              (not_configured ends the run, nothing reserved)
 *   allowance reserved             (allowance_exhausted ends the run)
 *   up to `maxRounds` model rounds: text streams as text_delta; tool calls are
 *     checked by policy.ts, shown as tool_call, executed, and every change is
 *     reported as mail_effect; virtual tools stream drafts and request sends
 *   chips, done { conversation, usage, summary }
 *   finally: allowance finalised with real usage, one content-free log line
 *
 * Stopping:
 *   - client abort / disconnect: the provider request is aborted, calls in
 *     flight are re-emitted as cancelled, no further model round starts.
 *     A mutation already handed to the mailbox is awaited (it cannot be
 *     recalled) but nothing new is started.
 *   - wall clock, round and token ceilings: the run ends with what it has,
 *     says so in one sentence, and still returns `done` with `stopped` set.
 *   - provider failure: `error` (user-safe), then `done` so the client keeps
 *     the conversation and the undo summary of what was already changed.
 */

import { appendTurn, type ConversationState, parseConversation, type TurnCall, type TurnRef } from "./conversation.ts";
import type { AssistantDeps, AssistantUsage } from "./deps.ts";
import { type DraftEnv, DraftWriter, editDraft, requestSend, type VirtualOutcome } from "./drafts.ts";
import {
  type AssistantChip,
  type AssistantEvent,
  type AssistantToolCall,
  type Emit,
  type ErrorCode,
  makeKey,
  type MessageKey,
  type RunUsage,
  type StopReason,
} from "./events.ts";
import { costMicroUsd, priceFor } from "./llm/pricing.ts";
import { resolveProvider } from "./llm/registry.ts";
import {
  isAbortError,
  LlmError,
  type LlmFinishReason,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
  type LlmToolDef,
  type LlmToolResult,
} from "./llm/types.ts";
import { describeCall, executeCall, RunMemory, runSummary } from "./mailbox.ts";
import {
  DEFAULT_LIMITS,
  isVirtualTool,
  type Limits,
  modelTools,
  REAL_TOOLS,
  type SanitizedCall,
  sanitizeToolCall,
} from "./policy.ts";
import { buildMessages, buildSystemPrompt, makeNonce, wrapToolResult } from "./prompt.ts";
import { type DraftState, keyOf, type RunInput } from "./request.ts";

export interface RunOptions {
  /** Client abort / disconnect. */
  signal: AbortSignal;
  emit: Emit;
  /** Tests inject these; production resolves them from env. */
  provider?: LlmProvider;
  model?: string;
  limits?: Partial<Limits>;
  now?: () => number;
  runId?: string;
  nonce?: string;
}

export type RunOutcome = "completed" | "approval" | "stopped" | "aborted" | "error" | "rejected";

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  errorCode?: ErrorCode;
  stopped?: StopReason;
  usage: RunUsage;
}

const STOP_TEXT: Record<StopReason, string> = {
  max_rounds: "I stopped here because this request needed too many steps. Ask me to continue if you want the rest.",
  timeout: "I ran out of time on this request. What I did so far is shown above.",
  token_ceiling: "I reached the size limit for one request and stopped. What I did so far is shown above.",
  output_limit: "My answer was cut off because it got too long. Ask for a narrower part and I will finish it.",
};

/** Said by the loop when a send was asked for, the draft has no recipient, and the model asked nothing. */
const ASK_RECIPIENT_TEXT = "Who should this go to? Give me the address and I will ask you to approve the send.";
const APPROVAL_TEXT = "The draft is ready for your approval. Nothing is sent until you approve it.";

interface PendingCall {
  index: number;
  id: string;
  name: string;
  args: string;
  ended: boolean;
  writer?: DraftWriter;
}

interface Job {
  call: PendingCall;
  result: LlmToolResult | null;
  sanitized: SanitizedCall | null;
  uiId: string;
}

class ClientGone extends Error {}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export async function runAssistant(input: RunInput, deps: AssistantDeps, opts: RunOptions): Promise<RunResult> {
  const run = new Run(input, deps, opts);
  return await run.execute();
}

class Run {
  private readonly limits: Limits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly runId: string;
  private readonly nonce: string;
  private readonly mem = new RunMemory();
  private readonly inboxIds: Set<string>;
  private readonly runCtl = new AbortController();
  private timedOut = false;

  private provider: LlmProvider | null = null;
  private model = "";
  private tokenCeiling = 0;

  private readonly usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  private rounds = 0;
  private firstOutputMs: number | null = null;
  private readonly toolLog: string[] = [];
  private readonly rejectLog: string[] = [];

  private messages: LlmMessage[] = [];
  private system = "";
  private tools: LlmToolDef[] = [];
  private conversation: ConversationState;
  private conversationRejected: string | null;

  private msgSeq = 0;
  private callSeq = 0;
  private readonly calls = new Map<string, { messageId: string; call: AssistantToolCall }>();
  private allText = "";
  /** The last request_send was refused because the draft has no recipient. */
  private recipientMissing = false;
  private lastText = "";
  private lastMessageId = "";
  private readonly readKeys: MessageKey[] = [];
  private draft: DraftState | null;
  private approvalRequested = false;

  constructor(private readonly input: RunInput, private readonly deps: AssistantDeps, private readonly opts: RunOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.runId = opts.runId ?? `run_${crypto.randomUUID()}`;
    this.nonce = opts.nonce ?? makeNonce();
    this.inboxIds = new Set(deps.inboxes.map((i) => i.inbox_id));
    this.draft = input.draft;
    const parsed = parseConversation(input.conversation);
    this.conversation = parsed.state;
    this.conversationRejected = parsed.rejected;
  }

  /* ---------------- lifecycle ---------------- */

  async execute(): Promise<RunResult> {
    const { emit } = this;
    emit({ type: "run_started", run_id: this.runId });
    emit({ type: "status", text: "Working" });

    try {
      if (this.opts.provider) {
        this.provider = this.opts.provider;
        this.model = this.opts.model ?? "test-model";
      } else {
        const resolved = resolveProvider(this.deps.env);
        this.provider = resolved.provider;
        this.model = resolved.model;
      }
    } catch {
      return this.reject("not_configured", "The assistant is not available right now.", false);
    }

    let reservationId: string | undefined;
    try {
      const reservation = await this.deps.reserveAllowance();
      if (!reservation.ok) {
        const resets = reservation.allowance?.resets_at;
        const when = resets && !Number.isNaN(Date.parse(resets)) ? ` It resets on ${resets.slice(0, 10)}.` : "";
        return this.reject("allowance_exhausted", `You have used all of this month's assistant requests.${when}`, false, resets);
      }
      reservationId = reservation.reservationId;
      const ceiling = reservation.allowance?.max_tokens_per_run;
      this.tokenCeiling = typeof ceiling === "number" && ceiling > 0
        ? Math.min(Math.max(Math.trunc(ceiling), 2_000), 2_000_000)
        : this.limits.defaultTokenCeiling;
    } catch {
      return this.reject("provider_error", "The assistant could not start. Try again.", true);
    }

    const onClientAbort = () => this.runCtl.abort();
    if (this.opts.signal.aborted) this.runCtl.abort();
    else this.opts.signal.addEventListener("abort", onClientAbort, { once: true });
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.runCtl.abort();
    }, this.limits.wallClockMs);

    let outcome: RunOutcome = "completed";
    let errorCode: ErrorCode | undefined;
    let stopped: StopReason | undefined;
    let llmError: LlmError | null = null;
    try {
      stopped = await this.loop();
      outcome = this.approvalRequested ? "approval" : stopped ? "stopped" : "completed";
      this.finish(stopped);
    } catch (err) {
      if (this.opts.signal.aborted || err instanceof ClientGone) {
        outcome = "aborted";
        this.cancelActive("stopped");
      } else if (this.timedOut) {
        outcome = "stopped";
        stopped = "timeout";
        this.cancelActive("stopped");
        this.finish(stopped);
      } else {
        outcome = "error";
        llmError = err instanceof LlmError ? err : null;
        const mapped = mapError(llmError);
        errorCode = mapped.code;
        this.cancelActive("failed");
        emit({ type: "error", message: mapped.message, code: mapped.code, retryable: mapped.retryable });
        emit({ type: "done", conversation: this.nextConversation(), usage: this.runUsage(), summary: runSummary(this.mem) });
      }
    } finally {
      clearTimeout(timer);
      this.opts.signal.removeEventListener("abort", onClientAbort);
      const usage = this.runUsage();
      if (reservationId) {
        const settled: AssistantUsage = {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cost_micro_usd: usage.cost_micro_usd,
          model: usage.model,
        };
        try {
          await this.deps.finalizeAllowance(reservationId, settled);
        } catch {
          this.safeLog("assistant_finalize_failed", { run_id: this.runId });
        }
      }
      this.logRun(outcome, errorCode, stopped, llmError);
    }
    return { runId: this.runId, outcome, errorCode, stopped, usage: this.runUsage() };
  }

  /** Ends a run before it started working: nothing was reserved or it was refused. */
  private reject(code: ErrorCode, message: string, retryable: boolean, resetsAt?: string): RunResult {
    this.emit({ type: "error", message, code, retryable, ...(resetsAt ? { resets_at: resetsAt } : {}) });
    this.logRun("rejected", code, undefined, null);
    return { runId: this.runId, outcome: "rejected", errorCode: code, usage: this.runUsage() };
  }

  private readonly emit: Emit = (event: AssistantEvent) => {
    if (this.firstOutputMs === null && (event.type === "text_delta" || event.type === "tool_call" || event.type === "draft_stream")) {
      this.firstOutputMs = this.now() - this.startedAt;
    }
    try {
      this.opts.emit(event);
    } catch {
      // A closed stream must not break the run's cleanup.
    }
  };

  /* ---------------- the loop ---------------- */

  private async loop(): Promise<StopReason | undefined> {
    const { input, deps } = this;
    this.system = buildSystemPrompt(deps.user, deps.inboxes, this.limits);
    const available = new Set(deps.toolSchemas.length ? deps.toolSchemas.map((t) => t.name) : REAL_TOOLS);
    this.tools = modelTools(available, this.limits);
    this.messages = buildMessages({
      text: input.text,
      keys: input.keys,
      note: input.note,
      decisions: input.decisions,
      intent: input.intent,
      draft: input.draft,
      now: new Date(this.now()),
      timezone: input.timezone,
      conversation: this.conversation,
      nonce: this.nonce,
    });
    for (const k of input.keys) if (k.folder) this.mem.note(keyOf(k), { folder: k.folder });

    await this.preRead();

    for (let round = 1; round <= this.limits.maxRounds; round++) {
      this.check();
      const budget = this.outputBudget();
      if (budget === null) return "token_ceiling";
      this.rounds = round;
      const result = await this.round(budget);
      if (this.approvalRequested) return undefined;
      if (result === "final") return undefined;
      if (result === "length") return "output_limit";
    }
    return "max_rounds";
  }

  /** Throws when the run must not continue. */
  private check(): void {
    if (this.opts.signal.aborted) throw new ClientGone();
    if (this.runCtl.signal.aborted) throw new LlmError("aborted");
  }

  /** Output tokens the next round may use, or null when the ceiling is reached. */
  private outputBudget(): number | null {
    const used = this.usage.inputTokens + this.usage.outputTokens;
    const next = estimateTokens(this.requestChars());
    const room = this.tokenCeiling - used - next;
    if (room < 200) return null;
    return Math.min(this.limits.maxOutputTokensPerRound, room);
  }

  private requestChars(): number {
    let n = this.system.length + JSON.stringify(this.tools).length;
    for (const m of this.messages) {
      if (m.role === "user") n += m.text.length;
      else if (m.role === "assistant") n += m.text.length + m.toolCalls.reduce((a, c) => a + c.argumentsJson.length + c.name.length, 0);
      else n += m.results.reduce((a, r) => a + r.content.length, 0);
    }
    return n;
  }

  /** One attached email and no draft: read it before the first model round.
   *  It is what the request is about, and it saves a full round trip. */
  private async preRead(): Promise<void> {
    const { input } = this;
    if (input.keys.length !== 1 || input.draft) return;
    const k = input.keys[0] as { inbox_id: string; message_id: string };
    const messageId = this.nextMessageId();
    const call: PendingCall = {
      index: 0,
      id: "pre_1",
      name: "email_read",
      args: JSON.stringify({ action: "read", inbox_id: k.inbox_id, message_id: k.message_id }),
      ended: true,
    };
    const results = await this.runCalls([call], messageId);
    this.messages.push({ role: "assistant", text: "", toolCalls: [{ id: call.id, name: call.name, argumentsJson: call.args }] });
    this.messages.push({ role: "tool", results });
  }

  private async round(maxOutputTokens: number): Promise<"final" | "continue" | "length"> {
    const provider = this.provider as LlmProvider;
    const messageId = this.nextMessageId();
    const pending = new Map<number, PendingCall>();
    let text = "";
    let finish: LlmFinishReason = "stop";
    let gotUsage = false;
    const requestChars = this.requestChars();
    let outputChars = 0;

    try {
      const stream = provider.stream({
        model: this.model,
        system: this.system,
        messages: this.messages,
        tools: this.tools,
        maxOutputTokens,
        temperature: 0.3,
        signal: this.runCtl.signal,
      });
      for await (const ev of stream) {
        if (this.runCtl.signal.aborted) break;
        switch (ev.type) {
          case "text_delta":
            text += ev.text;
            outputChars += ev.text.length;
            this.emit({ type: "text_delta", message_id: messageId, delta: ev.text });
            break;
          case "tool_call_start": {
            const call: PendingCall = { index: ev.index, id: ev.id, name: ev.name, args: "", ended: false };
            pending.set(ev.index, call);
            if (ev.name === "write_draft" && !this.approvalRequested) {
              call.writer = new DraftWriter(this.draftEnv(), this.nextCallId(), messageId);
            }
            break;
          }
          case "tool_call_delta": {
            const call = pending.get(ev.index);
            if (!call || call.ended) break;
            call.args += ev.argumentsDelta;
            outputChars += ev.argumentsDelta.length;
            call.writer?.onDelta(ev.argumentsDelta);
            break;
          }
          case "tool_call_end": {
            const call = pending.get(ev.index) ?? { index: ev.index, id: ev.id, name: ev.name, args: "", ended: false };
            pending.set(ev.index, call);
            call.args = ev.argumentsJson || call.args;
            call.ended = true;
            break;
          }
          case "usage":
            gotUsage = true;
            this.usage.inputTokens += ev.inputTokens;
            this.usage.outputTokens += ev.outputTokens;
            this.usage.cachedInputTokens += ev.cachedInputTokens;
            break;
          case "finish":
            finish = ev.reason;
            break;
        }
      }
    } catch (err) {
      this.accountUnreported(gotUsage, requestChars, outputChars);
      this.closeText(messageId, text);
      for (const c of pending.values()) c.writer?.abandon(this.opts.signal.aborted ? "stopped" : "failed");
      if (this.opts.signal.aborted) throw new ClientGone();
      if (isAbortError(err) || this.runCtl.signal.aborted) throw new LlmError("aborted");
      throw err;
    }
    this.accountUnreported(gotUsage, requestChars, outputChars);
    this.closeText(messageId, text);

    const all = [...pending.values()].sort((a, b) => a.index - b.index);
    for (const c of all) if (!c.ended) c.writer?.abandon("cut off");
    this.check();
    const complete = all.filter((c) => c.ended);
    if (!complete.length) {
      if (finish === "length") return "length";
      return "final";
    }

    const results = await this.runCalls(complete, messageId);
    this.messages.push({
      role: "assistant",
      text,
      toolCalls: complete.map((c): LlmToolCall => ({ id: c.id, name: c.name, argumentsJson: validJson(c.args) })),
    });
    this.messages.push({ role: "tool", results });
    return "continue";
  }

  /** A round the provider never reported usage for (abort, broken stream) is
   *  still paid for: count an estimate instead of zero. */
  private accountUnreported(gotUsage: boolean, requestChars: number, outputChars: number): void {
    if (gotUsage) return;
    this.usage.inputTokens += estimateTokens(requestChars);
    this.usage.outputTokens += estimateTokens(outputChars);
  }

  private closeText(messageId: string, text: string): void {
    if (!text) return;
    // The model answered after the refusal (text of the same round is closed
    // before its calls run), so the loop has nothing to add.
    this.recipientMissing = false;
    this.emit({ type: "text_delta", message_id: messageId, delta: "", done: true });
    this.allText += (this.allText ? "\n\n" : "") + text;
    this.lastText = text;
    this.lastMessageId = messageId;
  }

  /* ---------------- tool calls ---------------- */

  /** Runs the calls of one round. Returns one result per call, in order. */
  private async runCalls(calls: PendingCall[], messageId: string): Promise<LlmToolResult[]> {
    const jobs: Job[] = [];
    for (const call of calls) {
      const job: Job = { call, result: null, sanitized: null, uiId: "" };
      jobs.push(job);
      if (jobs.length > this.limits.maxToolCallsPerRound) {
        job.result = this.toolError(call, "Too many tool calls in one step. Continue with the rest in the next step.");
        this.rejectLog.push("too_many_calls");
        continue;
      }
      if (isVirtualTool(call.name)) continue;
      const parsed = parseArgs(call.args);
      const checked = sanitizeToolCall(call.name, parsed, {
        inboxIds: this.inboxIds,
        defaultInboxId: this.deps.inboxes.length === 1 ? (this.deps.inboxes[0]?.inbox_id ?? null) : null,
        limits: this.limits,
        bodiesRead: this.mem.bodiesRead,
        mutated: this.mem.mutated,
      });
      if (!checked.ok) {
        job.result = this.toolError(call, checked.message);
        this.rejectLog.push(checked.code);
        continue;
      }
      // Budgets are reserved now, so calls checked later in this round see them.
      if (checked.readOnly && (checked.action === "read" || checked.action === "read_batch")) {
        this.mem.bodiesRead += checked.messageIds.length;
      }
      if (!checked.readOnly) this.mem.mutated += checked.messageIds.length;
      job.sanitized = checked;
    }

    const n = jobs.filter((j) => !j.result).length;
    let done = 0;
    for (let i = 0; i < jobs.length;) {
      const job = jobs[i] as Job;
      if (job.result) {
        i++;
        continue;
      }
      // After a send request nothing else runs: the turn is the human's.
      if (this.approvalRequested) {
        job.result = this.toolError(job.call, "Skipped: the turn ended with the send request.");
        i++;
        continue;
      }
      this.check();
      if (job.sanitized?.readOnly) {
        // Consecutive read-only calls run together.
        const group: Job[] = [];
        while (i < jobs.length && !(jobs[i] as Job).result && (jobs[i] as Job).sanitized?.readOnly) group.push(jobs[i++] as Job);
        if (n > 1) this.emit({ type: "status", text: describeCall(group[0]?.sanitized as SanitizedCall, this.mem).human, progress: { i: done + 1, n } });
        await Promise.all(group.map((j) => this.runReal(j, messageId)));
        done += group.length;
        continue;
      }
      done++;
      if (job.sanitized) {
        if (n > 1) this.emit({ type: "status", text: describeCall(job.sanitized, this.mem).human, progress: { i: done, n } });
        await this.runReal(job, messageId);
      } else {
        job.result = await this.runVirtual(job.call, messageId);
      }
      i++;
    }
    return jobs.map((j) => j.result ?? this.toolError(j.call, "The call did not run."));
  }

  private async runReal(job: Job, messageId: string): Promise<void> {
    const call = job.sanitized as SanitizedCall;
    const id = this.nextCallId();
    job.uiId = id;
    this.toolLog.push(call.action ? `${call.tool}.${call.action}` : call.tool);
    const view = describeCall(call, this.mem);
    this.showCall(messageId, { id, ...view, meta: "", state: "running" });
    this.emit({ type: "status", text: view.human });

    const work = executeCall(call, this.deps.runTool, this.mem, this.limits);
    // A read can be abandoned on abort. A mutation cannot be recalled once it
    // was handed over, so it is awaited and its effect is always reported.
    const outcome = call.readOnly ? await this.raceAbort(work) : await work;
    if (call.action === "read" || call.action === "read_batch") {
      for (const e of outcome.effects) for (const k of e.keys) if (!this.readKeys.includes(k)) this.readKeys.push(k);
    }
    for (const effect of outcome.effects) this.emit({ type: "mail_effect", effect: { ...effect, call_id: id } });
    // Reads learn the sender while they run: show the better label when done.
    const after = call.readOnly ? describeCall(call, this.mem) : view;
    this.showCall(messageId, {
      id,
      ...view,
      human: after.human,
      meta: outcome.meta,
      state: outcome.isError ? "cancelled" : "done",
    });
    job.result = {
      callId: job.call.id,
      name: job.call.name,
      content: wrapToolResult(this.nonce, call.tool, outcome.content, outcome.isError),
      isError: outcome.isError,
    };
  }

  private async runVirtual(call: PendingCall, messageId: string): Promise<LlmToolResult> {
    this.toolLog.push(call.name);
    let outcome: VirtualOutcome;
    if (call.name === "write_draft") {
      const writer = call.writer ?? new DraftWriter(this.draftEnv(), this.nextCallId(), messageId);
      const res = writer.finish(call.args);
      if (res.draft) this.draft = res.draft;
      outcome = res.outcome;
    } else if (call.name === "edit_draft") {
      const res = await editDraft(this.draftEnv(), this.draft, call.args, this.nextCallId(), messageId);
      if (res.draft) this.draft = res.draft;
      outcome = res.outcome;
    } else {
      const res = requestSend(this.draftEnv(), this.draft, call.args, this.nextCallId(), messageId, `${this.runId}_ap1`);
      if (res.approved) this.approvalRequested = true;
      if (res.draft) this.draft = res.draft;
      // Remembered so a model that then says nothing does not end the run
      // silently: `finish` asks the question itself.
      this.recipientMissing = res.missingRecipient === true;
      outcome = res.outcome;
    }
    if (outcome.isError) this.rejectLog.push(`${call.name}_invalid`);
    return { callId: call.id, name: call.name, content: outcome.content, isError: outcome.isError };
  }

  private toolError(call: PendingCall, message: string): LlmToolResult {
    return { callId: call.id, name: call.name, content: JSON.stringify({ error: message }), isError: true };
  }

  private raceAbort<T>(work: Promise<T>): Promise<T> {
    const signal = this.runCtl.signal;
    if (signal.aborted) {
      work.catch(() => {});
      return Promise.reject(this.opts.signal.aborted ? new ClientGone() : new LlmError("aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        work.catch(() => {});
        reject(this.opts.signal.aborted ? new ClientGone() : new LlmError("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  private draftEnv(): DraftEnv {
    const { input, deps } = this;
    const single = input.keys.length === 1 ? (input.keys[0] as { inbox_id: string; message_id: string }) : null;
    return {
      inboxes: deps.inboxes,
      userEmail: deps.user.email,
      defaultInboxId: single?.inbox_id ?? input.draft?.inbox_id ?? deps.inboxes[0]?.inbox_id ?? null,
      defaultReplyTo: single ? { inbox_id: single.inbox_id, message_id: single.message_id } : (this.draft?.reply_to ?? null),
      mem: this.mem,
      limits: this.limits,
      emit: this.emit,
      showCall: (messageId, call) => this.showCall(messageId, call),
      sleep: (ms) => this.sleep(ms),
    };
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.runCtl.signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const signal = this.runCtl.signal;
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /* ---------------- transcript bookkeeping ---------------- */

  private nextMessageId(): string {
    return `${this.runId}_m${++this.msgSeq}`;
  }
  private nextCallId(): string {
    return `${this.runId}_c${++this.callSeq}`;
  }

  private showCall(messageId: string, call: AssistantToolCall): void {
    this.calls.set(call.id, { messageId, call });
    this.emit({ type: "tool_call", message_id: messageId, call });
  }

  /** Calls still in flight, re-emitted as cancelled. A held send stays held. */
  private cancelActive(meta: string): void {
    for (const entry of this.calls.values()) {
      if (entry.call.state !== "running") continue;
      entry.call = { ...entry.call, state: "cancelled", meta };
      this.emit({ type: "tool_call", message_id: entry.messageId, call: entry.call });
    }
  }

  /* ---------------- ending ---------------- */

  private finish(stopped: StopReason | undefined): void {
    if (this.approvalRequested) this.say(APPROVAL_TEXT);
    else if (stopped) this.say(STOP_TEXT[stopped]);
    else if (this.recipientMissing) this.say(ASK_RECIPIENT_TEXT);
    else if (!this.allText) this.say(this.mem.counts.moved + this.mem.counts.archived + this.mem.counts.trashed + this.mem.counts.flagged ? "Done." : "I have nothing to add.");
    const chips = this.chips();
    if (chips.length && this.lastMessageId) this.emit({ type: "chips", message_id: this.lastMessageId, chips });
    this.emit({
      type: "done",
      conversation: this.nextConversation(chips),
      usage: this.runUsage(),
      summary: runSummary(this.mem),
      ...(stopped ? { stopped } : {}),
    });
  }

  /** A sentence of our own, as its own message. */
  private say(text: string): void {
    const messageId = this.nextMessageId();
    this.emit({ type: "text_delta", message_id: messageId, delta: text, done: true });
    this.allText += (this.allText ? "\n\n" : "") + text;
    this.lastMessageId = messageId;
  }

  /** Emails the answer names (by sender or subject), and the folder mail went to. */
  private chips(): AssistantChip[] {
    const chips: AssistantChip[] = [];
    const answer = this.lastText.toLowerCase();
    if (answer) {
      const attached = new Set(this.input.keys.map(keyOf));
      const candidates = [...new Set([...this.mem.listed, ...this.readKeys])];
      for (const key of candidates) {
        if (chips.length >= 6) break;
        if (attached.has(key)) continue;
        const s = this.mem.seen.get(key);
        if (!s) continue;
        const name = (s.name || s.email).toLowerCase();
        const subject = s.subject.toLowerCase();
        const hit = (name.length >= 3 && answer.includes(name)) || (subject.length >= 6 && answer.includes(subject));
        if (hit) chips.push({ kind: "email", key, label: chipLabel(s.name || s.email, s.subject) });
      }
    }
    if (this.mem.lastMoveTo && this.mem.counts.moved) {
      chips.push({ kind: "folder", folder: this.mem.lastMoveTo, label: this.mem.lastMoveLabel, sub: `${this.mem.counts.moved} moved` });
    }
    return chips;
  }

  private nextConversation(chips: AssistantChip[] = []): ConversationState {
    const calls: TurnCall[] = [...this.calls.values()].map((e) => ({ h: e.call.human, k: e.call.keys.slice(0, 20) }));
    const refs = new Map<string, TurnRef>();
    const ref = (key: MessageKey) => {
      const s = this.mem.seen.get(key);
      refs.set(key, { k: key, l: s ? chipLabel(s.name || s.email, s.subject) : "attached email" });
    };
    for (const k of this.input.keys) ref(keyOf(k));
    for (const k of this.readKeys) ref(k);
    for (const c of chips) if (c.kind === "email") ref(c.key);
    if (this.draft?.reply_to) ref(makeKey(this.draft.reply_to.inbox_id, this.draft.reply_to.message_id));
    return appendTurn(this.conversation, {
      u: this.input.text || (this.input.intent ? `(pressed "${this.input.intent}")` : ""),
      a: this.allText,
      calls,
      refs: [...refs.values()],
    });
  }

  private runUsage(): RunUsage {
    return {
      input_tokens: this.usage.inputTokens,
      output_tokens: this.usage.outputTokens,
      cost_micro_usd: this.model ? costMicroUsd(this.model, this.usage) : 0,
      model: this.model,
      rounds: this.rounds,
    };
  }

  /* ---------------- logging: ids, counts, codes. Never content. ---------------- */

  private logRun(outcome: RunOutcome, errorCode: ErrorCode | undefined, stopped: StopReason | undefined, err: LlmError | null): void {
    const usage = this.runUsage();
    this.safeLog("assistant_run", {
      run_id: this.runId,
      provider: this.provider?.name ?? null,
      model: this.model || null,
      outcome,
      error_code: errorCode ?? null,
      stopped: stopped ?? null,
      llm_error: err?.kind ?? null,
      llm_status: err?.status ?? null,
      llm_code: err?.providerCode ? err.providerCode.slice(0, 60).replace(/[^\w.\-]/g, "_") : null,
      rounds: this.rounds,
      tools: this.toolLog,
      tools_rejected: this.rejectLog,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_input_tokens: this.usage.cachedInputTokens,
      cost_micro_usd: usage.cost_micro_usd,
      price_known: this.model ? priceFor(this.model).known : null,
      duration_ms: this.now() - this.startedAt,
      first_output_ms: this.firstOutputMs,
      context_keys: this.input.keys.length,
      has_draft: !!this.input.draft,
      text_chars: this.input.text.length,
      conversation_rejected: this.conversationRejected,
      bodies_read: this.mem.bodiesRead,
      messages_changed: this.mem.mutated,
      approval_requested: this.approvalRequested,
    });
  }

  private safeLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.log(event, fields);
    } catch {
      // Logging must never affect a run.
    }
  }
}

function mapError(err: LlmError | null): { code: ErrorCode; message: string; retryable: boolean } {
  switch (err?.kind) {
    case "rate_limit":
      return err.retryable
        ? { code: "rate_limited", message: "The assistant is busy right now. Try again in a moment.", retryable: true }
        : { code: "provider_error", message: "The assistant is not available right now.", retryable: false };
    case "auth":
    case "not_configured":
      return { code: "not_configured", message: "The assistant is not available right now.", retryable: false };
    case "context_length":
      return { code: "invalid_request", message: "This request is too large for the assistant. Try it with fewer emails.", retryable: false };
    case "invalid_request":
      return { code: "provider_error", message: "The assistant could not handle this request.", retryable: false };
    default:
      return { code: "provider_error", message: "The assistant could not finish. Try again.", retryable: true };
  }
}

function chipLabel(sender: string, subject: string): string {
  const label = subject ? `${sender} · ${subject}` : sender;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

function parseArgs(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** What is replayed to the provider must parse, whatever the model produced. */
function validJson(json: string): string {
  const v = parseArgs(json);
  return v && typeof v === "object" && !Array.isArray(v) ? json : "{}";
}
