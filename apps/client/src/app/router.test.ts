import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE,
  type Route,
  buildPath,
  canGoBack,
  canonicalizeLocation,
  currentOverlay,
  ensureBackStack,
  getRoute,
  navigate,
  parseLocation,
  pushOverlay,
  resetRouterForTests,
  subscribeRoute,
} from "./router";

const route = (patch: Partial<Route>): Route => ({ ...DEFAULT_ROUTE, ...patch });

describe("parseLocation / buildPath", () => {
  it("defaults to the unified inbox", () => {
    expect(parseLocation("/", "")).toEqual(DEFAULT_ROUTE);
    expect(buildPath(DEFAULT_ROUTE)).toBe("/all/inbox");
  });

  it("round-trips mailbox, folder, message and search", () => {
    const cases: Route[] = [
      route({ scope: "gmail", folder: { role: "sent" } }),
      route({ scope: "all", folder: { name: "Receipts" } }),
      route({ scope: "imap", folder: { inbox_id: "imap", folder_id: "INBOX/Clients & Leads" } }),
      route({ messageKey: "outlook:maya" }),
      route({ scope: "gmail", folder: { role: "archive" }, messageKey: "gmail:AAMk/ab=:c", query: "q4 renewal & more" }),
    ];
    for (const r of cases) {
      const url = new URL(buildPath(r), "https://app.mcpemails.com");
      expect(parseLocation(url.pathname, url.search)).toEqual(r);
    }
  });

  it("encodes every segment", () => {
    expect(buildPath(route({ messageKey: "gmail:maya" }))).toBe("/all/inbox/gmail%3Amaya");
    expect(buildPath(route({ folder: { name: "Receipts" }, query: "a b" }))).toBe("/all/name%3AReceipts?q=a%20b");
  });

  it("falls back to the inbox for an unknown folder and ignores a malformed key", () => {
    expect(parseLocation("/gmail/nonsense/not-a-key", "")).toEqual(route({ scope: "gmail" }));
  });

  it("restores the mail location behind /compose from history state", () => {
    const state = { mail: { scope: "gmail", folder: "sent", messageKey: null, query: "" } };
    expect(parseLocation("/compose", "", state)).toEqual(route({ scope: "gmail", folder: { role: "sent" }, compose: true }));
    expect(parseLocation("/compose", "")).toEqual(route({ compose: true }));
    expect(buildPath(route({ scope: "gmail", compose: true }))).toBe("/compose");
  });
});

describe("navigate", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    resetRouterForTests();
  });

  it("pushes by default and replaces on request", () => {
    const before = window.history.length;
    navigate({ folder: { role: "sent" } });
    expect(window.location.pathname).toBe("/all/sent");
    expect(window.history.length).toBe(before + 1);
    navigate({ messageKey: "gmail:a" }, { replace: true });
    expect(window.location.pathname).toBe("/all/sent/gmail%3Aa");
    expect(window.history.length).toBe(before + 1);
    expect(getRoute().messageKey).toBe("gmail:a");
  });

  it("is a no-op when nothing changes", () => {
    const before = window.history.length;
    const seen: string[] = [];
    const off = subscribeRoute((_r, cause) => seen.push(cause));
    navigate({ scope: "all" });
    expect(window.history.length).toBe(before);
    navigate({ query: "x" });
    expect(seen).toEqual(["navigate"]);
    off();
  });
});

describe("history bookkeeping", () => {
  const land = (url: string) => {
    window.history.replaceState(null, "", url);
    resetRouterForTests();
  };

  beforeEach(() => land("/"));

  it("knows whether Back stays inside the app", () => {
    expect(canGoBack()).toBe(false);
    navigate({ messageKey: "gmail:a" }, { replace: true });
    expect(canGoBack()).toBe(false);
    navigate({ folder: { role: "sent" }, messageKey: null });
    expect(canGoBack()).toBe(true);
    // Replacing keeps the position.
    navigate({ messageKey: "gmail:b" }, { replace: true });
    expect(canGoBack()).toBe(true);
  });

  it("canonicalizes an unknown URL to the route it parsed to", () => {
    canonicalizeLocation();
    expect(window.location.pathname).toBe("/all/inbox");

    land("/all/nonsense/not-a-key/extra?q=a%20b#frag");
    canonicalizeLocation();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/all/inbox?q=a%20b");
    expect(getRoute()).toEqual(route({ query: "a b" }));
  });

  it("puts the list under a deep-linked message, once", () => {
    land("/gmail/sent/gmail%3Aa?q=x");
    const before = window.history.length;
    ensureBackStack();
    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname).toBe("/gmail/sent/gmail%3Aa");
    expect(getRoute().messageKey).toBe("gmail:a");
    expect(canGoBack()).toBe(true);
    ensureBackStack();
    expect(window.history.length).toBe(before + 1);
  });

  it("leaves a plain list URL alone", () => {
    land("/all/inbox");
    const before = window.history.length;
    ensureBackStack();
    expect(window.history.length).toBe(before);
    expect(canGoBack()).toBe(false);
  });

  it("gives /compose a list entry to go back to", () => {
    land("/compose");
    ensureBackStack();
    expect(window.location.pathname).toBe("/compose");
    expect(getRoute().compose).toBe(true);
    expect(canGoBack()).toBe(true);
  });

  it("steps back instead of leaving a duplicate entry when a pushed view is closed with a replace", async () => {
    navigate({ folder: { role: "sent" } });
    // Opened from the list (push), then closed the way the stores do it (replace).
    navigate({ messageKey: "gmail:a" });
    const pops: string[] = [];
    const off = subscribeRoute((r, cause) => {
      if (cause === "pop") pops.push(buildPath(r));
    });
    navigate({ messageKey: null }, { replace: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(pops).toEqual(["/all/sent"]);
    expect(window.location.pathname).toBe("/all/sent");
    off();
  });

  it("does not step back when the replace lands somewhere else, or another navigation followed", async () => {
    navigate({ folder: { role: "sent" } });
    navigate({ messageKey: "gmail:a" });
    const pops: string[] = [];
    const off = subscribeRoute((_r, cause) => {
      if (cause === "pop") pops.push("pop");
    });
    // j / k in the reader: a replace to a different message.
    navigate({ messageKey: "gmail:b" }, { replace: true });
    // Close, then immediately go elsewhere: the newer navigation must survive.
    navigate({ messageKey: null }, { replace: true });
    navigate({ folder: { role: "drafts" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(pops).toEqual([]);
    expect(window.location.pathname).toBe("/all/drafts");
    off();
  });

  it("pushes an overlay entry on the same URL and does not stack it twice", () => {
    navigate({ folder: { role: "sent" } });
    const before = window.history.length;
    const url = window.location.href;
    pushOverlay("chat");
    pushOverlay("chat");
    expect(window.history.length).toBe(before + 1);
    expect(window.location.href).toBe(url);
    expect(currentOverlay()).toBe("chat");
    expect(canGoBack()).toBe(true);
    // A replace on top of it turns the entry into an ordinary one.
    navigate({ messageKey: "gmail:a" }, { replace: true });
    expect(currentOverlay()).toBeNull();
  });
});
