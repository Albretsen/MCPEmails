/**
 * What the automation form does with a rule's stored shape.
 *
 * Kept out of the component so it can be tested directly, because the failure it
 * guards against is silent: a rule written through MCP can hold filter fields the
 * form has no input for (`cc`, `text`, `since`, `before`, or an explicit `false`
 * on a checkbox field). Rebuilding the filter from the inputs alone deleted them
 * on the next save, so renaming a rule widened what it matched.
 *
 * Two independent protections, on purpose:
 *   1. The form carries every field it cannot show, and shows it read-only.
 *   2. An edit sends only what the person changed, so a rename cannot rewrite the
 *      filter or action at all, whatever shape they are in.
 */

export const FORM_TEXT_FILTER_FIELDS = ['from', 'to', 'subject', 'body'] as const;
export const FORM_BOOLEAN_FILTER_FIELDS = ['unread', 'has_attachment', 'flagged'] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = Record<string, unknown>;

/** Action fields the form has an input for, per action type. */
const FORM_ACTION_FIELDS: Record<string, readonly string[]> = {
  move: ['type', 'folder'],
  label: ['type', 'label'],
  mark_read: ['type'],
  forward: ['type', 'to', 'note'],
  draft_reply: ['type', 'template'],
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * Every part of a stored filter the form's inputs cannot represent.
 *
 * A checkbox can say `true` or "not set", never `false`, and `unread: false` is a
 * real condition (only mail already read), so an explicit false is held here too.
 */
export function hiddenFilterFields(filter: unknown): JsonObject {
  const hidden: JsonObject = {};
  for (const [field, value] of Object.entries(asObject(filter))) {
    if ((FORM_TEXT_FILTER_FIELDS as readonly string[]).includes(field)) continue;
    if ((FORM_BOOLEAN_FILTER_FIELDS as readonly string[]).includes(field) && value === true) continue;
    hidden[field] = value;
  }
  return hidden;
}

/** The action fields the form has no input for. Only meaningful for the same action type. */
export function hiddenActionFields(action: unknown): JsonObject {
  const source = asObject(action);
  const known = FORM_ACTION_FIELDS[String(source.type)] ?? ['type'];
  const hidden: JsonObject = {};
  for (const [field, value] of Object.entries(source)) {
    if (!known.includes(field)) hidden[field] = value;
  }
  return hidden;
}

export interface RuleFormValues {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  unread?: boolean;
  has_attachment?: boolean;
  flagged?: boolean;
  hiddenFilter?: JsonObject;
  actionType: string;
  folder?: string;
  label?: string;
  forwardTo?: string;
  forwardNote?: string;
  template?: string;
  hiddenAction?: JsonObject;
  hiddenActionType?: string | null;
}

/** The filter the form currently describes, the fields it does not show included. */
export function buildRuleFilter(form: RuleFormValues): JsonObject {
  const filter: JsonObject = { ...(form.hiddenFilter ?? {}) };
  for (const field of FORM_TEXT_FILTER_FIELDS) {
    const value = (form[field] ?? '').trim();
    if (value) filter[field] = value;
  }
  // After the hidden fields: ticking "Unread only" replaces a stored `false`.
  for (const field of FORM_BOOLEAN_FILTER_FIELDS) {
    if (form[field]) filter[field] = true;
  }
  return filter;
}

export function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? '').split(/[,;\s]+/).map((entry) => entry.trim()).filter(Boolean);
}

export function buildRuleAction(form: RuleFormValues): JsonObject {
  const kept = form.hiddenActionType === form.actionType ? (form.hiddenAction ?? {}) : {};
  if (form.actionType === 'move') return { ...kept, type: 'move', folder: (form.folder ?? '').trim() };
  if (form.actionType === 'label') return { ...kept, type: 'label', label: (form.label ?? '').trim() };
  if (form.actionType === 'mark_read') return { ...kept, type: 'mark_read' };
  if (form.actionType === 'forward') {
    const note = (form.forwardNote ?? '').trim();
    const action: JsonObject = { ...kept, type: 'forward', to: parseRecipients(form.forwardTo) };
    if (note) action.note = note;
    return action;
  }
  return { ...kept, type: 'draft_reply', template: (form.template ?? '').trim() };
}

function canonical(value: unknown): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value as JsonObject).sort()) out[key] = canonical((value as JsonObject)[key]);
    return out;
  }
  return (value ?? null) as Json;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The fields of a save body the person actually changed. Empty when nothing did. */
export function editPatch(rule: JsonObject, next: JsonObject): JsonObject {
  const patch: JsonObject = {};
  for (const [field, value] of Object.entries(next)) {
    if (!sameValue(rule[field], value)) patch[field] = value;
  }
  return patch;
}

/** A filter's conditions in the order a sentence reads best. */
const CONDITION_ORDER = ['from', 'to', 'cc', 'subject', 'body', 'text', 'has_attachment', 'unread', 'flagged', 'since', 'before'];

export function filterConditions(filter: unknown): Array<{ field: string; value: string | boolean }> {
  const source = asObject(filter);
  const ordered = [...CONDITION_ORDER, ...Object.keys(source).filter((field) => !CONDITION_ORDER.includes(field))];
  const conditions: Array<{ field: string; value: string | boolean }> = [];
  for (const field of ordered) {
    const value = source[field];
    if (typeof value === 'string' || typeof value === 'boolean') conditions.push({ field, value });
  }
  return conditions;
}

/**
 * The form's starting point for a copy of a rule.
 *
 * Built from an explicit list of what a rule SAYS, never by spreading the row, so
 * nothing about what the original has earned can come along: not its on/off state,
 * its id, its history or its handled-mail record, nor any approval setting added
 * later. A new column stays out of a copy unless someone names it here. The create
 * route writes `enabled: false` whatever it is sent.
 *
 * The inbox is left empty when there is more than one to choose from, since the
 * point of a copy is usually the second mailbox, and silently repeating the first
 * would double-process it.
 */
export function duplicateRuleDraft(rule: JsonObject, name: string, inboxCount: number): JsonObject {
  return {
    name,
    inbox_id: inboxCount > 1 ? '' : (rule.inbox_id ?? ''),
    api_key_id: rule.api_key_id ?? '',
    interval_minutes: rule.interval_minutes,
    max_messages_per_run: rule.max_messages_per_run,
    filter: rule.filter,
    action: rule.action,
  };
}
