import { useEffect } from "react";
import { useInboxes } from "../data/hooks";
import { mailActions } from "../data/mail-actions";
import { canWrite } from "../state/permissions";
import { type DeepLink, NOTIFICATION_ACTION } from "../platform";
import { useAssistantStore } from "../state/assistant-store";
import { useComposeStore } from "../state/compose-store";
import { useSelectionStore } from "../state/selection-store";
import { isPhone, useUiStore } from "../state/ui-store";
import { canonicalizeLocation, ensureBackStack, getRoute, navigate, parseLocation, subscribeRoute } from "./router";

/* Keeps the URL, the history stack and the stores telling the same story.
 *
 * The selection store already mirrors scope / folder / search / open message
 * to and from the URL. This module covers what it cannot:
 *   - the URL as typed (canonical form, a back stack for phone deep links)
 *   - /compose (the form lives in the compose store, not in the URL)
 *   - a mailbox in the URL that this account does not have
 *   - links opened from a notification
 */

/** Once, before the first interaction. Safe to call twice (StrictMode). */
export function initRouting(): () => void {
  // "/", "/nope", "/all/inbox/extra/segments" -> the canonical URL of what was parsed.
  canonicalizeLocation();
  // Phone: a link straight to a message or to /compose gets the list put
  // underneath, so Back shows the list instead of leaving the app.
  if (isPhone()) ensureBackStack();

  // Back / Forward across a /compose entry.
  return subscribeRoute((route, cause) => {
    if (cause !== "pop") return;
    const c = useComposeStore.getState().compose;
    if (route.compose && !c) {
      // A read-only member has nothing to compose: /compose just shows the list.
      if (canWrite()) mailActions.newCompose();
      return;
    }
    if (route.compose || !c || c.replyTo) return;
    // Left /compose with the form still open.
    if (c.held || c.streaming) {
      // A send is waiting for approval, or the assistant is still writing: the
      // form must not be hidden while it is live. Stay on it.
      navigate({ compose: true });
      if (isPhone()) useUiStore.getState().setScreen("compose");
      return;
    }
    // Same as Esc: keep what was typed as a draft and close the form.
    if (canWrite()) void mailActions.saveDraft();
    else useComposeStore.getState().discard();
  });
}

/** Renders nothing. Waits for the mailbox list, then finishes restoring the URL. */
export function RouteEffects() {
  const { data: inboxes } = useInboxes();

  useEffect(() => {
    if (!inboxes) return;
    const selection = useSelectionStore.getState();
    // A mailbox id in the URL that is not one of this account's: fall back to /all/inbox.
    if (selection.scope !== "all" && !inboxes.some((i) => i.inbox_id === selection.scope)) {
      useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: null, multiSel: [] });
      navigate({ scope: "all", folder: { role: "inbox" }, query: "", messageKey: null }, { replace: true });
      const ui = useUiStore.getState();
      if (ui.viewport === "phone" && ui.screen === "reader") ui.setScreen("list");
    }
    // Loaded on /compose (the manifest's Compose shortcut, a reload): open the
    // form now that there is a mailbox to send from.
    if (getRoute().compose && !useComposeStore.getState().compose && inboxes.length && canWrite()) mailActions.newCompose();
  }, [inboxes]);

  return null;
}

/** A notification was clicked (or another deep link arrived) while the app is open. */
export function openDeepLink(link: DeepLink): void {
  let url: URL;
  try {
    url = new URL(link.url, window.location.origin);
  } catch {
    return;
  }
  // Only in-app paths. The service worker enforces the same rule.
  if (url.origin !== window.location.origin) return;

  const approvalId = typeof link.data?.approval_id === "string" ? link.data.approval_id : null;
  const compose = useComposeStore.getState().compose;
  if (approvalId) {
    // "The assistant wants to send". The held draft is already on screen in
    // the compose form; never navigate away from it.
    if (compose?.held?.approval_id === approvalId) {
      if (isPhone()) useUiStore.getState().setScreen(compose.replyTo ? "reader" : "compose");
      // Approve only the send that is actually being held, and only when the
      // user pressed Approve. Anything else (Review, a tap on the body, an id
      // that no longer matches) just shows the draft: unanswered means not sent.
      if (link.action === NOTIFICATION_ACTION.approve && canWrite()) void useAssistantStore.getState().resolveApproval("approve");
      return;
    }
    // Stale approval: fall through and just open the location.
  }

  const route = parseLocation(url.pathname, url.search);
  if (route.compose) {
    if (!compose && canWrite()) mailActions.newCompose();
    return;
  }
  const selection = useSelectionStore.getState();
  selection.openFolder(route.folder, route.scope);
  if (route.query) selection.setQuery(route.query);
  if (route.messageKey) selection.select(route.messageKey);
}
