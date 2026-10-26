// ---------------------------------------------------------------------------
// The answer a tool call gets when the workspace has no mailbox yet.
//
// WHO SEES IT. Mostly connector-first users: they added MCPEmails in Claude,
// ChatGPT, Cursor or VS Code, created an account inside the OAuth detour, and
// asked their first question before connecting an inbox. 92% of them call a
// tool before they have an inbox, so this text is what nearly all of them read
// (onboarding report 02, R5). 38% never come back.
//
// WHAT IT ADDS to the two no-inbox answers index.ts already builds (the empty
// `inbox_list` with `setup_required`, and the `no_inbox_connected` error every
// other tool returns):
//
//   1. The provider guessed from the account email's domain, named in one
//      declarative sentence ("Your account email is a Gmail address.
//      Connecting Gmail takes an app password, about 2 minutes."). No
//      "about a minute" for Gmail, iCloud or Yahoo: an app password is not a
//      one-minute job.
//   2. A signed, short-lived connect URL:
//        /dashboard/inboxes?from=chat&client=<chip id>&provider=<guess>&exp=…&sig=…
//      The web page checks the signature against the signed-in user's active
//      workspace (apps/web/src/lib/onboarding/chat-connect-link.ts) and only
//      then switches to "from chat" mode: the connect step alone, then
//      "Connected. Go back to Claude and ask again". A workspace in the new
//      onboarding flow is sent on to /onboarding with the same parameters. A
//      link that fails the check still opens the normal dashboard with the
//      provider preselected, so a bad signature costs a nicety, never the
//      connect.
//   3. When the workspace failed a connect in the last 48 hours: the reason in
//      plain words and a three-step fix the model can walk the user through.
//   4. `_meta["mcpemails/setup_required"]` and `_meta["mcpemails/connect_url"]`
//      for clients that act on result metadata. Never a price or a plan.
//
// THE SIGNATURE. key = HMAC-SHA256(ENCRYPTION_KEY bytes, "mcpe-chat-connect-link-v1");
// sig = base64url-nopad(HMAC-SHA256(key, "v1|<workspace>|<exp>|<provider>|<client>")).
// ENCRYPTION_KEY is the one secret both this function and the web app already
// hold with the same value (stored mailbox credentials are written by one and
// read by the other), and the label keeps this use apart from encryption. The
// web side mirrors this contract and the shared test vector in
// no-inbox-answer.test.ts / chat-connect-link.test.ts; change both or neither.
//
// FAILURE. Every lookup is best effort. Without the account email the text
// names no provider; without the secret the URL is unsigned (still the right
// page, just not chat mode); any thrown error leaves index.ts's original text
// in place. A no-inbox answer must never get worse because this broke.
// ---------------------------------------------------------------------------

/** Providers the connect page can preselect (apps/web MODAL_CARD_BY_SLUG). */
export type ProviderGuess = "gmail" | "outlook" | "icloud" | "yahoo" | "fastmail" | "zoho" | "yandex";

/** The client chip ids the web app knows (apps/web/src/lib/onboarding/clients.mjs). */
const CHIP_CLIENTS = new Set([
  "claude", "chatgpt", "claude_code", "cursor", "vscode", "cline", "windsurf",
  "gemini", "zed", "jetbrains", "raycast", "warp", "curl",
]);

/** How long a connect link stays in chat mode. Users who return, return within the hour. */
export const CONNECT_LINK_TTL_SECONDS = 24 * 60 * 60;

/** A failed connect older than this is not mentioned. */
export const RECENT_FAILURE_MS = 48 * 60 * 60 * 1000;

const SIGNING_LABEL = "mcpe-chat-connect-link-v1";

const PROVIDER_LABEL: Record<ProviderGuess, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  icloud: "iCloud Mail",
  yahoo: "Yahoo Mail",
  fastmail: "Fastmail",
  zoho: "Zoho Mail",
  yandex: "Yandex Mail",
};

/** "a Gmail address", "an iCloud address", ... */
const ADDRESS_NOUN: Record<ProviderGuess, string> = {
  gmail: "a Gmail address",
  outlook: "an Outlook address",
  icloud: "an iCloud address",
  yahoo: "a Yahoo address",
  fastmail: "a Fastmail address",
  zoho: "a Zoho address",
  yandex: "a Yandex address",
};

