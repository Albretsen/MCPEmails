/**
 * The Security page's audit log: MCP tool calls (public.activity_log) and team
 * changes (public.workspace_audit_events, migration 20261111190100).
 *
 * WHO SEES WHAT
 *   member        tool calls on inboxes they can see (RLS on activity_log,
 *                 20261111190000: company-wide inboxes and their own private
 *                 ones, plus calls that named no inbox). No team changes, no
 *                 export.
 *   owner, admin  every tool call in the workspace, read with the service
 *                 role, metadata only (tool, inbox address, key name, person,
 *                 status, timing; never message content), every team change,
 *                 and the CSV export of either.
 *
 * Both lists say WHO acted: activity_log.user_id (the key's or grant's
 * creator) and workspace_audit_events.actor_user_id, resolved to an email and
 * name here. An id whose account is gone shows as a former member.
 *
 * PostgREST stops every select at 1000 rows, so the export pages through the
 * rows 1000 at a time in a total order (created_at, id), and stops at
 * AUDIT_EXPORT_MAX_ROWS.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const AUDIT_MAX_PAGE_SIZE = 100;
export const AUDIT_DEFAULT_PAGE_SIZE = 25;
/** The most rows one CSV export carries. The header row says when it was cut. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;
/** PostgREST's row cap; the export reads in pages of this size. */
export const AUDIT_EXPORT_PAGE = 1000;

export type AuditSource = 'calls' | 'events';

export interface AuditFilters {
  /** ISO timestamp, inclusive. */
  since: string | null;
  /** ISO timestamp, exclusive. */
  until: string | null;
}

export interface AuditPerson {
  id: string;
  email: string | null;
  name: string | null;
}

export interface AuditCallEntry {
  id: string;
  tool: string;
  inbox: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
  person: AuditPerson | null;
  status: string;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AuditEventEntry {
  id: string;
  kind: string;
  actor: AuditPerson | null;
  target: string | null;
  /** The target resolved to a person when it is a member's user id. */
  targetPerson: AuditPerson | null;
  details: Record<string, unknown>;
  createdAt: string;
}

const CALL_COLUMNS =
  'id, tool_name, status, error_code, duration_ms, created_at, user_id, inboxes(email_address, display_name), api_keys(name, key_prefix)';
const EVENT_COLUMNS = 'id, kind, actor_user_id, target, details, created_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A query value as an ISO timestamp, or null when absent or not a date. */
export function parseAuditDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseAuditPaging(url: URL): { page: number; pageSize: number } {
  const rawPage = parseInt(url.searchParams.get('page') ?? '0', 10);
  const rawSize = parseInt(url.searchParams.get('pageSize') ?? String(AUDIT_DEFAULT_PAGE_SIZE), 10);
  return {
    page: isNaN(rawPage) || rawPage < 0 ? 0 : rawPage,
    pageSize: isNaN(rawSize) || rawSize < 1 ? AUDIT_DEFAULT_PAGE_SIZE : Math.min(rawSize, AUDIT_MAX_PAGE_SIZE),
  };
}

function applyFilters(query: any, filters: AuditFilters): any {
  let q = query;
  if (filters.since) q = q.gte('created_at', filters.since);
  if (filters.until) q = q.lt('created_at', filters.until);
  return q;
}

/** Email and name for each id, read with the service role. Never throws. */
export async function resolvePeople(service: any, ids: Iterable<string | null | undefined>): Promise<Map<string, AuditPerson>> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)))];
  const out = new Map<string, AuditPerson>();
  if (unique.length === 0) return out;
  try {
    for (let i = 0; i < unique.length; i += 500) {
      const { data, error } = await service
        .from('users')
        .select('id, email, display_name')
        .in('id', unique.slice(i, i + 500));
      if (error) {
        console.error('[audit-log] people lookup failed:', error.message);
        break;
      }
      for (const row of (data ?? []) as Array<{ id: string; email: string | null; display_name: string | null }>) {
        out.set(row.id, { id: row.id, email: row.email ?? null, name: row.display_name ?? null });
      }
    }
  } catch (err) {
    console.error('[audit-log] people lookup threw:', err instanceof Error ? err.message : String(err));
  }
  return out;
}

function personFor(people: Map<string, AuditPerson>, id: unknown): AuditPerson | null {
  if (typeof id !== 'string' || !id) return null;
  return people.get(id) ?? { id, email: null, name: null };
}

// A disconnected mailbox whose address someone else reconnected keeps its old
// row under '<address>#retired-<id>' (migration 20261111190000); show the address.
export function displayInboxAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  return address.replace(/#retired-[0-9a-f-]+$/i, '');
}

