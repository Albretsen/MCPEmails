/* Incremental reader for a tool call's JSON arguments.
 *
 * The model generates `{"to":"...","subject":"...","body":"Hi Maya,\n..."}`
 * a few characters at a time. To stream a draft into the compose view while it
 * is being written, the value of ONE top-level string key (`body`) is decoded
 * as it arrives; every other top-level value becomes available once complete.
 *
 * Chunks split anywhere: inside an escape (`\` | `n`), inside `é`,
 * between the two halves of a surrogate pair (`\ud83d` | `\ude00`, or the two
 * literal code units). Nothing is emitted until it is unambiguous, and the
 * emitted text is always well-formed UTF-16: a lone surrogate becomes U+FFFD.
 *
 * This is a reader, not a validator: the complete arguments are still parsed
 * with JSON.parse when the call ends. On malformed input it stops (`failed`)
 * and emits nothing further.
 */

type Mode = "start" | "key_or_end" | "key" | "colon" | "value_start" | "string" | "raw" | "after_value" | "done" | "error";

const REPLACEMENT = "�";
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export class JsonArgStream {
  /** Top-level values received completely, parsed. */
  readonly completed: Record<string, unknown> = {};
  /** Decoded value of the streamed key so far. */
  text = "";
  /** The streamed key's value has begun (its opening quote was seen). */
  started = false;
  /** The streamed key's value is complete. */
  finished = false;

  private mode: Mode = "start";
  private key = "";
  private raw = "";
  private streaming = false;
  // String state (keys and string values).
  private escaped = false;
  private unicode: string | null = null;
  private pendingHigh = "";
  // Raw (non-string) value state.
  private depth = 0;
  private rawInString = false;
  private rawEscaped = false;

  constructor(private readonly streamKey: string) {}

  get failed(): boolean {
    return this.mode === "error";
  }

  /** Feeds a chunk; returns the newly decoded text of the streamed key. */
  push(chunk: string): string {
    let out = "";
    for (let i = 0; i < chunk.length; i++) {
      if (this.mode === "error" || this.mode === "done") break;
      const c = chunk[i] as string;
      const produced = this.step(c);
      if (produced === null) i--; // reprocess the same character in the new mode
      else if (produced) {
        out += produced;
        this.text += produced;
      }
    }
    return out;
  }

  /** End of input. Returns any held-back text (a lone surrogate, replaced). */
  end(): string {
    let out = "";
    if (this.streaming && this.pendingHigh) {
      out = REPLACEMENT;
      this.pendingHigh = "";
      this.text += out;
    }
    return out;
  }

  /** One character. Returns text to emit, or null to reprocess `c`. */
  private step(c: string): string | null {
    switch (this.mode) {
      case "start":
        if (isSpace(c)) return "";
        if (c === "{") this.mode = "key_or_end";
        else this.mode = "error";
        return "";
      case "key_or_end":
        if (isSpace(c) || c === ",") return "";
        if (c === '"') {
          this.mode = "key";
          this.raw = "";
          this.escaped = false;
        } else if (c === "}") this.mode = "done";
        else this.mode = "error";
        return "";
      case "key":
        if (this.escaped) {
          this.escaped = false;
          this.raw += c;
        } else if (c === "\\") {
          this.escaped = true;
          this.raw += c;
        } else if (c === '"') {
          const key = parseJsonString(this.raw);
          if (key === null) this.mode = "error";
          else {
            this.key = key;
            this.mode = "colon";
          }
        } else this.raw += c;
        return "";
      case "colon":
        if (isSpace(c)) return "";
        this.mode = c === ":" ? "value_start" : "error";
        return "";
      case "value_start":
        if (isSpace(c)) return "";
        this.raw = "";
        if (c === '"') {
          this.mode = "string";
          this.escaped = false;
          this.unicode = null;
          this.pendingHigh = "";
          this.streaming = this.key === this.streamKey && !this.started;
          if (this.streaming) this.started = true;
          return "";
        }
        this.mode = "raw";
        this.depth = 0;
        this.rawInString = false;
        this.rawEscaped = false;
        return null;
      case "string":
        return this.stringChar(c);
      case "raw":
        return this.rawChar(c);
      case "after_value":
        if (isSpace(c)) return "";
        if (c === ",") this.mode = "key_or_end";
        else if (c === "}") this.mode = "done";
        else this.mode = "error";
        return "";
      default:
        return "";
    }
  }

  private stringChar(c: string): string {
    if (this.unicode !== null) {
      if (!/[0-9a-fA-F]/.test(c)) {
        this.mode = "error";
        return "";
      }
      this.unicode += c;
      this.raw += c;
      if (this.unicode.length < 4) return "";
      const unit = String.fromCharCode(parseInt(this.unicode, 16));
      this.unicode = null;
      return this.unit(unit);
    }
    if (this.escaped) {
      this.escaped = false;
      this.raw += c;
      if (c === "u") {
        this.unicode = "";
        return "";
      }
      const simple = SIMPLE_ESCAPES[c];
      if (simple === undefined) {
        this.mode = "error";
        return "";
      }
      return this.unit(simple);
    }
    if (c === "\\") {
      this.escaped = true;
      this.raw += c;
      return "";
    }
    if (c === '"') {
      let out = "";
      if (this.streaming) {
        if (this.pendingHigh) {
          out = REPLACEMENT;
          this.pendingHigh = "";
        }
        this.finished = true;
        this.streaming = false;
        // push() appends `out` to `text` right after this returns.
        this.completed[this.key] = this.text + out;
      } else {
        const value = parseJsonString(this.raw);
        if (value === null) {
          this.mode = "error";
          return "";
        }
        this.completed[this.key] = wellFormed(value);
      }
      this.mode = "after_value";
      return out;
    }
    this.raw += c;
    return this.unit(c);
  }

  /** One decoded UTF-16 code unit of a string value. Pairs surrogates. */
  private unit(u: string): string {
    if (!this.streaming) return "";
    const code = u.charCodeAt(0);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (this.pendingHigh) {
      const high = this.pendingHigh;
      this.pendingHigh = "";
      if (isLow) return high + u;
      if (isHigh) {
        this.pendingHigh = u;
        return REPLACEMENT;
      }
      return REPLACEMENT + u;
    }
    if (isHigh) {
      this.pendingHigh = u;
      return "";
    }
    if (isLow) return REPLACEMENT;
    return u;
  }

  private rawChar(c: string): string | null {
    if (this.rawInString) {
      this.raw += c;
      if (this.rawEscaped) this.rawEscaped = false;
      else if (c === "\\") this.rawEscaped = true;
      else if (c === '"') this.rawInString = false;
      return "";
    }
    if (c === '"') {
      this.rawInString = true;
      this.raw += c;
      return "";
    }
    if (c === "{" || c === "[") {
      this.depth++;
      this.raw += c;
      return "";
    }
    if (c === "}" || c === "]") {
      if (this.depth === 0) return this.closeRaw() ? null : "";
      this.depth--;
      this.raw += c;
      if (this.depth === 0) this.closeRaw();
      return "";
    }
    if (this.depth === 0 && (c === "," || isSpace(c))) return this.closeRaw() ? null : "";
    this.raw += c;
    return "";
  }

  /** Parses the collected raw value. Returns false on malformed input. */
  private closeRaw(): boolean {
    try {
      this.completed[this.key] = JSON.parse(this.raw);
      this.mode = "after_value";
      return true;
    } catch {
      this.mode = "error";
      return false;
    }
  }
}

function isSpace(c: string): boolean {
  return c === " " || c === "\n" || c === "\r" || c === "\t";
}

function parseJsonString(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(`"${raw}"`);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Replaces lone surrogates with U+FFFD (same rule the stream applies). */
export function wellFormed(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] as string;
        out += s[i + 1] as string;
        i++;
      } else out += REPLACEMENT;
    } else if (code >= 0xdc00 && code <= 0xdfff) out += REPLACEMENT;
    else out += s[i] as string;
  }
  return out;
}
