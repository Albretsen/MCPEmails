/**
 * JSON transcript plans: a chat scene's calls, written as data so a routine
 * (or a person) can write one without writing code.
 *
 *   transcripts/<id>.plan.json
 *
 * {
 *   "turns": [
 *     { "role": "user", "text": "Find the overdue invoice and open it." },
 *     { "role": "tool", "as": "hits", "name": "email_read",
 *       "args": { "action": "search", "subject": "invoice" },
 *       "summary": "{{hits.messages | count}} matches" },
 *     { "role": "tool", "as": "msg", "name": "email_read",
 *       "args": { "action": "read",
 *                 "message_id": "{{hits.messages | where:subject~/overdue/i | first | get:id}}" },
 *       "summary": "opened \"{{msg.subject}}\"" },
 *     { "role": "assistant",
 *       "requires": "hits.messages | where:subject~/overdue/i | count",
 *       "text": "It is \"{{msg.subject}}\", from {{msg.from.name}}.",
 *       "otherwise": "Nothing in the inbox is overdue." }
 *   ]
 * }
 *
 * REFERENCES. A tool turn's `as` names its result (the tool's structured
 * payload, exactly as the server returned it). Any later string may embed
 * `{{expr}}`. A string that is EXACTLY one `{{expr}}` is replaced by the raw
 * value, so an array of ids stays an array; anywhere else the value is
 * stringified into the text.
 *
 * expr = <name>[.path] [| pipe]...   path: a.b, a[0].b
 *   count            length of an array (or string)
 *   first, last      one element
 *   take:N           the first N elements
 *   get:path         a field of an object
 *   pluck:path       that field of every element
 *   where:path~/re/flags   keep elements whose field matches the regex
 *   where:path!~/re/flags  keep elements whose field does not match
 *   where:path=value       keep elements whose field equals the text
 *   join[:sep]       join an array, default ", "
 *   lower, upper     case
 *   default:text     use the text when the value is empty
 *
 * A reference that resolves to nothing (undefined, null, empty array or empty
 * string) in a tool's args FAILS that turn rather than sending a call with a
 * hole in it, and the failure is recorded, so render refuses the transcript.
 * That is the point: a plan written against last week's mailbox must not film
 * a call that quietly did nothing this week.
 */

import { readFileSync } from 'node:fs';
import { lintCopy } from '../../src/copy-lint.mjs';

/** Tools that only read. Every other tool is treated as mutating, whatever
 *  the plan says, so a forgotten `"mutating": true` cannot slip past --write. */
export const READ_ONLY_TOOLS = new Set([
  'inbox_list',
  'email_read',
  'folder_list',
  'draft_list',
  'draft_read',
  'schedule_list',
  'signature_get',
  'contact_search',
  'automation_read',
]);

const TURN_KEYS = {
  user: ['role', 'text'],
  tool: ['role', 'name', 'args', 'as', 'summary', 'mutating'],
  assistant: ['role', 'text', 'requires', 'otherwise'],
};

class PlanError extends Error {}

/** Every `{{...}}` in any string inside `value`, with the names they use. */
function* expressionsIn(value) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{([^}]*)\}\}/g)) yield m[1].trim();
  } else if (Array.isArray(value)) {
    for (const v of value) yield* expressionsIn(v);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) yield* expressionsIn(v);
  }
}

