import { assertEquals } from "jsr:@std/assert@1";
import { isServiceKeyForThisProject, looksLikeServiceKey } from "./service-key-auth.ts";

const OWN = "sb_secret_ownkey";
const URL_ = "https://project.example";

function jwt(role: string): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64({ role })}.sig`;
}

function check(answer: (key: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push(String(url));
    return Promise.resolve(answer((init.headers as Record<string, string>).apikey));
  }) as unknown as typeof fetch;
  return {
    calls,
    deps: { ownKey: OWN, supabaseUrl: URL_, timingSafeEqual: (a: string, b: string) => a === b, fetchImpl },
  };
}

const notFound = () => new Response(JSON.stringify({ error_code: "user_not_found" }), { status: 404 });

Deno.test("the function's own key passes without asking anyone", async () => {
  const { calls, deps } = check(notFound);
  assertEquals(await isServiceKeyForThisProject(OWN, deps), true);
  assertEquals(calls.length, 0);
});

Deno.test("a different format of service key passes once the project accepts it", async () => {
  // The staging state: the site holds the legacy JWT, this function an sb_secret.
  const { calls, deps } = check(notFound);
  assertEquals(await isServiceKeyForThisProject(jwt("service_role"), deps), true);
  assertEquals(await isServiceKeyForThisProject("sb_secret_other", deps), true);
  assertEquals(calls.length, 2);
  // The probe names the nil user, so it can never return a real person's record.
  assertEquals(calls[0], `${URL_}/auth/v1/admin/users/00000000-0000-0000-0000-000000000000`);
});

Deno.test("anon and user tokens never reach the project at all", async () => {
  const { calls, deps } = check(notFound);
  assertEquals(await isServiceKeyForThisProject(jwt("anon"), deps), false);
  assertEquals(await isServiceKeyForThisProject(jwt("authenticated"), deps), false);
  assertEquals(await isServiceKeyForThisProject("sb_publishable_x", deps), false);
  assertEquals(await isServiceKeyForThisProject("mcp_key", deps), false);
  assertEquals(await isServiceKeyForThisProject("", deps), false);
  assertEquals(calls.length, 0);
});

Deno.test("a forged or revoked key shaped like a service key is refused", async () => {
  for (const response of [
    () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
    () => new Response(JSON.stringify({ error_code: "not_admin" }), { status: 403 }),
    // A 404 that is not Auth's own answer proves nothing.
    () => new Response("not here", { status: 404 }),
    // Fail closed: a 200 is not an answer this probe can get from a real admin check.
    () => new Response(JSON.stringify({ id: "x" }), { status: 200 }),
  ]) {
    const { deps } = check(response);
    assertEquals(await isServiceKeyForThisProject(jwt("service_role"), deps), false);
  }
});

Deno.test("no answer from the project is a refusal", async () => {
  const { deps } = check(() => Promise.reject(new Error("down")));
  assertEquals(await isServiceKeyForThisProject("sb_secret_other", deps), false);
});

Deno.test("looksLikeServiceKey survives garbage", () => {
  assertEquals(looksLikeServiceKey("a.b.c"), false);
  assertEquals(looksLikeServiceKey("..."), false);
  assertEquals(looksLikeServiceKey(jwt("service_role")), true);
});
