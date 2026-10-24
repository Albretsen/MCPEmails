// ---------------------------------------------------------------------------
// The Pro feature gate: who sees, and who may use, the new Pro-only features.
//
// One rule, for every new Pro feature:
//
//   visible = workspaces.pro_features_enabled (our internal rollout flag)
//             OR pricing_switches.pro_features_public (the launch switch)
//   allowed = visible AND effective plan in (solo, pro)
//
// `solo` is sold as Pro and `pro` as Business; both get Pro features. The
// effective plan is the comped-aware one (an unexpired comped_scale grant on
// the owner resolves to `pro`), the same rule checkPlanQuota and
// effective_workspace_plan() apply.
//
// Only NEW features are gated here. Nothing a Free or Personal workspace has
// today may be put behind this gate.
//
// Not visible means customers see no change: a Pro tool is left out of
// tools/list and a call to it is answered as an unknown tool, exactly as before
// the tool existed; a Pro argument is left out of its tool's listed schema.
// Visible but not allowed means the tool is listed and a call is refused with
// an isError tool result naming the Pro plan (the cap paywall pattern, never a
// JSON-RPC error).
//
// Pure module: no I/O, so it is testable without booting the server. The
// per-request read lives in index.ts (proFeatureAccess). Mirror for the
// dashboard: apps/web/src/lib/plans/pro-features.ts.
// ---------------------------------------------------------------------------

import { PLAN_DISPLAY_NAMES, type PlanLimitWording, plansInfoUrl } from "./usage-limit-message.ts";

export type ProFeature = "reminders" | "cross_inbox_search" | "inbox_instructions" | "morning_brief";

export const PRO_FEATURES: readonly ProFeature[] = [
  "reminders",
  "cross_inbox_search",
  "inbox_instructions",
  "morning_brief",
];

/** Plan ids that get Pro features: solo (Pro) and pro (Business). */
export const PRO_FEATURE_PLANS: readonly string[] = ["solo", "pro"];

/** The `from=` tag on the upgrade link, so the funnel can tell this door apart. */
export const PRO_FEATURE_UPGRADE_PATH = "/pricing?from=pro_feature";

/** The `_meta` key a refusal carries its machine-readable fields under. */
export const PRO_FEATURE_META_KEY = "com.mcpemails/pro_feature";

/** The activity_log error code of a refusal. */
export const PRO_FEATURE_ERROR_CODE = "pro_feature_required";

/**
 * Tools that exist only for a Pro feature, by the name tools/list and
 * tools/call use (consolidated and per-operation names alike). A tool listed
 * here is hidden and unknown until the feature is visible, and refused until
 * it is allowed. Feature branches add their entries here.
 */
export const PRO_FEATURE_TOOLS: Readonly<Record<string, ProFeature>> = {
  // reminders: the consolidated write tool, its read companion, and the
  // per-operation names an OpenAI key is listed (and any client may call).
  reminder: "reminders",
  reminder_list: "reminders",
  reminder_follow_up: "reminders",
  reminder_snooze: "reminders",
  reminder_done: "reminders",
  reminder_cancel: "reminders",
};

/**
 * Pro-only arguments on tools everyone has: tool name, then argument name.
 * Hidden from the listed schema until visible; a call that passes one is
 * refused unless allowed. Top-level properties only. Feature branches add
 * their entries here. A Pro VALUE of an existing argument (for example
 * `inbox_id: "all"`) cannot be expressed here: check it in the handler with
 * proFeatureAccess() from index.ts.
 */
export const PRO_FEATURE_ARGS: Readonly<Record<string, Readonly<Record<string, ProFeature>>>> = {
  // reminders: "follow up if nobody replies within N days" on every send path,
  // consolidated (email_compose send/reply/forward, draft send) and
  // per-operation.
  email_compose: { follow_up_days: "reminders" },
  draft: { follow_up_days: "reminders" },
  email_send: { follow_up_days: "reminders" },
  email_reply: { follow_up_days: "reminders" },
  email_forward: { follow_up_days: "reminders" },
  draft_send: { follow_up_days: "reminders" },
};

/** What the gate needs to know about a workspace. */
export interface ProGateInputs {
  /** Effective plan id (comped-aware), or null when it could not be read. */
  plan: string | null;
  /** workspaces.pro_features_enabled. */
  rolloutEnabled: boolean;
  /** pricing_switches.pro_features_public. */
  publicLaunch: boolean;
}

/** The gate's answer, the same for every Pro feature. */
export interface ProFeatureAccess {
  /** Listed in tools/list and offered in the UI. */
  visible: boolean;
  /** May be used. Never true unless visible. */
  allowed: boolean;
  /** The effective plan the answer was decided on, null when unknown. */
  plan: string | null;
}

/** Fail-closed inputs: hidden and refused, the pre-launch state. */
export const CLOSED_PRO_GATE: ProGateInputs = Object.freeze({
  plan: null,
  rolloutEnabled: false,
  publicLaunch: false,
});

export function isProFeaturePlan(plan: string | null | undefined): boolean {
  return typeof plan === "string" && PRO_FEATURE_PLANS.includes(plan);
}

/** The decision. Pure. */
export function decideProFeatureAccess(inputs: ProGateInputs): ProFeatureAccess {
  const visible = inputs.rolloutEnabled === true || inputs.publicLaunch === true;
  return {
    visible,
    allowed: visible && isProFeaturePlan(inputs.plan),
    plan: inputs.plan,
  };
}

