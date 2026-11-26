import { assert, assertEquals } from "jsr:@std/assert@1";
import { fitReferences, normaliseMessageId, parseThreadHeaderArgs } from "./thread-headers.ts";
import { buildMimeMessage } from "./mime-build.ts";
import { heldSendSnapshot } from "./signature-compose.ts";

Deno.test("no threading args leaves a send untouched", () => {
  assertEquals(parseThreadHeaderArgs({}), { ok: true });
  assertEquals(parseThreadHeaderArgs({ in_reply_to: null, references: [] }), { ok: true });
});

Deno.test("in_reply_to alone becomes the whole References chain", () => {
  assertEquals(parseThreadHeaderArgs({ in_reply_to: "<a1@mail.example.com>" }), {
    ok: true,
    inReplyTo: "<a1@mail.example.com>",
    references: "<a1@mail.example.com>",
  });
});

Deno.test("angle brackets are optional and whitespace is trimmed", () => {
  assertEquals(normaliseMessageId("  a1@x.y "), "<a1@x.y>");
  assertEquals(normaliseMessageId("<CAF=x/y$z+1@mail.gmail.com>"), "<CAF=x/y$z+1@mail.gmail.com>");
});

Deno.test("in_reply_to is appended to references when the chain does not end with it", () => {
  const r = parseThreadHeaderArgs({ in_reply_to: "<c@x>", references: ["<a@x>", "b@x"] });
  assertEquals(r, { ok: true, inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>" });
  const same = parseThreadHeaderArgs({ in_reply_to: "<b@x>", references: ["<a@x>", "<b@x>"] });
  assertEquals(same, { ok: true, inReplyTo: "<b@x>", references: "<a@x> <b@x>" });
});

Deno.test("references alone replies to its last id", () => {
  assertEquals(parseThreadHeaderArgs({ references: ["<a@x>", "<b@x>"] }), {
    ok: true,
    inReplyTo: "<b@x>",
    references: "<a@x> <b@x>",
  });
});

Deno.test("a raw References header string is split", () => {
  assertEquals(parseThreadHeaderArgs({ in_reply_to: "<b@x>", references: "<a@x>\r\n <b@x>" }), {
    ok: true,
    inReplyTo: "<b@x>",
    references: "<a@x> <b@x>",
  });
});

Deno.test("header injection and malformed ids are refused", () => {
  for (
    const bad of [
      "<a@x>\r\nBcc: victim@example.com",
      "a@x b@y",
      "no-at-sign",
      "<a@x",
      "a<b@x",
      "a@x>y",
      "@x",
      "a@",
      "x".repeat(300) + "@y",
    ]
  ) {
    const r = parseThreadHeaderArgs({ in_reply_to: bad });
    assert(!r.ok, `accepted ${JSON.stringify(bad)}`);
    const refs = parseThreadHeaderArgs({ references: ["<ok@x>", bad] });
    assert(!refs.ok, `accepted in references ${JSON.stringify(bad)}`);
  }
  assert(!parseThreadHeaderArgs({ in_reply_to: 42 }).ok);
  assert(!parseThreadHeaderArgs({ references: [1] }).ok);
  assert(!parseThreadHeaderArgs({ references: Array.from({ length: 101 }, (_, i) => `<m${i}@x>`) }).ok);
});

Deno.test("a long chain keeps the root and the newest ids within one header line", () => {
  const chain = Array.from({ length: 60 }, (_, i) => `<message-${String(i).padStart(3, "0")}-abcdefgh@mail.example.com>`);
  const fit = fitReferences(chain);
  assertEquals(fit[0], chain[0]);
  assertEquals(fit[fit.length - 1], chain[chain.length - 1]);
  assert(fit.join(" ").length <= 980);
  assert(fit.length < chain.length);
  const r = parseThreadHeaderArgs({ in_reply_to: chain[59], references: chain.slice(0, 59) });
  assert(r.ok && r.references!.length <= 980);
});

Deno.test("the MIME carries exactly the parsed headers", () => {
  const r = parseThreadHeaderArgs({ in_reply_to: "<b@x>", references: ["<a@x>"] });
  assert(r.ok);
  const mime = buildMimeMessage({
    from: "me@example.com",
    to: ["you@example.com"],
    subject: "Re: hi",
    textBody: "hello",
    attachments: [],
    messageId: "m1",
    inReplyTo: r.inReplyTo,
    references: r.references,
  });
  assert(mime.includes("\r\nIn-Reply-To: <b@x>\r\n"));
  assert(mime.includes("\r\nReferences: <a@x> <b@x>\r\n"));
});

Deno.test("a held send keeps its threading headers for the approved re-run", () => {
  const snap = heldSendSnapshot({
    inbox_id: "i",
    to: ["you@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: hi",
    textBody: "hello",
    attachments: [],
    inReplyTo: "<b@x>",
    references: "<a@x> <b@x>",
  });
  assertEquals(snap["in_reply_to"], "<b@x>");
  assertEquals(snap["references"], ["<a@x>", "<b@x>"]);
  // The re-run parses the snapshot back to the same headers.
  assertEquals(parseThreadHeaderArgs(snap), { ok: true, inReplyTo: "<b@x>", references: "<a@x> <b@x>" });
  const plain = heldSendSnapshot({ inbox_id: "i", to: [], cc: [], bcc: [], subject: "s", textBody: "b", attachments: [] });
  assert(!("in_reply_to" in plain) && !("references" in plain));
});