function shapeCall(row: any, people: Map<string, AuditPerson>): AuditCallEntry {
  const inbox = row.inboxes as { email_address?: string | null; display_name?: string | null } | null;
  const key = row.api_keys as { name?: string | null; key_prefix?: string | null } | null;
  return {
    id: row.id,
    tool: row.tool_name,
    inbox: inbox?.display_name ?? displayInboxAddress(inbox?.email_address),
    apiKeyName: key?.name ?? null,
    apiKeyPrefix: key?.key_prefix ?? null,
    person: personFor(people, row.user_id),
    status: row.status,
    errorCode: row.error_code ?? null,
    durationMs: row.duration_ms ?? null,
    createdAt: row.created_at,
  };
}

function shapeEvent(row: any, people: Map<string, AuditPerson>): AuditEventEntry {
  const target = typeof row.target === 'string' ? row.target : null;
  return {
    id: row.id,
    kind: row.kind,
    actor: personFor(people, row.actor_user_id),
    target,
    targetPerson: target && UUID_RE.test(target) && people.has(target) ? people.get(target)! : null,
    details: row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details : {},
    createdAt: row.created_at,
  };
}

/**
 * One page of tool calls. `reader` is the user client for a member (RLS
 * narrows to visible inboxes) or the service role for an owner or admin;
 * `service` resolves people.
 */
export async function fetchAuditCallsPage(
  reader: any,
  service: any,
  workspaceId: string,
  opts: {
    page: number;
    pageSize: number;
    filters: AuditFilters;
    /**
     * Set for a member: calls that named no inbox (a cross-inbox "all" call)
     * show only when this person made them. RLS says the same; this keeps
     * the API honest on its own.
     */
    memberUserId?: string | null;
  },
): Promise<{ ok: true; entries: AuditCallEntry[]; total: number } | { ok: false; error: string }> {
  const from = opts.page * opts.pageSize;
  const scope = (q: any) => (opts.memberUserId && UUID_RE.test(opts.memberUserId)
    ? q.or(`inbox_id.not.is.null,user_id.eq.${opts.memberUserId}`)
    : q);
  const [countResult, rowsResult] = await Promise.all([
    applyFilters(scope(reader.from('activity_log').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)), opts.filters),
    applyFilters(scope(reader.from('activity_log').select(CALL_COLUMNS).eq('workspace_id', workspaceId)), opts.filters)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + opts.pageSize - 1),
  ]);
  if (countResult.error) return { ok: false, error: countResult.error.message };
  if (rowsResult.error) return { ok: false, error: rowsResult.error.message };
  const rows = (rowsResult.data ?? []) as any[];
  const people = await resolvePeople(service, rows.map((r) => r.user_id));
  return { ok: true, entries: rows.map((r) => shapeCall(r, people)), total: countResult.count ?? 0 };
}

/** One page of team changes. Owner/admin only: the caller checks the role. */
export async function fetchAuditEventsPage(
  service: any,
  workspaceId: string,
  opts: { page: number; pageSize: number; filters: AuditFilters },
): Promise<{ ok: true; events: AuditEventEntry[]; total: number } | { ok: false; error: string }> {
  const from = opts.page * opts.pageSize;
  const [countResult, rowsResult] = await Promise.all([
    applyFilters(service.from('workspace_audit_events').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId), opts.filters),
    applyFilters(service.from('workspace_audit_events').select(EVENT_COLUMNS).eq('workspace_id', workspaceId), opts.filters)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + opts.pageSize - 1),
  ]);
  if (countResult.error) return { ok: false, error: countResult.error.message };
  if (rowsResult.error) return { ok: false, error: rowsResult.error.message };
  const rows = (rowsResult.data ?? []) as any[];
  const people = await resolvePeople(service, rows.flatMap((r) => [r.actor_user_id, r.target]));
  return { ok: true, events: rows.map((r) => shapeEvent(r, people)), total: countResult.count ?? 0 };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * One CSV cell. Formula-injection safe (OWASP): a value that a spreadsheet
 * would read as a formula (starting =, +, -, @, tab or carriage return) gets a
 * leading apostrophe. Quoted when it holds a comma, quote or line break.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}

export const CALLS_CSV_HEADER = [
  'time_utc', 'person_email', 'person_name', 'tool', 'inbox', 'api_key', 'api_key_prefix', 'status', 'error_code', 'duration_ms',
];
export const EVENTS_CSV_HEADER = ['time_utc', 'actor_email', 'actor_name', 'event', 'target', 'target_email', 'details'];