/** What connecting takes. Declarative, and no "about a minute" for app-password providers. */
const CONNECT_EFFORT: Record<ProviderGuess, string> = {
  gmail: "Connecting Gmail takes an app password, about 2 minutes.",
  icloud: "Connecting iCloud Mail takes an app-specific password, about 2 minutes.",
  yahoo: "Connecting Yahoo Mail takes an app password, about 2 minutes.",
  outlook: "Connecting Outlook is a Microsoft sign-in; there is no password to copy.",
  fastmail: "Connecting Fastmail takes an app password from Fastmail's settings.",
  zoho: "Connecting Zoho Mail takes the mailbox password, or an app-specific password when two-factor sign-in is on.",
  yandex: "Connecting Yandex Mail takes an app password.",
};

const EXACT_DOMAINS: Record<string, ProviderGuess> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "msn.com": "outlook",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "messagingengine.com": "fastmail",
  "zohomail.com": "zoho",
  "zohomail.eu": "zoho",
  "ya.ru": "yandex",
};

/** First-label families that only ever belong to one provider (hotmail.co.uk, yahoo.fr, ...). */
const FAMILY_LABELS: Record<string, ProviderGuess> = {
  outlook: "outlook",
  hotmail: "outlook",
  live: "outlook",
  windowslive: "outlook",
  yahoo: "yahoo",
  fastmail: "fastmail",
  zoho: "zoho",
  yandex: "yandex",
};

/**
 * The provider an address most likely lives at, from its domain alone, or null
 * (a company domain, a typo, nothing at all). A wrong guess is harmless: it
 * only preselects a card the user can change.
 */
export function guessProviderFromEmail(email: string | null | undefined): ProviderGuess | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (EXACT_DOMAINS[domain]) return EXACT_DOMAINS[domain];
  const labels = domain.split(".");
  // Only "<family>.<tld>" or "<family>.<sld>.<tld>" (hotmail.co.uk), never a
  // subdomain of some other company (outlook.example.com).
  if (labels.length > 3) return null;
  if (labels.length === 3 && labels[1].length > 3) return null;
  return FAMILY_LABELS[labels[0]] ?? null;
}

/**
 * The client chip id for this request: the User-Agent first, then the OAuth
 * key's name ("Claude · Oct 2026"), else null. Never stored; it only rides on
 * the connect URL so the page can say "Go back to Claude".
 */
export function chatClientFor(userAgent: string | null | undefined, keyName: string | null | undefined): string | null {
  for (const source of [userAgent, keyName]) {
    const text = (source ?? "").toLowerCase();
    if (!text) continue;
    if (text.includes("claude-code") || text.includes("claude code")) return "claude_code";
    if (text.includes("claude")) return "claude";
    if (text.includes("chatgpt") || text.includes("openai")) return "chatgpt";
    if (text.includes("visual studio code") || text.includes("vscode") || text.includes("vs code")) return "vscode";
    for (const id of ["cursor", "cline", "windsurf", "gemini", "zed", "jetbrains", "raycast", "warp"]) {
      if (text.includes(id)) return id;
    }
  }
  return null;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0 || clean.length < 32) return null;
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: Uint8Array<ArrayBuffer>, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

/** The payload both sides sign. */
export function connectLinkPayload(workspaceId: string, exp: number, provider: string | null, client: string | null): string {
  return `v1|${workspaceId.toLowerCase()}|${exp}|${provider ?? ""}|${client ?? ""}`;
}

/** The signature for one link, or null when the key is unusable. */
export async function signConnectLink(
  keyHex: string | null | undefined,
  workspaceId: string,
  exp: number,
  provider: string | null,
  client: string | null,
): Promise<string | null> {
  const secret = typeof keyHex === "string" ? hexBytes(keyHex) : null;
  if (!secret) return null;
  const signingKey = new Uint8Array(await hmac(secret, SIGNING_LABEL));
  return base64Url(await hmac(signingKey, connectLinkPayload(workspaceId, exp, provider, client)));
}

/**
 * The connect URL. Signed when the key is usable; unsigned (provider and client
 * hints only) otherwise.
 */
export async function buildConnectUrl(input: {
  appUrl: string;
  workspaceId: string;
  provider: ProviderGuess | null;
  client: string | null;
  keyHex: string | null | undefined;
  nowMs: number;
}): Promise<string> {
  const url = new URL("/dashboard/inboxes", input.appUrl);
  const client = input.client && CHIP_CLIENTS.has(input.client) ? input.client : null;
  if (input.provider) url.searchParams.set("provider", input.provider);
  url.searchParams.set("from", "chat");
  if (client) url.searchParams.set("client", client);
  const exp = Math.floor(input.nowMs / 1000) + CONNECT_LINK_TTL_SECONDS;
  const sig = await signConnectLink(input.keyHex, input.workspaceId, exp, input.provider, client).catch(() => null);
  if (sig) {
    url.searchParams.set("exp", String(exp));
    url.searchParams.set("sig", sig);
  }
  return url.toString();
}

