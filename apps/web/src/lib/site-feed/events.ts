/**
 * The anonymous activity ticker on albretsen.no, as pure functions.
 *
 * PRIVACY CONTRACT. What leaves this module is built from scratch, never
 * copied from a row: `product`, a phrase from the fixed TOOL_PHRASES table,
 * a short stable `kind`, and optionally a duration and a country. No id,
 * address, subject, name, key, user agent or timestamp from the source row can
 * reach the site, because nothing reads those fields. A tool that is not in
 * the table is dropped, so a new tool never appears on the site until someone
 * has chosen how to describe it.
 *
 * Country is k-anonymous: it is sent only when at least COUNTRY_K workspaces
 * share it, so a ticker line can never be the only workspace from a country.
 *
 * The I/O lives in run.ts. Nothing here reads a clock, the network or the
 * environment, so every rule is unit tested (events.test.ts).
 */

import { SITE_FEED_PRODUCT } from './mrr.ts';

/** A country is sent only when at least this many workspaces share it. */
export const COUNTRY_K = 5;

/** At most this many events per run. Cron is the only trigger: one run a minute. */
export const MAX_EVENTS_PER_RUN = 3;

/** Durations outside (0, MS_CEILING) are dropped rather than shown. */
const MS_CEILING = 120_000;

type Phrase = { text: string; kind: string };

const SENT: Phrase = { text: 'agent sent an email', kind: 'email.sent' };
const DRAFTED: Phrase = { text: 'agent drafted an email', kind: 'email.drafted' };
const READ: Phrase = { text: 'agent read an email', kind: 'email.read' };
const SORTED: Phrase = { text: 'agent sorted an inbox', kind: 'inbox.sorted' };

/**
 * The allowlist: `activity_log.tool_name` to the only words the site sees.
 *
 * Keys are the mcp-server's dispatch names (supabase/functions/mcp-server
 * index.ts, `runExecutor`), which is what `writeActivityLog` stores, plus the
 * consolidated public names (`email_compose`, `email_organize`, `draft`) that
 * older rows still carry. Deliberately absent: deletes, folder and automation
 * management, signatures, approvals, and the triage runner's own rows
 * (`triage_*`), which are an automation acting, not an agent.
 */
export const TOOL_PHRASES: Readonly<Record<string, Phrase>> = {
  email_send: SENT,
  email_compose: SENT,
  email_reply: { text: 'agent replied to an email', kind: 'email.replied' },
  email_forward: { text: 'agent forwarded an email', kind: 'email.forwarded' },
  draft_create: DRAFTED,
  draft_reply: DRAFTED,
  draft: DRAFTED,
  draft_send: { text: 'agent sent a draft', kind: 'draft.sent' },
  schedule_create: { text: 'agent scheduled an email', kind: 'email.scheduled' },
  email_search: { text: 'agent searched an inbox', kind: 'inbox.searched' },
  email_read: READ,
  email_read_batch: READ,
  email_list: { text: 'agent opened an inbox', kind: 'inbox.opened' },
  email_move: SORTED,
  email_move_batch: SORTED,
  email_archive: SORTED,
  email_flag: SORTED,
  email_search_and_move: SORTED,
  email_organize: SORTED,
  inbox_list: { text: 'agent checked its inboxes', kind: 'inbox.listed' },
};

const INBOX_CONNECTED: Phrase = { text: 'a new inbox was connected', kind: 'inbox.connected' };

/** Tool names whose rows are worth reading at all; the query filters on them. */
export const FEED_TOOL_NAMES: readonly string[] = Object.keys(TOOL_PHRASES);

/**
 * Kinds that win a slot before anything is sampled, in this order: a new
 * inbox, then mail actually leaving.
 */
export const PRIORITY_KINDS: readonly string[] = [
  'inbox.connected',
  'email.sent',
  'email.replied',
  'email.forwarded',
  'draft.sent',
];

/** The outbound tools, queried apart so a flood of reads cannot crowd them out. */
export const OUTBOUND_TOOL_NAMES: readonly string[] = FEED_TOOL_NAMES.filter((name) =>
  PRIORITY_KINDS.includes(TOOL_PHRASES[name].kind));

/** Exactly what is POSTed to /api/events. */
export type FeedEvent = {
  product: string;
  text: string;
  kind: string;
  ms?: number;
  country?: string;
};

/**
 * A source row. Only `source`, `tool_name` and `duration_ms` are ever read;
 * the index signature is there so a real row with every other column can be
 * passed in, and the tests can prove none of it comes out.
 */
