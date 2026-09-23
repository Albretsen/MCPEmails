import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  chooseImapPasswordMechanism,
  cramMd5Response,
  hmacMd5,
  imapLoginArgument,
  md5,
  parseImapCapabilities,
  redactImapAuthText,
} from "./imap-auth.ts";
import { ImapClient } from "./imap-client.ts";

const UTF8 = new TextEncoder();
const LATIN1 = new TextDecoder("latin1");

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -- MD5 / HMAC-MD5 / CRAM-MD5 vectors -----------------------------------------

Deno.test("md5 matches the RFC 1321 test suite", () => {
  const suite: Array<[string, string]> = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ];
  for (const [input, expected] of suite) assertEquals(hex(md5(UTF8.encode(input))), expected, input);
});

Deno.test("hmacMd5 matches the RFC 2104 vectors, including a key longer than a block", () => {
  assertEquals(
    hex(hmacMd5(new Uint8Array(16).fill(0x0b), UTF8.encode("Hi There"))),
    "9294727a3638bb1c13f48ef8158bfc9d",
  );
  assertEquals(
    hex(hmacMd5(UTF8.encode("Jefe"), UTF8.encode("what do ya want for nothing?"))),
    "750c783e6ab0b503eaa86e310a5db738",
  );
  // RFC 2202 test case 6: an 80-byte key is hashed down first.
  assertEquals(
    hex(hmacMd5(
      new Uint8Array(80).fill(0xaa),
      UTF8.encode("Test Using Larger Than Block-Size Key - Hash Key First"),
    )),
    "6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd",
  );
});

Deno.test("cramMd5Response reproduces the RFC 2195 example exchange", () => {
  // S: + PDE4OTYuNjk3MTcwOTUyQHBvc3RvZmZpY2UucmVzdG9uLm1jaS5uZXQ+
  // C: dGltIGI5MTNhNjAyYzdlZGE3YTQ5NWI0ZTZlNzMzNGQzODkw
  const challenge = "+ PDE4OTYuNjk3MTcwOTUyQHBvc3RvZmZpY2UucmVzdG9uLm1jaS5uZXQ+";
  const response = cramMd5Response("tim", "tanstaaftanstaaf", challenge);
  assertEquals(response, "dGltIGI5MTNhNjAyYzdlZGE3YTQ5NWI0ZTZlNzMzNGQzODkw");
  assertEquals(atob(response), "tim b913a602c7eda7a495b4e6e7334d3890");
  // The bare form of the continuation ("+<b64>" with no space) reads the same.
  assertEquals(
    cramMd5Response("tim", "tanstaaftanstaaf", challenge.replace("+ ", "+")),
    response,
  );
  assert(!atob(response).includes("tanstaaf"), "the password must never be in the response");
});

// -- Capability parsing and mechanism choice -----------------------------------

const EARTHLINK_CAPS =
  "* CAPABILITY IMAP4 IMAP4rev1 QUOTA LITERAL+ UIDPLUS NO_ATOMIC_RENAME UNSELECT SORT X-Move X-Count THREAD=ORDEREDSUBJECT THREAD=REFERENCES AUTH=CRAM-MD5 AUTH=EL-TAC AUTH=EL-VOICE STARTTLS ID CHILDREN";

Deno.test("parseImapCapabilities reads untagged lines and [CAPABILITY] codes, and says when there is none", () => {
  const earthlink = parseImapCapabilities([EARTHLINK_CAPS]);
  assert(earthlink?.has("AUTH=CRAM-MD5"));
  assert(earthlink?.has("X-MOVE"), "upper-cased");
  const greeting = parseImapCapabilities([
    "* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=LOGIN] Dovecot ready.",
  ]);
  assert(greeting?.has("AUTH=PLAIN"));
  assertEquals(parseImapCapabilities(["* OK earthlink.net IMAP Service ready"]), null);
  assertEquals(parseImapCapabilities([]), null);
});

Deno.test("chooseImapPasswordMechanism keeps PLAIN wherever it is today's behaviour", () => {
  const choose = (line: string | null) =>
    chooseImapPasswordMechanism(line === null ? null : parseImapCapabilities([line]));
  // Nothing known.
  assertEquals(choose(null), "PLAIN");
  // Mechanisms not listed at all (sina, t-online, most self-hosted presets).
  assertEquals(choose("* CAPABILITY IMAP4rev1 ID"), "PLAIN");
  // PLAIN advertised (Yandex, iCloud, Fastmail, Dovecot...), with or without others.
  assertEquals(choose("* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2"), "PLAIN");
  assertEquals(choose("* CAPABILITY IMAP4rev1 AUTH=CRAM-MD5 AUTH=PLAIN AUTH=LOGIN"), "PLAIN");
});

