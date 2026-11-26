import { assertEquals } from "jsr:@std/assert@1";
import { _resetServiceBearerCache, isServiceRoleBearer, looksLikeServiceKey } from "./service-bearer.ts";

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

const SERVICE_JWT = jwt({ iss: "supabase", ref: "proj", role: "service_role" });
const ANON_JWT = jwt({ iss: "supabase", ref: "proj", role: "anon" });

function fakeFetch(status: number) {
  const calls: string[] = [];
  const f = ((url: string) => {
    calls.push(String(url));
    return Promise.resolve(new Response("{}", { status }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

Deno.test("shape check: service JWT and sb_secret pass, anon JWT and junk fail", () => {
  assertEquals(looksLikeServiceKey(SERVICE_JWT), true);
  assertEquals(looksLikeServiceKey("sb_secret_abcdefghijklmnopqrstuv"), true);
  assertEquals(looksLikeServiceKey(ANON_JWT), false);
  assertEquals(looksLikeServiceKey("not-a-key"), false);
  assertEquals(looksLikeServiceKey("a.b.c"), false);
});

Deno.test("exact match with own key needs no network", async () => {
  _resetServiceBearerCache();
  const { f, calls } = fakeFetch(500);
  assertEquals(await isServiceRoleBearer("own-key", { supabaseUrl: "https://x", ownServiceKey: "own-key", fetch: f }), true);
  assertEquals(calls.length, 0);
});

Deno.test("a different but valid service key is accepted after one probe, then cached", async () => {
  _resetServiceBearerCache();
  const { f, calls } = fakeFetch(200);
  const deps = { supabaseUrl: "https://x", ownServiceKey: "rotated-key", fetch: f };
  assertEquals(await isServiceRoleBearer(SERVICE_JWT, deps), true);
  assertEquals(await isServiceRoleBearer(SERVICE_JWT, deps), true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "https://x/auth/v1/admin/users?page=1&per_page=1");
});

Deno.test("the cache expires", async () => {
  _resetServiceBearerCache();
  const { f, calls } = fakeFetch(200);
  let t = 0;
  const deps = { supabaseUrl: "https://x", ownServiceKey: "k", fetch: f, now: () => t };
  await isServiceRoleBearer(SERVICE_JWT, deps);
  t = 6 * 60_000;
  await isServiceRoleBearer(SERVICE_JWT, deps);
  assertEquals(calls.length, 2);
});

Deno.test("a key the project refuses is refused and not cached", async () => {
  _resetServiceBearerCache();
  const { f, calls } = fakeFetch(401);
  const deps = { supabaseUrl: "https://x", ownServiceKey: "k", fetch: f };
  assertEquals(await isServiceRoleBearer(SERVICE_JWT, deps), false);
  assertEquals(await isServiceRoleBearer(SERVICE_JWT, deps), false);
  assertEquals(calls.length, 2);
});

Deno.test("anon key, junk and empty bearers never probe", async () => {
  _resetServiceBearerCache();
  const { f, calls } = fakeFetch(200);
  const deps = { supabaseUrl: "https://x", ownServiceKey: "k", fetch: f };
  assertEquals(await isServiceRoleBearer(ANON_JWT, deps), false);
  assertEquals(await isServiceRoleBearer("junk", deps), false);
  assertEquals(await isServiceRoleBearer("", deps), false);
  assertEquals(calls.length, 0);
});

Deno.test("a network failure is a refusal", async () => {
  _resetServiceBearerCache();
  const f = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
  assertEquals(await isServiceRoleBearer(SERVICE_JWT, { supabaseUrl: "https://x", ownServiceKey: "k", fetch: f }), false);
});
