import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../../api";
import { setLatency } from "../../api/mock/latency";
import { MockMailApi } from "../../api/mock/mock-mail-api";
import { resetRouterForTests } from "../../app/router";
import { saveDraft } from "../../data/mail-actions";
import { queryClient } from "../../data/query-client";
import { useComposeStore } from "../../state/compose-store";
import { useUiStore } from "../../state/ui-store";
import { inboxHealth } from "../../api/inbox-health";
import type { Inbox } from "../../api/types";
import { type AutosaveStatus, createAutosaver } from "./autosave";
import { fromChoices, fromOptionLabel } from "./from";
import {
  addRecipients,
  chipsOf,
  isCommitKey,
  isValidAddress,
  looksLikeList,
  moveActive,
  removeRecipientAt,
  splitRecipients,
} from "./recipients";
import { defaultCustomTime, describeSchedule, parseLocalInputValue, scheduleOptions, toLocalInputValue } from "./schedule";

describe("recipients", () => {
  it("splits on commas, semicolons, spaces and new lines", () => {
    expect(splitRecipients("a@x.co, b@y.co;c@z.co d@w.co\ne@v.co")).toEqual(["a@x.co", "b@y.co", "c@z.co", "d@w.co", "e@v.co"]);
    expect(splitRecipients("  ,, ; ")).toEqual([]);
  });

  it("takes the address out of the Name <address> form", () => {
    expect(splitRecipients('Maya Chen <maya@lattice-labs.io>, "Nair, Priya" <priya@northwind.co>')).toEqual([
      "maya@lattice-labs.io",
      "priya@northwind.co",
    ]);
    expect(splitRecipients("mailto:a@x.co")).toEqual(["a@x.co"]);
  });

  it("adds without duplicates, whatever the case", () => {
    expect(addRecipients("a@x.co", "A@X.co, b@y.co")).toBe("a@x.co, b@y.co");
    expect(addRecipients("", ["a@x.co", "a@x.co"])).toBe("a@x.co");
    expect(addRecipients("a@x.co, b@y.co", "")).toBe("a@x.co, b@y.co");
  });

  it("removes one chip by position (backspace removes the last)", () => {
    const value = "a@x.co, b@y.co, c@z.co";
    expect(removeRecipientAt(value, 1)).toBe("a@x.co, c@z.co");
    expect(removeRecipientAt(value, chipsOf(value).length - 1)).toBe("a@x.co, b@y.co");
    expect(removeRecipientAt("a@x.co", 0)).toBe("");
  });

  it("flags invalid addresses", () => {
    expect(isValidAddress("maya@lattice-labs.io")).toBe(true);
    expect(isValidAddress(" a.b+c@sub.example.com ")).toBe(true);
    for (const bad of ["maya", "maya@", "@x.co", "maya@x", "ma ya@x.co", "a@b@c.co", "a@x.c"]) expect(isValidAddress(bad)).toBe(false);
  });

  it("knows which keys commit and which pastes are lists", () => {
    expect([",", ";", " ", "Enter"].every(isCommitKey)).toBe(true);
    expect(isCommitKey("a")).toBe(false);
    expect(looksLikeList("a@x.co")).toBe(false);
    expect(looksLikeList("a@x.co b@y.co")).toBe(true);
    expect(looksLikeList("Maya <a@x.co>")).toBe(true);
  });

  it("moves through suggestions and wraps", () => {
    expect(moveActive(-1, 3, "next")).toBe(0);
    expect(moveActive(-1, 3, "prev")).toBe(2);
    expect(moveActive(2, 3, "next")).toBe(0);
    expect(moveActive(0, 3, "prev")).toBe(2);
    expect(moveActive(1, 0, "next")).toBe(-1);
    expect(moveActive(1, 3, "last")).toBe(2);
  });
});

