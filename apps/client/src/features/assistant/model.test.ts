import { describe, expect, it } from "vitest";
import type { MessageKey, MessageRow } from "../../api/types";
import type { AssistantMessage } from "../../state/assistant-store";
import {
  attachable,
  chipKeys,
  chipLabel,
  composerPlaceholder,
  earlierLabel,
  fitSuggestions,
  inboxSuggestions,
  looksLikePerson,
  panelStatus,
  standardActions,
  threadSuggestions,
  visibleMessages,
} from "./model";

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  key: "outlook:maya",
  inbox_id: "outlook",
  id: "maya",
  from: { name: "Maya Chen", email: "maya@lattice-labs.io" },
  to: [],
  subject: "Q4 renewal",
  date: "",
  preview: "",
  is_read: false,
  has_attachments: false,
  folder: "INBOX",
  thread_id: "t",
  is_starred: false,
  folder_role: "inbox",
  ...over,
});
const maya = row();
const stripe = row({ key: "gmail:stripe", from: { name: "Stripe", email: "receipts@stripe.com" } });

const msg = (turn: number, role: "user" | "assistant" = "assistant"): AssistantMessage => ({
  id: `m${turn}${role}`, role, text: "", streaming: false, calls: [], cards: [], chips: [], run_id: null, turn, context: null,
});

