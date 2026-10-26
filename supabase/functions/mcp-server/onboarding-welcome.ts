// ---------------------------------------------------------------------------
// onboarding-welcome.ts - the one-time "what to ask next" line (onboarding
// plan A10, WP-F).
//
// The person is in their AI chat, not on our page, so the first useful tool
// result is the one place we can say what else MCPEmails does. The first
// SUCCESSFUL call against a real inbox (the same moment markFirstProductUse
// sets onboarding_value_activated_at: a resolved inbox, never inbox_list)
// ends with one short, declarative line naming two next things to ask.
//
// Rules, all deliberate:
//   - Never a price, a plan or a link. It is a tip, not an upsell.
//   - Once per workspace (per onboarding reset): claim_onboarding_welcome()
//     is a conditional UPDATE, so of two concurrent first calls only one
//     says it. It also re-checks that the value marker is still NULL.
//   - v1: internal accounts only. The claim function checks the owner with
//     growth_is_internal_email, so nothing reaches a customer until that
//     line in the function is widened.
//   - No query unless this call could be the first value call (markers
//     already read by the plan check say the value marker is NULL).
//   - It can never fail the call. Errors are logged and the result goes out
//     without the line.
// ---------------------------------------------------------------------------

import type { FirstUseMarkers } from "./request-pipeline.ts";

export const ONBOARDING_WELCOME_TEXT =
  "MCPEmails is now connected to this inbox. Next, the user can ask you to draft replies to the emails that need one " +
  "(saved as drafts, nothing is sent) or to give them a morning brief of what came in and what needs a reply today.";

/**
 * Could this call be the workspace's first value call? Only when the plan
 * check read the markers (unknown markers: no line, no query), the value
 * marker is not set, the call succeeded, it resolved an inbox and it was not
 * inbox_list.
 */
export function mayBeFirstValueCall(input: {
  markers: FirstUseMarkers | null | undefined;
  succeeded: boolean;
  inboxId: string | null;
  toolName: string;
}): boolean {
  if (!input.succeeded || !input.markers) return false;
  if (input.markers.onboarding_value_activated_at) return false;
  return input.inboxId !== null && input.toolName !== "inbox_list";
}

/** The slice of the Supabase client the claim uses. */
export interface OnboardingWelcomeDb {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): any;
}

/** Decide, claim, attach. Never throws. True when the line was attached. */
export async function maybeAttachOnboardingWelcome(options: {
  db: OnboardingWelcomeDb;
  workspaceId: string;
  markers: FirstUseMarkers | null | undefined;
  succeeded: boolean;
  inboxId: string | null;
  toolName: string;
  attach: (note: string) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<boolean> {
  const log = options.log ?? ((event, fields) => console.log(`[mcp-server] ${event}`, fields));
  try {
    if (!mayBeFirstValueCall(options)) return false;
    const { data, error } = await options.db.rpc("claim_onboarding_welcome", { p_workspace_id: options.workspaceId });
    if (error) throw new Error(error.message ?? String(error));
    if (data !== true) return false;
    options.attach(ONBOARDING_WELCOME_TEXT);
    log("onboarding_welcome_shown", { workspace_id: options.workspaceId, tool_name: options.toolName });
    return true;
  } catch (err) {
    log("onboarding_welcome_failed", {
      workspace_id: options.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
