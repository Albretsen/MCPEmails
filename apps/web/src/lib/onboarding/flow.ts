/**
 * The /onboarding step machine and the variant vocabulary, client-safe.
 *
 * STEPS (plan section 3). Each step is one panel component in its own file
 * under components/onboarding/steps/, so the agents that fill them never touch
 * each other's files:
 *
 *   inbox         A3-A5  InboxStep.jsx        (WP-E)
 *   add_to_ai     A6     AddToAiStep.jsx      (WP-F)
 *   first_prompt  A8     FirstPromptStep.jsx  (WP-F)
 *   wait          A8     WaitStep.jsx         (WP-F)
 *   it_works      A9     ItWorksStep.jsx      (WP-F)
 *
 * The machine is deliberately dumb: an ordered list, `next`, `goTo`, and one
 * function that picks where a (re)loaded page should start from the server
 * status. Panels decide when to call `goNext()`.
 *
 * VARIANTS. The two experiment keys and their values live here so that
 * client components can name them without importing server code. The server
 * side (assignment, the internal gate) is src/lib/onboarding/variant.ts.
 */

// ── Variants ────────────────────────────────────────────────────────────────

export const ONB_FLOW_KEY = 'onb_flow';
export const ONB_CONVERT_KEY = 'onb_convert';

export type OnboardingFlowArm = 'control' | 'new';
export type OnboardingConvertArm = 'off' | 'on';
export interface OnboardingVariant { flow: OnboardingFlowArm; convert: OnboardingConvertArm }

/** What every workspace gets unless something says otherwise. */
export const CONTROL_VARIANT: Readonly<OnboardingVariant> = Object.freeze({ flow: 'control', convert: 'off' });
/** What internal accounts get in v1. */
export const INTERNAL_VARIANT: Readonly<OnboardingVariant> = Object.freeze({ flow: 'new', convert: 'on' });

/** A variant object from untrusted input; anything malformed is the control. */
export function normalizeVariant(value: unknown): OnboardingVariant {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<'flow' | 'convert', unknown>>;
  return { flow: v.flow === 'new' ? 'new' : 'control', convert: v.convert === 'on' ? 'on' : 'off' };
}

/**
 * The part of OnboardingStatus (src/lib/onboarding/status.ts) the machine
 * reads. Declared here so this file stays client-safe.
 */
export interface StepSignals {
  inboxes?: { count?: number; sinceReset?: number; chosenAt?: string | null } | null;
  credential?: { sinceReset?: boolean } | null;
  handshake?: { at?: string | null } | null;
  firstCall?: { at?: string | null } | null;
  anyCall?: { at?: string | null } | null;
}

// ── Steps ───────────────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = ['inbox', 'add_to_ai', 'first_prompt', 'wait', 'it_works'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingStepCategory = 'step_inbox' | 'step_add_to_ai' | 'step_first_prompt' | 'step_wait' | 'step_it_works';

/** step id -> product_funnel_events.category for `onboarding_step_viewed`. */
export const STEP_FUNNEL_CATEGORY: Readonly<Record<OnboardingStep, OnboardingStepCategory>> = Object.freeze({
  inbox: 'step_inbox',
  add_to_ai: 'step_add_to_ai',
  first_prompt: 'step_first_prompt',
  wait: 'step_wait',
  it_works: 'step_it_works',
});

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** The step after `step`, or null after the last one. */
export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const at = ONBOARDING_STEPS.indexOf(step);
  if (at === -1 || at === ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[at + 1];
}

/** The step before `step`, or null before the first one. */
export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const at = ONBOARDING_STEPS.indexOf(step);
  return at > 0 ? ONBOARDING_STEPS[at - 1] : null;
}

/**
 * Where a page load starts, from the status (src/lib/onboarding/status.ts).
 * Every signal used here already ignores what happened before the last reset,
 * so a reset workspace starts over even though its inbox and keys still exist.
 *
 *   a successful call on a real inbox since reset  -> it_works
 *   an MCP handshake or any tool call since reset   -> wait
 *   a credential (connector grant / key) since reset-> first_prompt
 *   an inbox connected, or the connected inbox
 *   chosen ("Use <address>"), since reset           -> add_to_ai
 *   otherwise                                       -> inbox
 *
 * After a reset with an inbox still connected this returns `inbox`; the inbox
 * panel then offers "use the connected inbox" or "connect another"
 * (hasReusableInbox). Choosing it is stored (POST /api/onboarding
 * {inbox_reused}, status.inboxes.chosenAt), so a reload does not ask again.
 *
 */
export function initialStep(status: StepSignals | null | undefined): OnboardingStep {
  if (!status) return 'inbox';
  if (status.firstCall?.at) return 'it_works';
  if (status.handshake?.at || status.anyCall?.at) return 'wait';
  if (status.credential?.sinceReset) return 'first_prompt';
  if ((status.inboxes?.sinceReset ?? 0) > 0 || status.inboxes?.chosenAt) return 'add_to_ai';
  return 'inbox';
}

/** True when a reset left an inbox connected that the inbox step should offer to reuse. */
export function hasReusableInbox(status: StepSignals | null | undefined): boolean {
  return Boolean(status && (status.inboxes?.count ?? 0) > 0 && (status.inboxes?.sinceReset ?? 0) === 0 && !status.inboxes?.chosenAt);
}
