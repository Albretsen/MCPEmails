import { assertEquals } from "jsr:@std/assert@1";
import { referralPersonalActive } from "./referral-burst.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const LATER = "2026-12-01T00:00:00.000Z";
const EARLIER = "2026-11-01T00:00:00.000Z";

Deno.test("a running referral month lifts a Free workspace to Personal's burst", () => {
  assertEquals(
    referralPersonalActive({ storedPlan: "free", entitlement: { kind: "referral_personal", expires_at: LATER }, now: NOW }),
    true,
  );
});

Deno.test("an ended month, a paid plan, another kind or no row never lifts", () => {
  const cases = [
    { storedPlan: "free", entitlement: { kind: "referral_personal", expires_at: EARLIER } },
    { storedPlan: "free", entitlement: { kind: "referral_personal", expires_at: null } },
    { storedPlan: "solo", entitlement: { kind: "referral_personal", expires_at: LATER } },
    { storedPlan: "free", entitlement: { kind: "standard", expires_at: LATER } },
    { storedPlan: "free", entitlement: { kind: "comped_scale", expires_at: LATER } },
    { storedPlan: "free", entitlement: null },
  ];
  for (const c of cases) assertEquals(referralPersonalActive({ ...c, now: NOW }), false);
});
