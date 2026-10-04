// ---------------------------------------------------------------------------
// read-joined-body.test.ts — a forwarded message reads back with its original.
//
// Until 2026-10-04 `email_read` returned the FIRST text/plain part of a message
// and dropped the rest. A forward (the one forward-relay.ts builds, and the one
// most mail clients build when the original has attachments) is a
// multipart/mixed whose first inline text part is the note and whose second is
// the original, so the read returned the note and none of the original.
//
// Two layers are pinned here:
//
//   * the parser (`parseEmailJoined`, mime.ts): which parts are joined, in what
//     order, and that every message with ONE displayed part parses exactly as
//     `parseEmail` parses it;
//   * the tools: the real `email_read` and `email_read_batch` executors, against
//     the scripted IMAP server (imap-fake-server.ts) and the fake Gmail API
//     (provider-call-harness.ts). The only thing replaced on the IMAP side is
//     `ImapClient.connect`, which hands back a client wired to the fake.
//
// Every address, subject and body is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  API_KEY,
  b64url,
  encryptToken,
  executeReadEmail,
  executeReadEmails,
  gmailFull,
  inboxRow,
  INBOX_ID,
  json,
  type ProviderHandler,
  runTool,
} from "./provider-call-harness.ts";
import { buildRelayForwardMime, composeIntroText, summarizeOriginal } from "./forward-relay.ts";
import { ImapClient } from "./imap-client.ts";
import { type FakeMessage, FakeImapServer, fakeMessageWithAttachment, fakeTextMessage } from "./imap-fake-server.ts";
import { parseEmail, parseEmailJoined } from "./mime.ts";
import { stripHtmlToText } from "./text-extract.ts";

const CRLF = "\r\n";
const toText = (html: string) => stripHtmlToText(html, { keepLinks: true });

// ── fixtures ────────────────────────────────────────────────────────────────

function message(uid: number, headers: string[], body: string): FakeMessage {
  return {
    uid,
    flags: [],
    raw: [
      "Date: 01 Sep 2026 10:00:00 +0000",
      'From: "Sender" <sender@example.com>',
      "To: <owner@example.com>",
      `Subject: Fixture ${uid}`,
      `Message-ID: <fixture${uid}@example.com>`,
      "MIME-Version: 1.0",
      ...headers,
      "",
      body,
    ].join(CRLF),
  };
}

function multipart(boundary: string, parts: string[][]): string {
  return parts.map((p) => [`--${boundary}`, ...p].join(CRLF)).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
}

const octets = (raw: string) => Uint8Array.from(raw, (c) => c.charCodeAt(0));
const single = (bytes: Uint8Array) => String.fromCharCode(...bytes);

const NOTE = "FYI, see below.";
const ORIGINAL_TEXT = "The original paragraph that must survive a forward.";

/** What email_forward sends: forward-relay.ts, with the intro it composes. */
function relayForward(uid: number, original: FakeMessage, asAttachment = false): FakeMessage {
  const headerBlock = original.raw.slice(0, original.raw.indexOf("\r\n\r\n"));
  const built = buildRelayForwardMime({
    from: "Owner <owner@example.com>",
    to: ["third@example.com"],
    subject: "Fwd: Fixture",
    messageId: "00000000-0000-4000-8000-000000000001",
    introText: composeIntroText(NOTE, summarizeOriginal(headerBlock)),
    original: octets(original.raw),
    includeAttachments: true,
    asAttachment,
  });
  return { uid, flags: [], raw: single(built.bytes) };
}

const PLAIN_ORIGINAL = message(1, ["Content-Type: text/plain; charset=utf-8"], ORIGINAL_TEXT);

const FORWARDED_BLOCK = [
  "---------- Forwarded message ----------",
  'From: "Sender" <sender@example.com>',
  "Date: 01 Sep 2026 10:00:00 +0000",
  "Subject: Fixture 1",
  "To: <owner@example.com>",
].join("\n");

const FORWARD_BODY = `${NOTE}\n\n${FORWARDED_BLOCK}\n\n${ORIGINAL_TEXT}`;

const ALTERNATIVE = multipart("alt", [
  ["Content-Type: text/plain; charset=utf-8", "", "plain form"],
  ["Content-Type: text/html; charset=utf-8", "", "<p>html <b>form</b></p>"],
]);

