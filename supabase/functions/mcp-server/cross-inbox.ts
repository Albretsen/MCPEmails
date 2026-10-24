// ---------------------------------------------------------------------------
// Cross-inbox search and list (Pro feature `cross_inbox_search`).
//
// `email_list` and `email_search` (and the consolidated `email_read` actions
// `list` and `search`) take `inbox_id: "all"`: one call over every inbox the
// key may see. The handler in index.ts enumerates the inboxes, runs the
// ordinary single-inbox executor once per inbox through `runFanOut`, and
// hands the per-inbox pages to `mergeCrossInboxPages`. Everything here is pure
// (no I/O), so the scheduling, merge and listing rules are testable without
// booting the server.
//
// Gate (pro-features.ts): `"all"` is a Pro VALUE of an existing argument, so it
// cannot ride PRO_FEATURE_ARGS. Not visible: the call is answered exactly as
// before (the uuid format check refuses "all"), and tools/list is unchanged.
// Visible but not on Pro or Business: the standard Pro refusal. Allowed: the
// fan-out.
//
// Paging. `offset` and `limit` keep their meaning, over the MERGED list,
// newest first. Every call asks each inbox for its newest `offset + limit`
// results and merges them; an item at merged position r is always within its
// own inbox's first r + 1 results, so the merged prefix is exact. The window
// is capped at CROSS_INBOX_WINDOW per inbox (the executors' own `limit`
// maximum): a page never reaches past it, and when more mail lies beyond it
// the result says so and stops (`has_more: false`, `window_reached: true`,
// a note) instead of returning a page with gaps. There is no opaque cursor:
// the advertised schema keeps the integer `offset` it always had.
//
// Ordering is by `date` across inboxes. A provider that ranks its own search
// results by relevance (Outlook text search) still contributes its top
// results, then they are placed by date.
//
// Billing follows contact_search: one call is one action, however many inboxes
// it fans out to.
// ---------------------------------------------------------------------------

import { buildPaginationEnvelope } from "./pagination-envelope.ts";

/** The value that selects every inbox. Compared trimmed, case-insensitively. */
export const CROSS_INBOX_ALL = "all";

/** Legacy dispatch names that accept `inbox_id: "all"`. */
export const CROSS_INBOX_DISPATCH: ReadonlySet<string> = new Set(["email_list", "email_search"]);

/** Most inboxes one call covers; the rest are reported as skipped. */
export const CROSS_INBOX_MAX_INBOXES = 25;

/** Per-inbox window: the newest results any page can reach, per inbox. */
export const CROSS_INBOX_WINDOW = 100;

/** A slow inbox is reported as timed out after this, and the rest still answer. */
export const CROSS_INBOX_TIMEOUT_MS = 25_000;

/** Inboxes worked on at once, across providers. */
export const CROSS_INBOX_CONCURRENCY = 6;

/**
 * At most this many inboxes of one provider at once. Gmail and Graph meter
 * concurrent requests per app as well as per mailbox; IMAP has no pool here,
 * so every inbox is its own connection.
 */
export const CROSS_INBOX_PROVIDER_LIMITS: Readonly<Record<string, number>> = {
  gmail: 4,
  outlook: 4,
  imap: 3,
  fastmail: 3,
};

/**
 * At most this many connections to one IMAP host at once. Yahoo, AOL and some
 * hosted servers count connections per source address as well as per account
 * (Yahoo's connection_limit), and every inbox of a fan-out comes from the same
 * edge isolate.
 */
export const CROSS_INBOX_IMAP_HOST_LIMIT = 2;

/** True when an `inbox_id` value asks for every inbox. */
export function isCrossInboxAll(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === CROSS_INBOX_ALL;
}

/** True when this dispatch is a cross-inbox call. */
export function isCrossInboxCall(dispatchName: string, rawArgs: unknown): boolean {
  if (!CROSS_INBOX_DISPATCH.has(dispatchName)) return false;
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return false;
  return isCrossInboxAll((rawArgs as Record<string, unknown>)["inbox_id"]);
}

/**
 * The arguments the server-side schema check sees for a cross-inbox call: the
 * same object without `inbox_id`, whose uuid format "all" cannot meet. Every
 * other argument is still validated as usual.
 */
export function crossInboxValidationArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const { inbox_id: _all, ...rest } = rawArgs;
  return rest;
}

/** The single-inbox arguments one leg of the fan-out runs with. */
export function crossInboxLegArgs(
  rawArgs: Record<string, unknown>,
  inboxId: string,
  fetchLimit: number,
): Record<string, unknown> {
  const { inbox: _inbox, inbox_id: _all, offset: _offset, limit: _limit, ...rest } = rawArgs;
  return { ...rest, inbox_id: inboxId, offset: 0, limit: fetchLimit };
}