/** A failed connect as product_funnel_events stores it. */
export interface ConnectFailure {
  provider: string | null;
  errorCategory: string | null;
  authReason: string | null;
}

export interface ConnectFix {
  /** One sentence on what went wrong. */
  reason: string;
  /** Exactly three steps. */
  steps: [string, string, string];
}

const APP_PASSWORD_STEPS: Record<string, [string, string, string]> = {
  gmail: [
    "Turn on 2-Step Verification for the Google account at https://myaccount.google.com/security (skip this if it is already on).",
    "Create an app password at https://myaccount.google.com/apppasswords and copy the 16 characters.",
    "Paste that app password, not the Google password, into the connect page and connect again.",
  ],
  yahoo: [
    "Open https://login.yahoo.com/account/security and sign in.",
    "Choose \"Generate app password\", name it MCPEmails and copy it.",
    "Paste that app password, not the Yahoo password, into the connect page and connect again.",
  ],
  icloud: [
    "Sign in at https://account.apple.com and open Sign-In and Security, then App-Specific Passwords.",
    "Create one named MCPEmails and copy it.",
    "Paste that password, not the Apple Account password, into the connect page and connect again.",
  ],
};

const GENERIC_APP_PASSWORD_STEPS: [string, string, string] = [
  "Open the mail provider's account security settings.",
  "Create an app password for mail and copy it.",
  "Paste that app password, not the account password, into the connect page and connect again.",
];

/** The reason and a three-step fix for the last failed connect, or null when there is nothing useful to say. */
export function connectFixFor(failure: ConnectFailure | null | undefined): ConnectFix | null {
  if (!failure) return null;
  const provider = failure.provider ?? "";
  const label = PROVIDER_LABEL[provider as ProviderGuess] ?? "The mail provider";
  switch (failure.authReason) {
    case "app_password_required":
    case "account_password_used":
      return {
        reason: `${label} refused the account password; it only accepts an app password.`,
        steps: APP_PASSWORD_STEPS[provider] ?? GENERIC_APP_PASSWORD_STEPS,
      };
    case "app_password_length":
      return {
        reason: "The app password that was pasted looked incomplete.",
        steps: [
          "Create a fresh app password with the mail provider.",
          "Copy all of it; spaces in it do not matter.",
          "Paste it into the connect page and connect again.",
        ],
      };
    case "imap_disabled":
      return {
        reason: "IMAP access is switched off for this mailbox.",
        steps: [
          "Open the mailbox's settings on the provider's website.",
          "Find the IMAP (or \"access from other mail apps\") setting and turn it on.",
          "Connect again on the connect page.",
        ],
      };
    case "password_rejected":
      return {
        reason: "The mailbox rejected the password.",
        steps: [
          "Check that the mailbox address is spelled correctly.",
          "Create a new app password with the provider (or check the mailbox password if the provider does not use app passwords).",
          "Paste it into the connect page and connect again.",
        ],
      };
    case "provider_refused_signin":
      return {
        reason: "The provider blocked the sign-in as a security precaution.",
        steps: [
          "Sign in to the mailbox in a web browser and approve any security alert about a new sign-in.",
          "Wait a few minutes.",
          "Connect again on the connect page.",
        ],
      };
    case "login_username_required":
      return {
        reason: "This mailbox signs in with a username that is not the email address.",
        steps: [
          "Find the IMAP username in the provider's help pages or settings.",
          "On the connect page, open Advanced and enter it as the username.",
          "Connect again.",
        ],
      };
  }
  switch (failure.errorCategory) {
    case "provider_denied":
      return {
        reason: "The Microsoft sign-in was cancelled before access was granted.",
        steps: [
          "Open the connect page and choose Outlook again.",
          "Sign in with the Microsoft account that owns the mailbox.",
          "Accept the permissions screen to finish.",
        ],
      };
    case "consent_required":
      return {
        reason: "The organization's Microsoft 365 settings need an administrator to approve MCPEmails first.",
        steps: [
          "On the connect page, choose Outlook and copy the admin approval link.",
          "Send it to the organization's IT administrator.",
          "Connect again once they have approved it.",
        ],
      };
    case "plan_limit":
      return null;
  }
  return {
    reason: "The last attempt to connect a mailbox did not finish.",
    steps: [
      "Open the connect page.",
      "Check the mailbox address and the password (Gmail, iCloud and Yahoo need an app password).",
      "Connect again; if it fails, the page shows the exact error.",
    ],
  };
}

