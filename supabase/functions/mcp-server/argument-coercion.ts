// ---------------------------------------------------------------------------
// Scalar-shaped arguments that are unambiguous, rewritten into the declared
// type before schema validation.
//
// A model that has one recipient writes `"to": "a@b.no"`, not
// `"to": ["a@b.no"]`, however plainly the schema says `type: "array"`. It
// writes `"include_signature": "false"` and `"limit": "20"` for the same
// reason: the value is right and only its JSON type is wrong. Each of those was
// refused as `must be array; received string`, the model retried with the right
// shape, and the user paid a failed call and a round trip for nothing. It was
// the largest type rejection in production: `email_compose.to` alone was 35
// calls across 5 workspaces in the 60 days to 2026-09-22, and one customer's
// host reported that "the first call always fails and then it corrects itself".
//
// The advertised schema does NOT loosen. `to` stays an array of emails in
// tools/list, because a `string | array` union costs tokens on every listing
// and some hosts refuse `anyOf` outright.
// This is the tolerant-reader half: advertise one shape, accept the obvious
// neighbours of it, and let the validator judge the result exactly as if the
// caller had sent it that way. Nothing here can turn an invalid value into an
// accepted one it would not otherwise be: every coerced value is still checked
// by the validator (formats, bounds, enums).
//
// Only these shapes are rewritten, and only where the declared type does NOT
// already admit the value as sent:
//
//   array, got a string   → a JSON array literal ('["a@b.no"]') is parsed;
//                           for email items the string is split on , and ;
//                           (a bare address can contain neither); anything
//                           else becomes a one-item array. Ids are NEVER
//                           split: their shape is the provider's, not ours.
//   array, got an object  → one-item array, when the items are objects
//                           (one attachment sent without its brackets).
//   boolean, got a string → "true" / "false", any case, trimmed. Nothing else:
//                           "yes", "1", "" stay strings and stay refused.
//   integer, got a string → base-10 digits with an optional sign, and only
//                           within the safe-integer range.
//   number, got a string  → the same, plus a decimal fraction.
//   object, got a string  → a JSON object literal ('{"from":"a@b.no"}') is
//                           parsed. Some hosts serialise every nested object.
//
// ── Added 2026-09-23, from a sweep of every advertised parameter ────────────
//
//   null, on a property whose type does not admit null → the property is
//     removed, i.e. treated as not sent. Clients that fill every declared field
//     (OpenAI-style strict function calling) send `null` for the ones they
//     mean to leave unset; all 265 optional parameters refused that. A
//     REQUIRED property sent as null is still missing afterwards, so it is
//     still refused as required.
//   enum, wrong case → the member that matches ignoring case and surrounding
//     whitespace ("Gmail" → "gmail"). Only when exactly one member matches.
//   email, "Name <addr>" → addr. The display name is dropped: every email
//     field here takes a bare address, and the validator then checks addr.
//     A list given as one string is split on , and ; OUTSIDE quotes and angle
//     brackets, so '"Doe, John" <j@x.no>, a@b.no' is two recipients, not three.
//   integer above `maximum`, on a property the CALLER names as clampable →
//     the maximum. Only page sizes are clampable (see CLAMPED_TO_MAXIMUM):
//     asking for 200 results and getting the first 100 plus `has_more` is the
//     answer to the question that was asked. A cap that bounds what a write
//     touches (a delete's `limit`, `max_messages_per_run`) is never clamped:
//     there a larger number is an instruction, and a silent smaller one is not
//     the same instruction. A clamp is always DISCLOSED in the result by the
//     caller of this module; the others are not, because they change nothing
//     about what the call does.
//
// Pure and dependency-free so it can be tested without booting the server.
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

/** One rewrite, for the operator log. Path and types only, never the value. */
export interface CoercedArgument {
  /** Dotted path, e.g. `to` or `attachments[0].attachment_index`. */
  path: string;
  /** JSON type the caller sent. */
  from: string;
  /**
   * What it was rewritten into: a declared type, `absent` for a null that was
   * removed, `enum` for a case-folded member, `address` for an extracted
   * email address, or `clamped` for a value lowered to its maximum.
   */
  to: string;
  /** For `clamped` only: the number asked for and the number used. */
  requested?: number;
  used?: number;
}