describe("the From menu", () => {
  const box = (inbox_id: string, state: Partial<Pick<Inbox, "status" | "status_reason">> = { status: "ok", status_reason: null }) => {
    const inbox = { inbox_id, email_address: `${inbox_id}@x.io`, display_name: inbox_id.toUpperCase(), sender_identity_status: "available" as const, ...state };
    return { ...inbox, health: inboxHealth(inbox) };
  };
  const boxes = [
    box("a"),
    box("b", { status: "reconnect_required", status_reason: "password_refused" }),
    box("c", { status: "reconnect_required", status_reason: "sender_identity" }),
    box("d", { status: "error", status_reason: "no_mailbox" }),
  ];

  it("offers only mailboxes whose mail works", () => {
    expect(fromChoices(boxes, "a").map((b) => b.inbox_id)).toEqual(["a", "c"]);
  });

  it("keeps the mailbox the form is already set to, whatever its state", () => {
    expect(fromChoices(boxes, "b").map((b) => b.inbox_id)).toEqual(["a", "b", "c"]);
  });

  it("says in the menu when only the send-as addresses need a reconnect", () => {
    expect(fromOptionLabel(boxes[0]!, true)).toBe("a@x.io · A");
    expect(fromOptionLabel(boxes[0]!, false)).toBe("a@x.io");
    expect(fromOptionLabel(boxes[2]!, true)).toBe("c@x.io · C (send-as addresses need a reconnect)");
  });
});

describe("schedule options", () => {
  // 2026-09-30 is a Wednesday.
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
  const summary = (now: Date) => scheduleOptions(now).map((o) => [o.label, toLocalInputValue(o.at)]);

  it("offers tomorrow 8:00, next Monday 8:00 and this afternoon in the morning", () => {
    expect(summary(at(2026, 9, 30, 9, 52))).toEqual([
      ["Tomorrow morning", "2026-10-01T08:00"],
      ["Monday morning", "2026-10-05T08:00"],
      ["This afternoon", "2026-09-30T14:00"],
    ]);
  });

  it("drops this afternoon once 14:00 has passed", () => {
    expect(summary(at(2026, 9, 30, 14, 0)).map((o) => o[0])).toEqual(["Tomorrow morning", "Monday morning"]);
  });

  it("does not offer Monday twice on a Sunday", () => {
    expect(summary(at(2026, 10, 4, 10))).toEqual([
      ["Tomorrow morning", "2026-10-05T08:00"],
      ["This afternoon", "2026-10-04T14:00"],
    ]);
  });

  it("on a Monday, Monday morning is next week", () => {
    expect(summary(at(2026, 10, 5, 16))).toEqual([
      ["Tomorrow morning", "2026-10-06T08:00"],
      ["Monday morning", "2026-10-12T08:00"],
    ]);
  });

  it("crosses month and year ends", () => {
    expect(summary(at(2026, 12, 31, 20))[0]).toEqual(["Tomorrow morning", "2027-01-01T08:00"]);
  });

  it("every option is in the future and described", () => {
    const now = at(2026, 9, 30, 9, 52);
    for (const o of scheduleOptions(now)) {
      expect(o.at.getTime()).toBeGreaterThan(now.getTime());
      expect(o.when).not.toBe("");
      expect(o.full).not.toBe("");
    }
    expect(describeSchedule(at(2026, 9, 30, 14), now).when.startsWith("Today")).toBe(true);
  });

  it("round-trips datetime-local values as local time and rejects the past", () => {
    const now = at(2026, 9, 30, 9, 52);
    expect(toLocalInputValue(at(2026, 1, 5, 7, 3))).toBe("2026-01-05T07:03");
    expect(parseLocalInputValue("2026-10-02T16:30", now)?.getTime()).toBe(at(2026, 10, 2, 16, 30).getTime());
    expect(parseLocalInputValue("2026-09-30T09:00", now)).toBeNull();
    expect(parseLocalInputValue("nonsense", now)).toBeNull();
    expect(toLocalInputValue(defaultCustomTime(now))).toBe("2026-09-30T11:00");
  });
});

