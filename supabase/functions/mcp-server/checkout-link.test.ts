// ---------------------------------------------------------------------------
// Who gets a checkout link in the Free-cap refusal, and what the link is.
//
// The eligibility matrix is the part that matters for policy: every OpenAI
// key name and client name is out (OpenAI's plugin guidelines forbid linking
// to checkout), a member who is not the owner is out, a paid plan is out, and
// the rollout gate decides the rest. A mistake in any of those puts a payment
// page where it must not be, so each one is pinned here.
//
// The token contract is shared with apps/web (the redeem route hashes what it
// is handed and looks the hash up), so its shape is pinned too.
//
// Run: deno test --node-modules-dir=none supabase/functions/mcp-server/checkout-link.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  byteaHex,
  CHECKOUT_LINK_EXPERIMENT_KEY,
  CHECKOUT_LINK_MINT_FAILED,
  checkoutClientLabel,
  type CheckoutIssueArgs,
  type CheckoutLinkIo,
  checkoutLinkMode,
  type CheckoutLinkRequest,
  checkoutTokenHash,
  deriveCheckoutToken,
  type ExperimentRow,
  experimentSubjectId,
  hashUnit,
  mintCheckoutLink,
  pickVariant,
  resolveExperimentVariant,
} from "./checkout-link.ts";
import * as webBucketing from "../../../apps/web/src/lib/experiments/bucketing.ts";

const WORKSPACE = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";
const MEMBER = "77777777-7777-4777-8777-777777777777";
const SECRET = "s".repeat(32);
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const PROPOSED_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function request(overrides: Partial<CheckoutLinkRequest> = {}): CheckoutLinkRequest {
  return {
    workspaceId: WORKSPACE,
    plan: "free",
    keyName: "OAuth: Claude",
    keyCreatedBy: OWNER,
    clientName: "claude-ai",
    blockedTool: "email_compose",
    appOrigin: "https://mcpemails.com",
    modeEnv: "on",
    secretEnv: SECRET,
    ...overrides,
  };
}

interface FakeState {
  workspace: { owner_id: string | null; chat_checkout_link_enabled: boolean | null } | null;
  experiment: ExperimentRow | null;
  issued: CheckoutIssueArgs[];
  assigned: Array<[string, string, string]>;
  errors: Array<[string, Record<string, unknown>]>;
  /** What the RPC answers; default: insert the proposed row. */
  issueAnswer?: (args: CheckoutIssueArgs) => { id: string; expires_at: string; reused: boolean } | null;
  failOn?: "workspace" | "experiment" | "assign" | "issue";
  storedVariant?: string;
}

function fake(overrides: Partial<FakeState> = {}): { io: CheckoutLinkIo; state: FakeState } {
  const state: FakeState = {
    workspace: { owner_id: OWNER, chat_checkout_link_enabled: false },
    experiment: null,
    issued: [],
    assigned: [],
    errors: [],
    ...overrides,
  };
  const io: CheckoutLinkIo = {
    workspace: () => state.failOn === "workspace" ? Promise.reject(new Error("workspace down")) : Promise.resolve(state.workspace),
    experiment: () => state.failOn === "experiment" ? Promise.reject(new Error("experiment down")) : Promise.resolve(state.experiment),
    assign: (key, subject, variant) => {
      if (state.failOn === "assign") return Promise.reject(new Error("assign down"));
      state.assigned.push([key, subject, variant]);
      return Promise.resolve(state.storedVariant ?? variant);
    },
    issue: (args) => {
      if (state.failOn === "issue") return Promise.reject(new Error("rpc down"));
      state.issued.push(args);
      return Promise.resolve(
        state.issueAnswer
          ? state.issueAnswer(args)
          : { id: args.p_id, expires_at: new Date(NOW + 30 * 60_000).toISOString(), reused: false },
      );
    },
    newId: () => PROPOSED_ID,
    now: () => NOW,
    logError: (event, fields) => void state.errors.push([event, fields]),
  };
  return { io, state };
}

// ── Rollout mode ─────────────────────────────────────────────────────────────

Deno.test("CHAT_CHECKOUT_LINK is off unless it says exactly one of the three modes", () => {
  for (const raw of [undefined, null, "", "off", "true", "1", "yes", "experiments", "ON!"]) {
    assertEquals(checkoutLinkMode(raw), "off", String(raw));
  }
  assertEquals(checkoutLinkMode("internal"), "internal");
  assertEquals(checkoutLinkMode(" Experiment "), "experiment");
  assertEquals(checkoutLinkMode("on"), "on");
});