/** The no-inbox text, for the empty inbox_list (`list`) or another tool's error (`error`). */
export function noInboxText(input: {
  mode: "list" | "error";
  provider: ProviderGuess | null;
  connectUrl: string;
  fix: ConnectFix | null;
}): string {
  const parts: string[] = [];
  parts.push(
    input.mode === "list"
      ? "No mailbox is connected to this account yet, so there is nothing to read or send from."
      : "No mailbox is connected to this account yet, so this tool has nothing to act on.",
  );
  if (input.provider) {
    parts.push(`Your account email is ${ADDRESS_NOUN[input.provider]}. ${CONNECT_EFFORT[input.provider]}`);
  } else {
    parts.push("Gmail, Outlook, iCloud, Yahoo, Fastmail and any other IMAP mailbox can be connected.");
  }
  parts.push(
    `Tell the user this and give them this link, rendered so they can click it: ${input.connectUrl} ` +
      (input.provider
        ? `It opens the connect page with ${PROVIDER_LABEL[input.provider]} selected.`
        : "It opens the connect page."),
  );
  if (input.fix) {
    parts.push(
      `Their last attempt to connect failed. ${input.fix.reason} Walk them through this fix: ` +
        input.fix.steps.map((step, i) => `${i + 1}. ${step}`).join(" "),
    );
  }
  parts.push(
    input.mode === "list"
      ? "Once they say a mailbox is connected, call inbox_list again."
      : "Retry this tool once they confirm a mailbox is connected.",
  );
  return parts.join(" ");
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/** What enrichNoInboxResult reads; injected so tests need no database. */
export interface NoInboxDeps {
  /** The account email of the key's creator (or the workspace owner). */
  accountEmail(): Promise<string | null>;
  /** The latest failed inbox connect within RECENT_FAILURE_MS, or null. */
  recentFailure(sinceIso: string): Promise<ConnectFailure | null>;
}

export interface NoInboxContext {
  appUrl: string;
  workspaceId: string;
  userAgent: string | null;
  keyName: string | null;
  keyHex: string | null | undefined;
  nowMs: number;
  deps: NoInboxDeps;
}

type ToolResultLike = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/** Which no-inbox answer this response is, or null for any other result. */
export function noInboxMode(response: unknown, logErrorCode: string | null): "list" | "error" | null {
  const result = (response as { result?: ToolResultLike } | null)?.result;
  if (!result || typeof result !== "object") return null;
  if (logErrorCode === "no_inbox_connected" && result.isError === true) return "error";
  if (result.isError !== true && result.structuredContent?.["setup_required"] === true) return "list";
  return null;
}

/**
 * Rewrite a no-inbox answer in place with the guessed provider, the signed
 * connect URL and the last failure's fix. Any other response is left alone.
 * Never throws: on any error the original answer stands.
 */
export async function enrichNoInboxResult(
  response: unknown,
  logErrorCode: string | null,
  ctx: NoInboxContext,
): Promise<void> {
  const mode = noInboxMode(response, logErrorCode);
  if (!mode) return;
  try {
    const result = (response as { result: ToolResultLike }).result;
    const sinceIso = new Date(ctx.nowMs - RECENT_FAILURE_MS).toISOString();
    const [email, failure] = await Promise.all([
      ctx.deps.accountEmail().catch(() => null),
      ctx.deps.recentFailure(sinceIso).catch(() => null),
    ]);
    const provider = guessProviderFromEmail(email);
    const client = chatClientFor(ctx.userAgent, ctx.keyName);
    const connectUrl = await buildConnectUrl({
      appUrl: ctx.appUrl,
      workspaceId: ctx.workspaceId,
      provider,
      client,
      keyHex: ctx.keyHex,
      nowMs: ctx.nowMs,
    });
    const fix = connectFixFor(failure);
    const text = noInboxText({ mode, provider, connectUrl, fix });

    if (mode === "list") {
      const structured = { ...(result.structuredContent ?? {}), setup_url: connectUrl, message: text };
      result.structuredContent = structured;
      result.content = [{ type: "text", text: JSON.stringify(structured) }];
    } else {
      result.content = [{ type: "text", text }];
    }
    result._meta = {
      ...(result._meta ?? {}),
      "mcpemails/setup_required": true,
      "mcpemails/connect_url": connectUrl,
      ...(provider ? { "mcpemails/provider_guess": provider } : {}),
      ...(fix && failure
        ? { "mcpemails/connect_failure": { provider: failure.provider, reason: failure.authReason ?? failure.errorCategory } }
        : {}),
    };
  } catch (error) {
    console.error("[mcp-server] no_inbox_answer_failed", {
      workspace_id: ctx.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