describe("autosaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once, 1.5 s after typing stops", async () => {
    const save = vi.fn(async () => {});
    const a = createAutosaver({ save });
    a.touch();
    await vi.advanceTimersByTimeAsync(1000);
    a.touch();
    await vi.advanceTimersByTimeAsync(1499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("never overlaps saves, so each one sees the id the previous one returned", async () => {
    // A server that, like IMAP, replaces the draft id on every update.
    let serverId: string | null = null;
    let stored: string | undefined;
    let n = 0;
    const seen: (string | undefined)[] = [];
    const save = vi.fn(async () => {
      const usedId = stored;
      seen.push(usedId);
      await new Promise((r) => setTimeout(r, 400));
      if (usedId !== undefined && usedId !== serverId) throw new Error("draft_not_found");
      serverId = `d${++n}`;
      stored = serverId;
    });
    const statuses: AutosaveStatus[] = [];
    const a = createAutosaver({ save, onStatus: (s) => statuses.push(s) });

    a.touch();
    await vi.advanceTimersByTimeAsync(1500); // save 1 starts
    a.touch(); // typed while it is in flight
    await vi.advanceTimersByTimeAsync(300);
    a.touch();
    await vi.advanceTimersByTimeAsync(1500); // quiet period over, but save 1 only just landed
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);

    expect(save).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([undefined, "d1"]);
    expect(stored).toBe("d2");
    expect(statuses).toEqual(["saving", "saved", "saving", "saved"]);
    expect(a.pending).toBe(false);
  });

  it("settle waits for the save in flight and drops the pending one", async () => {
    let resolve: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const a = createAutosaver({ save });
    a.touch();
    await vi.advanceTimersByTimeAsync(1500);
    a.touch();
    let settled = false;
    void a.settle().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save and keeps going", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const statuses: AutosaveStatus[] = [];
    const a = createAutosaver({ save, onStatus: (s) => statuses.push(s) });
    a.touch();
    await vi.advanceTimersByTimeAsync(1500);
    a.touch();
    await vi.advanceTimersByTimeAsync(1500);
    expect(statuses).toEqual(["saving", "error", "saving", "saved"]);
  });

  it("cancel drops the pending save", async () => {
    const save = vi.fn(async () => {});
    const a = createAutosaver({ save });
    a.touch();
    a.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("autosave against the mailbox (draft id changes on every save)", () => {
  let api: MockMailApi;

  beforeEach(() => {
    setLatency({ read: [0, 0], write: [0, 0], failWrites: false });
    api = new MockMailApi("pro");
    setMailApi(api);
    queryClient.clear();
    window.history.replaceState({}, "", "/");
    resetRouterForTests();
    useUiStore.setState({ viewport: "desktop", screen: "list", menu: null });
    useComposeStore.setState({ compose: null });
  });

  it("keeps the newest id, leaves the form open, and never leaves a second draft behind", async () => {
    const before = (await api.listDrafts("gmail")).length;
    useComposeStore.getState().open({ inbox_id: "gmail", to: "k@x.co", subject: "Hi", body: "One" });

    await saveDraft({ keepOpen: true, silent: true });
    const first = useComposeStore.getState().compose?.draft_id;
    expect(first).toBeTruthy();
    expect(useComposeStore.getState().compose?.body).toBe("One");

    useComposeStore.getState().patch({ body: "One two" });
    await saveDraft({ keepOpen: true, silent: true });
    const second = useComposeStore.getState().compose?.draft_id;
    expect(second).toBeTruthy();

    useComposeStore.getState().patch({ body: "One two three" });
    await saveDraft({ keepOpen: true, silent: true });
    const third = useComposeStore.getState().compose?.draft_id;

    const drafts = await api.listDrafts("gmail");
    expect(drafts.length).toBe(before + 1);
    expect(drafts.some((d) => d.draft_id === third)).toBe(true);
    const saved = await api.readDraft("gmail", third!);
    expect(saved.body_text).toBe("One two three");
    // Whatever the provider does with ids, the store always holds the live one.
    for (const old of new Set([first, second])) {
      if (old !== third) expect(drafts.some((d) => d.draft_id === old)).toBe(false);
    }
  });

  it("an empty form is not saved", async () => {
    const before = (await api.listDrafts("gmail")).length;
    useComposeStore.getState().open({ inbox_id: "gmail" });
    await saveDraft({ keepOpen: true, silent: true });
    expect(useComposeStore.getState().compose?.draft_id).toBeUndefined();
    expect((await api.listDrafts("gmail")).length).toBe(before);
  });
});
