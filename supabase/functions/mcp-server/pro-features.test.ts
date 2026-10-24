// The Pro feature gate (pro-features.ts): the decision, the call and listing
// helpers, and the refusal shape.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CLOSED_PRO_GATE,
  decideProFeatureAccess,
  hasProFeatureSurface,
  hideProFeaturesFromListing,
  isProFeatureTool,
  PRO_FEATURE_ARGS,
  PRO_FEATURE_ERROR_CODE,
  PRO_FEATURE_META_KEY,
  PRO_FEATURE_TOOLS,
  PRO_FEATURES,
  type ProFeature,
  proFeatureForCall,
  proFeatureRefusalResult,
} from "./pro-features.ts";

const PLANS = ["free", "personal", "solo", "pro", "enterprise", "unknown"];

Deno.test("decideProFeatureAccess: hidden without the rollout flag or the launch switch, on every plan", () => {
  for (const plan of PLANS) {
    assertEquals(
      decideProFeatureAccess({ plan, rolloutEnabled: false, publicLaunch: false }),
      { visible: false, allowed: false, plan },
      plan,
    );
  }
});

Deno.test("decideProFeatureAccess: visible with either switch, allowed only on solo and pro", () => {
  for (const [rolloutEnabled, publicLaunch] of [[true, false], [false, true], [true, true]]) {
    for (const plan of PLANS) {
      const access = decideProFeatureAccess({ plan, rolloutEnabled, publicLaunch });
      assertEquals(access.visible, true, `${plan} ${rolloutEnabled} ${publicLaunch}`);
      assertEquals(access.allowed, plan === "solo" || plan === "pro", `${plan} ${rolloutEnabled} ${publicLaunch}`);
    }
  }
});

Deno.test("decideProFeatureAccess: an unknown plan is never allowed, and the closed inputs are hidden", () => {
  assertEquals(decideProFeatureAccess({ plan: null, rolloutEnabled: true, publicLaunch: true }).allowed, false);
  assertEquals(decideProFeatureAccess(CLOSED_PRO_GATE), { visible: false, allowed: false, plan: null });
});

Deno.test("the shipped registry names known features only, and ordinary calls touch none", () => {
  for (const feature of Object.values(PRO_FEATURE_TOOLS)) assert(PRO_FEATURES.includes(feature));
  for (const args of Object.values(PRO_FEATURE_ARGS)) {
    for (const feature of Object.values(args)) assert(PRO_FEATURES.includes(feature));
  }
  assertEquals(proFeatureForCall("inbox_list", { inbox_id: "x" }), null);
  // An existing send tool is only Pro when the Pro argument is passed.
  assertEquals(proFeatureForCall("email_compose", { action: "send", to: ["a@b.example"] }), null);
  assertEquals(proFeatureForCall("email_compose", { action: "send", follow_up_days: 3 }), "reminders");
  assertEquals(proFeatureForCall("reminder_list", {}), "reminders");
});

const TOOLS: Record<string, ProFeature> = { reminder_list: "reminders" };
const ARGS: Record<string, Record<string, ProFeature>> = { inbox_list: { instructions: "inbox_instructions" } };

Deno.test("proFeatureForCall: a Pro tool by name, a Pro argument only when passed", () => {
  assertEquals(proFeatureForCall("reminder_list", {}, TOOLS, ARGS), "reminders");
  assertEquals(proFeatureForCall("reminder_list", undefined, TOOLS, ARGS), "reminders");
  assertEquals(proFeatureForCall("inbox_list", { instructions: "x" }, TOOLS, ARGS), "inbox_instructions");
  assertEquals(proFeatureForCall("inbox_list", { instructions: null }, TOOLS, ARGS), null);
  assertEquals(proFeatureForCall("inbox_list", {}, TOOLS, ARGS), null);
  assertEquals(proFeatureForCall("inbox_list", ["instructions"], TOOLS, ARGS), null);
  assertEquals(proFeatureForCall("email_read", { instructions: "x" }, TOOLS, ARGS), null);
  // Prototype names are not registry entries.
  assertEquals(proFeatureForCall("constructor", {}, TOOLS, ARGS), null);
  assertEquals(isProFeatureTool("reminder_list", TOOLS), true);
  assertEquals(isProFeatureTool("toString", TOOLS), false);
  assert(hasProFeatureSurface(TOOLS, {}));
  assert(hasProFeatureSurface({}, ARGS));
});

function listing() {
  return [
    { name: "reminder_list", inputSchema: { type: "object", properties: {} } },
    {
      name: "inbox_list",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer" }, instructions: { type: "string" } },
        required: ["instructions"],
      },
      listedInputSchema: { type: "object", properties: { instructions: { type: "string" } } },
    },
    { name: "email_read", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  ];
}

Deno.test("hideProFeaturesFromListing: not visible drops Pro tools and Pro arguments, without mutating", () => {
  const tools = listing();
  const hidden = hideProFeaturesFromListing(tools, { visible: false, allowed: false, plan: "free" }, TOOLS, ARGS);
  assertEquals(hidden.map((t) => t.name), ["inbox_list", "email_read"]);
  assertEquals(Object.keys(hidden[0].inputSchema.properties as object), ["limit"]);
  assertEquals(hidden[0].inputSchema.required, []);
  assertEquals(Object.keys(hidden[0].listedInputSchema!.properties as object), []);
  assert(hidden[1] === tools[2], "an untouched tool is passed through as is");
  // The source entries are unchanged.
  assertEquals(Object.keys(tools[1].inputSchema.properties as object), ["limit", "instructions"]);
});

Deno.test("hideProFeaturesFromListing: visible lists everything, allowed or not", () => {
  const tools = listing();
  assert(hideProFeaturesFromListing(tools, { visible: true, allowed: false, plan: "personal" }, TOOLS, ARGS) === tools);
  assert(hideProFeaturesFromListing(tools, { visible: true, allowed: true, plan: "solo" }, TOOLS, ARGS) === tools);
});

Deno.test("proFeatureRefusalResult: an isError tool result naming Pro, the upgrade link and the current plan", () => {
  const r = proFeatureRefusalResult("reminders", "personal", "https://mcpemails.com");
  assertEquals(r.isError, true);
  const text = r.content[0].text;
  assert(text.includes("Pro and Business plans"), text);
  assert(text.includes("on the Personal plan"), text);
  assert(text.includes("https://mcpemails.com/pricing?from=pro_feature"), text);
  assert(!text.includes("personal"), "no raw plan slug in the text");
  assert(!text.includes("—"), "no em dash");
  const meta = r._meta[PRO_FEATURE_META_KEY] as Record<string, unknown>;
  assertEquals(meta.error_code, PRO_FEATURE_ERROR_CODE);
  assertEquals(meta.feature, "reminders");
  assertEquals(meta.effective_plan, "personal");
  assertEquals(meta.required_plans, ["solo", "pro"]);
  assertEquals(meta.upgrade_url, "https://mcpemails.com/pricing?from=pro_feature");
  assertEquals("structuredContent" in r, false);
});

Deno.test("proFeatureRefusalResult: directory wording links the plain plans page and sells nothing", () => {
  const r = proFeatureRefusalResult("morning_brief", null, "https://mcpemails.com", "directory");
  const text = r.content[0].text;
  assert(text.includes("https://mcpemails.com/pricing."), text);
  assert(!text.includes("from=pro_feature"), text);
  assert(!text.includes("adds it"), text);
  const meta = r._meta[PRO_FEATURE_META_KEY] as Record<string, unknown>;
  assertEquals(meta.plans_url, "https://mcpemails.com/pricing");
  assertEquals("upgrade_url" in meta, false);
});
