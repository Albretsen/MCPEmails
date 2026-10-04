// JWT verification and the workspace gate.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { canWrite, JwtVerifier, WorkspaceGate } from "../auth.ts";
import { ApiError } from "../errors.ts";
import {
  b64url,
  claimsFor,
  JWT_SECRET,
  membership,
  mintHs256,
  OTHER_USER_ID,
  SECOND_WORKSPACE_ID,
  SUPABASE_URL,
  USER_ID,
  WORKSPACE_ID,
} from "./helpers.ts";

const noFetch: typeof fetch = () => Promise.reject(new Error("auth test: unexpected network call"));

function hsVerifier(): JwtVerifier {
  return new JwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET, fetch: noFetch });
}

async function rejects401(run: () => Promise<unknown>): Promise<void> {
  const error = await assertRejects(run, ApiError);
  assertEquals(error.status, 401);
  assertEquals(error.body.code, "unauthenticated");
}

Deno.test("HS256: a good token verifies locally, with no network call", async () => {
  const claims = await hsVerifier().verify(await mintHs256());
  assertEquals(claims.sub, USER_ID);
  assertEquals(claims.email, "owner@client-api-test.example");
});

Deno.test("HS256: an expired token is refused", async () => {
  await rejects401(async () => hsVerifier().verify(await mintHs256({ expiresIn: -60 })));
});

Deno.test("HS256: a token not yet valid is refused", async () => {
  await rejects401(async () => hsVerifier().verify(await mintHs256({ nbfIn: 600 })));
});

Deno.test("HS256: the wrong audience is refused, as a string and as a list", async () => {
  await rejects401(async () => hsVerifier().verify(await mintHs256({ aud: "some-other-service" })));
  await rejects401(async () => hsVerifier().verify(await mintHs256({ aud: ["a", "b"] })));
  // A list that contains the expected audience is accepted.
  await hsVerifier().verify(await mintHs256({ aud: ["x", "authenticated"] }));
});

Deno.test("HS256: the project's anon and service_role keys are not user sessions", async () => {
  await rejects401(async () => hsVerifier().verify(await mintHs256({ role: "anon" })));
  await rejects401(async () => hsVerifier().verify(await mintHs256({ role: "service_role" })));
  await rejects401(async () => hsVerifier().verify(await mintHs256({ sub: "not-a-uuid" })));
});

Deno.test("alg none is refused, signed or not", async () => {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claimsFor()));
  await rejects401(() => hsVerifier().verify(`${header}.${payload}.`));
  await rejects401(() => hsVerifier().verify(`${header}.${payload}.AAAA`));
  // A real HS256 signature under a header that says "none" is still refused.
  const real = (await mintHs256()).split(".");
  await rejects401(() => hsVerifier().verify(`${header}.${real[1]}.${real[2]}`));
});

Deno.test("an unknown algorithm is refused", async () => {
  const token = await mintHs256({ header: { alg: "HS512" } });
  await rejects401(() => hsVerifier().verify(token));
});

Deno.test("HS256: a tampered payload, a tampered signature and a wrong secret are refused", async () => {
  const token = await mintHs256();
  const [header, , signature] = token.split(".");
  const forged = b64url(JSON.stringify(claimsFor({ sub: OTHER_USER_ID })));
  await rejects401(() => hsVerifier().verify(`${header}.${forged}.${signature}`));
  const flipped = signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA");
  await rejects401(() => hsVerifier().verify(`${token.split(".").slice(0, 2).join(".")}.${flipped}`));
  await rejects401(async () => hsVerifier().verify(await mintHs256({ secret: "another-secret" })));
});

Deno.test("malformed tokens are refused without throwing anything else", async () => {
  for (const bad of ["", "abc", "a.b", "a.b.c.d", "!!!.###.$$$", "e30.e30."]) {
    await rejects401(() => hsVerifier().verify(bad));
  }
});

// ── asymmetric (JWKS) ───────────────────────────────────────────────────────

async function ecFixture(kid = "kid-1") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "ES256", use: "sig" };
  const sign = async (claims: Record<string, unknown>, headerKid = kid): Promise<string> => {
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: headerKid }));
    const payload = b64url(JSON.stringify(claims));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    );
    return `${header}.${payload}.${b64url(signature)}`;
  };
  return { jwk, sign };
}