describe("assistant panel model", () => {
  it("picks the context chip: ticked rows, else the open email, unless removed or the run is about all mail", () => {
    expect(attachable(row({ folder_role: "drafts" }))).toBeNull();
    expect(attachable(row({ folder_role: "sent" }))).toBeNull();
    expect(attachable(maya)).toBe(maya);
    const base = { inboxRun: false, multiSel: [], target: maya, ctxOff: false };
    expect(chipKeys(base)).toEqual(["outlook:maya"]);
    expect(chipKeys({ ...base, ctxOff: true })).toEqual([]);
    expect(chipKeys({ ...base, ctxOff: true, multiSel: ["a:1", "a:2"] })).toEqual(["a:1", "a:2"]);
    expect(chipKeys({ ...base, inboxRun: true })).toEqual([]);
    expect(chipLabel(["outlook:maya"], maya)).toBe("Maya Chen · Q4 renewal");
    expect(chipLabel(["a:1", "a:2", "a:3"], maya)).toBe("3 emails");
    expect(chipLabel([], maya)).toBe("");
  });

  it("the chip carries the focused message, or the whole conversation when asked", () => {
    const base = { inboxRun: false, multiSel: [], target: maya, ctxOff: false };
    const conversation: MessageKey[] = ["outlook:m1", "outlook:m2", "outlook:maya"];
    expect(chipKeys({ ...base, conversation: null })).toEqual(["outlook:maya"]);
    expect(chipKeys({ ...base, conversation })).toEqual(conversation);
    // Removed, ticked rows and a run about all mail win, as before.
    expect(chipKeys({ ...base, conversation, ctxOff: true })).toEqual([]);
    expect(chipKeys({ ...base, conversation, multiSel: ["a:1", "a:2"] })).toEqual(["a:1", "a:2"]);
    expect(chipKeys({ ...base, conversation, inboxRun: true })).toEqual([]);
    // A conversation of one is just the message.
    expect(chipKeys({ ...base, conversation: ["outlook:maya"] })).toEqual(["outlook:maya"]);
    expect(chipLabel(conversation, maya, true)).toBe("Conversation · Q4 renewal (3 emails)");
  });

  it("words the placeholder for each state", () => {
    const p = (o: Partial<Parameters<typeof composerPlaceholder>[0]>) =>
      composerPlaceholder({ busy: false, keys: [], target: null, aiDraftInline: false, ...o });
    expect(p({ busy: true, keys: ["outlook:maya"], target: maya })).toBe("Working… Esc to stop");
    expect(p({ keys: ["a:1", "a:2"], target: maya })).toBe("Ask about these 2 emails…");
    expect(p({ keys: ["outlook:maya"], target: maya })).toBe("Ask about Maya's email…");
    expect(p({ keys: ["outlook:maya"], target: maya, aiDraftInline: true })).toBe("Ask for changes to the draft…");
    expect(p({})).toBe("Ask about all your mail…");
  });

  it("suggests follow-ups from what was last done with the email", () => {
    const base = { busy: false, target: maya, act: undefined, inline: false, aiDraftReady: false, lastQuestion: undefined };
    const labels = (o: Partial<Parameters<typeof threadSuggestions>[0]>) => threadSuggestions({ ...base, ...o }).map((x) => x.label);
    expect(labels({})).toEqual([]);
    expect(labels({ inline: true, aiDraftReady: true })).toEqual(["Make it shorter", "Make it warmer", "Review and send"]);
    // Held, streaming or hand-written drafts get none.
    expect(labels({ inline: true, act: "about" })).toEqual([]);
    expect(labels({ act: "about" })).toEqual(["What do they need from me?", "Any deadlines?", "Earlier from Maya"]);
    expect(labels({ act: "about", lastQuestion: "Any deadlines?" })).toEqual(["What do they need from me?", "Earlier from Maya"]);
    expect(labels({ act: "sent" })).toEqual(["Archive this email", "Earlier from Maya"]);
    expect(labels({ act: "sender" })).toEqual(["Archive this email"]);
    expect(labels({ act: "about", busy: true })).toEqual([]);
    expect(threadSuggestions({ ...base, inline: true, aiDraftReady: true })[2]).toMatchObject({ intent: "send" });
  });

  it("offers starters only while the conversation is empty, with the free walkthrough on first run", () => {
    expect(inboxSuggestions({ busy: false, empty: true, firstRun: true }).map((x) => [x.label, x.intent, !!x.free])).toEqual([
      ["Go through my inbox", "firstrun", true],
      ["What needs a reply?", "needs", false],
      ["File this week's receipts", "receipts", false],
    ]);
    expect(inboxSuggestions({ busy: false, empty: true, firstRun: false })).toHaveLength(2);
    expect(inboxSuggestions({ busy: false, empty: false, firstRun: true })).toEqual([]);
    expect(inboxSuggestions({ busy: true, empty: true, firstRun: true })).toEqual([]);
  });

  it("offers 'Draft a reply' only where a reply makes sense, and nothing while a reply is open", () => {
    expect(looksLikePerson(maya)).toBe(true);
    for (const email of ["receipts@stripe.com", "no-reply@figma.com", "notifications@github.com", "aws-billing@amazon.com", "kale@hackernewsletter.com"]) {
      expect(looksLikePerson({ from: { name: "", email } })).toBe(false);
    }
    expect(standardActions({ target: maya, inline: false }).map((a) => a.label)).toEqual(["Draft a reply", "Summarize"]);
    expect(standardActions({ target: stripe, inline: false }).map((a) => a.label)).toEqual(["Summarize"]);
    expect(standardActions({ target: maya, inline: true })).toEqual([]);
    expect(standardActions({ target: null, inline: false })).toEqual([]);
  });

  it("fits suggestions to the width, always keeping the first", () => {
    const list = [{ label: "What do they need from me?" }, { label: "Any deadlines?" }, { label: "Earlier from Maya" }];
    expect(fitSuggestions(list, 380)).toHaveLength(1);
    expect(fitSuggestions(list, 480).map((x) => x.label)).toEqual(["What do they need from me?", "Any deadlines?"]);
    expect(fitSuggestions(list, 640)).toHaveLength(3);
    expect(fitSuggestions(list, 100)).toHaveLength(1);
    expect(fitSuggestions([], 400)).toEqual([]);
  });

  it("folds requests older than the last three", () => {
    const messages = [1, 2, 3, 4, 5].flatMap((t) => [msg(t, "user"), msg(t)]);
    const v = visibleMessages(messages, false);
    expect(v).toMatchObject({ turns: 5, hidden: 2 });
    expect([...new Set(v.shown.map((m) => m.turn))]).toEqual([3, 4, 5]);
    expect(visibleMessages(messages, true).shown).toHaveLength(10);
    expect(visibleMessages(messages.slice(0, 6), false)).toMatchObject({ hidden: 0 });
    expect(earlierLabel(5, false)).toBe("Show 2 earlier requests");
    expect(earlierLabel(4, false)).toBe("Show 1 earlier request");
    expect(earlierLabel(5, true)).toBe("Show only recent");
  });

  it("words the status line", () => {
    expect(panelStatus({ held: false, busy: false, status: "", progress: null })).toEqual({ text: "Asks before sending", tone: "idle" });
    expect(panelStatus({ held: false, busy: true, status: "Filing Stripe", progress: { i: 2, n: 6 } })).toEqual({ text: "Filing Stripe · 2 of 6", tone: "busy" });
    expect(panelStatus({ held: true, busy: true, status: "Waiting", progress: null })).toEqual({ text: "A reply needs your approval", tone: "held" });
  });
});