Deno.test("mode off or unknown mints nothing and asks the database nothing", async () => {
  for (const modeEnv of [undefined, "off", "maybe"]) {
    const { io, state } = fake();
    let asked = false;
    io.workspace = () => {
      asked = true;
      return Promise.resolve(null);
    };
    assertEquals(await mintCheckoutLink(io, request({ modeEnv })), null);
    assertEquals(asked, false, `${modeEnv}: no read`);
    assertEquals(state.issued.length, 0);
    assertEquals(state.errors, []);
  }
});

// ── Eligibility matrix ──────────────────────────────────────────────────────

Deno.test("every OpenAI key name is excluded", async () => {
  for (const keyName of ["OAuth: ChatGPT", "OAuth: chatgpt.com", "OAuth: Codex", "OAuth: openai", "OAuth: ChatGPT (2)"]) {
    const { io, state } = fake();
    assertEquals(await mintCheckoutLink(io, request({ keyName, clientName: null })), null, keyName);
    assertEquals(state.issued.length, 0, keyName);
  }
});

Deno.test("every OpenAI initialize client name is excluded", async () => {
  for (
    const clientName of [
      "openai-mcp",
      "openai-mcp (Codex)",
      "openai-mcp (ChatGPT)",
      "codex-mcp-client",
      "Codex",
      "codex-config-check",
    ]
  ) {
    const { io, state } = fake();
    assertEquals(await mintCheckoutLink(io, request({ clientName })), null, clientName);
    assertEquals(state.issued.length, 0, clientName);
  }
});

Deno.test("a failed client lookup gets no link: OpenAI cannot be ruled out", async () => {
  const { io, state } = fake();
  assertEquals(await mintCheckoutLink(io, request({ clientName: undefined })), null);
  assertEquals(state.issued.length, 0);
});

Deno.test("a key that never sent initialize is still eligible", async () => {
  const { io, state } = fake();
  assert(await mintCheckoutLink(io, request({ clientName: null })));
  assertEquals(state.issued[0].p_client_label, "unknown");
});

Deno.test("a key minted by a member, or by nobody recorded, is excluded", async () => {
  for (const keyCreatedBy of [MEMBER, null, undefined, ""]) {
    const { io, state } = fake();
    assertEquals(await mintCheckoutLink(io, request({ keyCreatedBy })), null, String(keyCreatedBy));
    assertEquals(state.issued.length, 0);
  }
});

Deno.test("a workspace with no row or no owner is excluded", async () => {
  for (const workspace of [null, { owner_id: null, chat_checkout_link_enabled: true }]) {
    const { io, state } = fake({ workspace });
    assertEquals(await mintCheckoutLink(io, request()), null);
    assertEquals(state.issued.length, 0);
  }
});

Deno.test("paid plans are excluded", async () => {
  for (const plan of ["personal", "solo", "pro", "business"]) {
    const { io, state } = fake();
    assertEquals(await mintCheckoutLink(io, request({ plan })), null, plan);
    assertEquals(state.issued.length, 0);
  }
});

Deno.test("internal mode follows workspaces.chat_checkout_link_enabled", async () => {
  {
    const { io, state } = fake({ workspace: { owner_id: OWNER, chat_checkout_link_enabled: false } });
    assertEquals(await mintCheckoutLink(io, request({ modeEnv: "internal" })), null);
    assertEquals(state.issued.length, 0);
  }
  {
    const { io, state } = fake({ workspace: { owner_id: OWNER, chat_checkout_link_enabled: true } });
    const link = await mintCheckoutLink(io, request({ modeEnv: "internal" }));
    assert(link);
    assertEquals(link.variant, "internal");
    assertEquals(state.issued[0].p_variant, "internal");
  }
});

Deno.test("on mode links every eligible owner and records variant on", async () => {
  const { io, state } = fake();
  const link = await mintCheckoutLink(io, request());
  assert(link);
  assertEquals(link.variant, "on");
  assertEquals(state.issued[0].p_variant, "on");
  assertEquals(state.issued[0].p_owner_user_id, OWNER);
  assertEquals(state.issued[0].p_workspace_id, WORKSPACE);
  assertEquals(state.issued[0].p_blocked_tool, "email_compose");
  assertEquals(state.issued[0].p_ttl_minutes, 30);
  assertEquals(state.issued[0].p_client_label, "claude_ai");
});

// ── Experiment ──────────────────────────────────────────────────────────────

const VARIANTS = [{ id: "control", weight: 50 }, { id: "link", weight: 50 }];

Deno.test("experiment mode: a draft serves control to everyone and records nothing", async () => {
  const { io, state } = fake({
    experiment: { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "draft", variants: VARIANTS, winner_variant_id: null },
  });
  assertEquals(await mintCheckoutLink(io, request({ modeEnv: "experiment" })), null);
  assertEquals(state.assigned, []);
  assertEquals(state.issued.length, 0);
});

