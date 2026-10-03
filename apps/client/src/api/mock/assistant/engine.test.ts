import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantEvent, AssistantRequest, DiffSegment } from "../../assistant-api";
import { setMailApi } from "../../index";
import { setLatency } from "../latency";
import { MockMailApi } from "../mock-mail-api";
import { ScriptedAssistantTransport, setAssistantPace } from "./engine";
import { editText, humanize, route, routeWithContext } from "./route";

let api: MockMailApi;
let t: ScriptedAssistantTransport;

const req = (text: string, extra: Partial<AssistantRequest> = {}): AssistantRequest => ({
  text,
  context: { keys: [] },
  conversation_id: "conv",
  ...extra,
});

type Hook = (ev: AssistantEvent, abort: AbortController) => void | Promise<void>;

/** Consumes a whole run. `onEvent` can answer approvals or abort. */
async function collect(r: AssistantRequest, onEvent?: Hook): Promise<AssistantEvent[]> {
  const abort = new AbortController();
  const out: AssistantEvent[] = [];
  for await (const ev of t.run(r, { signal: abort.signal })) {
    out.push(ev);
    await onEvent?.(ev, abort);
  }
  return out;
}

const calls = (events: AssistantEvent[]) => {
  const last = new Map<string, Extract<AssistantEvent, { type: "tool_call" }>["call"]>();
  for (const e of events) if (e.type === "tool_call") last.set(e.call.id, e.call);
  return [...last.values()];
};
const text = (events: AssistantEvent[]) =>
  events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
const runId = (events: AssistantEvent[]) => {
  const e = events[0];
  return e?.type === "run_started" ? e.run_id : "";
};
const folderOf = (key: `${string}:${string}`) => api.getMessage(key)?.folder;
const sent = () => api.allMessages().filter((m) => m.folder === "Sent" && m.id.startsWith("s") && m.id !== "sent1");

beforeEach(() => {
  setLatency({ read: [0, 0], write: [0, 0], failWrites: false });
  setAssistantPace(0);
  api = new MockMailApi("pro");
  setMailApi(api);
  t = new ScriptedAssistantTransport();
});

afterEach(() => {
  setMailApi(null);
  setAssistantPace(1);
});

describe("routing", () => {
  it("routes free text like the prototype", () => {
    expect(route("Make it shorter")).toBe("shorter");
    expect(route("a bit warmer please")).toBe("warmer");
    expect(route("File this week's receipts")).toBe("receipts");
    expect(route("Reply that Thursday works, and send it")).toBe("send");
    expect(route("What needs a reply?")).toBe("needs");
    expect(route("Draft a reply")).toBe("draft");
    expect(route("tl;dr")).toBe("summary");
    expect(route("delta trip")).toBe("generic");
  });

  it("lets an explicit intent win, and reads free text about one attached email as a question about it", () => {
    expect(routeWithContext("anything", "firstrun", false)).toBe("firstrun");
    expect(routeWithContext("when do I fly?", undefined, true)).toBe("about");
    expect(routeWithContext("What do they need from me?", undefined, true)).toBe("about");
    expect(routeWithContext("What needs a reply?", undefined, false)).toBe("needs");
    expect(routeWithContext("archive this", undefined, true)).toBe("archiveOne");
  });

  it("words tool calls by state", () => {
    expect(humanize("email_read", "Maya · Q4", "running")).toBe("Reading Maya · Q4");
    expect(humanize("email_read", "Maya · Q4", "done")).toBe("Read Maya · Q4");
    expect(humanize("email_search", "x", "done")).toBe("Searched your mail");
    expect(humanize("draft", "edit · shorter", "running", "edit")).toBe("Editing the draft");
    expect(humanize("email_compose", "to a@b.c", "waiting")).toBe("Waiting for your approval to send to a@b.c");
    expect(humanize("email_compose", "to a@b.c", "cancelled")).toBe("Not sent");
  });

  it("shortens and warms a body it has no canned version for", () => {
    const body = "Hi Sam,\n\nFirst point. More detail here.\n\nSecond point. Even more.\n\nBest,\nJordan";
    expect(editText(body, "shorter")).toBe("Hi Sam,\n\nFirst point. Second point.\n\nBest,\nJordan");
    expect(editText(body, "warmer")).toContain("Thanks so much for this. First point.");
    expect(editText(body, "warmer")).toContain("Really appreciate it,\nJordan");
  });
});