export type FeedSourceRow = {
  source: 'activity_log' | 'inboxes';
  tool_name?: unknown;
  duration_ms?: unknown;
  [column: string]: unknown;
};

export type FeedContext = {
  /** The workspace's `acquisition_country`, if known. */
  country?: string | null;
  /** How many workspaces share that country. */
  countryWorkspaces?: number | null;
};

/**
 * One row as a site event, or null when it must not be shown.
 *
 * `inboxes` rows are a new inbox. `activity_log` rows are shown only when
 * their tool is in TOOL_PHRASES.
 */
export function toFeedEvent(row: FeedSourceRow, ctx: FeedContext = {}): FeedEvent | null {
  let phrase: Phrase | undefined;
  let ms: number | undefined;
  if (row.source === 'inboxes') {
    phrase = INBOX_CONNECTED;
  } else if (row.source === 'activity_log' && typeof row.tool_name === 'string') {
    phrase = Object.prototype.hasOwnProperty.call(TOOL_PHRASES, row.tool_name) ? TOOL_PHRASES[row.tool_name] : undefined;
    const duration = typeof row.duration_ms === 'number' ? Math.round(row.duration_ms) : Number.NaN;
    if (Number.isFinite(duration) && duration > 0 && duration < MS_CEILING) ms = duration;
  }
  if (!phrase) return null;

  const event: FeedEvent = { product: SITE_FEED_PRODUCT, text: phrase.text, kind: phrase.kind };
  if (ms !== undefined) event.ms = ms;
  const country = feedCountry(ctx);
  if (country) event.country = country;
  return event;
}

/** An ISO alpha-2 code shared by at least COUNTRY_K workspaces, else null. */
export function feedCountry(ctx: FeedContext): string | null {
  const code = typeof ctx.country === 'string' ? ctx.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const shared = ctx.countryWorkspaces;
  return typeof shared === 'number' && shared >= COUNTRY_K ? code : null;
}

/** Just the kind a row would get, for sampling before the country is looked up. */
export function feedKind(row: FeedSourceRow): string | null {
  return toFeedEvent(row)?.kind ?? null;
}

/**
 * At most `max` candidates, chosen for variety.
 *
 *   1. One of each PRIORITY_KINDS kind present, in that order.
 *   2. Then uniformly at random among candidates whose kind is not taken yet,
 *      one at a time, so common kinds are likelier but never doubled.
 *   3. Only if every kind is taken and slots remain, uniformly among the rest.
 *
 * `random` is injected so tests are deterministic. The result keeps the
 * input's order: pass candidates oldest first and they post oldest first.
 */
export function selectFeedEvents<T extends { kind: string }>(
  candidates: readonly T[],
  { max = MAX_EVENTS_PER_RUN, random = Math.random }: { max?: number; random?: () => number } = {},
): T[] {
  const limit = Math.max(0, Math.floor(max));
  const picked = new Set<number>();
  const kinds = new Set<string>();
  const pick = (pool: number[]) => {
    const index = pool[pickIndex(random, pool.length)];
    picked.add(index);
    kinds.add(candidates[index].kind);
  };
  const indices = candidates.map((_, index) => index);

  for (const kind of PRIORITY_KINDS) {
    if (picked.size >= limit) break;
    const pool = indices.filter((index) => candidates[index].kind === kind);
    if (pool.length > 0) pick(pool);
  }
  while (picked.size < limit) {
    const pool = indices.filter((index) => !picked.has(index) && !kinds.has(candidates[index].kind));
    if (pool.length === 0) break;
    pick(pool);
  }
  while (picked.size < limit) {
    const pool = indices.filter((index) => !picked.has(index));
    if (pool.length === 0) break;
    pick(pool);
  }
  return indices.filter((index) => picked.has(index)).map((index) => candidates[index]);
}

/** floor(random * length), clamped, so a bad generator cannot index out of range. */
function pickIndex(random: () => number, length: number): number {
  const r = random();
  if (!Number.isFinite(r) || r < 0) return 0;
  return Math.min(length - 1, Math.floor(r * length));
}

/**
 * The previous whole minute, `[start, end)`, as ISO strings. A run that is
 * retried or fires twice in the same minute reads the same window, so it can
 * at worst repeat its own three lines, never fan out.
 */
export function feedWindow(nowMs: number): { start: string; end: string } {
  const end = Math.floor(nowMs / 60_000) * 60_000;
  return { start: new Date(end - 60_000).toISOString(), end: new Date(end).toISOString() };
}