Deno.test("experiment mode: a missing experiment row is control", async () => {
  const { io, state } = fake({ experiment: null });
  assertEquals(await mintCheckoutLink(io, request({ modeEnv: "experiment" })), null);
  assertEquals(state.errors, []);
});

Deno.test("experiment mode: a concluded winner is served to everyone", async () => {
  for (const [winner, linked] of [["link", true], ["control", false]] as const) {
    const { io, state } = fake({
      experiment: { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "concluded", variants: VARIANTS, winner_variant_id: winner },
    });
    const link = await mintCheckoutLink(io, request({ modeEnv: "experiment" }));
    assertEquals(Boolean(link), linked, winner);
    assertEquals(state.assigned, [], "a concluded experiment writes no assignment");
  }
});

Deno.test("experiment mode: running buckets deterministically on the dashless workspace id and stores it", async () => {
  const subject = experimentSubjectId(WORKSPACE)!;
  assertEquals(subject, "55555555555545558555555555555555");
  const expected = pickVariant(VARIANTS, hashUnit(subject, CHECKOUT_LINK_EXPERIMENT_KEY));
  for (let i = 0; i < 3; i++) {
    const { io, state } = fake({
      experiment: { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "running", variants: VARIANTS, winner_variant_id: null },
    });
    const link = await mintCheckoutLink(io, request({ modeEnv: "experiment" }));
    assertEquals(state.assigned, [[CHECKOUT_LINK_EXPERIMENT_KEY, subject, expected]]);
    assertEquals(Boolean(link), expected === "link");
  }
});

Deno.test("experiment mode: the stored assignment beats the hash", async () => {
  for (const stored of ["control", "link"]) {
    const { io } = fake({
      experiment: { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "running", variants: VARIANTS, winner_variant_id: null },
      storedVariant: stored,
    });
    const link = await mintCheckoutLink(io, request({ modeEnv: "experiment" }));
    assertEquals(Boolean(link), stored === "link", stored);
    if (link) assertEquals(link.variant, "link");
  }
});

Deno.test("experiment mode: ineligible requests never write an assignment", async () => {
  const { io, state } = fake({
    experiment: { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "running", variants: VARIANTS, winner_variant_id: null },
  });
  await mintCheckoutLink(io, request({ modeEnv: "experiment", keyCreatedBy: MEMBER }));
  await mintCheckoutLink(io, request({ modeEnv: "experiment", clientName: "openai-mcp" }));
  await mintCheckoutLink(io, request({ modeEnv: "experiment", plan: "personal" }));
  assertEquals(state.assigned, []);
});

Deno.test("the bucketing is the web side's, subject for subject, and splits 50/50", () => {
  // Parity against apps/web's own module (pure, no imports beyond its
  // constants), so whichever side assigns a workspace first, the other agrees.
  let links = 0;
  for (let i = 0; i < 2000; i++) {
    const subject = (i * 2654435761 >>> 0).toString(16).padStart(32, "0");
    assertEquals(hashUnit(subject, CHECKOUT_LINK_EXPERIMENT_KEY), webBucketing.hashUnit(subject, CHECKOUT_LINK_EXPERIMENT_KEY));
    const a = pickVariant(VARIANTS, hashUnit(subject, CHECKOUT_LINK_EXPERIMENT_KEY));
    assertEquals(a, webBucketing.pickVariant(VARIANTS.map((v) => ({ ...v, label: v.id })), hashUnit(subject, CHECKOUT_LINK_EXPERIMENT_KEY)));
    if (a === "link") links++;
  }
  assert(links > 900 && links < 1100, `50/50 split, got ${links}/2000`);
});

