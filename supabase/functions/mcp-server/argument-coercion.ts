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
  /** Declared type it was rewritten into. */
  to: string;
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
        const parts = trimmed.split(/[,;]/).map((part) => part.trim()).filter((part) => part !== "");
        return { value: parts.length > 0 ? parts : [text], to: "array" };
      }
      return { value: [text], to: "array" };
    }
  }
  return null;
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
