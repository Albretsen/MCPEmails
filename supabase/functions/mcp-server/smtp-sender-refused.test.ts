// ---------------------------------------------------------------------------
// A mail server that refuses the From address gets its own answer.
//
// With IMAP Send As (20261018120000) an agent can put a verified alias in
// From. Verification proves mail for the alias reaches the user; it does not
// prove their provider lets this login send as it. iCloud, Exchange and others
// refuse such a From, at MAIL FROM or at the end of DATA. Before this the
// end-of-DATA refusal was reported as "delivery status unknown, do not retry",
// which sends the agent to search Sent for a message that was never accepted.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  isSenderOwnershipRefusal,
  SmtpNotSentError,
  SmtpSenderRefusedError,
} from "./smtp-client.ts";

const reply = (code: number, text: string) => ({ code, text });

Deno.test("sender-ownership refusals are recognised", () => {
  for (const r of [
    reply(554, "5.7.1 [CS01] Message rejected: From address is not one of your addresses"),
    reply(553, "5.7.1 Sender address rejected: not owned by user primary@icloud.example"),
    reply(554, "5.2.252 SendAsDenied; primary@contoso.example not allowed to send as alias@contoso.example"),
    reply(550, "5.7.60 SMTP; Client does not have permissions to send as this sender"),
    reply(553, "5.7.1 From address does not match authenticated user"),
    reply(550, "Sender address is not allowed for this login"),
  ]) {
    assert(isSenderOwnershipRefusal(r), r.text);
  }
});

Deno.test("IP, reputation, recipient and transient replies are not mistaken for it", () => {
  for (const r of [
    reply(550, "[ACR04] Amazon AWS IP 100.27.38.52 may not use this server."),
    reply(550, "5.7.1 Service unavailable, client host blocked"),
    reply(550, "5.1.1 Recipient address rejected: User unknown"),
    reply(554, "5.7.1 Message rejected due to content restrictions"),
    reply(451, "4.7.1 From address does not match authenticated user, try again later"),
    reply(250, "2.0.0 Ok: queued"),
  ]) {
    assert(!isSenderOwnershipRefusal(r), r.text);
  }
});

Deno.test("a sender refusal is a not-sent error that is not retryable", () => {
  const err = new SmtpSenderRefusedError("SMTP MAIL FROM <a@b.example> refused: 553 not owned by user");
  assert(err instanceof SmtpNotSentError, "every not-sent handler still treats it as not sent");
  assertEquals(err.retryable, false);
  assertEquals(err.name, "SmtpSenderRefusedError");
});

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const CLIENT = await Deno.readTextFile(new URL("./smtp-client.ts", import.meta.url));

Deno.test("each send handler answers a sender refusal before the generic not-sent branch", () => {
  // SmtpSenderRefusedError extends SmtpNotSentError, so the order is the
  // whole point: checked second, it would never be reached.
  for (const op of ["email_forward", "email_reply", "email_send", "draft_send"]) {
    const refused = INDEX.indexOf(`senderRefusedResult("${op}"`);
    const notSent = INDEX.indexOf(`notSentResult("${op}"`);
    assert(refused > 0, `${op} maps SmtpSenderRefusedError`);
    assert(notSent > refused && notSent - refused < 400, `${op}: checked right before notSentResult`);
  }
  const batch = INDEX.slice(INDEX.indexOf("function classifyForwardFailure("));
  assert(
    batch.indexOf("instanceof SmtpSenderRefusedError") < batch.indexOf("instanceof SmtpNotSentError"),
    "the batch forward classifier checks it first too",
  );
});

Deno.test("both refusal points in the SMTP exchange are classified", () => {
  assert(/MAIL FROM[\s\S]{0,400}isSenderOwnershipRefusal\(mailFrom\)/.test(CLIENT), "at MAIL FROM");
  assert(/writeData[\s\S]{0,300}isSenderOwnershipRefusal\(accepted\)/.test(CLIENT), "at the end of DATA");
});