/** How many results each inbox is asked for, for a page at offset/limit. */
export function crossInboxFetchLimit(offset: number, limit: number): number {
  return Math.max(1, Math.min(CROSS_INBOX_WINDOW, offset + limit));
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** One concurrency bucket an item occupies while it runs. */
export interface FanOutBucket {
  key: string;
  limit: number;
}

/** The buckets an inbox occupies: its provider, and for IMAP its host. */
export function crossInboxBuckets(inbox: { provider: string; imap_host?: string | null }): FanOutBucket[] {
  const provider = inbox.provider || "imap";
  const buckets: FanOutBucket[] = [{
    key: `provider:${provider}`,
    limit: CROSS_INBOX_PROVIDER_LIMITS[provider] ?? CROSS_INBOX_PROVIDER_LIMITS.imap,
  }];
  const host = typeof inbox.imap_host === "string" ? inbox.imap_host.trim().toLowerCase() : "";
  if (provider !== "gmail" && provider !== "outlook" && host) {
    buckets.push({ key: `imap_host:${host}`, limit: CROSS_INBOX_IMAP_HOST_LIMIT });
  }
  return buckets;
}

export type FanOutOutcome<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown; timedOut: boolean };

export interface FanOutOptions<T> {
  concurrency: number;
  timeoutMs: number;
  buckets: (item: T) => FanOutBucket[];
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Thrown into a leg's outcome when it ran past the per-item timeout. */
export class FanOutTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "FanOutTimeoutError";
  }
}

/**
 * Runs `task` over every item, never more than `concurrency` at once and never
 * more than a bucket's limit inside that bucket. Outcomes come back in item
 * order. A failure or a timeout is that item's outcome; it never stops the
 * others (unlike mapWithConcurrency, which stops at the first failure: here a
 * partial answer is the point).
 *
 * A timed-out task is not cancelled (the executors own their connections and
 * release them on their own timeouts); its slot is freed so the queue moves on.
 */
export async function runFanOut<T, R>(
  items: readonly T[],
  options: FanOutOptions<T>,
  task: (item: T, index: number) => Promise<R>,
): Promise<FanOutOutcome<R>[]> {
  const outcomes = new Array<FanOutOutcome<R>>(items.length);
  if (items.length === 0) return outcomes;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as number));
  const concurrency = Math.max(1, Math.floor(options.concurrency) || 1);
  const bucketsOf = items.map((item) => options.buckets(item));
  const inBucket = new Map<string, number>();
  const pending: number[] = items.map((_, i) => i);
  let running = 0;

  return await new Promise<FanOutOutcome<R>[]>((resolve) => {
    let settled = 0;
    const fits = (index: number) =>
      bucketsOf[index].every((b) => (inBucket.get(b.key) ?? 0) < Math.max(1, b.limit));
    const occupy = (index: number, delta: number) => {
      for (const b of bucketsOf[index]) inBucket.set(b.key, (inBucket.get(b.key) ?? 0) + delta);
    };
    const pump = () => {
      for (let p = 0; p < pending.length && running < concurrency;) {
        const index = pending[p];
        if (!fits(index)) {
          p++;
          continue;
        }
        pending.splice(p, 1);
        start(index);
      }
    };
    const start = (index: number) => {
      running++;
      occupy(index, 1);
      let done = false;
      const finish = (outcome: FanOutOutcome<R>) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        outcomes[index] = outcome;
        running--;
        occupy(index, -1);
        settled++;
        if (settled === items.length) resolve(outcomes);
        else pump();
      };
      const timer = setTimer(
        () => finish({ ok: false, error: new FanOutTimeoutError(options.timeoutMs), timedOut: true }),
        options.timeoutMs,
      );
      let promise: Promise<R>;
      try {
        promise = task(items[index], index);
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error, timedOut: false }),
      );
    };
    pump();
  });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** The inbox one leg ran against. */
export interface CrossInboxTarget {
  inbox_id: string;
  inbox_address: string;
}

/** What one inbox answered, already read out of its tool result. */
export type CrossInboxLeg =
  | {
    ok: true;
    target: CrossInboxTarget;
    messages: Record<string, unknown>[];
    total: number | null;
    totalIsEstimate: boolean;
    hasMore: boolean;
    notes?: string[];
    queryNormalized?: string;
  }
  | {
    ok: false;
    target: CrossInboxTarget;
    errorCode: string;
    message: string;
  };

