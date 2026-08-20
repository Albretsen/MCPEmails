/**
 * Automations (internal prefix `triage_`): shared server-side validation.
 *
 * Everything a client sends is re-validated here. The dashboard form is a
 * convenience, not a boundary: an automation runs unattended, repeatedly, with
 * no human in the loop, so an unchecked field would silently become a standing
 * instruction against a real mailbox.
 *
 * Three rules are load-bearing and must not be relaxed:
 *
 *   1. There is NO delete-shaped action. Not trash, not permanent, not
 *      "archive then purge". `assertNoDeleteShape` rejects anything that even
 *      names deletion so a future action type cannot slip one in by accident.
 *   2. `forward` is always approval-gated downstream. This module still caps
 *      the recipient list so a rule cannot fan out to an unbounded audience.
 *   3. `draft_reply` produces a draft. The template is stored verbatim and is
 *      never evaluated; only the placeholder whitelist below is substituted.
 */

/** Cadences the dispatcher understands. Mirrors the interval_minutes CHECK. */
export const ALLOWED_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

/** Actions a rule may take. Deliberately has no delete member. */
export const ALLOWED_ACTION_TYPES = ['move', 'label', 'mark_read', 'forward', 'draft_reply'] as const;

/** Fields of the NormalizedSearch shape a stored filter may carry. */
const FILTER_STRING_FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'text', 'raw'] as const;
const FILTER_BOOLEAN_FIELDS = ['unread', 'has_attachment', 'flagged'] as const;
const FILTER_DATE_FIELDS = ['since', 'before'] as const;

export const MAX_TEMPLATE_LENGTH = 5000;
export const MAX_NOTE_LENGTH = 500;
export const MAX_FORWARD_RECIPIENTS = 10;
export const MAX_NAME_LENGTH = 80;
export const MAX_FILTER_FIELD_LENGTH = 500;
export const MIN_MESSAGES_PER_RUN = 1;
export const MAX_MESSAGES_PER_RUN = 200;

/**
 * Words that describe destroying mail. Any action type containing one of these
 * is refused outright rather than falling through to "unknown action type", so
 * the refusal reads as the deliberate product rule it is.
 */
const DELETE_SHAPED = ['delete', 'trash', 'purge', 'remove', 'destroy', 'erase', 'expunge'];

// Move destinations refused because moving mail there is deletion wearing a
// different hat: every provider auto-purges trash and junk on a timer, so an
// unattended move to Trash is a delete with a delayed fuse. Kept in step with
// TRIAGE_FORBIDDEN_MOVE_DESTINATIONS in
// supabase/functions/mcp-server/triage-engine.ts, which is the enforcing copy.
const FORBIDDEN_MOVE_DESTINATIONS = [
  'trash', 'bin', 'deleted', 'deleted items', 'deleted messages', 'junk', 'spam',
];

function folderLeaf(folder: string): string {
  const leaf = folder.split(/[/.\\]/).filter(Boolean).pop() ?? folder;
  return leaf.trim().toLowerCase().replace(/\s+/g, ' ');
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Deliberately permissive: the provider is the real authority on deliverability. */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function validateName(raw: unknown): ValidationResult<string> {
  if (typeof raw !== 'string') return fail('An automation name is required.');
  const name = raw.trim();
  if (!name) return fail('An automation name is required.');
  if (name.length > MAX_NAME_LENGTH) return fail(`An automation name can be at most ${MAX_NAME_LENGTH} characters.`);
  return { ok: true, value: name };
}

export function validateInterval(raw: unknown): ValidationResult<number> {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || !(ALLOWED_INTERVALS as readonly number[]).includes(value)) {
    return fail('Choose one of the supported run frequencies.');
  }
  return { ok: true, value };
}

export function validateMaxMessages(raw: unknown): ValidationResult<number> {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < MIN_MESSAGES_PER_RUN || value > MAX_MESSAGES_PER_RUN) {
    return fail(`The per-run message limit must be a whole number between ${MIN_MESSAGES_PER_RUN} and ${MAX_MESSAGES_PER_RUN}.`);
  }
  return { ok: true, value };
}

