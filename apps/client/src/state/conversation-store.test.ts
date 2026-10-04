import { beforeEach, describe, expect, it } from "vitest";
import type { MessageKey } from "../api/types";
import { replyTargetOf, selectExpanded, useThreadStore } from "./conversation-store";

const T = () => useThreadStore.getState();
const m = (key: string, is_read = true) => ({ key: key as MessageKey, is_read });
const open = (key: string) => selectExpanded(key as MessageKey)(T());

beforeEach(() => T().clear());

describe("the open thread", () => {
  it("opens with the latest message and every unread one expanded, the latest focused", () => {
    T().sync("conv", [m("a:1"), m("a:2", false), m("a:3"), m("a:4")]);
    expect(["a:1", "a:2", "a:3", "a:4"].map(open)).toEqual([false, true, false, true]);
    expect(T().focused).toBe("a:4");
  });

  it("messages found later are ADDED: nothing that is open collapses, the focus stays, new unread ones open", () => {
    T().sync("conv", [m("a:1"), m("a:3", false), m("a:4")]);
    T().toggle("a:1" as MessageKey); // the person opened the oldest
    T().focus("a:3" as MessageKey);
    // Opening marked a:3 read; the thread op then inserts a Sent message and an unread one.
    T().sync("conv", [m("a:0", false), m("a:1"), m("a:2"), m("a:3"), m("a:4")]);
    expect(["a:0", "a:1", "a:2", "a:3", "a:4"].map(open)).toEqual([true, true, false, true, true]);
    expect(T().focused).toBe("a:3");
    expect(T().order).toEqual(["a:0", "a:1", "a:2", "a:3", "a:4"]);
  });

  it("a new latest message (a reply arrives) is expanded; the conversation's state is not started over", () => {
    T().sync("conv", [m("a:1"), m("a:2")]);
    T().toggle("a:1" as MessageKey);
    T().sync("conv", [m("a:1"), m("a:2"), m("a:3", false)]);
    expect(["a:1", "a:2", "a:3"].map(open)).toEqual([true, true, true]);
    expect(T().focused).toBe("a:1");
  });

  it("another conversation starts over", () => {
    T().sync("conv", [m("a:1"), m("a:2")]);
    T().toggle("a:1" as MessageKey);
    T().sync("other", [m("b:1"), m("b:2")]);
    expect(["b:1", "b:2"].map(open)).toEqual([false, true]);
    expect([T().focused, T().toggled]).toEqual(["b:2", {}]);
  });

  it("toggle expands and collapses and takes the focus; step moves it and stops at the ends", () => {
    T().sync("conv", [m("a:1"), m("a:2"), m("a:3")]);
    T().toggle("a:3" as MessageKey);
    expect(open("a:3")).toBe(false);
    T().toggle("a:3" as MessageKey);
    expect(open("a:3")).toBe(true);
    expect(T().step(1)).toBeNull();
    expect(T().step(-1)).toBe("a:2");
    expect(T().step(-1)).toBe("a:1");
    expect(T().step(-1)).toBeNull();
    expect(T().focused).toBe("a:1");
  });

  it("a link to one message of a conversation focuses and expands that message", () => {
    T().wantFocus("a:1" as MessageKey);
    T().sync("conv", [m("a:1"), m("a:2"), m("a:3")]);
    expect([T().focused, open("a:1"), T().wanted]).toEqual(["a:1", true, null]);
    // Asked for while the thread is already open.
    T().wantFocus("a:2" as MessageKey);
    T().sync("conv", [m("a:1"), m("a:2"), m("a:3")]);
    expect([T().focused, open("a:2"), T().wanted]).toEqual(["a:2", true, null]);
  });

  it("the reply target is the focused message of the open thread, else the open row", () => {
    expect(replyTargetOf(null)).toBeNull();
    expect(replyTargetOf("a:9" as MessageKey)).toBe("a:9");
    T().sync("conv", [m("a:1"), m("a:2"), m("a:3")]);
    expect(replyTargetOf("a:3" as MessageKey)).toBe("a:3");
    T().focus("a:1" as MessageKey);
    expect(replyTargetOf("a:3" as MessageKey)).toBe("a:1");
    // A row that is not part of the open thread.
    expect(replyTargetOf("b:7" as MessageKey)).toBe("b:7");
    // A single message is not a thread.
    T().sync("one", [m("c:1")]);
    expect(replyTargetOf("c:1" as MessageKey)).toBe("c:1");
  });
});