/** An original with both forms and a file: mixed[ alternative[plain, html], pdf ]. */
const RICH_ORIGINAL = message(2, ['Content-Type: multipart/mixed; boundary="mix"'], multipart("mix", [
  ['Content-Type: multipart/alternative; boundary="alt"', "", ALTERNATIVE],
  [
    'Content-Type: application/pdf; name="report.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="report.pdf"',
    "",
    btoa("%PDF-invented"),
  ],
]));

// ── 1. the parser ───────────────────────────────────────────────────────────

Deno.test("parser: a relay-built forward reads back as note, forwarded block, original, in that order", () => {
  const forwarded = relayForward(9, PLAIN_ORIGINAL);
  assertEquals(parseEmail(forwarded.raw).text, `${NOTE}\n\n${FORWARDED_BLOCK}\n`, "first-part-wins dropped the original");
  const joined = parseEmailJoined(forwarded.raw, toText);
  assertEquals(joined.text, FORWARD_BODY);
  assertEquals(joined.html, null, "no part had HTML, so there is still no body_html");
  assertEquals(joined.attachments, []);
});

Deno.test("parser: multipart/alternative inside multipart/mixed contributes its plain form once, never both", () => {
  const joined = parseEmailJoined(relayForward(9, RICH_ORIGINAL).raw, toText);
  assertEquals(joined.text, `${NOTE}\n\n${FORWARDED_BLOCK.replace("Fixture 1", "Fixture 2")}\n\nplain form`);
  assert(!joined.text!.includes("html form"), "the HTML alternative is not appended as text");
  // body_html: the note (which had no HTML form) escaped, then the original's HTML.
  assert(joined.html!.includes("FYI, see below.") && joined.html!.endsWith("<p>html <b>form</b></p>"), joined.html!);
  assert(joined.html!.indexOf("FYI") < joined.html!.indexOf("<p>html"), "in document order");
  assert(joined.html!.includes("&lt;sender@example.com&gt;"), "text shown as HTML is escaped");
  assertEquals(joined.attachments.map((a) => [a.filename, a.mimeType]), [["report.pdf", "application/pdf"]]);
});

Deno.test("parser: a text/plain ATTACHMENT is never joined into the body", () => {
  const raw = message(3, ['Content-Type: multipart/mixed; boundary="mix"'], multipart("mix", [
    ["Content-Type: text/plain; charset=utf-8", "", "The body."],
    ["Content-Type: text/plain; charset=utf-8", "Content-Disposition: attachment", "", "ATTACHED NOTES"],
    ['Content-Type: text/plain; charset=utf-8; name="log.txt"', "", "NAMED LOG"],
    ["Content-Type: text/plain; charset=utf-8", 'Content-Disposition: inline; filename="inline.txt"', "", "FILENAMED"],
    ["Content-Type: text/plain; charset=utf-8", "Content-Disposition: inline", "", "A second inline part."],
  ])).raw;
  const joined = parseEmailJoined(raw, toText);
  assertEquals(joined.text, "The body.\n\nA second inline part.");
  assertEquals(joined.attachments.map((a) => a.filename), ["attachment", "log.txt", "inline.txt"]);
  assertEquals(joined.attachments, parseEmail(raw).attachments, "the attachment list is the one parseEmail builds");
});

