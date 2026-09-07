// ---------------------------------------------------------------------------
// What production actually returned on 2026-09-07, for eight email_forward
// calls with `include_attachments: true` against the same IMAP inbox:
//
//   An error occurred while forwarding the message via imap. The message may
//   or may not have been delivered. Do not retry automatically to avoid
//   duplicate delivery.
//
//   delivery_status: "unknown"
//
// All eight failed while fetching the original's attachment bytes, which runs
// before the message is composed and long before it is transmitted. The client
// honoured the advice, did not retry, and reconciled against Sent instead:
//
//   email_read action:search include_folders:["sent"] to:"bilag.fiken.no" ...
//   → total: 0
//
// Nothing had been sent, in any of the eight. The classification was not wrong
// by accident - it was wrong by default, because the pre-transmission stages
// were not enumerated and everything that threw from them fell through to the
// generic provider branch.
//
// These tests pin the inversion: the stages are named, anything thrown from
// inside one is not-sent whatever its shape, the sentinel strings the handlers
// dispatch on survive being classified, and neither pre-transmission sentence
// may ever acquire the ambiguity wording that caused this.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  asPreTransmissionError,
  DELIVERY_STATUS_NOT_SENT,
  DELIVERY_STATUS_UNKNOWN,
  MessageBuildError,
  PreTransmissionError,
  preTransmission,
  preTransmissionMessage,
  preTransmissionSync,
  TargetUnresolvedError,
} from "./send-stages.ts";
import { targetUnresolvedMessage } from "./message-id-errors.ts";
import {
  collectForwardAttachments,
  ForwardAttachmentError,
} from "./forward-attachments.ts";

Deno.test("a forward that dies fetching attachment bytes is a source failure", async () => {
  // The 2026-09-07 shape: readImapMessage throws part-way through the
  // attachment fetch, which is stage "source" - the original and its bytes are
  // the thing being read.
  const err = await preTransmission("source", () => {
    throw new Error("IMAP fetch failed: connection reset while reading part 2");
  }).then(() => null, (e: unknown) => e);

  assert(err instanceof TargetUnresolvedError, "classified as target-unresolved");
  assert(err instanceof PreTransmissionError, "and so answers the base question");
  assertEquals((err as PreTransmissionError).stage, "source");
});

Deno.test("a failure assembling the MIME is a compose failure, not an unknown", async () => {
  const err = await preTransmission("compose", () => {
    throw new Error("base64 encode failed: invalid character in attachment data");
  }).then(() => null, (e: unknown) => e);

  assert(err instanceof MessageBuildError, "classified as message-build");
  assert(err instanceof PreTransmissionError);
  assertEquals((err as PreTransmissionError).stage, "compose");
});

Deno.test("a stage classifies whatever it throws, including non-Errors", async () => {
  // The point of wrapping the stage rather than the call: a throw site added
  // inside it later inherits not-sent without anyone remembering to. That has
  // to hold for values that are not Errors at all, which is how a stringified
  // provider payload or a rejected promise arrives.
  for (const thrown of ["boom", 42, null, undefined, { code: 7 }]) {
    const err = await preTransmission("compose", () => {
      throw thrown;
    }).then(() => null, (e: unknown) => e);
    assert(
      err instanceof PreTransmissionError,
      `${String(thrown)} must still be pre-transmission`,
    );
  }
});

Deno.test("a stage that succeeds is left completely alone", async () => {
  assertEquals(await preTransmission("compose", () => "mime"), "mime");
  assertEquals(await preTransmission("source", () => Promise.resolve(7)), 7);
  assertEquals(preTransmissionSync("compose", () => ["a"]), ["a"]);
});

Deno.test("the sync form classifies the same way", () => {
  let caught: unknown = null;
  try {
    preTransmissionSync("source", () => {
      throw new Error("decodeImapId: malformed id");
    });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof TargetUnresolvedError);
});

Deno.test("the sentinel strings the handlers dispatch on survive classification", () => {
  // index.ts checks these by string equality BEFORE it looks at error classes,
  // and each already has an honest, non-ambiguous result of its own. Rewriting
  // any of them here would silently route a clean "message not found" into the
  // pre-transmission branch's generic wording - a different regression with the
  // same shape as the one this module fixes.
  for (
    const sentinel of [
      "message_not_found",
      "draft_not_found",
      "draft_has_no_recipients",
      "gmail_auth_failed",
      "outlook_auth_failed",
      "fastmail_auth_failed",
      "imap_auth_failed",
      "quota_exceeded",
      "email_reply: the source message carries no From, To or Cc address, so " +
      "there is no reply recipient to derive from it. Send a new message with " +
      "an explicit recipient instead.",
    ]
  ) {
    const classified = asPreTransmissionError("compose", new Error(sentinel));
    assertEquals(classified.message, sentinel, sentinel);
  }
});

