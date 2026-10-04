// ---------------------------------------------------------------------------
// A scripted IMAP wire for tests: the test writes the server's replies octet
// for octet, and sees the client's commands octet for octet.
//
// `imap-fake-server.ts` models a mailbox and builds well-formed replies from
// it. That is the wrong tool for asking "what does the client do with THESE
// bytes": a raw UTF-8 mailbox name, a literal in a LIST reply, a tagged NO in
// Chinese, a reply delivered one octet per socket read. Here nothing is
// modelled. `answer` gets each command and returns the reply as a byte string
// (one character per octet); the wire handles only what a script cannot,
// which is the `+` continuation for a synchronising literal.
//
// Test-only. No real mailbox data is involved.
// ---------------------------------------------------------------------------

export interface ScriptedCommand {
  tag: string;
  /** The command line without its tag; each literal appears as `{n}`. */
  text: string;
  /** The octets of each literal the command carried, in order. */
  literals: Uint8Array[];
}

export interface ScriptedWireOptions {
  /** Most octets one socket read returns. Default: everything available. */
  maxRead?: number;
}

/** A byte string (one character per octet) as bytes. */
export function wireBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new Error(`not a byte string: U+${code.toString(16)} at ${i}`);
    out[i] = code;
  }
  return out;
}

/** Bytes as a byte string, the slow obvious way so it can be trusted. */
export function wireString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Text as its UTF-8 octets, one character per octet. */
export function utf8Wire(text: string): string {
  return wireString(new TextEncoder().encode(text));
}

export class ScriptedWire {
  /** Every command received, in order. */
  readonly commands: ScriptedCommand[] = [];
  /** Every octet the client wrote, in order. */
  readonly written: number[] = [];
  closed = false;

  #inbound: number[] = [];
  #line: number[] = [];
  #literals: Uint8Array[] = [];
  #literalLeft = 0;
  #literal: number[] = [];
  #literalEndedAt = -1;
  readonly #answer: (command: ScriptedCommand) => string;
  readonly #maxRead: number;

  constructor(answer: (command: ScriptedCommand) => string, options: ScriptedWireOptions = {}) {
    this.#answer = answer;
    this.#maxRead = options.maxRead ?? Number.POSITIVE_INFINITY;
  }

  /** A connected, "authenticated" client of the given class on this wire. */
  client<C>(clientClass: unknown): C {
    const ctor = clientClass as { new (conn: unknown): C };
    return new ctor(this.conn());
  }

  conn(): { write(p: Uint8Array): Promise<number>; read(p: Uint8Array): Promise<number | null>; close(): void } {
    return {
      write: (p) => {
        for (const b of p) {
          this.written.push(b);
          this.#take(b);
        }
        return Promise.resolve(p.length);
      },
      read: (p) => {
        if (this.#inbound.length === 0) {
          return this.closed
            ? Promise.resolve(null)
            : Promise.reject(new Error("scripted IMAP wire: the client is waiting for a reply nobody scripted"));
        }
        const n = Math.min(p.length, this.#inbound.length, this.#maxRead);
        for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
        this.#inbound.splice(0, n);
        return Promise.resolve(n);
      },
      close: () => {
        this.closed = true;
      },
    };
  }

  #send(text: string): void {
    for (const b of wireBytes(text)) this.#inbound.push(b);
  }

  #take(b: number): void {
    if (this.#literalLeft > 0) {
      this.#literal.push(b);
      if (--this.#literalLeft === 0) {
        this.#literals.push(Uint8Array.from(this.#literal));
        this.#literal = [];
      }
      return;
    }
    this.#line.push(b);
    const n = this.#line.length;
    if (n < 2 || this.#line[n - 2] !== 0x0d || this.#line[n - 1] !== 0x0a) return;
    const line = wireString(Uint8Array.from(this.#line.slice(0, n - 2)));
    // A `{n}` the line ENDS in announces a literal, unless it is the one whose
    // octets were just read (an APPEND ends right after its literal).
    const literal = n - 2 === this.#literalEndedAt ? null : /\{(\d+)(\+)?\}$/.exec(line);
    if (literal) {
      // Keep the line (with its `{n}`) and read the octets that follow it.
      this.#line = this.#line.slice(0, n - 2);
      this.#literalEndedAt = n - 2;
      this.#literalLeft = Number(literal[1]);
      if (this.#literalLeft === 0) this.#literals.push(new Uint8Array(0));
      if (!literal[2]) this.#send("+ Ready for literal data\r\n");
      return;
    }
    this.#line = [];
    this.#literalEndedAt = -1;
    const space = line.indexOf(" ");
    const command: ScriptedCommand = {
      tag: line.slice(0, space),
      text: line.slice(space + 1),
      literals: this.#literals,
    };
    this.#literals = [];
    this.commands.push(command);
    this.#send(this.#answer(command));
  }
}
