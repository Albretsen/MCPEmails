import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../../api/types";
import type { EnableResult, InboxPushPreference, PushController, PushPreferences, PushState } from "../../app/push";
import { EMPTY_SESSION, useSessionStore } from "../../auth";
import { useToastStore } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { NotificationSettings } from "./NotificationSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const session = {
  user: { id: "u1", email: "me@example.com", display_name: "Me" },
  workspaces: [{ id: "w1", display_name: "Acme", role: "owner", plan: "solo", web_client_enabled: true }],
  workspace_id: "w1",
  role: "owner",
  inboxes: [
    { inbox_id: "i1", email_address: "work@example.com", display_name: "Work", provider: "imap", sender_identities: [] },
    { inbox_id: "i2", email_address: "home@example.com", display_name: "", provider: "gmail", sender_identities: [] },
  ],
  allowance: { plan: "solo", used: 0, cap: 1000, remaining: 1000, period_start: "", resets_at: "" },
} as unknown as SessionInfo;

function fakeController(initial: Partial<PushState> = {}) {
  const calls: string[] = [];
  const server = {
    state: { availability: "ready", permission: "default", subscribed: false, ...initial } as PushState,
    prefs: {
      configured: true,
      subscribed_devices: 0,
      inboxes: [
        { inbox_id: "i1", enabled: true, payload_mode: "rich", quiet_hours: null },
        { inbox_id: "i2", enabled: true, payload_mode: "rich", quiet_hours: null },
      ],
    } as PushPreferences,
    enableResult: "enabled" as EnableResult,
    saved: [] as Array<Array<Partial<InboxPushPreference> & { inbox_id: string }>>,
    failSave: false,
    test: { devices: 1, sent: 1, failed: 0, expired: 0 },
  };
  const controller: PushController = {
    state: async () => server.state,
    enable: async () => {
      calls.push("enable");
      if (server.enableResult === "enabled") server.state = { availability: "ready", permission: "granted", subscribed: true };
      return server.enableResult;
    },
    disable: async () => {
      calls.push("disable");
      server.state = { ...server.state, subscribed: false };
    },
    sync: async () => {},
    signOut: async () => {},
    preferences: async () => {
      calls.push("preferences");
      return structuredClone(server.prefs);
    },
    savePreferences: async (changes) => {
      calls.push("save");
      server.saved.push(changes);
      if (server.failSave) throw new Error("nope");
      const byId = new Map(changes.map((c) => [c.inbox_id, c]));
      server.prefs.inboxes = server.prefs.inboxes.map((p) => ({ ...p, ...(byId.get(p.inbox_id) ?? {}) }));
      return structuredClone(server.prefs.inboxes);
    },
    sendTest: async () => {
      calls.push("test");
      return server.test;
    },
  };
  return { controller, calls, server };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
const render = async (controller: PushController | null) => {
  await act(async () => root.render(<NotificationSettings controller={controller} />));
  await settle();
};
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const switches = () => [...host.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const click = async (el: HTMLElement | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
  await settle();
};
const toast = () => useToastStore.getState().toast?.text ?? null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useSessionStore.setState({ session, status: "ready", fromCache: false, errorCode: null });
  useToastStore.getState().dismiss();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSessionStore.setState(EMPTY_SESSION);
  useUiStore.getState().setMenu(null);
});

