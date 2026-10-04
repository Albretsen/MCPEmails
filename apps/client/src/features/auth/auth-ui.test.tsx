import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../../api/types";
import { Gate } from "../../app/Gate";
import { type AuthBackend, AuthFailure, EMPTY_SESSION, initAuth, useAuthStore, useSessionStore } from "../../auth";
import { resetAuthForTests } from "../../auth/auth-store";
import { useUiStore } from "../../state/ui-store";
import { AccountMenu } from "../sidebar/AccountMenu";
import { LoginScreen } from "./Login";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const calls: string[] = [];

const backend: AuthBackend = {
  getSession: async () => null,
  refreshSession: async () => null,
  onChange: () => () => {},
  signInWithPassword: async (email, password) => {
    calls.push(`password:${email}`);
    if (password !== "right") throw new AuthFailure("That email and password do not match.", "invalid_credentials");
    return { access_token: "t", user: { id: "u1", email, name: null } };
  },
  sendMagicLink: async (email) => {
    calls.push(`link:${email}`);
  },
  signInWithOAuth: async (provider) => {
    calls.push(`oauth:${provider}`);
  },
  exchangeCode: async () => null,
  signOut: async () => {},
};

const session: SessionInfo = {
  user: { id: "u1", email: "me@example.com", display_name: "Me Myself" },
  workspaces: [
    { id: "w1", display_name: "Acme", role: "owner", plan: "solo", web_client_enabled: true },
    { id: "w2", display_name: "Side project", role: "member", plan: "free", web_client_enabled: false },
  ],
  workspace_id: "w1",
  role: "owner",
  inboxes: [],
  allowance: { plan: "solo", used: 0, cap: 1000, remaining: 1000, period_start: "", resets_at: "" },
};

const render = (node: React.ReactNode) => act(async () => root.render(node));
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
const q = <T extends Element>(sel: string) => host.querySelector<T>(sel);
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const message = () => q<HTMLElement>("p[role]");

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: Element | undefined | null) => act(async () => void (el as HTMLElement).click());