Deno.test("parser: an inline message/rfc822 is shown under a header block; its files and an attached .eml are attachments", () => {
  const embedded = [
    "From: Original Author <author@example.com>",
    "To: Owner <owner@example.com>",
    "Date: 30 Aug 2026 08:00:00 +0000",
    "Subject: =?UTF-8?B?QsOmcg==?= report",
    'Content-Type: multipart/mixed; boundary="in"',
    "",
    multipart("in", [
      ["Content-Type: text/plain; charset=utf-8", "", "Embedded text."],
      ['Content-Type: text/csv; name="data.csv"', "Content-Disposition: attachment", "", "a,b"],
    ]),
  ].join(CRLF);
  const raw = message(4, ['Content-Type: multipart/mixed; boundary="mix"'], multipart("mix", [
    ["Content-Type: text/plain; charset=utf-8", "", "See the message below."],
    ["Content-Type: message/rfc822", "Content-Disposition: inline", "", embedded],
    ['Content-Type: message/rfc822; name="other.eml"', 'Content-Disposition: attachment; filename="other.eml"', "", embedded],
  ])).raw;
  const joined = parseEmailJoined(raw, toText);
  assertEquals(
    joined.text,
    [
      "See the message below.",
      "",
      "---------- Forwarded message ----------",
      "From: Original Author <author@example.com>",
      "Date: 30 Aug 2026 08:00:00 +0000",
      "Subject: Bær report",
      "To: Owner <owner@example.com>",
      "",
      "Embedded text.",
    ].join("\n"),
  );
  // The embedded message's file comes AFTER the message's own attachment even
  // though it is earlier in the document: index 0 is still other.eml, as it was
  // when embedded messages were not read at all.
  assertEquals(joined.attachments.map((a) => [a.filename, a.mimeType]), [
    ["other.eml", "message/rfc822"],
    ["data.csv", "text/csv"],
  ]);
  const before = parseEmail(raw).attachments;
  assertEquals(before.map((a) => a.filename), ["other.eml"]);
  assertEquals(joined.attachments.slice(0, before.length), before, "every existing attachment index names the same file");
  assertEquals(joined.text!.split("Embedded text.").length - 1, 1, "the attached .eml is not read into the body");

  // The forward as_attachment builds: note first, the original as an attached .eml.
  const asEml = parseEmailJoined(relayForward(9, PLAIN_ORIGINAL, true).raw, toText);
  assertEquals(asEml.text, `${NOTE}\n\n${FORWARDED_BLOCK}\n`);
  assertEquals(asEml.attachments.map((a) => a.mimeType), ["message/rfc822"]);
});

Deno.test("parser: an HTML-only inline part is joined through the HTML-to-text path, and body_html joins too", () => {
  const raw = message(5, ['Content-Type: multipart/mixed; boundary="mix"'], multipart("mix", [
    ["Content-Type: text/html; charset=utf-8", "", '<p>First <a href="https://example.com/a">link</a></p>'],
    ["Content-Type: image/png", "Content-ID: <img1>", "Content-Transfer-Encoding: base64", "", btoa("png")],
    ["Content-Type: text/html; charset=utf-8", "", "<p>Second</p>"],
  ])).raw;
  const joined = parseEmailJoined(raw, toText);
  assertEquals(joined.text, "First link (https://example.com/a)\n\nSecond");
  assertEquals(joined.html, '<p>First <a href="https://example.com/a">link</a></p>\n<p>Second</p>');
});