/** True when any tool or argument is registered, i.e. the gate has work to do. */
export function hasProFeatureSurface(
  tools: Readonly<Record<string, ProFeature>> = PRO_FEATURE_TOOLS,
  args: Readonly<Record<string, Readonly<Record<string, ProFeature>>>> = PRO_FEATURE_ARGS,
): boolean {
  return Object.keys(tools).length > 0 || Object.keys(args).length > 0;
}

/**
 * The Pro feature a tools/call touches, from its tool name and raw arguments,
 * or null when it touches none. Decides whether the gate is read at all, so a
 * call to an ordinary tool costs nothing.
 */
export function proFeatureForCall(
  toolName: string,
  rawArgs: unknown,
  tools: Readonly<Record<string, ProFeature>> = PRO_FEATURE_TOOLS,
  args: Readonly<Record<string, Readonly<Record<string, ProFeature>>>> = PRO_FEATURE_ARGS,
): ProFeature | null {
  if (Object.hasOwn(tools, toolName)) return tools[toolName];
  const argFeatures = Object.hasOwn(args, toolName) ? args[toolName] : undefined;
  if (!argFeatures || rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
  for (const [arg, feature] of Object.entries(argFeatures)) {
    const value = (rawArgs as Record<string, unknown>)[arg];
    if (value !== undefined && value !== null) return feature;
  }
  return null;
}

/** True when the tool name exists only for a Pro feature. */
export function isProFeatureTool(
  toolName: string,
  tools: Readonly<Record<string, ProFeature>> = PRO_FEATURE_TOOLS,
): boolean {
  return Object.hasOwn(tools, toolName);
}

/** The listing shape this module touches: a name and up to two schemas. */
interface ListableTool {
  name: string;
  inputSchema: Record<string, unknown>;
  listedInputSchema?: Record<string, unknown>;
}

function withoutProperties(schema: Record<string, unknown>, drop: string[]): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  if (!drop.some((name) => Object.hasOwn(properties, name))) return schema;
  const kept = Object.fromEntries(
    Object.entries(properties as Record<string, unknown>).filter(([name]) => !drop.includes(name)),
  );
  const next: Record<string, unknown> = { ...schema, properties: kept };
  if (Array.isArray(schema.required)) {
    next.required = (schema.required as unknown[]).filter((name) => !drop.includes(String(name)));
  }
  return next;
}

/**
 * tools/list: what a workspace is shown. When the features are not visible,
 * Pro tools are removed and Pro arguments are dropped from the listed schema
 * (a copy; the registry entry is never mutated). When visible, the list is
 * returned unchanged: a visible-but-not-allowed workspace is shown the tool
 * and refused at call time, which is how it learns the feature exists.
 */
export function hideProFeaturesFromListing<T extends ListableTool>(
  tools: T[],
  access: ProFeatureAccess,
  proTools: Readonly<Record<string, ProFeature>> = PRO_FEATURE_TOOLS,
  proArgs: Readonly<Record<string, Readonly<Record<string, ProFeature>>>> = PRO_FEATURE_ARGS,
): T[] {
  if (access.visible) return tools;
  const out: T[] = [];
  for (const tool of tools) {
    if (Object.hasOwn(proTools, tool.name)) continue;
    const args = Object.hasOwn(proArgs, tool.name) ? Object.keys(proArgs[tool.name]) : [];
    if (args.length === 0) {
      out.push(tool);
      continue;
    }
    const copy: T = { ...tool, inputSchema: withoutProperties(tool.inputSchema, args) };
    if (tool.listedInputSchema) copy.listedInputSchema = withoutProperties(tool.listedInputSchema, args);
    out.push(copy);
  }
  return out;
}

/** Customer-facing names of the features, for the refusal text. */
const FEATURE_LABELS: Record<ProFeature, string> = {
  reminders: "Reminders",
  cross_inbox_search: "Search across all inboxes",
  inbox_instructions: "Per-inbox instructions",
  morning_brief: "The morning brief",
};

/**
 * The refusal as an isError TOOL result (content + _meta), for a feature that
 * is visible but not allowed on this plan. Declarative facts only, no
 * instruction aimed at the model (see buildUsageLimitText for why). The
 * machine-readable fields ride in `_meta`, never `structuredContent`.
 *
 * `directory` wording (OpenAI directory clients) names no plan to buy and links
 * the plain plans page, as the cap paywall does.
 */
export function proFeatureRefusalResult(
  feature: ProFeature,
  plan: string | null,
  appOrigin: string,
  wording: PlanLimitWording = "standard",
): { content: { type: "text"; text: string }[]; isError: true; _meta: Record<string, unknown> } {
  const label = FEATURE_LABELS[feature];
  const planLabel = plan ? (PLAN_DISPLAY_NAMES[plan] ?? null) : null;
  const onPlan = planLabel ? ` This workspace is on the ${planLabel} plan.` : "";
  const link = wording === "directory" ? plansInfoUrl(appOrigin) : `${appOrigin}${PRO_FEATURE_UPGRADE_PATH}`;
  const text = `${label} is part of the Pro and Business plans.${onPlan} ` +
    `Nothing was changed, and retrying will not help: this is a plan feature, not a temporary failure. ` +
    (wording === "directory"
      ? `The plans and what each includes are described at ${link}.`
      : `The Pro plan adds it, at ${link}.`);
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: {
      [PRO_FEATURE_META_KEY]: {
        error_code: PRO_FEATURE_ERROR_CODE,
        feature,
        effective_plan: plan,
        required_plans: [...PRO_FEATURE_PLANS],
        retryable: false,
        ...(wording === "directory" ? { plans_url: link } : { upgrade_url: link }),
      },
    },
  };
}