beforeEach(async () => {
  calls.length = 0;
  resetAuthForTests();
  useSessionStore.setState(EMPTY_SESSION);
  useUiStore.setState({ menu: null });
  await initAuth(backend);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("login screen", () => {
  it("has labelled fields, every way to sign in, and the two links out", async () => {
    await render(<LoginScreen />);
    const email = q<HTMLInputElement>('input[type="email"]');
    const password = q<HTMLInputElement>('input[type="password"]');
    expect(email?.labels?.[0]?.textContent).toBe("Email");
    expect(password?.labels?.[0]?.textContent).toBe("Password");
    expect(email?.autocomplete).toBe("username");
    expect(password?.autocomplete).toBe("current-password");
    expect(document.activeElement).toBe(email);
    for (const name of ["Sign in", "Email me a sign-in link", "Continue with Google", "Continue with GitHub"]) {
      expect(button(name), name).toBeTruthy();
    }
    const links = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://mcpemails.com/forgot-password", "https://mcpemails.com/signup"]);
    expect(q("h1")?.textContent).toBe("Sign in");
  });

  it("the message line is always there, so errors do not move the buttons", async () => {
    await render(<LoginScreen />);
    expect(message()).toBeTruthy();
    expect(message()?.textContent).toBe("");
    expect(message()?.getAttribute("role")).toBe("status");
  });

  it("validates before asking the server, and points at the field", async () => {
    await render(<LoginScreen />);
    await click(button("Sign in"));
    expect(message()?.textContent).toBe("Enter your email address.");
    expect(message()?.getAttribute("role")).toBe("alert");
    const email = q<HTMLInputElement>('input[type="email"]');
    expect(email?.getAttribute("aria-invalid")).toBe("true");
    expect(email?.getAttribute("aria-describedby")).toBe(message()?.id);
    expect(document.activeElement).toBe(email);
    expect(calls).toEqual([]);
  });

  it("shows the server's reason inline and keeps what was typed", async () => {
    await render(<LoginScreen />);
    const email = q<HTMLInputElement>('input[type="email"]') as HTMLInputElement;
    const password = q<HTMLInputElement>('input[type="password"]') as HTMLInputElement;
    await type(email, "me@example.com");
    await type(password, "wrong");
    await click(button("Sign in"));
    await settle();
    expect(calls).toEqual(["password:me@example.com"]);
    expect(message()?.textContent).toBe("That email and password do not match.");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(email.value).toBe("me@example.com");
    expect(button("Sign in")?.disabled).toBe(false);
  });

  it("signs in with the right password", async () => {
    await render(<LoginScreen />);
    await type(q<HTMLInputElement>('input[type="email"]') as HTMLInputElement, "me@example.com");
    await type(q<HTMLInputElement>('input[type="password"]') as HTMLInputElement, "right");
    await click(button("Sign in"));
    await settle();
    expect(useAuthStore.getState().status).toBe("signed-in");
  });

  it("emails a sign-in link to the address in the field", async () => {
    await render(<LoginScreen />);
    await type(q<HTMLInputElement>('input[type="email"]') as HTMLInputElement, "me@example.com");
    await click(button("Email me a sign-in link"));
    await settle();
    expect(calls).toEqual(["link:me@example.com"]);
    expect(message()?.textContent).toMatch(/^Check me@example.com for a sign-in link/);
    expect(message()?.getAttribute("role")).toBe("status");
  });

  it("starts the provider flows", async () => {
    await render(<LoginScreen />);
    await click(button("Continue with Google"));
    await settle();
    expect(calls).toEqual(["oauth:google"]);
  });

  it("shows why the last session ended", async () => {
    useAuthStore.setState({ notice: "Your session ended. Sign in again to continue." });
    await render(<LoginScreen />);
    expect(message()?.textContent).toBe("Your session ended. Sign in again to continue.");
  });
});

describe("gate", () => {
  const app = <div data-app="">mail</div>;
  const shown = () => (q("[data-app]") ? "app" : (q("h1")?.textContent ?? q('[role="status"]')?.getAttribute("aria-label") ?? ""));
  const signIn = () => useAuthStore.setState({ status: "signed-in", user: { id: "u1", email: "me@example.com", name: null } });

  it("signed out shows the login screen", async () => {
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("Sign in");
  });

  it("not known yet shows a neutral frame, never the app", async () => {
    useAuthStore.setState({ status: "loading" });
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("Loading mcpemails");
  });

  it("signed in shows the app while /session is still loading", async () => {
    signIn();
    useSessionStore.setState({ status: "loading" });
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("app");
  });

  it("a workspace without the web client gets the notice, both ways the server can say it", async () => {
    signIn();
    useSessionStore.setState({ status: "error", errorCode: "web_client_disabled" });
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("The web client is not enabled here yet");
    expect(host.querySelector('a[href="https://mcpemails.com/dashboard"]')).toBeTruthy();

    await act(async () => {
      useSessionStore.setState({ status: "ready", errorCode: null, session: { ...session, workspace_id: "w2" } });
    });
    expect(shown()).toBe("The web client is not enabled here yet");
    // The enabled workspace is offered.
    expect(button("Acme")).toBeTruthy();
  });

  it("no mailbox: a prompt to connect one, but only on the server's word", async () => {
    signIn();
    useSessionStore.setState({ status: "ready", session, fromCache: true });
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("app");
    await act(async () => useSessionStore.setState({ fromCache: false }));
    expect(shown()).toBe("Connect a mailbox to get started");
  });

  it("a failed load with nothing cached says so with a way to retry", async () => {
    signIn();
    useSessionStore.setState({ status: "error", errorCode: "timeout" });
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("Could not load your account");
    expect(button("Try again")).toBeTruthy();
  });

  it("a failed refresh with a cached session keeps the app up", async () => {
    signIn();
    useSessionStore.setState({ status: "error", errorCode: "network", fromCache: true, session: { ...session, inboxes: [] } });
    await render(<Gate>{app}</Gate>);
    expect(shown()).toBe("app");
  });
});

describe("account menu", () => {
  it("shows who is signed in and opens a menu with workspaces, settings and sign out", async () => {
    useAuthStore.setState({ status: "signed-in", user: { id: "u1", email: "me@example.com", name: null } });
    useSessionStore.setState({ status: "ready", session });
    await render(<AccountMenu rail={false} />);
    const trigger = q<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toContain("Me Myself");
    expect(trigger?.textContent).toContain("Acme · Pro");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(q('[role="menu"]')).toBeNull();

    await click(trigger);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual([
      "AcmePro",
      "Side projectWeb client not enabled",
      "Conversation viewOn: replies are grouped with the email they answer",
      "Notifications",
      "Dashboard settings",
      "Sign out",
    ]);
    expect(q('[role="menu"]')?.textContent).toContain("me@example.com");
  });

  it("has no workspace list for a single workspace", async () => {
    useAuthStore.setState({ status: "signed-in", user: { id: "u1", email: "me@example.com", name: null } });
    useSessionStore.setState({ status: "ready", session: { ...session, workspaces: session.workspaces.slice(0, 1) } });
    await render(<AccountMenu rail={false} />);
    await click(q('button[aria-haspopup="menu"]'));
    expect([...host.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual([
      "Conversation viewOn: replies are grouped with the email they answer",
      "Notifications",
      "Dashboard settings",
      "Sign out",
    ]);
  });
});