Deno.test("chooseImapPasswordMechanism uses LOGIN where PLAIN was never going to work", () => {
  const choose = (line: string) => chooseImapPasswordMechanism(parseImapCapabilities([line]));
  assertEquals(choose(EARTHLINK_CAPS), "LOGIN", "EarthLink");
  assertEquals(choose("* CAPABILITY IMAP4REV1 LITERAL+ SASL-IR AUTH=LOGIN ID"), "LOGIN", "online.no");
  assertEquals(choose("* CAPABILITY IMAP4rev1 XLIST SASL-IR AUTH=XOAUTH2"), "LOGIN", "163.com");
  assertEquals(choose("* CAPABILITY IMAP4rev1 AUTH=XOAUTH AUTH=XOAUTH2 AUTH=EXTERNAL"), "LOGIN", "aliyun");
});

Deno.test("chooseImapPasswordMechanism falls to CRAM-MD5 only when LOGIN is disabled", () => {
  const choose = (line: string) => chooseImapPasswordMechanism(parseImapCapabilities([line]));
  assertEquals(choose("* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=CRAM-MD5"), "CRAM-MD5");
  // Nothing we can do: keep the old behaviour so the server's own answer is what surfaces.
  assertEquals(choose("* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=GSSAPI"), "PLAIN");
});

Deno.test("imapLoginArgument quotes printable ASCII and sends anything else as a literal", () => {
  assertEquals(imapLoginArgument("user@earthlink.net"), { kind: "quoted", text: '"user@earthlink.net"' });
  assertEquals(imapLoginArgument('pa"ss\\word'), { kind: "quoted", text: '"pa\\"ss\\\\word"' });
  assertEquals(imapLoginArgument(""), { kind: "quoted", text: '""' });
  const literal = imapLoginArgument("blåbær");
  assertEquals(literal.kind, "literal");
  if (literal.kind === "literal") assertEquals(literal.bytes, UTF8.encode("blåbær"));
  assertEquals(imapLoginArgument("a\r\nb").kind, "literal", "CR/LF can never go in a quoted string");
});

Deno.test("redactImapAuthText strips submitted values and token-shaped runs, keeps the diagnosis", () => {
  const token = btoa("\u0000nobody@centurylink.net\u0000hunter2secret");
  // What CenturyLink's server actually does with an inline PLAIN it rejects.
  const echoed = `BAD AUTHENTICATE extra parameters supplied "${token}"`;
  const out = redactImapAuthText(echoed, ["nobody@centurylink.net", "hunter2secret"]);
  assert(!out.includes(token));
  assertStringIncludes(out, "extra parameters supplied");
  assertEquals(
    redactImapAuthText('LOGIN "me@x.net" "hunter2secret" failed', ["me@x.net", "hunter2secret"]),
    'LOGIN "<redacted>" "<redacted>" failed',
  );
  assertEquals(redactImapAuthText("[AUTHENTICATIONFAILED] Authentication failed", []),
    "[AUTHENTICATIONFAILED] Authentication failed");
});

// -- Drift ---------------------------------------------------------------------

// Touches the filesystem; the suite runs with --allow-read (see utf7-copies.test.ts).
Deno.test("the two copies of the IMAP auth module agree", async () => {
  const ANCHOR = "export type ImapPasswordMechanism =";
  const here = new URL(".", import.meta.url).pathname;
  const files = [`${here}imap-auth.ts`, `${here}../../../apps/web/src/lib/email/imap-auth.ts`];
  const bodies: string[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const at = source.indexOf(ANCHOR);
    assertNotEquals(at, -1, `${file} no longer contains "${ANCHOR}"`);
    bodies.push(source.slice(at));
  }
  assertEquals(
    bodies[0],
    bodies[1],
    "supabase/functions/mcp-server/imap-auth.ts and apps/web/src/lib/email/imap-auth.ts have drifted; make them identical again",
  );
});

// -- Wire transcripts through the real client ----------------------------------

/**
 * A fake server: every chunk the client writes is recorded and handed to
 * `respond`, whose return value (if any) is queued for the client to read.
 */