const rootName = (expr) => expr.split('|')[0].trim().split(/[.[]/)[0];

/**
 * Read and check a JSON plan. Shape errors are thrown here, before any call is
 * made, naming the turn index and the key.
 */
export function loadJsonPlan(file) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new PlanError(`${file} is not valid JSON: ${e.message}`);
  }
  if (!plan || !Array.isArray(plan.turns) || plan.turns.length === 0) {
    throw new PlanError(`${file} must be an object with a non-empty "turns" array.`);
  }
  for (const k of Object.keys(plan)) {
    if (k !== 'turns' && k !== 'note') throw new PlanError(`plan: unknown top-level key "${k}". Allowed: turns, note.`);
  }

  const named = new Set();
  plan.turns.forEach((turn, i) => {
    const w = `plan turn ${i}`;
    if (!turn || typeof turn !== 'object') throw new PlanError(`${w}: must be an object.`);
    const allowed = TURN_KEYS[turn.role];
    if (!allowed) throw new PlanError(`${w}: "role" must be user, tool or assistant, got ${JSON.stringify(turn.role)}.`);
    for (const k of Object.keys(turn)) {
      if (!allowed.includes(k)) throw new PlanError(`${w} (${turn.role}): unknown key "${k}". Allowed: ${allowed.join(', ')}.`);
    }

    if (turn.role === 'user' || turn.role === 'assistant') {
      if (typeof turn.text !== 'string' || !turn.text.trim()) throw new PlanError(`${w}: "text" must be a non-empty string.`);
      // On screen, so the same copy rules as a storyboard.
      for (const key of ['text', 'otherwise']) {
        const problems = lintCopy(turn[key], `${w}: "${key}"`);
        if (problems.length) throw new PlanError(problems[0]);
      }
    }
    if (turn.role === 'user' && /\{\{/.test(turn.text)) {
      throw new PlanError(`${w}: a user turn cannot reference a result. The user asked before anything ran.`);
    }
    if (turn.role === 'assistant') {
      if (turn.requires !== undefined && typeof turn.requires !== 'string') throw new PlanError(`${w}: "requires" must be an expression string, like "hits.messages | count".`);
      if (turn.requires !== undefined && turn.otherwise === undefined) throw new PlanError(`${w}: "requires" needs an "otherwise" text for when it is empty.`);
    }
    if (turn.role === 'tool') {
      if (typeof turn.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(turn.name)) throw new PlanError(`${w}: "name" must be a tool name like "email_read".`);
      if (turn.args !== undefined && (typeof turn.args !== 'object' || Array.isArray(turn.args) || turn.args === null)) {
        throw new PlanError(`${w}: "args" must be an object.`);
      }
      if (turn.as !== undefined && !/^[a-z][a-zA-Z0-9_]*$/.test(String(turn.as))) {
        throw new PlanError(`${w}: "as" must be a name like "hits" (letters, digits, underscore).`);
      }
      if (turn.as !== undefined && named.has(turn.as)) throw new PlanError(`${w}: "as": "${turn.as}" is already used by an earlier turn.`);
      if (turn.summary !== undefined && typeof turn.summary !== 'string') throw new PlanError(`${w}: "summary" must be a string template.`);
      if (turn.mutating !== undefined && typeof turn.mutating !== 'boolean') throw new PlanError(`${w}: "mutating" must be true or false.`);
    }

    // References may only point BACKWARDS, except that a tool's own summary
    // may read its own result.
    const own = turn.role === 'tool' ? turn.as : undefined;
    const sources = turn.role === 'tool' ? [turn.args] : turn.role === 'assistant' ? [turn.text, turn.otherwise, `{{${turn.requires ?? ''}}}`] : [];
    for (const expr of expressionsIn(sources)) {
      if (!expr) continue;
      const name = rootName(expr);
      if (!named.has(name)) throw new PlanError(`${w}: {{${expr}}} refers to "${name}", which no earlier tool turn names with "as".`);
    }
    if (turn.role === 'tool' && turn.summary) {
      for (const expr of expressionsIn(turn.summary)) {
        const name = rootName(expr);
        if (!named.has(name) && name !== own) throw new PlanError(`${w}: summary {{${expr}}} refers to "${name}", which is neither this turn's "as" nor an earlier one.`);
      }
    }
    if (turn.role === 'tool' && turn.as) named.add(turn.as);
  });

  return plan;
}

// --- Evaluation -------------------------------------------------------------

function getPath(value, path) {
  if (!path) return value;
  const parts = path.match(/[^.[\]]+/g) ?? [];
  let v = value;
  for (const p of parts) {
    if (v === undefined || v === null) return undefined;
    v = /^\d+$/.test(p) && Array.isArray(v) ? v[Number(p)] : v[p];
  }
  return v;
}

function parseRegex(text) {
  const m = text.match(/^\/(.*)\/([a-z]*)$/);
  return m ? new RegExp(m[1], m[2]) : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

const asArray = (v, pipe) => {
  if (!Array.isArray(v)) throw new Error(`"${pipe}" needs a list, got ${v === undefined ? 'nothing' : typeof v}`);
  return v;
};

function applyPipe(value, pipe) {
  const colon = pipe.indexOf(':');
  const op = (colon === -1 ? pipe : pipe.slice(0, colon)).trim();
  const arg = colon === -1 ? undefined : pipe.slice(colon + 1).trim();

  switch (op) {
    case 'count':
      return value === undefined || value === null ? 0 : (Array.isArray(value) || typeof value === 'string' ? value.length : 1);
    case 'first':
      return asArray(value, op)[0];
    case 'last': {
      const a = asArray(value, op);
      return a[a.length - 1];
    }
    case 'take':
      return asArray(value, op).slice(0, Number(arg));
    case 'get':
      return getPath(value, arg);
    case 'pluck':
      return asArray(value, op).map((x) => getPath(x, arg));
    case 'where': {
      const m = arg?.match(/^([^!~=]+)(!~|~|=)(.*)$/);
      if (!m) throw new Error(`"where" needs field~/regex/, field!~/regex/ or field=value, got "${arg}"`);
      const [, field, cmp, rhs] = m;
      const re = cmp === '=' ? null : parseRegex(rhs);
      return asArray(value, op).filter((x) => {
        const f = getPath(x, field.trim());
        const s = f === undefined || f === null ? '' : String(f);
        if (cmp === '=') return s === rhs;
        return cmp === '~' ? re.test(s) : !re.test(s);
      });
    }
    case 'join':
      return asArray(value, op).join(arg ?? ', ');
    case 'lower':
      return String(value ?? '').toLowerCase();
    case 'upper':
      return String(value ?? '').toUpperCase();
    case 'default':
      return isEmpty(value) ? arg : value;
    default:
      throw new Error(`unknown pipe "${op}"`);
  }
}

export const isEmpty = (v) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Evaluate one expression against the named results. Throws on a bad pipe. */
export function evaluate(expr, scope) {
  // Split on pipes that are not inside a /regex/.
  const parts = [];
  let buf = '';
  let inRe = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '/' && expr[i - 1] !== '\\') inRe = !inRe;
    if (c === '|' && !inRe) {
      parts.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  parts.push(buf);

  const head = parts[0].trim();
  const name = rootName(head);
  let value = getPath(scope[name], head.slice(name.length).replace(/^\./, ''));
  for (const pipe of parts.slice(1)) value = applyPipe(value, pipe.trim());
  return value;
}

/**
 * Fill every `{{expr}}` in `value` (deeply, for args). Returns
 * { value, empty: [exprs that resolved to nothing] }.
 */
export function fill(value, scope) {
  const empty = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{([^}]*)\}\}$/);
      if (whole) {
        const r = evaluate(whole[1].trim(), scope);
        if (isEmpty(r)) empty.push(whole[1].trim());
        return r;
      }
      return v.replace(/\{\{([^}]*)\}\}/g, (_m, expr) => {
        const r = evaluate(expr.trim(), scope);
        if (isEmpty(r)) empty.push(expr.trim());
        return Array.isArray(r) ? r.join(', ') : r === undefined || r === null ? '' : String(r);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), empty };
}

export { PlanError };