Deno.test("resolveExperimentVariant: running with an assign failure throws, it does not serve the link", async () => {
  let threw = false;
  try {
    await resolveExperimentVariant(
      { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "running", variants: VARIANTS, winner_variant_id: null },
      "0".repeat(32),
      () => Promise.reject(new Error("down")),
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

// ── Failures ────────────────────────────────────────────────────────────────

Deno.test("a missing or short secret is no link, before anything is read", async () => {
  for (const secretEnv of [undefined, null, "", "x".repeat(31)]) {
    const { io, state } = fake();
    let asked = false;
    io.workspace = () => {
      asked = true;
      return Promise.resolve(null);
    };
    assertEquals(await mintCheckoutLink(io, request({ secretEnv })), null);
    assertEquals(asked, false);
    assertEquals(state.issued.length, 0);
  }
});

Deno.test("every database failure is null plus one fixed log line with the workspace and message only", async () => {
  for (const failOn of ["workspace", "experiment", "assign", "issue"] as const) {
    const { io, state } = fake({
      failOn,
      experiment: { key: CHECKOUT_LINK_EXPERIMENT_KEY, status: "running", variants: VARIANTS, winner_variant_id: null },
    });
    const modeEnv = failOn === "experiment" || failOn === "assign" ? "experiment" : "on";
    assertEquals(await mintCheckoutLink(io, request({ modeEnv })), null, failOn);
    assertEquals(state.errors.length, 1, failOn);
    assertEquals(state.errors[0][0], CHECKOUT_LINK_MINT_FAILED);
    assertEquals(Object.keys(state.errors[0][1]).sort(), ["error", "workspace_id"]);
    assertEquals(state.errors[0][1].workspace_id, WORKSPACE);
  }
});

Deno.test("an RPC that answers no row is a failure, not a link", async () => {
  const { io, state } = fake({ issueAnswer: () => null });
  assertEquals(await mintCheckoutLink(io, request()), null);
  assertEquals(state.errors.length, 1);
});

// ── Token ───────────────────────────────────────────────────────────────────

Deno.test("the token is deterministic per id, 43 base64url characters, and differs per id and secret", async () => {
  const a = await deriveCheckoutToken(SECRET, PROPOSED_ID);
  assertEquals(a, await deriveCheckoutToken(SECRET, PROPOSED_ID));
  assertEquals(a.length, 43);
  assertMatch(a, /^[A-Za-z0-9_-]{43}$/);
  assert(a !== await deriveCheckoutToken(SECRET, "aaaaaaaa-0000-4000-8000-000000000002"));
  assert(a !== await deriveCheckoutToken("t".repeat(32), PROPOSED_ID));
});

Deno.test("the token is HMAC-SHA256(secret, id), checked against an independent computation", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(PROPOSED_ID)));
  const b64 = btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  assertEquals(await deriveCheckoutToken(SECRET, PROPOSED_ID), b64);
});

Deno.test("the stored hash is sha256(utf8(token)) in PostgREST's \\x hex form", async () => {
  const token = await deriveCheckoutToken(SECRET, PROPOSED_ID);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  assertEquals(await checkoutTokenHash(token), digest);
  const hex = byteaHex(digest);
  assertMatch(hex, /^\\x[0-9a-f]{64}$/);

  const { io, state } = fake();
  const link = await mintCheckoutLink(io, request());
  assert(link);
  assertEquals(state.issued[0].p_id, PROPOSED_ID);
  assertEquals(state.issued[0].p_token_hash, hex);
  assertEquals(link.url, `https://mcpemails.com/u/${token}`);
  assertEquals(link.minutes, 30);
  assertEquals(link.reused, false);
});

Deno.test("a reused row's token is re-derived from ITS id, with the minutes actually left", async () => {
  const liveId = "bbbbbbbb-0000-4000-8000-000000000009";
  const { io } = fake({
    issueAnswer: () => ({ id: liveId, expires_at: new Date(NOW + 12 * 60_000).toISOString(), reused: true }),
  });
  const link = await mintCheckoutLink(io, request());
  assert(link);
  assertEquals(link.url, `https://mcpemails.com/u/${await deriveCheckoutToken(SECRET, liveId)}`);
  assertEquals(link.minutes, 12);
  assertEquals(link.reused, true);
});

Deno.test("a blocked tool name outside the column's pattern is stored as null", async () => {
  const { io, state } = fake();
  await mintCheckoutLink(io, request({ blockedTool: "Email-Compose" }));
  assertEquals(state.issued[0].p_blocked_tool, null);
});

// ── Client label ────────────────────────────────────────────────────────────

Deno.test("the client label is a fixed family, never the raw name", () => {
  assertEquals(checkoutClientLabel("anthropic/claudeai"), "claude_ai");
  assertEquals(checkoutClientLabel("claude-ai"), "claude_ai");
  assertEquals(checkoutClientLabel("claude-code"), "claude_code");
  assertEquals(checkoutClientLabel("anthropic/toolbox"), "anthropic_toolbox");
  assertEquals(checkoutClientLabel("Cursor"), "cursor");
  assertEquals(checkoutClientLabel("Visual Studio Code"), "unknown");
  assertEquals(checkoutClientLabel("my-homegrown agent v2 <script>"), "unknown");
  assertEquals(checkoutClientLabel(null), "unknown");
  for (const name of ["anthropic/claudeai", "claude-code", "cursor", "zed", "whatever"]) {
    assertMatch(checkoutClientLabel(name), /^[a-z0-9_.-]{1,40}$/);
  }
});