export interface CrossInboxError {
  inbox_id: string;
  inbox_address: string;
  error_code: string;
  message: string;
}

export interface CrossInboxPage {
  messages: Record<string, unknown>[];
  total: number | null;
  total_is_estimate: boolean;
  has_more: boolean;
  next_offset: number | null;
  /** Every inbox the call covered, in the order they were enumerated. */
  inboxes: { inbox_id: string; inbox_address: string; status: "ok" | "error" }[];
  /** One entry per inbox that did not answer. Empty when all did. */
  inbox_errors: CrossInboxError[];
  /** True when more mail lies past the per-inbox window than paging reaches. */
  window_reached?: boolean;
  query_normalized?: string;
  notes?: string[];
}

const MAX_ERROR_TEXT = 300;

/** A per-inbox error text, short enough to repeat for many inboxes. */
export function shortErrorText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT - 1)}…` : flat;
}

function dateKey(message: Record<string, unknown>): number {
  const value = message["date"];
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Merges the per-inbox pages into one page at `offset`/`limit`.
 *
 * Newest first by `date`; ties broken by inbox_id then message id so the
 * order is total and a message cannot swap pages between two calls. Every
 * message is tagged with `inbox_id` and `inbox_address`.
 *
 * `skippedInboxes` counts inboxes the call did not cover at all (over the
 * inbox cap); with any error or skip the total is a floor.
 */
export function mergeCrossInboxPages(input: {
  legs: CrossInboxLeg[];
  offset: number;
  limit: number;
  skippedInboxes?: number;
}): CrossInboxPage {
  const { legs, offset, limit } = input;
  const skipped = input.skippedInboxes ?? 0;
  const tagged: { message: Record<string, unknown>; date: number; inbox: string; id: string }[] = [];
  const errors: CrossInboxError[] = [];
  const notes: string[] = [];
  let anyInboxMore = false;
  let total: number | null = 0;
  let estimate = false;
  let queryNormalized: string | undefined;

  for (const leg of legs) {
    if (!leg.ok) {
      errors.push({
        inbox_id: leg.target.inbox_id,
        inbox_address: leg.target.inbox_address,
        error_code: leg.errorCode,
        message: shortErrorText(leg.message),
      });
      continue;
    }
    if (leg.hasMore) anyInboxMore = true;
    if (leg.total === null || total === null) total = null;
    else total += leg.total;
    if (leg.totalIsEstimate) estimate = true;
    if (queryNormalized === undefined && typeof leg.queryNormalized === "string") {
      queryNormalized = leg.queryNormalized;
    }
    for (const note of leg.notes ?? []) notes.push(`${leg.target.inbox_address}: ${note}`);
    for (const message of leg.messages) {
      tagged.push({
        message: { ...message, inbox_id: leg.target.inbox_id, inbox_address: leg.target.inbox_address },
        date: dateKey(message),
        inbox: leg.target.inbox_id,
        id: typeof message["id"] === "string" ? message["id"] as string : "",
      });
    }
  }

  tagged.sort((a, b) => {
    if (a.date !== b.date) return b.date - a.date;
    if (a.inbox !== b.inbox) return a.inbox < b.inbox ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Never past the window: beyond it an inbox's next result may belong
  // earlier than what was fetched, so the merged order is no longer exact.
  const end = Math.min(offset + limit, CROSS_INBOX_WINDOW);
  const page = offset < end ? tagged.slice(offset, end).map((t) => t.message) : [];
  const moreBeyondEnd = tagged.length > end || anyInboxMore;
  const windowReached = moreBeyondEnd && end >= CROSS_INBOX_WINDOW;
  const hasMore = moreBeyondEnd && !windowReached;

  if (errors.length > 0 || skipped > 0 || windowReached) estimate = true;
  const envelope = buildPaginationEnvelope({
    returned: page.length,
    offset,
    limit,
    total,
    totalIsEstimate: estimate,
    hasMore,
  });
  // A partial answer's count is a floor even when every inbox that answered
  // gave an exact one.
  if (envelope.total !== null && estimate) envelope.total_is_estimate = true;

  if (errors.length > 0) {
    notes.push(
      `${errors.length} of ${legs.length} inboxes did not answer and are not in these results; ` +
        "see inbox_errors.",
    );
  }
  if (skipped > 0) {
    notes.push(
      `Covered the first ${legs.length} inboxes; ${skipped} more were not searched. ` +
        "Name an inbox_id to reach one of them.",
    );
  }
  if (windowReached) {
    notes.push(
      `Across all inboxes, paging reaches the newest ${CROSS_INBOX_WINDOW} results of each inbox. ` +
        "More exist: narrow the request (since, before, from) or pass one inbox_id to page further.",
    );
  }

  const inboxes = legs.map((leg) => ({
    inbox_id: leg.target.inbox_id,
    inbox_address: leg.target.inbox_address,
    status: leg.ok ? "ok" as const : "error" as const,
  }));

  return {
    messages: page,
    ...envelope,
    inboxes,
    inbox_errors: errors,
    ...(windowReached ? { window_reached: true } : {}),
    ...(queryNormalized !== undefined ? { query_normalized: queryNormalized } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Reads one leg's executor outcome into a CrossInboxLeg. The executors return
 * `jsonOk` results, so the payload is `structuredContent`, with the JSON text
 * block as the fallback.
 */
export function legFromToolResult(
  target: CrossInboxTarget,
  outcome: {
    result: { content?: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
    logErrorCode?: string | null;
  } | null,
): CrossInboxLeg {
  if (!outcome) {
    return { ok: false, target, errorCode: "internal_error", message: "No result from this inbox." };
  }
  const text = outcome.result.content?.find((c) => c.type === "text")?.text ?? "";
  if (outcome.result.isError === true) {
    return { ok: false, target, errorCode: outcome.logErrorCode ?? "provider_error", message: text || "Error." };
  }
  let payload: unknown = outcome.result.structuredContent;
  if (!payload || typeof payload !== "object") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).messages)) {
    return { ok: false, target, errorCode: "internal_error", message: "Unreadable result from this inbox." };
  }
  const p = payload as Record<string, unknown>;
  return {
    ok: true,
    target,
    messages: (p.messages as unknown[]).filter((m): m is Record<string, unknown> =>
      m !== null && typeof m === "object" && !Array.isArray(m)
    ),
    total: typeof p.total === "number" ? p.total : null,
    totalIsEstimate: p.total_is_estimate === true,
    hasMore: p.has_more === true,
    ...(Array.isArray(p.notes) ? { notes: (p.notes as unknown[]).filter((n): n is string => typeof n === "string") } : {}),
    ...(typeof p.query_normalized === "string" ? { queryNormalized: p.query_normalized } : {}),
  };
}

// ---------------------------------------------------------------------------
// Listing (tools/list) when the feature is visible
// ---------------------------------------------------------------------------

const ALL_SENTENCE = `Or "all" for every inbox at once (Pro); results carry inbox_id and inbox_address.`;

/**
 * Listed tools whose `inbox_id` gains the "all" value, with the sentence that
 * says when it applies. The consolidated `email_read` takes it on two actions
 * only; the per-operation `email_list` and `email_search` take it outright.
 */
export const CROSS_INBOX_LISTED: Readonly<Record<string, string>> = {
  email_read: `With action list or search: ${ALL_SENTENCE.charAt(0).toLowerCase()}${ALL_SENTENCE.slice(1)}`,
  email_list: ALL_SENTENCE,
  email_search: ALL_SENTENCE,
};

interface ListableTool {
  name: string;
  inputSchema: Record<string, unknown>;
  listedInputSchema?: Record<string, unknown>;
}

function withAllInboxId(schema: Record<string, unknown>, sentence: string): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const current = (properties as Record<string, unknown>)["inbox_id"];
  if (!current || typeof current !== "object" || Array.isArray(current)) return schema;
  // `format: "uuid"` goes: a client that enforces formats would refuse "all"
  // before it reached us. Only for workspaces that see the feature.
  const { format: _uuid, ...rest } = current as Record<string, unknown>;
  const description = typeof rest.description === "string" ? `${rest.description} ${sentence}` : sentence;
  return {
    ...schema,
    properties: { ...(properties as Record<string, unknown>), inbox_id: { ...rest, description } },
  };
}

/**
 * tools/list: when the feature is visible, `inbox_id` on the listed list and
 * search tools says it takes "all". Not visible: the list is returned
 * untouched, so customers see no change. Copies only; registry entries are
 * never mutated, and the server-side validator keeps the registry schema.
 */
export function advertiseCrossInboxSearch<T extends ListableTool>(
  tools: T[],
  access: { visible: boolean },
): T[] {
  if (!access.visible) return tools;
  return tools.map((tool) => {
    const sentence = Object.hasOwn(CROSS_INBOX_LISTED, tool.name) ? CROSS_INBOX_LISTED[tool.name] : null;
    if (!sentence) return tool;
    const copy: T = { ...tool, inputSchema: withAllInboxId(tool.inputSchema, sentence) };
    if (tool.listedInputSchema) copy.listedInputSchema = withAllInboxId(tool.listedInputSchema, sentence);
    return copy;
  });
}