export type StoredFilter = Record<string, string | boolean>;

/**
 * Validates the stored query. Unknown keys are refused rather than dropped: a
 * silently ignored field would look like it was saved and never match anything.
 */
export function validateFilter(raw: unknown): ValidationResult<StoredFilter> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('The message filter must be an object.');
  }
  const input = raw as Record<string, unknown>;
  const out: StoredFilter = {};

  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;

    if ((FILTER_STRING_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'string') return fail(`The filter field "${key}" must be text.`);
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_FILTER_FIELD_LENGTH) {
        return fail(`The filter field "${key}" can be at most ${MAX_FILTER_FIELD_LENGTH} characters.`);
      }
      out[key] = trimmed;
      continue;
    }

    if ((FILTER_BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') return fail(`The filter field "${key}" must be true or false.`);
      out[key] = value;
      continue;
    }

    if ((FILTER_DATE_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        return fail(`The filter field "${key}" must be a date.`);
      }
      out[key] = value;
      continue;
    }

    return fail(`"${key}" is not a supported filter field.`);
  }

  if (Object.keys(out).length === 0) {
    return fail('Add at least one filter condition so the automation cannot match your whole mailbox.');
  }
  return { ok: true, value: out };
}

/** Refuses anything delete-shaped before the action type is even considered. */
function assertNoDeleteShape(type: string): string | null {
  const lowered = type.toLowerCase();
  if (DELETE_SHAPED.some((word) => lowered.includes(word))) {
    return 'Automations can never delete email. Choose move, label, mark as read, forward or draft a reply.';
  }
  return null;
}

export type StoredAction =
  | { type: 'move'; folder: string }
  | { type: 'label'; label: string }
  | { type: 'mark_read' }
  | { type: 'forward'; to: string[]; note?: string }
  | { type: 'draft_reply'; template: string };

export function validateAction(raw: unknown): ValidationResult<StoredAction> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('An action is required.');
  }
  const input = raw as Record<string, unknown>;
  const type = input.type;
  if (typeof type !== 'string' || !type.trim()) return fail('An action is required.');

  const deleteRefusal = assertNoDeleteShape(type);
  if (deleteRefusal) return fail(deleteRefusal);

  if (!(ALLOWED_ACTION_TYPES as readonly string[]).includes(type)) {
    return fail('That action is not available to automations.');
  }

  if (type === 'move') {
    const folder = typeof input.folder === 'string' ? input.folder.trim() : '';
    if (!folder) return fail('Choose the folder to move matching mail into.');
    if (folder.length > 200) return fail('A folder name can be at most 200 characters.');
    if (FORBIDDEN_MOVE_DESTINATIONS.includes(folderLeaf(folder))) {
      return fail(
        'Automations cannot move mail into trash or junk. Those folders are emptied '
        + 'automatically, so it would be a delete on a timer. Choose a folder you own.',
      );
    }
    return { ok: true, value: { type: 'move', folder } };
  }

  if (type === 'label') {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label) return fail('Enter the label to apply to matching mail.');
    if (label.length > 200) return fail('A label can be at most 200 characters.');
    return { ok: true, value: { type: 'label', label } };
  }

  if (type === 'mark_read') {
    return { ok: true, value: { type: 'mark_read' } };
  }

  if (type === 'forward') {
    const rawTo = input.to;
    const list = Array.isArray(rawTo)
      ? rawTo
      : typeof rawTo === 'string'
        ? rawTo.split(/[,;\s]+/)
        : [];
    const recipients = list
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (recipients.length === 0) return fail('Add at least one forwarding recipient.');
    if (recipients.length > MAX_FORWARD_RECIPIENTS) {
      return fail(`A forwarding rule can have at most ${MAX_FORWARD_RECIPIENTS} recipients.`);
    }
    const invalid = recipients.find((entry) => !EMAIL_RE.test(entry));
    if (invalid) return fail(`"${invalid}" is not a valid email address.`);
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > MAX_NOTE_LENGTH) return fail(`A forwarding note can be at most ${MAX_NOTE_LENGTH} characters.`);
    return { ok: true, value: note ? { type: 'forward', to: recipients, note } : { type: 'forward', to: recipients } };
  }

  const template = typeof input.template === 'string' ? input.template.trim() : '';
  if (!template) return fail('Enter the reply template to draft.');
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return fail(`A reply template can be at most ${MAX_TEMPLATE_LENGTH} characters.`);
  }
  return { ok: true, value: { type: 'draft_reply', template } };
}

