/**
 * Step id -> panel component. Owned by WP-C (the skeleton); each panel file is
 * owned by the work package that fills it, so two agents never edit the same
 * file:
 *
 *   inbox         ./InboxStep.jsx        WP-E (A3-A5)
 *   add_to_ai     ./AddToAiStep.jsx      WP-F (A6)
 *   first_prompt  ./FirstPromptStep.jsx  WP-F (A8)
 *   wait          ./WaitStep.jsx         WP-F (A8)
 *   it_works      ./ItWorksStep.jsx      WP-F (A9)
 *
 * THE PANEL CONTRACT. OnboardingApp renders exactly one panel and passes it
 * these props (and nothing else):
 *
 *   step            the panel's own step id
 *   status          OnboardingStatus | null  (src/lib/onboarding/status.ts)
 *   refreshStatus   () => Promise<OnboardingStatus | null>   fetch it now
 *   setPolling      (cadence | null) => void   poll /api/onboarding/status;
 *                   cadence(elapsedMs) -> next delay in ms, or null to stop.
 *                   `adaptiveCadence` in ../useOnboardingStatus.js is the
 *                   plan's default. Stopped automatically on unmount of the app.
 *   client          the chip id ('claude', 'chatgpt', 'claude_code', ...)
 *   clientLabel     its display name ("Claude", "VS Code")
 *   provider        the ?provider= slug from a /connect/<slug> page, or null
 *                   (unvalidated; resolve with src/lib/connect/intent.mjs)
 *   variant         { flow: 'control'|'new', convert: 'off'|'on' }
 *                   (convert 'on' = Flow B moments, WP-H)
 *   mcpUrl          the MCP server URL to install (https://mcpemails.com/api/mcp)
 *   userEmail       the signed-in user's address (the A3 "use my signup
 *                   address" chip; never prefill the field with it)
 *   goNext()        advance to the next step (no-op after the last)
 *   goTo(stepId)    jump to any step (ONBOARDING_STEPS in src/lib/onboarding/flow.ts)
 *   finish(href?)   the flow is done: stamps onboarding_completed_at and
 *                   navigates to /dashboard (or `href`, a /dashboard path)
 *   flowB           Flow B facts (src/lib/onboarding/flow-b-server.ts), or
 *                   null outside onb_convert = on or off Free (WP-H)
 *   secondInbox     true when the inbox step was opened from It works'
 *                   "Connect your other inbox" (WP-H, plan B1)
 *   startSecondInbox()  open the inbox step in that mode
 *
 * Panels must not import from components/dashboard/*: /onboarding has its own
 * JS budget (under 170 KB brotli first load, plan A9). Strings go in the
 * `onboarding` namespace (messages/<locale>/onboarding.json), under
 * steps.<step id>.*.
 */
import { InboxStep } from './InboxStep';
import { AddToAiStep } from './AddToAiStep';
import { FirstPromptStep } from './FirstPromptStep';
import { WaitStep } from './WaitStep';
import { ItWorksStep } from './ItWorksStep';

export const STEP_PANELS = {
  inbox: InboxStep,
  add_to_ai: AddToAiStep,
  first_prompt: FirstPromptStep,
  wait: WaitStep,
  it_works: ItWorksStep,
};