describe("Notifications settings", () => {
  it("opening it asks for nothing: permission is requested only by the Turn on button", async () => {
    const f = fakeController();
    await render(f.controller);
    expect(f.calls).toEqual(["preferences"]);
    expect(host.textContent).toContain("Notifications are off");
    expect(button("Send test notification")!.disabled).toBe(true);

    await click(button("Turn on notifications"));
    expect(f.calls.filter((c) => c === "enable")).toHaveLength(1);
    expect(toast()).toBe("Notifications are on");
    expect(host.textContent).toContain("Notifications are on");
    expect(button("Turn off")).toBeTruthy();
    expect(button("Send test notification")!.disabled).toBe(false);
  });

  it("lists every mailbox by name with its own switch, and saves a change for that mailbox only", async () => {
    const f = fakeController({ permission: "granted", subscribed: true });
    await render(f.controller);
    expect(host.textContent).toContain("Work");
    expect(host.textContent).toContain("home@example.com"); // no display name: the address
    const [work, home] = switches();
    expect([work!.checked, home!.checked]).toEqual([true, true]);
    await click(home);
    expect(f.server.saved).toEqual([[{ inbox_id: "i2", enabled: false }]]);
    expect(switches()[1]!.checked).toBe(false);
  });

  it("the payload mode applies to all mailboxes: Show sender and subject, or Private", async () => {
    const f = fakeController({ permission: "granted", subscribed: true });
    await render(f.controller);
    expect(host.textContent).toContain("Show sender and subject");
    expect(host.textContent).toContain("Private");
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
    await click(radios()[1]);
    expect(f.server.saved).toEqual([[
      { inbox_id: "i1", payload_mode: "private" },
      { inbox_id: "i2", payload_mode: "private" },
    ]]);
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
  });

  it("quiet hours: on with a default window in the local time zone, off again with null", async () => {
    const f = fakeController({ permission: "granted", subscribed: true });
    await render(f.controller);
    const quiet = () => switches()[2]!;
    await click(quiet());
    const saved = f.server.saved[0]!;
    expect(saved.map((s) => s.inbox_id)).toEqual(["i1", "i2"]);
    expect(saved[0]!.quiet_hours).toMatchObject({ start: "22:00", end: "07:00" });
    expect(typeof saved[0]!.quiet_hours!.timezone).toBe("string");
    expect(host.querySelectorAll('input[type="time"]')).toHaveLength(2);
    await click(quiet());
    expect(f.server.saved[1]).toEqual([{ inbox_id: "i1", quiet_hours: null }, { inbox_id: "i2", quiet_hours: null }]);
  });

  it("a save that fails puts the switch back and says so", async () => {
    const f = fakeController({ permission: "granted", subscribed: true });
    f.server.failSave = true;
    await render(f.controller);
    await click(switches()[0]);
    expect(switches()[0]!.checked).toBe(true);
    expect(toast()).toBe("That setting could not be saved.");
  });

  it("Send test notification reports what happened", async () => {
    const f = fakeController({ permission: "granted", subscribed: true });
    await render(f.controller);
    await click(button("Send test notification"));
    expect(f.calls).toContain("test");
    expect(toast()).toBe("Test notification sent");
    f.server.test = { devices: 1, sent: 0, failed: 0, expired: 1 };
    await click(button("Send test notification"));
    expect(toast()).toContain("could not be delivered");
  });

  it("Turn off unsubscribes this device", async () => {
    const f = fakeController({ permission: "granted", subscribed: true });
    await render(f.controller);
    await click(button("Turn off"));
    expect(f.calls).toContain("disable");
    expect(host.textContent).toContain("Notifications are off");
  });

  it("iPhone in a browser tab: the Add to Home Screen guidance, and the button cannot be pressed", async () => {
    const f = fakeController({ availability: "needs_install" });
    await render(f.controller);
    expect(host.textContent).toContain("Add to Home Screen");
    expect(button("Turn on notifications")!.disabled).toBe(true);
    await act(async () => button("Turn on notifications")!.click());
    expect(f.calls).not.toContain("enable");
  });

  it("blocked, unsupported and a build without push each say what is wrong", async () => {
    for (const [availability, text] of [
      ["blocked", "blocked for this site"],
      ["unsupported", "does not support notifications"],
      ["unavailable", "not available in this version"],
    ] as const) {
      const f = fakeController({ availability });
      await render(f.controller);
      expect(host.textContent).toContain(text);
      expect(button("Turn on notifications")!.disabled).toBe(true);
    }
  });

  it("a refused permission prompt is explained and nothing is switched on", async () => {
    const f = fakeController();
    f.server.enableResult = "blocked";
    await render(f.controller);
    await click(button("Turn on notifications"));
    expect(toast()).toContain("Notifications are blocked");
    expect(host.textContent).toContain("Notifications are off");
  });

  it("without a push controller (the demo) it says so and offers nothing", async () => {
    await render(null);
    expect(host.textContent).toContain("not available in the demo");
    expect(button("Send test notification")!.disabled).toBe(true);
  });

  it("is a modal dialog with a title and a Close button", async () => {
    const f = fakeController();
    useUiStore.getState().setMenu("notifications");
    await render(f.controller);
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Notifications");
    await click(host.querySelector<HTMLButtonElement>('button[aria-label="Close"]') ?? undefined);
    expect(useUiStore.getState().menu).toBeNull();
  });
});
