import { describe, expect, it } from "vitest";
import { INBOX_NOTICE, SENDER_IDENTITY_HINT, hasServerStatus, inboxHealth, usableInboxes } from "../../api/inbox-health";
import type { Inbox, InboxHealthStatus, InboxStatusReason } from "../../api/types";
import { allowanceView, countSuffix, mailboxProblem, sidebarAttention } from "./model";

describe("allowanceView", () => {
  it("shows used / cap and a normal meter below 80%", () => {
    const v = allowanceView({ used: 312, cap: 1000 });
    expect(v.text).toBe("312 / 1,000");
    expect(v.fraction).toBeCloseTo(0.312);
    expect(v.tone).toBe("normal");
  });

  it("turns amber from 80% and never overflows the meter", () => {
    expect(allowanceView({ used: 799, cap: 1000 }).tone).toBe("normal");
    expect(allowanceView({ used: 800, cap: 1000 }).tone).toBe("warn");
    expect(allowanceView({ used: 5000, cap: 1000 }).fraction).toBe(1);
  });

  it("never renders a null cap as a number", () => {
    const v = allowanceView({ used: 42, cap: null });
    expect(v.text).toBe("42 used");
    expect(v.fraction).toBeNull();
    expect(v.tone).toBe("normal");
    expect(v.valueText).not.toMatch(/null|NaN|Infinity/);
  });
});

describe("mailbox status from /session", () => {
  const box = (email_address: string, status?: InboxHealthStatus, status_reason: InboxStatusReason | null = null, sender = "available") => {
    const inbox = { email_address, status, status_reason, sender_identity_status: sender as Inbox["sender_identity_status"] };
    return { ...inbox, health: inboxHealth(inbox) };
  };

  it("has exact copy per reason, with no em dash anywhere", () => {
    expect(inboxHealth({ status: "reconnect_required", status_reason: "password_refused", sender_identity_status: "unavailable" })).toMatchObject({
      usable: false,
      reconnectable: true,
      code: "reconnect_required",
      notice: "This mailbox's password was refused. Reconnect it in the dashboard.",
    });
    expect(inboxHealth({ status: "reconnect_required", status_reason: "access_revoked", sender_identity_status: "unavailable" }).notice).toBe(
      "Access to this mailbox expired. Reconnect it in the dashboard.",
    );
    for (const reason of ["no_mailbox", "unavailable"] as const) {
      expect(inboxHealth({ status: "error", status_reason: reason, sender_identity_status: "unavailable" })).toMatchObject({
        usable: false,
        reconnectable: false,
        code: "inbox_unavailable",
        notice: "This mailbox is unavailable.",
      });
    }
    for (const text of [...Object.values(INBOX_NOTICE), SENDER_IDENTITY_HINT]) expect(text).not.toMatch(/[—–]/);
  });

  it("sender_identity: mail works, there is only a hint for compose", () => {
    const h = inboxHealth({ status: "reconnect_required", status_reason: "sender_identity", sender_identity_status: "reconnect_required" });
    expect(h).toMatchObject({ usable: true, senderHint: true, notice: null, code: null });
    expect(mailboxProblem(box("a@x.io", "reconnect_required", "sender_identity", "reconnect_required"))).toBeNull();
  });

  it("the server's status wins; a refusal heard from a mail call only fills the gap", () => {
    const ok = { status: "ok" as const, status_reason: null, sender_identity_status: "available" as const };
    expect(inboxHealth(ok).usable).toBe(true);
    // Refused by a call since the last session: down, reason not known yet.
    expect(inboxHealth(ok, true)).toMatchObject({ usable: false, reason: null, notice: INBOX_NOTICE.generic, code: "reconnect_required" });
    // No status from the server at all: the remembered refusal is all there is.
    const legacy: Pick<Inbox, "status" | "status_reason" | "sender_identity_status"> = { sender_identity_status: "available" };
    expect(inboxHealth(legacy).usable).toBe(true);
    expect(inboxHealth(legacy, true).usable).toBe(false);
    expect(hasServerStatus([legacy])).toBe(false);
    expect(hasServerStatus([legacy, ok])).toBe(true);
    // And keeps the badge it always had for its one signal.
    expect(mailboxProblem(box("a@x.io", undefined, null, "reconnect_required"))).toBe(INBOX_NOTICE.generic);
    expect(usableInboxes([{ inbox_id: "a", ...ok }, { inbox_id: "b", ...ok }], { b: true }).map((i) => i.inbox_id)).toEqual(["a"]);
  });

  it("words the line under the mailbox list", () => {
    expect(sidebarAttention([box("a@x.io", "ok"), box("b@x.io", "ok")])).toBeNull();
    expect(sidebarAttention([box("a@x.io", "ok"), box("b@x.io", "reconnect_required", "password_refused")])).toEqual({
      text: "b@x.io: This mailbox's password was refused. Reconnect it in the dashboard.",
      reconnect: true,
    });
    // The only mailbox: no name needed.
    expect(sidebarAttention([box("b@x.io", "reconnect_required", "access_revoked")])).toEqual({
      text: "Access to this mailbox expired. Reconnect it in the dashboard.",
      reconnect: true,
    });
    expect(sidebarAttention([box("a@x.io", "ok"), box("b@x.io", "error", "no_mailbox")])).toEqual({
      text: "b@x.io: This mailbox is unavailable.",
      reconnect: false,
    });
    expect(sidebarAttention([box("a@x.io", "reconnect_required", "password_refused"), box("b@x.io", "reconnect_required", "access_revoked")])).toEqual({
      text: "2 mailboxes need reconnecting.",
      reconnect: true,
    });
    expect(sidebarAttention([box("a@x.io", "reconnect_required", "password_refused"), box("b@x.io", "error", "unavailable")])).toEqual({
      text: "2 mailboxes need attention.",
      reconnect: true,
    });
  });
});

describe("countSuffix", () => {
  it("is empty for zero and words the count otherwise", () => {
    expect(countSuffix(0, "unread")).toBe("");
    expect(countSuffix(3, "unread")).toBe(", 3 unread");
    expect(countSuffix(1, "total")).toBe(", 1 email");
    expect(countSuffix(1200, "total")).toBe(", 1,200 emails");
  });
});
