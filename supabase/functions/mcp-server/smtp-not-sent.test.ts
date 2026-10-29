// ---------------------------------------------------------------------------
// Which SMTP rejections are worth trying again.
//
// The retry in sendViaSmtp only ever fires before DATA, so it cannot duplicate
// a message; the only thing it can waste is time. This classifier decides
// which side of that trade a given rejection falls on, and it is the piece
// worth pinning down, because both mistakes are real:
//
//   - Calling an IP-reputation block permanent strands mail that would have
//     gone out on the very next attempt. That is the bug this shipped for.
//   - Calling a dead recipient transient means every message to a mistyped
//     address pays the retry twice over and still fails.
//
// The line drawn is RFC 3463's enhanced status classes: 5.1.x is "bad
// destination address" and repeats forever, everything else may not.
// ---------------------------------------------------------------------------

import { isRecipientAddressRejection, isRetryableEnvelopeRefusal, type SmtpReply } from "./smtp-client.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function reply(code: number, text: string): SmtpReply {
  return { code, text, lines: [text] };
}

Deno.test("an IP-reputation block is retryable", () => {
  // Verbatim from smtp.domeneshop.no on 2026-08-30. Three of these and one
  // success inside five minutes, same inbox, same recipient: the only variable
  // was which egress address the invocation drew.
  const acr04 = reply(
    550,
    "[ACR04] Amazon AWS IP 100.27.38.52 may not use this server. " +
      "Amazon servers should use Amazon SES (https://aws.amazon.com/ses/).",
  );
  assertEquals(isRecipientAddressRejection(acr04), false, "blames our address, not the recipient's");

  // Other shapes of the same verdict: about the sender or the connection.
  assertEquals(
    isRecipientAddressRejection(reply(550, "5.7.1 Service unavailable, client host blocked")),
    false,
    "5.7.x is policy, not a bad address",
  );
  assertEquals(
    isRecipientAddressRejection(reply(451, "4.7.1 Greylisted, try again later")),
    false,
    "greylisting is the definition of retryable",
  );
  assertEquals(
    isRecipientAddressRejection(reply(421, "Too many connections from your IP")),
    false,
    "a bare rate-limit code carries no enhanced status",
  );
});

Deno.test("a bad recipient address is not retryable", () => {
  assertEquals(
    isRecipientAddressRejection(reply(550, "5.1.1 <nobody@example.com>: Recipient address rejected: User unknown")),
    true,
    "no such mailbox repeats on every attempt",
  );
  assertEquals(
    isRecipientAddressRejection(reply(501, "5.1.3 Bad recipient address syntax")),
    true,
    "syntax will not fix itself",
  );
  assertEquals(
    isRecipientAddressRejection(reply(550, "5.1.10 RESOLVER.ADR.RecipientNotFound")),
    true,
    "two-digit subcodes are matched, not truncated to 5.1.1",
  );
});

Deno.test("the sender-address class is not mistaken for the recipient one", () => {
  // 5.2.x (mailbox status: full, disabled) and 5.4.x (network) are about the
  // destination too, but they are states that change, so they stay retryable.
  assertEquals(
    isRecipientAddressRejection(reply(552, "5.2.2 Mailbox full")),
    false,
    "a full mailbox may be emptied",
  );
  // The digits must be an enhanced status, not any occurrence of the numerals.
  assertEquals(
    isRecipientAddressRejection(reply(550, "Message rejected: score 5.1 exceeds threshold")),
    false,
    "a bare decimal in prose is not an enhanced status code",
  );
});

// ---------------------------------------------------------------------------
// Which envelope refusals the caller may try again later (2026-10-29).
//
// A 5xx at MAIL FROM or RCPT TO is permanent, except an origin block that
// blames our egress address. 4xx stays retryable. On 2026-10-28 a provider's
// `550 Outgoing mail from ... blocked` was retried once a minute per row.
// ---------------------------------------------------------------------------

Deno.test("an account-level 550 block is permanent", () => {
  assertEquals(
    isRetryableEnvelopeRefusal(reply(550, "Outgoing mail from sender@example.com blocked")),
    false,
    "the account is blocked from any address",
  );
  assertEquals(
    isRetryableEnvelopeRefusal(reply(550, "5.7.1 <a@b.no>... Command rejected")),
    false,
    "a plain policy refusal repeats",
  );
  assertEquals(isRetryableEnvelopeRefusal(reply(552, "5.2.2 Mailbox full")), false, "552 is permanent");
  assertEquals(
    isRetryableEnvelopeRefusal(reply(550, "5.1.1 User unknown")),
    false,
    "a bad address stays permanent",
  );
});

Deno.test("a 550 that blames our egress address stays retryable", () => {
  assertEquals(
    isRetryableEnvelopeRefusal(
      reply(550, "[ACR04] Amazon AWS IP 100.27.38.52 may not use this server."),
    ),
    true,
    "a fresh isolate or the relay has a different address",
  );
  assertEquals(
    isRetryableEnvelopeRefusal(reply(554, "5.7.1 Service unavailable; Client host [1.2.3.4] blocked using Spamhaus")),
    true,
    "a blocklisted connecting IP",
  );
});

Deno.test("a 4xx envelope refusal stays retryable", () => {
  assertEquals(isRetryableEnvelopeRefusal(reply(451, "4.7.1 Greylisted, try again later")), true, "greylisting");
  assertEquals(isRetryableEnvelopeRefusal(reply(421, "Too many connections")), true, "rate limit");
  assertEquals(isRetryableEnvelopeRefusal(reply(450, "4.2.0 Mailbox busy")), true, "busy mailbox");
});