export function callCsvRow(e: AuditCallEntry): string {
  return csvLine([
    e.createdAt, e.person?.email, e.person?.name, e.tool, e.inbox, e.apiKeyName, e.apiKeyPrefix, e.status, e.errorCode, e.durationMs,
  ]);
}

export function eventCsvRow(e: AuditEventEntry): string {
  return csvLine([e.createdAt, e.actor?.email, e.actor?.name, e.kind, e.target, e.targetPerson?.email, e.details]);
}

/**
 * The export as a stream: header, then pages of AUDIT_EXPORT_PAGE rows read
 * one at a time (so memory holds one page), up to AUDIT_EXPORT_MAX_ROWS. A
 * read error mid-stream ends the file with a final `# export incomplete` line
 * rather than a silently short file.
 *
 * Consistent under writes: `until` is pinned to the moment the export started
 * (rows written while it streams are left out), and pages follow a keyset on
 * (created_at, id) descending rather than an offset, so a row inserted or
 * purged mid-export can neither repeat a row nor skip one.
 */
export function auditCsvStream(
  service: any,
  workspaceId: string,
  source: AuditSource,
  filters: AuditFilters,
  maxRows: number = AUDIT_EXPORT_MAX_ROWS,
  now: Date = new Date(),
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = 0;
  let headerDone = false;
  const startedAt = now.toISOString();
  const pinned: AuditFilters = {
    since: filters.since,
    until: filters.until && filters.until < startedAt ? filters.until : startedAt,
  };
  let cursor: AuditCursor | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerDone) {
        headerDone = true;
        controller.enqueue(enc.encode(csvLine(source === 'calls' ? CALLS_CSV_HEADER : EVENTS_CSV_HEADER)));
        return;
      }
      if (sent >= maxRows) {
        controller.enqueue(enc.encode(`# stopped at ${maxRows} rows; narrow the dates with since and until\r\n`));
        controller.close();
        return;
      }
      const size = Math.min(AUDIT_EXPORT_PAGE, maxRows - sent);
      const result = source === 'calls'
        ? await fetchCallsAfter(service, workspaceId, cursor, size, pinned)
        : await fetchEventsAfter(service, workspaceId, cursor, size, pinned);
      if (!result.ok) {
        console.error('[audit-log] export page failed:', result.error);
        controller.enqueue(enc.encode('# export incomplete: a page could not be read\r\n'));
        controller.close();
        return;
      }
      const lines = result.lines;
      if (lines.length > 0) controller.enqueue(enc.encode(lines.join('')));
      sent += lines.length;
      cursor = result.last;
      if (lines.length < size || !cursor) controller.close();
    },
  });
}

/** The last row of a page: the next page starts strictly after it. */
interface AuditCursor {
  createdAt: string;
  id: string;
}

/** Rows strictly after `cursor` in (created_at desc, id desc) order. */
function afterCursor(query: any, cursor: AuditCursor | null): any {
  if (!cursor) return query;
  // Values come from our own rows (timestamps and uuids); quoted for PostgREST.
  const at = `"${cursor.createdAt}"`;
  return query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${cursor.id})`);
}

function lastCursor(rows: any[]): AuditCursor | null {
  const last = rows[rows.length - 1];
  return last && typeof last.created_at === 'string' && typeof last.id === 'string'
    ? { createdAt: last.created_at, id: last.id }
    : null;
}

async function fetchCallsAfter(service: any, workspaceId: string, cursor: AuditCursor | null, size: number, filters: AuditFilters) {
  const { data, error } = await afterCursor(
    applyFilters(service.from('activity_log').select(CALL_COLUMNS).eq('workspace_id', workspaceId), filters),
    cursor,
  )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(size);
  if (error) return { ok: false as const, error: error.message as string };
  const rows = (data ?? []) as any[];
  const people = await resolvePeople(service, rows.map((r) => r.user_id));
  return { ok: true as const, lines: rows.map((r) => callCsvRow(shapeCall(r, people))), last: lastCursor(rows) };
}

async function fetchEventsAfter(service: any, workspaceId: string, cursor: AuditCursor | null, size: number, filters: AuditFilters) {
  const { data, error } = await afterCursor(
    applyFilters(service.from('workspace_audit_events').select(EVENT_COLUMNS).eq('workspace_id', workspaceId), filters),
    cursor,
  )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(size);
  if (error) return { ok: false as const, error: error.message as string };
  const rows = (data ?? []) as any[];
  const people = await resolvePeople(service, rows.flatMap((r) => [r.actor_user_id, r.target]));
  return { ok: true as const, lines: rows.map((r) => eventCsvRow(shapeEvent(r, people))), last: lastCursor(rows) };
}