/**
 * Page-size properties that are lowered to their schema `maximum` instead of
 * refused, per tool. Read-only listings only: every one of these bounds how
 * much is RETURNED, never how much is changed. `email_read.limit` alone was
 * refused 346 times in the 10 days to 2026-09-22, most of them a client
 * retrying the identical call every three seconds.
 */
export const CLAMPED_TO_MAXIMUM: Readonly<Record<string, readonly string[]>> = {
  email_read: ["limit", "body_max_chars"],
  draft: ["limit"],
  draft_list: ["limit"],
  schedule: ["limit"],
  schedule_list: ["limit"],
  contact_search: ["limit"],
  // `limit` on these two is the run-history page size (action 'runs').
  // `max_messages_per_run` is deliberately absent: it bounds what an
  // unattended rule may touch.
  automation: ["limit"],
  automation_read: ["limit"],
};

export interface CoercionOptions {
  /** Top-level properties that may be clamped to their maximum. */
  clamp?: readonly string[];
}

function declaredTypes(schema: Schema): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type): type is string => typeof type === "string");
  }
  return typeof schema.type === "string" ? [schema.type] : [];
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function asSchema(value: unknown): Schema | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Schema
    : null;
}

/** Does the declared type already admit this value as sent? */
function admits(types: readonly string[], value: unknown): boolean {
  const actual = valueType(value);
  return types.some((type) =>
    type === actual ||
    (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (type === "number" && typeof value === "number")
  );
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function coerceString(text: string, types: readonly string[], schema: Schema): { value: unknown; to: string } | null {
  const trimmed = text.trim();
  for (const type of types) {
    if (type === "boolean") {
      const lowered = trimmed.toLowerCase();
      if (lowered === "true") return { value: true, to: "boolean" };
      if (lowered === "false") return { value: false, to: "boolean" };
    }
    if (type === "integer" && INTEGER_TEXT.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) return { value: parsed, to: "integer" };
    }
    if (type === "number" && NUMBER_TEXT.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return { value: parsed, to: "number" };
    }
    if (type === "object" && trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { value: parsed, to: "object" };
        }
      } catch {
        // Not JSON; leave it for the validator.
      }
    }
    if (type === "array") {
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return { value: parsed, to: "array" };
        } catch {
          // Not JSON after all; fall through to the one-item reading.
        }
      }
      const items = asSchema(schema.items);
      const itemTypes = items ? declaredTypes(items) : [];
      // Only a list of plain strings can be built from a string. An array of
      // objects or numbers given a string is a different mistake; leave it for
      // the validator to name.
      if (items && !itemTypes.includes("string")) continue;
      if (items?.format === "email") {
        const parts = splitAddressList(trimmed);
        return { value: parts.length > 0 ? parts : [text], to: "array" };
      }
      return { value: [text], to: "array" };
    }
  }
  return null;
}

/**
 * Split an address list written as one string into bare addresses.
 *
 * Separators are `,` and `;`, but only outside a quoted display name and
 * outside angle brackets, so a display name may contain either. An entry with
 * an angle-bracketed part contributes what is inside the brackets; any other
 * entry contributes itself, trimmed. Nothing here decides validity: the
 * validator checks every address that comes out.
 */
export function splitAddressList(text: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of text) {
    if (char === '"' && !angled) quoted = !quoted;
    else if (char === "<" && !quoted) angled = true;
    else if (char === ">" && !quoted) angled = false;
    if ((char === "," || char === ";") && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current);
  return entries
    .map((entry) => bareAddress(entry))
    .filter((entry) => entry !== "");
}

/** `Name <addr>` → `addr`; anything without angle brackets, trimmed. */
function bareAddress(entry: string): string {
  const match = /<([^<>]*)>\s*$/.exec(entry.trim());
  return (match ? match[1] : entry).trim();
}

/** Does this string carry a display name around an angle-bracketed address? */
function hasDisplayName(entry: string): boolean {
  return /<[^<>]*>\s*$/.test(entry.trim());
}

/** The one enum member equal to `text` ignoring case and surrounding space. */
function enumMember(text: string, members: readonly unknown[]): string | null {
  const wanted = text.trim().toLowerCase();
  const hits = members.filter((member) =>
    typeof member === "string" && member.toLowerCase() === wanted
  );
  return hits.length === 1 ? hits[0] as string : null;
}