Deno.test("parser: every message with ONE displayed part parses exactly as parseEmail parses it", () => {
  const utf8 = single(new TextEncoder().encode("Blåbær – “quoted”"));
  const fixtures: FakeMessage[] = [
    fakeTextMessage(1),
    fakeTextMessage(2, { body: "line one\r\n\r\nline two\r\n" }),
    message(3, [], "no content-type at all"),
    message(4, ["Content-Type: text/html; charset=utf-8"], "<p>HTML only</p>"),
    message(5, ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"], utf8),
    message(6, ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable"], "Bl=E5b=E6r =\r\nsoft"),
    message(7, ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"], btoa(utf8)),
    message(8, ['Content-Type: multipart/alternative; boundary="alt"'], ALTERNATIVE),
    message(9, ['Content-Type: multipart/alternative; boundary="alt"'], multipart("alt", [
      ["Content-Type: text/plain; charset=utf-8", "", ""],
      ["Content-Type: text/html; charset=utf-8", "", "<p>empty plain part</p>"],
    ])),
    RICH_ORIGINAL,
    fakeMessageWithAttachment(11),
    message(12, ['Content-Type: multipart/related; boundary="rel"'], multipart("rel", [
      ['Content-Type: multipart/alternative; boundary="alt"', "", ALTERNATIVE],
      ["Content-Type: image/png", "Content-ID: <logo>", "Content-Transfer-Encoding: base64", "", btoa("png")],
    ])),
    message(13, ['Content-Type: multipart/alternative; boundary="alt"'], multipart("alt", [
      ["Content-Type: text/plain; charset=utf-8", "", "You are invited."],
      ["Content-Type: text/calendar; charset=utf-8; method=REQUEST", "", "BEGIN:VCALENDAR"],
    ])),
    message(14, ["Content-Type: text/calendar; charset=utf-8"], "BEGIN:VCALENDAR"),
    message(15, ['Content-Type: multipart/mixed; boundary="mix"'], multipart("mix", [
      ['Content-Type: application/pdf; name="only.pdf"', "Content-Transfer-Encoding: base64", "", btoa("pdf")],
    ])),
  ];
  for (const fixture of fixtures) {
    const before = parseEmail(fixture.raw);
    const joined = parseEmailJoined(fixture.raw, toText);
    assertEquals(
      { text: joined.text, html: joined.html, attachments: joined.attachments, headers: [...joined.headers] },
      { text: before.text, html: before.html, attachments: before.attachments, headers: [...before.headers] },
      `uid ${fixture.uid}`,
    );
  }
});

// ── 2. the tools, over IMAP ─────────────────────────────────────────────────

interface ToolOutcome {
  result: { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  logStatus: string;
  logErrorCode: string | null;
}

const noHttp: ProviderHandler = (call) => json({ error: `unexpected ${call.url}` }, 500);

async function imapInbox(): Promise<Record<string, unknown>> {
  return await inboxRow("gmail", {
    provider: "imap",
    email_address: "owner@example.com",
    oauth_access_token: null,
    oauth_refresh_token: null,
    oauth_token_expires_at: null,
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_security: "tls",
    imap_username: "owner@example.com",
    imap_password: await encryptToken("app-password-invented"),
  });
}

/** Run `body` with every IMAP connection answered by a scripted server holding `messages`. */
async function withImap<T>(
  messages: FakeMessage[],
  body: () => Promise<T>,
): Promise<{ value: T; servers: FakeImapServer[] }> {
  const servers: FakeImapServer[] = [];
  const holder = ImapClient as unknown as { connect: (cfg: unknown) => Promise<ImapClient> };
  const realConnect = holder.connect;
  holder.connect = () => {
    const server = new FakeImapServer({ mailboxes: [{ name: "INBOX", messages }] });
    servers.push(server);
    return Promise.resolve(server.client());
  };
  try {
    const { value } = await runTool(await imapInbox(), noHttp, body);
    return { value, servers };
  } finally {
    holder.connect = realConnect;
  }
}

const read = (args: Record<string, unknown>) =>
  executeReadEmail({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>;
const readBatch = (args: Record<string, unknown>) =>
  executeReadEmails({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>;

/** The whole result of reading PLAIN_ORIGINAL, as this server has always returned it. */
const PLAIN_ORIGINAL_RESULT = {
  id: "INBOX:1",
  thread_id: "1",
  from: { name: "Sender", email: "sender@example.com" },
  to: [{ name: "", email: "owner@example.com" }],
  cc: [],
  bcc: [],
  reply_to: null,
  subject: "Fixture 1",
  date: "2026-09-01T10:00:00.000Z",
  body_text: ORIGINAL_TEXT,
  body_html: null,
  attachments: [],
  is_read: false,
  labels: [],
  in_reply_to: null,
  references: [],
};

Deno.test("email_read (imap): a single-part message is byte-identical to before", async () => {
  const { value } = await withImap([PLAIN_ORIGINAL], () => read({ message_id: "INBOX:1" }));
  assert(!value.result.isError, value.result.content[0].text);
  const expected = { ...PLAIN_ORIGINAL_RESULT, untrusted_content: true };
  assertEquals(value.result.structuredContent, expected);
  // The exact serialisation: no new key, no reordered key, no extra byte.
  assertEquals(JSON.stringify(value.result.structuredContent), JSON.stringify(expected));
  assertEquals(value.result.structuredContent!.body_text, parseEmail(PLAIN_ORIGINAL.raw).text);
});

Deno.test("email_read (imap): a forwarded message's body_text holds the note AND the original", async () => {
  const forwarded = relayForward(2, PLAIN_ORIGINAL);
  const { value, servers } = await withImap([PLAIN_ORIGINAL, forwarded], () => read({ message_id: "INBOX:2" }));
  const structured = value.result.structuredContent!;
  assertEquals(structured.body_text, FORWARD_BODY);
  assertEquals(structured.body_html, null);
  assertEquals(structured.attachments, []);
  assertEquals("body_truncated" in structured, false, "a whole body carries no window fields");
  assertEquals(
    servers.flatMap((s) => s.commands).filter((c) => c.includes("FETCH")),
    ["UID FETCH 2 (FLAGS BODY.PEEK[])"],
    "the same single fetch as before",
  );
});

Deno.test("email_read (imap): include_html joins the HTML of a forward too, sanitised", async () => {
  const forwarded = relayForward(3, RICH_ORIGINAL);
  const { value } = await withImap([forwarded], () => read({ message_id: "INBOX:3", include_html: true }));
  const structured = value.result.structuredContent!;
  assertEquals(structured.body_text, `${NOTE}\n\n${FORWARDED_BLOCK.replace("Fixture 1", "Fixture 2")}\n\nplain form`);
  const html = structured.body_html as string;
  assert(html.includes("FYI, see below.") && html.includes("<b>form</b>"), html);
  assert(!html.includes("<script"), html);
  assertEquals(
    (structured.attachments as { filename: string; attachment_index: number }[]).map((a) => [a.attachment_index, a.filename]),
    [[0, "report.pdf"]],
  );
});

Deno.test("email_read (imap): attachment_index is stable; files inside an inline embedded message are appended after the message's own", async () => {
  const embedded = [
    "From: Original Author <author@example.com>",
    "Subject: Inner",
    'Content-Type: multipart/mixed; boundary="in"',
    "",
    multipart("in", [
      ["Content-Type: text/plain; charset=utf-8", "", "Embedded text."],
      ['Content-Type: text/csv; name="inner.csv"', "Content-Disposition: attachment", "", "a,b"],
    ]),
  ].join(CRLF);
  const pdf = (name: string) => [
    `Content-Type: application/pdf; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    btoa(`%PDF-${name}`),
  ];
  // The embedded message sits BETWEEN the message's own two files.
  const nested = message(7, ['Content-Type: multipart/mixed; boundary="mix"'], multipart("mix", [
    ["Content-Type: text/plain; charset=utf-8", "", "Two files and a message."],
    pdf("first.pdf"),
    ["Content-Type: message/rfc822", "", embedded],
    pdf("second.pdf"),
  ]));
  assertEquals(parseEmail(nested.raw).attachments.map((a) => a.filename), ["first.pdf", "second.pdf"], "the indices before this change");

  const { value } = await withImap([nested], () => read({ message_id: "INBOX:7", include_attachments: true }));
  const attachments = value.result.structuredContent!.attachments as { attachment_index: number; filename: string; data: string }[];
  assertEquals(
    attachments.map((a) => [a.attachment_index, a.filename]),
    [[0, "first.pdf"], [1, "second.pdf"], [2, "inner.csv"]],
  );
  assertEquals(atob(attachments[1].data), "%PDF-second.pdf", "index 1 is still second.pdf, bytes and all");
  assertEquals(atob(attachments[2].data), "a,b");
  assert((value.result.structuredContent!.body_text as string).endsWith("Subject: Inner\n\nEmbedded text."));
});

Deno.test("parser: an 8bit body decodes from the reader's exact octets, the same for every caller (no first-party flag)", () => {
  const text = "Ødegård – “hei”";
  // What the socket read yields since the reader became byte-exact: one
  // character per octet.
  const wire = String.fromCharCode(...new TextEncoder().encode(text));
  const raw = message(8, ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"], wire).raw;
  assertEquals(parseEmailJoined(raw, toText).text, text);
  assertEquals(parseEmail(raw).text, text);
});

Deno.test("email_read (imap): truncation and offset paging walk across the join without losing or repeating a character", async () => {
  const forwarded = relayForward(2, PLAIN_ORIGINAL);
  const total = FORWARD_BODY.length;
  // A window that ends inside the forwarded block, well before the original.
  const cut = NOTE.length + 10;
  const { value: first } = await withImap([forwarded], () => read({ message_id: "INBOX:2", body_max_chars: cut }));
  const one = first.result.structuredContent!;
  assertEquals(one.body_text, FORWARD_BODY.slice(0, cut));
  assertEquals(
    [one.body_truncated, one.body_offset, one.body_total_chars, one.body_next_offset],
    [true, 0, total, cut],
  );
  assertEquals(
    one.body_continue,
    `Call email_read action: read with message_id "INBOX:2" and body_offset: ${cut} for the rest.`,
  );

  // Follow body_next_offset to the end, 40 characters at a time.
  let collected = one.body_text as string;
  let next = one.body_next_offset as number | undefined;
  let calls = 0;
  while (next !== undefined) {
    const offset = next;
    const { value } = await withImap([forwarded], () => read({ message_id: "INBOX:2", body_max_chars: 40, body_offset: offset }));
    const page = value.result.structuredContent!;
    assertEquals(page.body_offset, offset);
    assertEquals(page.body_total_chars, total);
    assertEquals(page.body_text, FORWARD_BODY.slice(offset, offset + 40));
    collected += page.body_text as string;
    next = page.body_next_offset as number | undefined;
    if (next === undefined) assertEquals(page.body_truncated, false, "the last window says it is the last");
    else assertEquals(page.body_truncated, true);
    assert(++calls < 20, "paging terminates");
  }
  assertEquals(collected, FORWARD_BODY);
  assert(collected.endsWith(ORIGINAL_TEXT), "the original is reachable by paging");

  // An offset that starts inside the second part.
  const inside = FORWARD_BODY.indexOf(ORIGINAL_TEXT) + 4;
  const { value: tail } = await withImap([forwarded], () => read({ message_id: "INBOX:2", body_offset: inside }));
  assertEquals(tail.result.structuredContent!.body_text, ORIGINAL_TEXT.slice(4));
  assertEquals(
    [tail.result.structuredContent!.body_truncated, tail.result.structuredContent!.body_offset, tail.result.structuredContent!.body_total_chars],
    [false, inside, total],
  );
});

Deno.test("email_read_batch (imap): forwarded and single-part messages together, one connection", async () => {
  const forwarded = relayForward(2, PLAIN_ORIGINAL);
  const { value, servers } = await withImap(
    [PLAIN_ORIGINAL, forwarded],
    () => readBatch({ message_ids: ["INBOX:1", "INBOX:2"] }),
  );
  assert(!value.result.isError, value.result.content[0].text);
  const structured = value.result.structuredContent!;
  const messages = structured.messages as Record<string, unknown>[];
  assertEquals(structured.errors, []);
  assertEquals(messages[0], PLAIN_ORIGINAL_RESULT, "the single-part entry is what it always was");
  assertEquals(messages[1].body_text, FORWARD_BODY);
  assertEquals(servers.length, 1);

  // The per-message cap applies to the joined text and names the single read.
  const { value: capped } = await withImap(
    [PLAIN_ORIGINAL, forwarded],
    () => readBatch({ message_ids: ["INBOX:2"], body_max_chars: 30 }),
  );
  const entry = (capped.result.structuredContent!.messages as Record<string, unknown>[])[0];
  assertEquals(entry.body_text, FORWARD_BODY.slice(0, 30));
  assertEquals([entry.body_truncated, entry.body_total_chars, entry.body_next_offset], [true, FORWARD_BODY.length, 30]);
});

// ── 3. the tools, over the Gmail API ────────────────────────────────────────

const GMAIL_HEADERS = [
  { name: "From", value: "A Sender <a@x.example>" },
  { name: "To", value: "owner@gmail-harness.example" },
  { name: "Subject", value: "Fwd: Fixture" },
];
const textPart = (text: string) => ({ mimeType: "text/plain", filename: "", body: { size: text.length, data: b64url(text) } });
const htmlPart = (html: string) => ({ mimeType: "text/html", filename: "", body: { size: html.length, data: b64url(html) } });

function gmailMessage(id: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { id, threadId: `thread-${id}`, labelIds: ["INBOX"], internalDate: "1767225600000", payload: { headers: GMAIL_HEADERS, ...payload } };
}

const GMAIL_STORE: Record<string, Record<string, unknown>> = {
  // What Gmail returns for a relay-built forward of a plain original.
  fwd: gmailMessage("fwd", {
    mimeType: "multipart/mixed",
    parts: [textPart(`${NOTE}\n\n${FORWARDED_BLOCK}\n`), textPart(ORIGINAL_TEXT)],
  }),
  // The original had both forms and a file; the note is text only.
  rich: gmailMessage("rich", {
    mimeType: "multipart/mixed",
    parts: [
      textPart("The note."),
      {
        mimeType: "multipart/mixed",
        filename: "",
        parts: [
          { mimeType: "multipart/alternative", filename: "", parts: [textPart("plain form"), htmlPart("<p>html <b>form</b></p>")] },
          { mimeType: "application/pdf", filename: "report.pdf", body: { size: 12, attachmentId: "att-1" } },
          { mimeType: "text/plain", filename: "notes.txt", body: { size: 5, attachmentId: "att-2" } },
        ],
      },
    ],
  }),
  // An inline message/rfc822 and an attached one.
  nested: gmailMessage("nested", {
    mimeType: "multipart/mixed",
    parts: [
      textPart("See the message below."),
      {
        mimeType: "message/rfc822",
        filename: "",
        body: { size: 100 },
        parts: [{
          mimeType: "text/plain",
          filename: "",
          headers: [
            { name: "From", value: "Original Author <author@example.com>" },
            { name: "To", value: "Owner <owner@example.com>" },
            { name: "Date", value: "30 Aug 2026 08:00:00 +0000" },
            { name: "Subject", value: "Report" },
          ],
          body: { size: 14, data: b64url("Embedded text.") },
        }],
      },
      {
        mimeType: "message/rfc822",
        filename: "other.eml",
        body: { size: 100, attachmentId: "att-eml" },
        parts: [textPart("ATTACHED MESSAGE TEXT")],
      },
    ],
  }),
  plain: gmailFull({ id: "plain", from: "A Sender <a@x.example>", to: "owner@gmail-harness.example", subject: "Plain", text: "Just text.", html: "<p>Just text.</p>" }),
};

const gmailHandler: ProviderHandler = (call) => {
  const path = new URL(call.url).pathname;
  const id = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  return GMAIL_STORE[id] ? json(GMAIL_STORE[id]) : json({ error: { code: 404 } }, 404);
};

async function gmail<T>(body: () => Promise<T>): Promise<T> {
  return (await runTool(await inboxRow("gmail"), gmailHandler, body)).value;
}

Deno.test("email_read (gmail): the inline text parts of a multipart/mixed are joined; alternatives are not doubled", async () => {
  const fwd = await gmail(() => read({ message_id: "fwd" }));
  assertEquals(fwd.result.structuredContent!.body_text, FORWARD_BODY);
  assertEquals(fwd.result.structuredContent!.body_html, null);

  const rich = await gmail(() => read({ message_id: "rich", include_html: true }));
  const structured = rich.result.structuredContent!;
  assertEquals(structured.body_text, "The note.\n\nplain form");
  assert((structured.body_html as string).includes("The note.") && (structured.body_html as string).includes("<b>form</b>"));
  assertEquals(
    (structured.attachments as { filename: string }[]).map((a) => a.filename),
    ["report.pdf", "notes.txt"],
    "a text/plain attachment stays an attachment",
  );
});

Deno.test("email_read (gmail): an inline message/rfc822 is shown under its header block; an attached one is not read in", async () => {
  const nested = await gmail(() => read({ message_id: "nested" }));
  const structured = nested.result.structuredContent!;
  assertEquals(
    structured.body_text,
    [
      "See the message below.",
      "",
      "---------- Forwarded message ----------",
      "From: Original Author <author@example.com>",
      "Date: 30 Aug 2026 08:00:00 +0000",
      "Subject: Report",
      "To: Owner <owner@example.com>",
      "",
      "Embedded text.",
    ].join("\n"),
  );
  assertEquals((structured.attachments as { filename: string }[]).map((a) => a.filename), ["other.eml"]);
});

Deno.test("email_read / email_read_batch (gmail): an ordinary message is unchanged, and a batch joins and windows the same text", async () => {
  const plain = await gmail(() => read({ message_id: "plain" }));
  assertEquals(plain.result.structuredContent!.body_text, "Just text.");
  assertEquals("body_truncated" in plain.result.structuredContent!, false);

  const batch = await gmail(() => readBatch({ message_ids: ["plain", "fwd"] }));
  const messages = batch.result.structuredContent!.messages as Record<string, unknown>[];
  assertEquals(messages.map((m) => m.body_text), ["Just text.", FORWARD_BODY]);

  const capped = await gmail(() => readBatch({ message_ids: ["fwd"], body_max_chars: 25 }));
  const entry = (capped.result.structuredContent!.messages as Record<string, unknown>[])[0];
  assertEquals(entry.body_text, FORWARD_BODY.slice(0, 25));
  assertEquals([entry.body_truncated, entry.body_total_chars, entry.body_next_offset], [true, FORWARD_BODY.length, 25]);

  const page = await gmail(() => read({ message_id: "fwd", body_offset: 25, body_max_chars: 50_000 }));
  assertEquals(page.result.structuredContent!.body_text, FORWARD_BODY.slice(25));
  assertEquals(page.result.structuredContent!.body_truncated, false);
});
