/**
 * The decision behind the inbox-cap paywall beacon, kept free of React so it
 * can be tested directly.
 *
 * Two rules matter and both are easy to get wrong in an effect:
 *
 *   1. Fire once per modal-open, not once per render. The upgrade panel lives
 *      in a component that re-renders on every keystroke elsewhere in the
 *      modal, and a paywall counted once per render would report intent that
 *      nobody expressed, inflating the denominator of the only conversion rate
 *      this instrumentation exists to measure.
 *   2. Never fire for a reconnect. Re-authenticating an inbox the workspace
 *      already owns is not a purchase decision, and the modal deliberately
 *      never shows the upgrade panel in that mode, so counting one would be
 *      counting a paywall that was not shown.
 *
 * The reporter is stateful by design: one instance per modal-open, discarded
 * with the modal. The caller holds it in a ref so remounting (i.e. the user
 * opening the modal again, which IS a second paywall hit) starts a fresh one.
 */
export function createInboxPaywallReporter() {
  let reported = false;
  /**
   * @param {object} state
   * @param {boolean} state.isReconnect        - The modal is re-authenticating an existing inbox.
   * @param {boolean} state.atInboxLimit       - The client-side gate: the page loaded already at the cap.
   * @param {boolean} state.serverLimitReached - The stale-prop fallback: a connect route answered 402.
   * @returns {boolean} True exactly once, on the first state in which the panel is shown.
   */
  return function shouldReport({ isReconnect, atInboxLimit, serverLimitReached }) {
    if (reported) return false;
    if (isReconnect) return false;
    if (!atInboxLimit && !serverLimitReached) return false;
    reported = true;
    return true;
  };
}
