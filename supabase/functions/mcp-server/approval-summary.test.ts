import { assertEquals } from "jsr:@std/assert@1";
import { isSealedSummary, openApprovalSummary, sealApprovalSummary } from "./approval-summary.ts";

const encrypt = (p: string) => Promise.resolve("c:" + p);
const decrypt = (c: string) =>
  c.startsWith("c:") ? Promise.resolve(c.slice(2)) : Promise.reject(new Error("bad ciphertext"));

Deno.test("a sealed summary round-trips and holds nothing in clear", async () => {
  const summary = { to: ["ada@x.com"], subject: "Q3", bcc_count: 1 };
  const sealed = await sealApprovalSummary(summary, (p) => Promise.resolve(btoa(p)));
  assertEquals(Object.keys(sealed).sort(), ["data", "v"]);
  assertEquals(JSON.stringify(sealed).includes("ada@x.com"), false);
  assertEquals(await openApprovalSummary(sealed, (c) => Promise.resolve(atob(c))), summary);
});

Deno.test("a plaintext summary from before 2026-10-30 reads as it is", async () => {
  const legacy = { to: ["ada@x.com"], subject: "Q3" };
  assertEquals(isSealedSummary(legacy), false);
  assertEquals(await openApprovalSummary(legacy, decrypt), legacy);
});

Deno.test("an undecryptable wrapper, null or a non-object reads as empty", async () => {
  assertEquals(await openApprovalSummary({ v: 1, data: "garbage" }, decrypt), {});
  assertEquals(await openApprovalSummary(null, decrypt), {});
  assertEquals(await openApprovalSummary("x", decrypt), {});
  assertEquals(await openApprovalSummary(await sealApprovalSummary({ a: 1 }, encrypt), decrypt), { a: 1 });
});

Deno.test("only the exact {v:1,data} shape counts as sealed", () => {
  assertEquals(isSealedSummary({ v: 1, data: "x" }), true);
  assertEquals(isSealedSummary({ v: 1, data: "x", subject: "y" }), false);
  assertEquals(isSealedSummary({ v: 2, data: "x" }), false);
  assertEquals(isSealedSummary({ v: 1, data: "" }), false);
});