class ScriptedConn {
  readonly written: string[] = [];
  #inbound: number[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  constructor(private readonly respond: (chunk: string) => string | undefined) {}

  write(p: Uint8Array): Promise<number> {
    const chunk = LATIN1.decode(p);
    this.written.push(chunk);
    const reply = this.respond(chunk);
    if (reply) this.send(reply);
    return Promise.resolve(p.length);
  }
  send(text: string): void {
    for (const b of UTF8.encode(text)) this.#inbound.push(b);
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
  async read(p: Uint8Array): Promise<number | null> {
    while (this.#inbound.length === 0) {
      if (this.#closed) return null;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    const n = Math.min(p.length, this.#inbound.length);
    for (let i = 0; i < n; i++) p[i] = this.#inbound[i];
    this.#inbound.splice(0, n);
    return n;
  }
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }
}

type LoginResult = {
  resp: { status: "OK" | "NO" | "BAD"; text: string };
  sent: string;
  mechanism: string;
};

function loginOn(
  conn: ScriptedConn,
  greeting: string | null,
  username: string,
  password: string,
): Promise<LoginResult> {
  const ctor = ImapClient as unknown as { new (conn: unknown): unknown };
  const client = new ctor(conn) as {
    login(g: string | null, u: string, p: string): Promise<LoginResult>;
  };
  return client.login(greeting, username, password);
}

/** Tag of a command chunk ("A00001 LOGIN ..." -> "A00001"). */
const tagOf = (chunk: string) => chunk.split(" ")[0];

Deno.test("EarthLink: no caps on the greeting, so CAPABILITY is asked, then LOGIN is sent", async () => {
  const conn: ScriptedConn = new ScriptedConn((chunk): string | undefined => {
    if (chunk.endsWith("CAPABILITY\r\n")) return `${EARTHLINK_CAPS}\r\n${tagOf(chunk)} OK Completed\r\n`;
    if (chunk.includes(" LOGIN ")) return `${tagOf(chunk)} OK LOGIN completed\r\n`;
    return `${tagOf(chunk)} BAD unexpected\r\n`;
  });
  const result = await loginOn(
    conn,
    "* OK earthlink.net IMAP Service 24949 imapd EL_0_1_44_OIM_1_P ready",
    "someone@earthlink.net",
    "correct horse",
  );
  assertEquals(result.mechanism, "LOGIN");
  assertEquals(result.resp.status, "OK");
  assertEquals(conn.written.length, 2);
  assertEquals(conn.written[0], `${tagOf(conn.written[0])} CAPABILITY\r\n`);
  assertEquals(
    conn.written[1],
    `${tagOf(conn.written[1])} LOGIN "someone@earthlink.net" "correct horse"\r\n`,
  );
  assert(!conn.written.some((c) => c.includes("AUTHENTICATE")), "no SASL attempt that burns the single try");
});

Deno.test("LOGIN with a non-ASCII password goes as a synchronizing literal", async () => {
  const conn: ScriptedConn = new ScriptedConn((chunk): string | undefined => {
    if (chunk.endsWith("CAPABILITY\r\n")) return `${EARTHLINK_CAPS}\r\n${tagOf(chunk)} OK Completed\r\n`;
    if (/\{\d+\}\r\n$/.test(chunk)) return "+ Ready for literal data\r\n";
    if (chunk === "\r\n") return `${tagOf(conn.written[1])} OK LOGIN completed\r\n`;
    return undefined;
  });
  const result = await loginOn(conn, null, "someone@earthlink.net", "blåbær");
  assertEquals(result.resp.status, "OK");
  assertEquals(conn.written[1], `${tagOf(conn.written[1])} LOGIN "someone@earthlink.net" {8}\r\n`);
  // The literal is the UTF-8 octets of the password, 8 of them.
  assertEquals(conn.written[2], LATIN1.decode(UTF8.encode("blåbær")));
  assertEquals(conn.written[3], "\r\n");
});

Deno.test("PLAIN on the greeting's caps: no extra round trip, bytes identical to before", async () => {
  const conn = new ScriptedConn((chunk) => `${tagOf(chunk)} OK Logged in\r\n`);
  const result = await loginOn(
    conn,
    "* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=LOGIN] Dovecot ready.",
    "me@example.com",
    "pw",
  );
  assertEquals(result.mechanism, "PLAIN");
  assertEquals(conn.written.length, 1);
  assertEquals(
    conn.written[0],
    `${tagOf(conn.written[0])} AUTHENTICATE PLAIN ${btoa("\u0000me@example.com\u0000pw")}\r\n`,
  );
});

Deno.test("PLAIN when the server lists no mechanisms, and when CAPABILITY is refused", async () => {
  for (const capReply of ["* CAPABILITY IMAP4rev1 ID\r\nTAG OK done\r\n", "TAG BAD what\r\n"]) {
    const conn = new ScriptedConn((chunk) =>
      chunk.endsWith("CAPABILITY\r\n")
        ? capReply.replace("TAG", tagOf(chunk))
        : `${tagOf(chunk)} OK Logged in\r\n`
    );
    const result = await loginOn(conn, "* OK sina imap server ready", "me@sina.com", "pw");
    assertEquals(result.mechanism, "PLAIN", capReply);
    assertEquals(
      conn.written[1],
      `${tagOf(conn.written[1])} AUTHENTICATE PLAIN ${btoa("\u0000me@sina.com\u0000pw")}\r\n`,
    );
  }
});

Deno.test("PLAIN keeps its two-step retry for servers without SASL-IR (Yandex)", async () => {
  const token = btoa("\u0000me@yandex.ru\u0000pw");
  const conn: ScriptedConn = new ScriptedConn((chunk): string | undefined => {
    if (chunk.endsWith("CAPABILITY\r\n")) {
      return `* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2\r\n${tagOf(chunk)} OK done\r\n`;
    }
    if (chunk.endsWith(` AUTHENTICATE PLAIN ${token}\r\n`)) {
      return `${tagOf(chunk)} BAD AUTHENTICATE Command syntax error\r\n`;
    }
    if (chunk.endsWith(" AUTHENTICATE PLAIN\r\n")) return "+\r\n";
    if (chunk === `${token}\r\n`) return `${tagOf(conn.written[2])} OK Authenticated\r\n`;
    return undefined;
  });
  const result = await loginOn(conn, "* OK Yandex IMAP4rev1 ready", "me@yandex.ru", "pw");
  assertEquals(result.resp.status, "OK");
  const [a, b, c] = conn.written.map(tagOf);
  assertEquals(conn.written, [
    `${a} CAPABILITY\r\n`,
    `${b} AUTHENTICATE PLAIN ${token}\r\n`,
    `${c} AUTHENTICATE PLAIN\r\n`,
    `${token}\r\n`,
  ]);
});

Deno.test("CRAM-MD5 against the RFC 2195 transcript when LOGIN is disabled", async () => {
  const conn: ScriptedConn = new ScriptedConn((chunk): string | undefined => {
    if (chunk.endsWith("CAPABILITY\r\n")) {
      return `* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=CRAM-MD5\r\n${tagOf(chunk)} OK done\r\n`;
    }
    if (chunk.endsWith(" AUTHENTICATE CRAM-MD5\r\n")) {
      return "+ PDE4OTYuNjk3MTcwOTUyQHBvc3RvZmZpY2UucmVzdG9uLm1jaS5uZXQ+\r\n";
    }
    const tag = tagOf(conn.written[1]);
    if (chunk === "dGltIGI5MTNhNjAyYzdlZGE3YTQ5NWI0ZTZlNzMzNGQzODkw\r\n") {
      return `${tag} OK CRAM authentication successful\r\n`;
    }
    return `${tag} NO wrong response\r\n`;
  });
  const result = await loginOn(conn, null, "tim", "tanstaaftanstaaf");
  assertEquals(result.mechanism, "CRAM-MD5");
  assertEquals(result.resp.status, "OK");
  assert(!conn.written.join("").includes("tanstaaf"), "the password never goes on the wire");
});

Deno.test("CRAM-MD5 refused at the command surfaces the tagged answer instead of hanging", async () => {
  const conn: ScriptedConn = new ScriptedConn((chunk): string | undefined => {
    if (chunk.endsWith("CAPABILITY\r\n")) {
      return `* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=CRAM-MD5\r\n${tagOf(chunk)} OK done\r\n`;
    }
    return `${tagOf(chunk)} NO Server(s) unavailable to complete operation\r\n`;
  });
  const result = await loginOn(conn, null, "tim", "tanstaaftanstaaf");
  assertEquals(result.resp.status, "NO");
  assertStringIncludes(result.resp.text, "unavailable");
});