Deno.test("an already-classified error keeps its own stage", () => {
  // A provider path that throws TargetUnresolvedError from deep inside its read
  // (the Gmail and Outlook reply paths both do) must not be relabelled
  // "compose" by whichever wrapper happens to be outermost.
  const inner = new TargetUnresolvedError("Gmail API error fetching original: quota");
  assertEquals(asPreTransmissionError("compose", inner), inner);
  assertEquals(asPreTransmissionError("compose", inner).stage, "source");
});

Deno.test("the cause is kept for the log line, not the sentence", () => {
  const original = new Error("connection reset");
  const classified = asPreTransmissionError("source", original);
  assertEquals(classified.cause, original);
});

Deno.test("both pre-transmission sentences say nothing was sent and a retry is safe", () => {
  const source = preTransmissionMessage("email_forward", "imap", "source", "connection reset");
  const compose = preTransmissionMessage("email_forward", "imap", "compose", "encode failed");

  for (const message of [source, compose]) {
    // The fact that matters most, stated without hedging.
    assertStringIncludes(message, "nothing was sent");
    assertStringIncludes(message, "no delivery");
    assertStringIncludes(message, "no copy in");
    // The action that follows from it, which is the opposite of the old advice.
    assertStringIncludes(message, "Retrying is safe");
    // The provider and its own words, the only clue distinguishing the causes.
    assertStringIncludes(message, "imap");

    // And crucially: none of the ambiguity wording survives. Those sentences
    // are reserved for a request that reached the send endpoint and then
    // failed, and this is what the eight forwards were wrongly told.
    assert(
      !message.includes("may or may not"),
      `ambiguous wording must not appear: ${message}`,
    );
    assert(
      !message.includes("Do not retry"),
      `do-not-retry advice must not appear: ${message}`,
    );
    assert(
      !message.includes("Check your Sent folder"),
      `no reconciliation errand for a message that was never built: ${message}`,
    );
  }

  assertStringIncludes(source, "connection reset");
  assertStringIncludes(compose, "encode failed");
});

Deno.test("the source sentence is the one message-id-errors already pinned", () => {
  // Not a paraphrase of it. An attachment read and an original read fail the
  // same way and have the same remedy, and a caller should not have to learn a
  // second vocabulary depending on which byte of the message was unreadable.
  assertEquals(
    preTransmissionMessage("email_forward", "gmail", "source", "Rate limit exceeded"),
    targetUnresolvedMessage("email_forward", "gmail", "Rate limit exceeded"),
  );
});

Deno.test("the compose sentence names the stage it actually failed at", () => {
  // "could not read the message it was asked to act on" would be a lie about a
  // MIME encoder, which is the only reason this is a second sentence at all.
  const compose = preTransmissionMessage("email_send", "gmail", "compose", "out of memory");
  assertStringIncludes(compose, "building the message");
  assert(
    !compose.includes("could not read the message it was asked to act on"),
    `compose must not borrow the source wording: ${compose}`,
  );
});

Deno.test("a forward attachment refusal keeps its own type through the wrapper", () => {
  // forward-attachments.ts refuses to send a forward whose attachment bytes it
  // could not carry, and email_forward has a branch that names the file and the
  // limit. That branch is `instanceof ForwardAttachmentError`, so the compose
  // wrapper must not reclassify it on the way out - which it does not, because
  // ForwardAttachmentError IS a PreTransmissionError.
  let caught: unknown = null;
  try {
    preTransmissionSync("compose", () =>
      collectForwardAttachments(
        [{ filename: "invoice.pdf", mime_type: "application/pdf", size_bytes: 99, data: null }],
        true,
      ));
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof ForwardAttachmentError, "specific branch still fires");
  assert(caught instanceof PreTransmissionError, "and the not-sent guarantee holds");
  assertEquals((caught as ForwardAttachmentError).filename, "invoice.pdf");
});

Deno.test("no pre-transmission failure is ever told to try again in a moment", () => {
  // The mirror of message-id-errors.test.ts's last test. "Please try again in a
  // moment" is retry advice for a transient condition; a message that could not
  // be built is usually not one, and an agent will follow that advice until its
  // quota is gone.
  for (const stage of ["source", "compose"] as const) {
    const message = preTransmissionMessage("email_forward", "imap", stage, "x");
    assert(
      !message.includes("try again in a moment"),
      `must not invite a retry loop: ${message}`,
    );
  }
});

Deno.test("the two delivery statuses are the wire values, unchanged", () => {
  // Pinned as literals because they are read outside this codebase: an agent
  // branches on them, and "unknown" is the one already documented as carrying
  // the do-not-retry warning. Renaming either is a breaking change, not a
  // refactor. (That they cannot be equal is enforced by the type system - the
  // constants are `const`, so TypeScript rejects a comparison between them.)
  assertEquals(DELIVERY_STATUS_NOT_SENT, "not_sent");
  assertEquals(DELIVERY_STATUS_UNKNOWN, "unknown");
});