function jwksFetch(keys: () => unknown[], counter: { n: number }): typeof fetch {
  return (input) => {
    const url = String(input);
    if (url !== `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) {
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }
    counter.n++;
    return Promise.resolve(
      new Response(JSON.stringify({ keys: keys() }), { headers: { "content-type": "application/json" } }),
    );
  };
}

Deno.test("ES256: verified against the project JWKS, fetched once and cached", async () => {
  const { jwk, sign } = await ecFixture();
  const counter = { n: 0 };
  const verifier = new JwtVerifier({ supabaseUrl: SUPABASE_URL, fetch: jwksFetch(() => [jwk], counter) });
  const token = await sign(claimsFor());
  assertEquals((await verifier.verify(token)).sub, USER_ID);
  assertEquals((await verifier.verify(token)).sub, USER_ID);
  assertEquals(counter.n, 1, "the JWKS is fetched once for two verifications");
});

Deno.test("ES256: expired, wrong audience and tampered tokens are refused", async () => {
  const { jwk, sign } = await ecFixture();
  const verifier = new JwtVerifier({ supabaseUrl: SUPABASE_URL, fetch: jwksFetch(() => [jwk], { n: 0 }) });
  await rejects401(async () => verifier.verify(await sign(claimsFor({ expiresIn: -5 * 60 }))));
  await rejects401(async () => verifier.verify(await sign(claimsFor({ aud: "other" }))));
  const token = await sign(claimsFor());
  const [header, , signature] = token.split(".");
  await rejects401(() =>
    verifier.verify(`${header}.${b64url(JSON.stringify(claimsFor({ sub: OTHER_USER_ID })))}.${signature}`)
  );
});

Deno.test("ES256: a token signed by a different key with the same kid is refused", async () => {
  const real = await ecFixture("kid-1");
  const attacker = await ecFixture("kid-1");
  const verifier = new JwtVerifier({ supabaseUrl: SUPABASE_URL, fetch: jwksFetch(() => [real.jwk], { n: 0 }) });
  await rejects401(async () => verifier.verify(await attacker.sign(claimsFor())));
});

Deno.test("ES256: an HS256 token cannot be passed off using the public key as the secret", async () => {
  const { jwk } = await ecFixture();
  const verifier = new JwtVerifier({
    supabaseUrl: SUPABASE_URL,
    // No HS secret configured: an HS256 token goes to GoTrue, which refuses it.
    fetch: (input) =>
      String(input).endsWith("/auth/v1/user")
        ? Promise.resolve(new Response("{}", { status: 401 }))
        : jwksFetch(() => [jwk], { n: 0 })(input),
  });
  await rejects401(async () => verifier.verify(await mintHs256({ secret: JSON.stringify(jwk) })));
});

Deno.test("ES256: an unknown kid refetches the JWKS at most once per 30 s (key rotation)", async () => {
  const first = await ecFixture("kid-old");
  const second = await ecFixture("kid-new");
  let served = [first.jwk];
  const counter = { n: 0 };
  let now = 1_000_000;
  const verifier = new JwtVerifier({
    supabaseUrl: SUPABASE_URL,
    fetch: jwksFetch(() => served, counter),
    now: () => now,
  });
  const claims = { ...claimsFor(), exp: Math.floor(now / 1000) + 3600 };
  await verifier.verify(await first.sign(claims));
  assertEquals(counter.n, 1);
  // Rotation: the new key appears; the first token with it triggers one refetch.
  served = [first.jwk, second.jwk];
  now += 31_000;
  await verifier.verify(await second.sign(claims));
  assertEquals(counter.n, 2);
  // A made-up kid straight after does NOT cause another fetch.
  await rejects401(async () => verifier.verify(await second.sign(claims, "kid-made-up")));
  assertEquals(counter.n, 2);
});

Deno.test("fallback: with no secret, an HS256 token is checked with GoTrue and cached per token", async () => {
  let calls = 0;
  const verifier = new JwtVerifier({
    supabaseUrl: SUPABASE_URL,
    apiKey: "anon-key-placeholder",
    fetch: (input, init) => {
      calls++;
      assertEquals(String(input), `${SUPABASE_URL}/auth/v1/user`);
      const headers = new Headers(init?.headers);
      assert(headers.get("authorization")?.startsWith("Bearer "));
      assertEquals(headers.get("apikey"), "anon-key-placeholder");
      return Promise.resolve(
        new Response(JSON.stringify({ id: USER_ID, email: "owner@client-api-test.example", aud: "authenticated", role: "authenticated" })),
      );
    },
  });
  const token = await mintHs256({ secret: "unknown-to-this-verifier" });
  assertEquals((await verifier.verify(token)).sub, USER_ID);
  assertEquals((await verifier.verify(token)).sub, USER_ID);
  assertEquals(calls, 1, "the second verification is served from the per-token cache");
});

Deno.test("fallback: GoTrue refusing the token is a 401", async () => {
  const verifier = new JwtVerifier({
    supabaseUrl: SUPABASE_URL,
    fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
  });
  await rejects401(async () => verifier.verify(await mintHs256()));
});

// ── the gate ────────────────────────────────────────────────────────────────

function gateWith(rows: ReturnType<typeof membership>[], clock = { now: 0 }) {
  const source = {
    calls: 0,
    rows,
    memberships() {
      source.calls++;
      return Promise.resolve(source.rows);
    },
  };
  return { gate: new WorkspaceGate(source, 60_000, () => clock.now), source, clock };
}

Deno.test("gate: a user with no workspace is forbidden", async () => {
  const { gate } = gateWith([]);
  const error = await assertRejects(() => gate.resolve(USER_ID, null), ApiError);
  assertEquals([error.status, error.body.code], [403, "forbidden"]);
});

Deno.test("gate: a workspace the user is not a member of is forbidden, whatever its flag", async () => {
  const { gate } = gateWith([membership()]);
  const error = await assertRejects(() => gate.resolve(USER_ID, SECOND_WORKSPACE_ID), ApiError);
  assertEquals([error.status, error.body.code], [403, "forbidden"]);
  const malformed = await assertRejects(() => gate.resolve(USER_ID, "'; drop table"), ApiError);
  assertEquals(malformed.body.code, "forbidden");
});

Deno.test("gate: a disabled workspace is refused with web_client_disabled", async () => {
  const { gate } = gateWith([membership({ web_client_enabled: false })]);
  const error = await assertRejects(() => gate.resolve(USER_ID, null), ApiError);
  assertEquals([error.status, error.body.code], [403, "web_client_disabled"]);
  const named = await assertRejects(() => gate.resolve(USER_ID, WORKSPACE_ID), ApiError);
  assertEquals(named.body.code, "web_client_disabled");
});

Deno.test("gate: with no header, the earliest ENABLED membership is chosen; the header overrides", async () => {
  const { gate } = gateWith([
    membership({ workspace_id: SECOND_WORKSPACE_ID, joined_at: "2026-03-01T00:00:00Z", web_client_enabled: true }),
    membership({ workspace_id: WORKSPACE_ID, joined_at: "2026-01-01T00:00:00Z", web_client_enabled: false }),
  ]);
  assertEquals((await gate.resolve(USER_ID, null)).workspace.workspace_id, SECOND_WORKSPACE_ID);
  const named = await assertRejects(() => gate.resolve(USER_ID, WORKSPACE_ID), ApiError);
  assertEquals(named.body.code, "web_client_disabled");
});

Deno.test("gate: memberships are cached for 60 s and no longer", async () => {
  const { gate, source, clock } = gateWith([membership()]);
  assertEquals((await gate.resolve(USER_ID, null)).cached, false);
  assertEquals((await gate.resolve(USER_ID, null)).cached, true);
  assertEquals(source.calls, 1);
  // The workspace is switched off; the cache still says on until it expires.
  source.rows = [membership({ web_client_enabled: false })];
  clock.now = 59_000;
  await gate.resolve(USER_ID, null);
  clock.now = 60_001;
  const error = await assertRejects(() => gate.resolve(USER_ID, null), ApiError);
  assertEquals(error.body.code, "web_client_disabled");
  assertEquals(source.calls, 2);
});

Deno.test("gate: one user's cached memberships are never served to another", async () => {
  const source = {
    memberships: (userId: string) =>
      Promise.resolve(userId === USER_ID ? [membership()] : []),
  };
  const gate = new WorkspaceGate(source);
  await gate.resolve(USER_ID, null);
  const error = await assertRejects(() => gate.resolve(OTHER_USER_ID, WORKSPACE_ID), ApiError);
  assertEquals(error.body.code, "forbidden");
});

Deno.test("verified-token cache: the signature is checked once, the clock on every call, and only that exact token is trusted", async () => {
  let now = Date.now();
  const verifier = new JwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET, fetch: noFetch, now: () => now });
  const token = await mintHs256({ expiresIn: 600 });
  const first = await verifier.verify(token);
  const again = await verifier.verify(token);
  assertEquals(again.sub, first.sub);
  // Same header and payload, another signature: a different token, never a cache hit.
  const forged = `${token.slice(0, token.lastIndexOf(".") + 1)}${"A".repeat(43)}`;
  await rejects401(() => verifier.verify(forged));
  // The cached token expires exactly as an uncached one does, and stays refused.
  now += 700_000;
  await rejects401(() => verifier.verify(token));
  await rejects401(() => verifier.verify(token));
});

Deno.test("roles: only a viewer is read-only", () => {
  assertEquals(["owner", "admin", "member", "viewer"].map((r) => canWrite(r as "owner")), [true, true, true, false]);
});
