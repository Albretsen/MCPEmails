// `POST /mail/batch`: up to 12 mail ops in one round trip.
//
// Ordering and sharing rules:
//   - results come back in the order the calls were given, always;
//   - calls for DIFFERENT inboxes run in parallel;
//   - calls for the SAME inbox run one after another, in the order given, so
//     on IMAP they share one session: the first call opens (or reuses) the
//     pooled connection and each later one takes it over as it is returned;
//   - one call failing does not fail the batch: its slot carries the error.
//
// A Gmail or Outlook inbox has no session to share, so when the inbox row is
// already cached and says so, its calls run concurrently (bounded) instead.

import { type ErrorBody, invalidRequest, toApiError } from "../errors.ts";
import { MAX_BATCH_CALLS, OPS } from "./ops.ts";
import { type MailEnv, type MailRequest, type OpTimings, runMailOp } from "./run.ts";

export type BatchEntry = { ok: true; result: unknown } | { ok: false; error: ErrorBody };

export interface BatchOutcome {
  results: BatchEntry[];
  timings: OpTimings;
  /** Per call, for the log line: op name and outcome code only. */
  summary: Array<{ op: string; status: "ok" | string }>;
}

const HTTP_PROVIDER_CONCURRENCY = 4;

export function parseBatch(body: unknown): MailRequest[] {
  const calls = (body as { calls?: unknown } | null)?.calls;
  if (!Array.isArray(calls) || calls.length === 0) throw invalidRequest("batch: 'calls' must be a non-empty array.");
  if (calls.length > MAX_BATCH_CALLS) throw invalidRequest(`batch: at most ${MAX_BATCH_CALLS} calls.`);
  return calls.map((call) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) throw invalidRequest("batch: every call must be an object.");
    return call as MailRequest;
  });
}

export async function runMailBatch(
  env: MailEnv,
  calls: MailRequest[],
  workspaceId: string,
): Promise<BatchOutcome> {
  const results: BatchEntry[] = new Array(calls.length);
  const summary: BatchOutcome["summary"] = new Array(calls.length);
  const timings: OpTimings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };

  const runOne = async (index: number): Promise<void> => {
    const call = calls[index];
    const op = typeof call.op === "string" ? call.op.slice(0, 40) : "?";
    const own: OpTimings = { providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 };
    try {
      if (typeof call.op === "string" && Object.hasOwn(OPS, call.op) && OPS[call.op].special === "attachment") {
        throw invalidRequest("batch: 'attachment' returns a binary body; call POST /mail for it.");
      }
      // A fresh flow per call: the pool hands the SAME connection to the next
      // call once this one returns it, rather than treating them as one
      // operation that needs two connections at once.
      const outcome = await runMailOp(env, call, {}, own);
      if (outcome.type !== "json") throw invalidRequest("batch: unsupported result type.");
      results[index] = { ok: true, result: outcome.result };
      summary[index] = { op, status: "ok" };
    } catch (error) {
      const api = toApiError(error);
      results[index] = { ok: false, error: api.body };
      summary[index] = { op, status: api.body.code };
    } finally {
      // A failed call's time counts too.
      timings.providerMs += own.providerMs;
      timings.connectMs += own.connectMs;
      timings.imapDials += own.imapDials;
      timings.imapReuses += own.imapReuses;
      if (own.imapCalls?.length) (timings.imapCalls ??= []).push(...own.imapCalls.slice(0, 48 - (timings.imapCalls?.length ?? 0)));
    }
  };

  // Group by inbox, keeping each group's calls in request order.
  const groups = new Map<string, number[]>();
  calls.forEach((call, index) => {
    const key = typeof call.inbox_id === "string" ? call.inbox_id.toLowerCase() : `\u0000none:${index}`;
    const group = groups.get(key);
    if (group) group.push(index);
    else groups.set(key, [index]);
  });

  await Promise.all([...groups.entries()].map(async ([inboxId, indexes]) => {
    const cached = env.inboxes.get(inboxId, workspaceId);
    const httpProvider = cached !== null && (cached.provider === "gmail" || cached.provider === "outlook");
    if (!httpProvider || indexes.length === 1) {
      for (const index of indexes) await runOne(index);
      return;
    }
    let next = 0;
    const worker = async () => {
      while (next < indexes.length) await runOne(indexes[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(HTTP_PROVIDER_CONCURRENCY, indexes.length) }, worker));
  }));

  return { results, timings, summary };
}
