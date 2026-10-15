/* The opaque conversation state the client carries between requests.
 *
 * The server stores nothing. `done.conversation` goes to the client, and the
 * client sends it back with the next request. So it is INPUT: it is validated
 * strictly (exact keys, types, lengths, total size) and anything that does not
 * validate is discarded and the conversation starts fresh. A tampered state
 * can at most put words in the model's context, exactly like typing them; it
 * cannot widen what the tools allow (policy.ts is applied to every call).
 *
 * It holds only what the client already received in events: the user's text,
 * the assistant's text, the human labels of tool calls, and chip labels. No
 * tool results, no email bodies, no system prompt.
 *
 * Compaction: the last MAX_TURNS turns are kept whole; older ones are folded
 * into `summary` (one clipped line each, oldest dropped first).
 */

export const CONVERSATION_VERSION = 1;
/** Larger input is rejected outright. */
export const MAX_INPUT_CHARS = 32_000;
/** What we return never exceeds this. */
export const MAX_OUTPUT_CHARS = 16_000;
const MAX_TURNS = 6;
const MAX_SUMMARY_CHARS = 1_500;
const MAX_USER_CHARS = 2_000;
const MAX_ASSISTANT_CHARS = 3_000;
const MAX_CALLS = 16;
const MAX_REFS = 12;
const MAX_LABEL_CHARS = 160;
const MAX_KEY_CHARS = 1_100;

export interface TurnCall {
  /** Human label, as shown in the transcript. */
  h: string;
  /** Message keys it touched. */
  k: string[];
}

export interface TurnRef {
  /** Message key. */
  k: string;
  /** "Sender · Subject", as shown on the chip. */
  l: string;
}

export interface Turn {
  u: string;
  a: string;
  calls: TurnCall[];
  refs: TurnRef[];
}

export interface ConversationState {
  v: typeof CONVERSATION_VERSION;
  summary: string;
  turns: Turn[];
}

export function emptyConversation(): ConversationState {
  return { v: CONVERSATION_VERSION, summary: "", turns: [] };
}

export interface ParsedConversation {
  state: ConversationState;
  /** Why the input was discarded, for the log. null when accepted or absent. */
  rejected: "too_large" | "invalid" | null;
}

export function parseConversation(input: unknown): ParsedConversation {
  if (input === undefined || input === null) return { state: emptyConversation(), rejected: null };
  let size: number;
  try {
    size = JSON.stringify(input)?.length ?? 0;
  } catch {
    return { state: emptyConversation(), rejected: "invalid" };
  }
  if (size > MAX_INPUT_CHARS) return { state: emptyConversation(), rejected: "too_large" };
  const state = validate(input);
  return state ? { state, rejected: null } : { state: emptyConversation(), rejected: "invalid" };
}

function validate(input: unknown): ConversationState | null {
  if (!exactKeys(input, ["v", "summary", "turns"])) return null;
  if (input.v !== CONVERSATION_VERSION) return null;
  if (!isText(input.summary, MAX_SUMMARY_CHARS)) return null;
  if (!Array.isArray(input.turns) || input.turns.length > MAX_TURNS) return null;
  const turns: Turn[] = [];
  for (const t of input.turns) {
    if (!exactKeys(t, ["u", "a", "calls", "refs"])) return null;
    if (!isText(t.u, MAX_USER_CHARS) || !isText(t.a, MAX_ASSISTANT_CHARS)) return null;
    if (!Array.isArray(t.calls) || t.calls.length > MAX_CALLS) return null;
    if (!Array.isArray(t.refs) || t.refs.length > MAX_REFS) return null;
    const calls: TurnCall[] = [];
    for (const c of t.calls) {
      if (!exactKeys(c, ["h", "k"]) || !isText(c.h, MAX_LABEL_CHARS)) return null;
      if (!Array.isArray(c.k) || c.k.length > 50 || !c.k.every(isKey)) return null;
      calls.push({ h: c.h, k: [...(c.k as string[])] });
    }
    const refs: TurnRef[] = [];
    for (const r of t.refs) {
      if (!exactKeys(r, ["k", "l"]) || !isKey(r.k) || !isText(r.l, MAX_LABEL_CHARS)) return null;
      refs.push({ k: r.k, l: r.l });
    }
    turns.push({ u: t.u, a: t.a, calls, refs });
  }
  return { v: CONVERSATION_VERSION, summary: input.summary, turns };
}

/** Adds this run's turn and compacts to the output budget. */
export function appendTurn(state: ConversationState, turn: Turn): ConversationState {
  const next: ConversationState = {
    v: CONVERSATION_VERSION,
    summary: state.summary,
    turns: [...state.turns, clipTurn(turn)],
  };
  while (next.turns.length > MAX_TURNS) fold(next);
  while (JSON.stringify(next).length > MAX_OUTPUT_CHARS && next.turns.length > 1) fold(next);
  if (JSON.stringify(next).length > MAX_OUTPUT_CHARS) {
    // One enormous turn: keep the words, drop the bookkeeping.
    const only = next.turns[0] as Turn;
    next.turns = [{ u: only.u, a: only.a, calls: [], refs: [] }];
  }
  return next;
}

/** Moves the oldest turn into the summary. */
function fold(state: ConversationState): void {
  const t = state.turns.shift();
  if (!t) return;
  const did = t.calls.length ? ` (${t.calls.slice(0, 3).map((c) => c.h).join("; ")})` : "";
  const line = `User: ${oneLine(t.u, 140)} / Assistant: ${oneLine(t.a, 180)}${oneLine(did, 200)}`;
  const joined = state.summary ? `${state.summary}\n${line}` : line;
  // Oldest lines fall off the front.
  state.summary = joined.length > MAX_SUMMARY_CHARS
    ? joined.slice(joined.length - MAX_SUMMARY_CHARS).replace(/^[^\n]*\n/, "")
    : joined;
}

function clipTurn(t: Turn): Turn {
  return {
    u: clip(t.u, MAX_USER_CHARS),
    a: clip(t.a, MAX_ASSISTANT_CHARS),
    calls: t.calls.slice(0, MAX_CALLS).map((c) => ({
      h: clip(c.h, MAX_LABEL_CHARS),
      k: c.k.filter(isKey).slice(0, 50),
    })),
    refs: t.refs.filter((r) => isKey(r.k)).slice(0, MAX_REFS).map((r) => ({ k: r.k, l: clip(r.l, MAX_LABEL_CHARS) })),
  };
}

function exactKeys<K extends string>(v: unknown, keys: readonly K[]): v is Record<K, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
function isText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}
function isKey(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_KEY_CHARS) return false;
  const i = v.indexOf(":");
  return i > 0 && i < v.length - 1;
}
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