/** Columns the dashboard reads. Never selects anything holding message content. */
export const RULE_COLUMNS =
  'id, workspace_id, inbox_id, api_key_id, name, enabled, filter, action, interval_minutes, max_messages_per_run, next_run_at, last_run_at, running_since, consecutive_failures, disabled_reason, created_at, updated_at';

export const RUN_COLUMNS =
  'id, rule_id, status, trigger, started_at, completed_at, duration_ms, matched, processed, succeeded, failed, skipped, error_code, error_detail';

export const RUN_ITEM_COLUMNS =
  'id, run_id, outcome, subject_redacted, sender_redacted, detail, undone_at, created_at';

/**
 * Confirms the inbox and API key both belong to the caller's workspace.
 *
 * Without this an owner could bind a rule to another workspace's inbox id and
 * have the runner act, unattended, on a mailbox they never connected.
 *
 * Lives here rather than in the route module because a Next.js route file may
 * only export HTTP handlers and route config.
 */
export async function assertWorkspaceResources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  workspaceId: string,
  inboxId: string,
  apiKeyId: string,
): Promise<{ error: string; status: number } | null> {
  const { data: inbox } = await db.from('inboxes')
    .select('id, deleted_at')
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!inbox || inbox.deleted_at) return { error: 'That inbox is not available in this workspace.', status: 400 };

  const { data: key } = await db.from('api_keys')
    .select('id, scopes, inbox_ids, deleted_at')
    .eq('id', apiKeyId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!key || key.deleted_at) return { error: 'That API key is not available in this workspace.', status: 400 };

  // null inbox_ids means "every inbox, including ones connected later".
  if (Array.isArray(key.inbox_ids) && !key.inbox_ids.includes(inboxId)) {
    return { error: 'That API key is not allowed to use the selected inbox.', status: 400 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What "apply a label" means on each provider
//
// A label is one idea with three provider-native spellings, and only one of
// them has naming rules strict enough to refuse a rule over:
//
//   gmail   -> a LABEL.    Free-form text, created if it does not exist.
//   outlook -> a CATEGORY. Free-form text, merged into the message's categories.
//   imap    -> a KEYWORD.  An IMAP atom, so a constrained ASCII token.
//
// Kept in step with supabase/functions/mcp-server/label-target.ts, which is the
// enforcing copy: the runner re-derives all of this before it writes anything.
// This copy exists so the dashboard refuses an impossible label at the moment a
// person types it, rather than storing a rule that can only ever fail.
// ---------------------------------------------------------------------------

export type LabelTargetKind = 'label' | 'category' | 'keyword';

export interface LabelTarget {
  kind: LabelTargetKind;
  /** Exactly what will be written to the mailbox. */
  applied_as: string;
  /** True when applied_as differs from what the user typed. */
  transformed: boolean;
}

/** See MAX_IMAP_KEYWORD_CHARS in label-target.ts for why there is a ceiling at all. */
export const MAX_IMAP_KEYWORD_CHARS = 64;

// RFC 3501 atom-specials, plus '[' which is refused here deliberately: it is
// legal in an atom but round-trips badly through enough servers that allowing
// half a bracket pair buys nothing.
const IMAP_KEYWORD_ILLEGAL_RE = /[()[\]{}%*"\\]/;
const IMAP_KEYWORD_NON_ATOM_RE = /[^\x21-\x7e]/;
const IMAP_KEYWORD_ILLEGAL_LIST = '( ) [ ] { } % * " \\';

/**
 * Normalises a label into a legal IMAP keyword, or refuses it.
 *
 * THE ONE TRANSFORMATION: runs of whitespace become a single underscore, so
 * "Order updates" is applied as "Order_updates". Nothing else is transformed:
 * an illegal character is an error, because a user who typed "Sale (50%)" wants
 * to be told their label was refused, not to find "Sale_50" in their mailbox.
 */
export function normalizeImapKeyword(label: string): ValidationResult<LabelTarget> {
  const raw = label.trim();
  if (!raw) return fail('Enter the label to apply to matching mail.');

  const keyword = raw.replace(/\s+/g, '_');
  const transformed = keyword !== raw;

  if (keyword.startsWith('\\')) {
    return fail(
      'On an IMAP mailbox a label is stored as an IMAP keyword, and a keyword cannot begin '
      + 'with a backslash: that namespace is reserved for system flags such as \\Seen. '
      + 'Choose a name without the leading backslash.',
    );
  }
  if (IMAP_KEYWORD_ILLEGAL_RE.test(keyword)) {
    return fail(
      `On an IMAP mailbox a label is stored as an IMAP keyword, which cannot contain ${IMAP_KEYWORD_ILLEGAL_LIST}. `
      + 'Choose a name without those characters, or move the mail to a folder instead.',
    );
  }
  if (IMAP_KEYWORD_NON_ATOM_RE.test(keyword)) {
    return fail(
      'On an IMAP mailbox a label is stored as an IMAP keyword, which the IMAP protocol limits to '
      + 'printable ASCII. Use ASCII letters, digits, - or _, or move the mail to a folder instead: '
      + 'folder names have no such limit.',
    );
  }
  if (keyword.length > MAX_IMAP_KEYWORD_CHARS) {
    return fail(
      `On an IMAP mailbox a label is stored as an IMAP keyword, which can be at most ${MAX_IMAP_KEYWORD_CHARS} characters.`,
    );
  }
  return { ok: true, value: { kind: 'keyword', applied_as: keyword, transformed } };
}

/**
 * Resolves what a label becomes on one provider.
 *
 * Every IMAP service is stored as provider 'imap' with a `service`
 * discriminator, so IMAP is the default branch and an unrecognised provider is
 * treated as IMAP rather than waved through. A null provider is unconstrained:
 * the runner validates again before it writes, and refusing a legal label
 * because the dashboard could not read the inbox row is the worse error.
 */
export function labelTargetFor(provider: string | null, label: string): ValidationResult<LabelTarget> {
  const trimmed = label.trim();
  if (!trimmed) return fail('Enter the label to apply to matching mail.');
  if (provider === null || provider === 'gmail') {
    return { ok: true, value: { kind: 'label', applied_as: trimmed, transformed: false } };
  }
  if (provider === 'outlook') {
    return { ok: true, value: { kind: 'category', applied_as: trimmed, transformed: false } };
  }
  return normalizeImapKeyword(trimmed);
}

/**
 * Re-checks a validated action against the inbox it will run on.
 *
 * Split from `validateAction` because the provider is a second database read
 * the callers only need when the action is a label, and threading an inbox row
 * through every validator to serve one action type would be the wrong shape.
 */
export function validateActionForProvider(
  action: StoredAction,
  provider: string | null,
): ValidationResult<StoredAction> {
  if (action.type !== 'label') return { ok: true, value: action };
  const target = labelTargetFor(provider, action.label);
  if (!target.ok) return fail(target.error);
  return { ok: true, value: action };
}

/**
 * Reads just the provider of an inbox in the caller's workspace.
 *
 * Returns null when the row is not readable, which callers treat as "no
 * provider-specific constraint": the runner is the enforcing copy.
 */
export async function readInboxProvider(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  workspaceId: string,
  inboxId: string,
): Promise<string | null> {
  const { data } = await db.from('inboxes')
    .select('provider')
    .eq('id', inboxId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return typeof data?.provider === 'string' ? data.provider : null;
}