/**
 * Rewrite unambiguous scalar-shaped arguments into their declared types, IN
 * PLACE, and return what was changed. Walks declared properties only, and
 * recurses into declared sub-objects and arrays of them, the same reach as
 * the validator. Values the schema already admits are never touched.
 */
export function coerceArgumentTypes(
  schema: Schema,
  value: unknown,
  path = "",
  options: CoercionOptions = {},
): CoercedArgument[] {
  const changed: CoercedArgument[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return changed;
  const properties = asSchema(schema.properties) ?? {};
  const object = value as Record<string, unknown>;
  for (const [key, rawPropertySchema] of Object.entries(properties)) {
    if (!(key in object)) continue;
    const propertySchema = asSchema(rawPropertySchema);
    if (!propertySchema) continue;
    const childPath = path === "" ? key : `${path}.${key}`;
    const types = declaredTypes(propertySchema);
    let child = object[key];

    // null for an optional field means "not set" to the clients that send it.
    if (child === null && types.length > 0 && !types.includes("null")) {
      delete object[key];
      changed.push({ path: childPath, from: "null", to: "absent" });
      continue;
    }

    if (types.length > 0 && !admits(types, child)) {
      if (typeof child === "string") {
        const coerced = coerceString(child, types, propertySchema);
        if (coerced) {
          object[key] = coerced.value;
          child = coerced.value;
          changed.push({ path: childPath, from: "string", to: coerced.to });
        }
      } else if (
        types.includes("array") && valueType(child) === "object" &&
        declaredTypes(asSchema(propertySchema.items) ?? {}).includes("object")
      ) {
        object[key] = [child];
        child = object[key];
        changed.push({ path: childPath, from: "object", to: "array" });
      }
    }

    if (
      typeof child === "string" && Array.isArray(propertySchema.enum) &&
      !propertySchema.enum.includes(child)
    ) {
      const member = enumMember(child, propertySchema.enum);
      if (member !== null) {
        object[key] = member;
        child = member;
        changed.push({ path: childPath, from: "string", to: "enum" });
      }
    }

    if (typeof child === "string" && propertySchema.format === "email" && hasDisplayName(child)) {
      object[key] = bareAddress(child);
      child = object[key];
      changed.push({ path: childPath, from: "string", to: "address" });
    }
    if (Array.isArray(child) && asSchema(propertySchema.items)?.format === "email") {
      child.forEach((item, index) => {
        if (typeof item === "string" && hasDisplayName(item)) {
          (child as unknown[])[index] = bareAddress(item);
          changed.push({ path: `${childPath}[${index}]`, from: "string", to: "address" });
        }
      });
    }

    if (
      path === "" && options.clamp?.includes(key) && typeof child === "number" &&
      typeof propertySchema.maximum === "number" && child > propertySchema.maximum
    ) {
      const used = propertySchema.maximum;
      changed.push({ path: childPath, from: "number", to: "clamped", requested: child, used });
      object[key] = used;
      child = used;
    }

    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      changed.push(...coerceArgumentTypes(propertySchema, child, childPath));
    } else if (Array.isArray(child)) {
      const items = asSchema(propertySchema.items);
      if (items && asSchema(items.properties)) {
        child.forEach((item, index) => {
          changed.push(...coerceArgumentTypes(items, item, `${childPath}[${index}]`));
        });
      }
    }
  }
  return changed;
}

/** How to get the rest, per clamped property. */
const CLAMP_CONTINUATION: Record<string, string> = {
  limit: "call again with the returned next_offset for the rest",
  body_max_chars: "continue a truncated body with body_offset",
};

/**
 * The result note for page sizes lowered to their maximum. The caller asked
 * for more than it got; the note says so and says how to get the rest.
 */
export function buildClampedArgumentsNote(clamped: readonly CoercedArgument[]): string {
  const parts = clamped.map((entry) =>
    `${entry.path} ${entry.requested} is above the maximum of ${entry.used}, so ${entry.used} ` +
    `was used` + (CLAMP_CONTINUATION[entry.path] ? `; ${CLAMP_CONTINUATION[entry.path]}` : "")
  );
  return `Note: ${parts.join(". ")}.`;
}