describe("scripted assistant", () => {
  it("files receipts: searches, moves each one for real, and undo puts them back", async () => {
    const before = api.consumeAssistantAction(0).used;
    const events = await collect(req("File this week's receipts"));
    const moved = events.filter((e) => e.type === "mail_effect" && e.effect.kind === "moved");
    expect(moved).toHaveLength(6);
    for (const e of moved) {
      if (e.type !== "mail_effect") continue;
      expect(e.effect.to).toEqual({ name: "Receipts" });
      expect(folderOf(e.effect.keys[0]!)).toBe("Receipts");
    }
    expect(folderOf("gmail:stripe")).toBe("Receipts");
    expect(folderOf("outlook:aws")).toBe("Receipts");
    expect(folderOf("outlook:maya")).toBe("INBOX");

    const cs = calls(events);
    expect(cs[0]).toMatchObject({ tool: "email_search", state: "done", meta: "6 found", human: "Searched your mail" });
    expect(cs.slice(1).every((c) => c.tool === "email_organize" && c.state === "done" && c.human.startsWith("Moved "))).toBe(true);
    expect(cs[1]?.human).toBe("Moved Stripe → Receipts");
    // Each row is read (highlight) before it is moved.
    const stripe = events.filter((e) => e.type === "tool_call" && e.call.keys[0] === "gmail:stripe");
    expect(stripe.map((e) => (e.type === "tool_call" ? `${e.call.tool}:${e.call.state}` : ""))).toEqual([
      "email_read:running",
      "email_organize:running",
      "email_organize:done",
    ]);
    expect(events.some((e) => e.type === "status" && e.progress?.i === 6 && e.progress.n === 6)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", summary: { text: "Filed 6 emails in Receipts", undoable: true } });
    expect(text(events)).toBe("Filed 6 receipts, $665.18 in total. Undo is at the top of this conversation.");
    expect(events.some((e) => e.type === "chips" && e.chips[0]?.kind === "folder")).toBe(true);
    expect(api.consumeAssistantAction(0).used).toBe(before + 1);

    await t.undo(runId(events));
    expect(folderOf("gmail:stripe")).toBe("INBOX");
    expect(folderOf("outlook:aws")).toBe("INBOX");

    // Nothing left to file the second time round is not the case after undo...
    const again = await collect(req("", { intent: "receipts" }));
    expect(again.filter((e) => e.type === "mail_effect")).toHaveLength(6);
    // ...and once filed, a third run finds none.
    const third = await collect(req("File receipts"));
    expect(text(third)).toBe("No receipts left in your inbox.");
  });

  it("stops a bulk move mid-way: the call in flight is cancelled, earlier moves stay and can be undone", async () => {
    let n = 0;
    const events = await collect(req("File this week's receipts"), (ev, abort) => {
      if (ev.type === "mail_effect" && ++n === 2) abort.abort();
    });
    expect(events.filter((e) => e.type === "mail_effect")).toHaveLength(2);
    expect(events.some((e) => e.type === "done")).toBe(false);
    const cs = calls(events);
    expect(cs.filter((c) => c.state === "cancelled")).toHaveLength(1);
    expect(cs.find((c) => c.state === "cancelled")).toMatchObject({ meta: "stopped" });
    expect(api.allMessages().filter((m) => m.folder === "Receipts" && m.id !== "uber")).toHaveLength(2);
    await t.undo(runId(events));
    expect(api.allMessages().filter((m) => m.folder === "Receipts" && m.id !== "uber")).toHaveLength(0);
  });

  it("finds what needs a reply: reads each person's email, labels it, links to it", async () => {
    const events = await collect(req("What needs a reply?"));
    const reads = calls(events).filter((c) => c.tool === "email_read");
    expect(reads.map((c) => c.keys[0])).toEqual(["outlook:maya", "outlook:priya", "outlook:kenji", "imap:alex"]);
    expect(events.filter((e) => e.type === "row_label" && e.label === "needs reply")).toHaveLength(4);
    const chips = events.find((e) => e.type === "chips");
    expect(chips?.type === "chips" && chips.chips[0]).toMatchObject({ kind: "email", key: "outlook:maya", sub: "Confirm the Thursday 2pm call" });
    expect(text(events)).toBe("4 emails need a reply from you. I've labelled them in the list.");
  });

  it("drafts a reply into compose, then streams 'shorter' as a word diff that settles", async () => {
    const drafted = await collect(req("Draft a reply", { context: { keys: ["outlook:maya"] }, intent: "draft" }));
    const streams = drafted.filter((e) => e.type === "draft_stream");
    expect(streams[0]).toMatchObject({ phase: "writing", reply_to: "outlook:maya", body_delta: "", fields: { inbox_id: "outlook", to: "maya@lattice-labs.io", subject: "Re: Q4 renewal — can we do Thursday?" } });
    const done = streams.at(-1);
    if (done?.type !== "draft_stream") throw new Error("no draft");
    const reply = api.getHints("outlook:maya")!.reply!;
    expect(done).toMatchObject({ done: true, body: reply });
    expect(streams.map((e) => (e.type === "draft_stream" ? (e.body_delta ?? "") : "")).join("")).toBe(reply);
    // It is a real draft in the mailbox.
    expect(done.draft_id).toBeTruthy();
    expect((await api.readDraft("outlook", done.draft_id!)).body_text).toBe(reply);
    expect(drafted.some((e) => e.type === "mail_effect" && e.effect.kind === "drafted")).toBe(true);
    expect(calls(drafted).map((c) => [c.tool, c.state, c.meta])).toEqual([
      ["email_read", "done", ""],
      ["draft", "done", "under the email"],
    ]);

    const draft = { inbox_id: "outlook", to: "maya@lattice-labs.io", subject: done.fields.subject, body: reply, reply_to: "outlook:maya" as const, draft_id: done.draft_id };
    const edited = await collect(req("Make it shorter", { context: { keys: ["outlook:maya"] }, draft }));
    const segs = edited.filter((e) => e.type === "draft_stream" && !e.done).map((e) => (e.type === "draft_stream" ? (e.segments as DiffSegment[]) : []));
    const shorter = api.getHints("outlook:maya")!.shorter!;
    const join = (s: DiffSegment[], drop: DiffSegment["k"]) => s.filter((g) => g.k !== drop).map((g) => g.t).join("");
    // First frame: the old text with deletions marked and nothing inserted yet.
    expect(segs[0]!.some((g) => g.k === "del")).toBe(true);
    expect(segs[0]!.filter((g) => g.k === "ins").every((g) => g.t === "")).toBe(true);
    expect(segs[0]!.map((g) => g.t).join("")).toBe(reply);
    // Last frame: deletions gone, what is left is the new text.
    expect(segs.at(-1)!.filter((g) => g.k === "del").every((g) => g.t === "")).toBe(true);
    expect(join(segs.at(-1)!, "del")).toBe(shorter);
    const end = edited.filter((e) => e.type === "draft_stream").at(-1);
    expect(end).toMatchObject({ phase: "editing", done: true, body: shorter });
    expect(calls(edited)[0]).toMatchObject({ tool: "draft", action: "edit", human: "Edited the draft", state: "done" });
    // The saved draft was updated too (Outlook keeps the id).
    expect((await api.readDraft("outlook", done.draft_id!)).body_text).toBe(shorter);
  });

  it("stops while drafting: partial text stays, the draft call is cancelled, nothing is saved", async () => {
    setAssistantPace(0.001);
    let seen = 0;
    const events = await collect(req("Draft a reply to Maya"), (ev, abort) => {
      if (ev.type === "draft_stream" && ev.body_delta && ++seen === 5) abort.abort();
    });
    const partial = events.map((e) => (e.type === "draft_stream" ? (e.body_delta ?? "") : "")).join("");
    expect(partial).toBe("Hi Maya,\n\n");
    expect(events.some((e) => e.type === "draft_stream" && e.done)).toBe(false);
    expect(calls(events).find((c) => c.tool === "draft")).toMatchObject({ state: "cancelled", meta: "stopped" });
    await new Promise((r) => setTimeout(r, 5));
    expect(await api.listDrafts("outlook")).toHaveLength(1); // only the seeded one
  });

  it("refuses to draft a reply to a receipt and says there is no draft to edit", async () => {
    expect(text(await collect(req("Draft a reply", { context: { keys: ["gmail:stripe"] }, intent: "draft" })))).toBe(
      "This is a receipt from Stripe. It doesn't need a reply.",
    );
    expect(text(await collect(req("Make it warmer")))).toBe("There is no draft yet. Ask me to draft a reply first.");
  });

  it("send: drafts, holds for approval, and sends only once approved", async () => {
    const events = await collect(req("Reply that Thursday works, and send it", { context: { keys: ["outlook:maya"] } }), async (ev) => {
      if (ev.type !== "approval_required") return;
      // Held: nothing has gone out yet.
      expect(sent()).toHaveLength(0);
      expect(ev).toMatchObject({ external: true, draft: { to: "maya@lattice-labs.io", reply_to: "outlook:maya" } });
      await t.resolveApproval(ev.approval_id, "approve");
    });
    const order = events.map((e) => e.type);
    expect(order.indexOf("draft_stream")).toBeLessThan(order.indexOf("approval_required"));
    const waiting = events.find((e) => e.type === "tool_call" && e.call.state === "waiting");
    expect(waiting?.type === "tool_call" && waiting.call).toMatchObject({ tool: "email_compose", meta: "needs approval", human: "Waiting for your approval to send to maya@lattice-labs.io" });
    expect(calls(events).find((c) => c.tool === "email_compose")).toMatchObject({ state: "done", meta: "approved", human: "Sent to maya@lattice-labs.io" });
    expect(events.some((e) => e.type === "mail_effect" && e.effect.kind === "sent")).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ inbox_id: "outlook", body_text: api.getHints("outlook:maya")!.reply, to: [{ email: "maya@lattice-labs.io" }] });
    expect(text(events)).toContain("Sent to maya@lattice-labs.io. It's in Sent.");
    // The draft it was written as is gone from Drafts.
    expect(await api.listDrafts("outlook")).toHaveLength(1);
  });

  it("send: a rejection or 'edit' sends nothing", async () => {
    for (const [decision, meta, line] of [
      ["reject", "declined", "Not sent. The draft is still below."],
      ["edit", "you are editing", "Not sent. The draft is yours to edit and send."],
    ] as const) {
      const events = await collect(req("send it", { context: { keys: ["outlook:maya"] }, intent: "send" }), async (ev) => {
        if (ev.type === "approval_required") await t.resolveApproval(ev.approval_id, decision);
      });
      expect(calls(events).find((c) => c.tool === "email_compose")).toMatchObject({ state: "cancelled", meta, human: "Not sent" });
      expect(text(events)).toContain(line);
      expect(sent()).toHaveLength(0);
      expect(events.at(-1)?.type).toBe("done");
    }
  });

  it("send: fails closed when the run is aborted while the approval is pending", async () => {
    let approval = "";
    const events = await collect(req("send it", { context: { keys: ["outlook:maya"] }, intent: "send" }), (ev, abort) => {
      if (ev.type === "approval_required") {
        approval = ev.approval_id;
        abort.abort();
      }
    });
    expect(approval).not.toBe("");
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(calls(events).find((c) => c.tool === "email_compose")).toMatchObject({ state: "cancelled", meta: "stopped" });
    // A late approval of a dead request does nothing.
    await t.resolveApproval(approval, "approve");
    await new Promise((r) => setTimeout(r, 5));
    expect(sent()).toHaveLength(0);
  });

  it("send: reuses the draft already in compose instead of writing a new one", async () => {
    const draft = { inbox_id: "outlook", to: "maya@lattice-labs.io", subject: "Re: Q4", body: "Thursday works.", reply_to: "outlook:maya" as const };
    const events = await collect(req("Review and send", { context: { keys: ["outlook:maya"] }, intent: "send", draft }), async (ev) => {
      if (ev.type === "approval_required") await t.resolveApproval(ev.approval_id, "approve");
    });
    expect(events.some((e) => e.type === "draft_stream")).toBe(false);
    expect(sent()[0]?.body_text).toBe("Thursday works.");
  });

  it("answers about one email: summary, what they need, deadlines, earlier mail, archive", async () => {
    const ctx = { context: { keys: ["outlook:kenji" as const] } };
    expect(text(await collect(req("Summarize", { ...ctx, intent: "summary" })))).toContain("Kenji wants your comments on the Q3 board update by Friday.");
    expect(text(await collect(req("What do they need from me?", { ...ctx, intent: "about" })))).toBe("Kenji wants you to send comments on the board draft by Friday.");
    expect(text(await collect(req("Any deadlines?", { ...ctx, intent: "about" })))).toBe("Friday. He plans to send it to the board on Monday.");

    const earlier = await collect(req("Earlier from Maya", { context: { keys: ["outlook:maya"] }, intent: "sender" }));
    expect(text(earlier)).toBe("This is the only email from Maya in your mailboxes.");

    const archived = await collect(req("Archive this email", { ...ctx, intent: "archiveOne" }));
    expect(folderOf("outlook:kenji")).toBe("Archive");
    expect(archived.at(-1)).toEqual({ type: "done", summary: { text: "Archived Kenji Watanabe", undoable: true } });
    await t.undo(runId(archived));
    expect(folderOf("outlook:kenji")).toBe("INBOX");
  });

  it("first run: reads the inbox without spending an action and offers cards", async () => {
    api = new MockMailApi("first");
    setMailApi(api);
    const events = await collect(req("Go through my inbox", { intent: "firstrun" }));
    expect(api.consumeAssistantAction(0).used).toBe(0);
    expect(text(events)).toContain("Gmail is connected.");
    const cards = events.find((e) => e.type === "cards");
    if (cards?.type !== "cards") throw new Error("no cards");
    expect(cards.cards.map((c) => [c.id, c.intent, c.action])).toEqual([
      ["cr", "draft", "Draft a reply to Maya"],
      ["cf", "receipts", "File them in Receipts"],
      ["cn", "newsletters", "Archive them"],
    ]);
    expect(cards.cards[1]?.sub).toBe("$665.18 from Stripe, Vercel, Amazon Web Services and 3 more");
    expect(text(events)).toContain("Each uses 1 of your 50 free assistant actions this month.");
    // The sweep call leaves no row highlighted.
    const sweep = calls(events).find((c) => c.human.includes("more emails"));
    expect(sweep).toMatchObject({ state: "done", keys: [] });
  });

  it("falls back to a search with linked results", async () => {
    const events = await collect(req("denver trip"));
    expect(calls(events)[0]).toMatchObject({ tool: "email_search", state: "done" });
    const chips = events.find((e) => e.type === "chips");
    expect(chips?.type === "chips" && chips.chips.some((c) => c.kind === "email" && c.key === "gmail:delta")).toBe(true);
    expect(text(await collect(req("zzzzqqq")))).toContain("Nothing matched.");
  });
});
