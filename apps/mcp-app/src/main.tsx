import { render } from "preact";
import { HostBridge } from "./bridge";
import { App } from "./components/App";
import { setLocale } from "./format";
import "./styles.css";
import {
  armResultWatchdog,
  disarmResultWatchdog,
  getState,
  runTeardownSaver,
  setState,
  toolInfoFrom,
  wireResultHandlers,
} from "./store";
import { applyHostContext, applyTheme } from "./theme";

const APP_INFO = { name: "mcp-emails-review-card", version: "1.0.0" };

const bridge = new HostBridge();

// --- handlers first ---------------------------------------------------------
// Phase-0 Q7.12: tool-input and tool-result are one-shot and can be delivered
// immediately after the handshake, so every handler is attached before
// connect() is called, not after.

// tool-input, tool-result AND tool-cancelled, together, because they are three
// halves of one state machine: any can be the thing that ends the wait, none is
// guaranteed to arrive at all, and tool-input is the only one a re-mounted view
// is actually promised. See store.ts#wireResultHandlers.
wireResultHandlers(bridge);

bridge.onHostContextChanged = () => {
  // The host does not apply the theme for us (Q7.1); re-apply on every change.
  applyHostContext(bridge.hostContext);
  setLocale(bridge.hostContext.locale);
  setState({
    hostContext: bridge.hostContext,
    toolInfo: toolInfoFrom(bridge.hostContext),
  });
};

// Diagnostics only: keeps the `hs`/`rx` counters live while the handshake is
// still being retried, so a card that never connects shows what it actually
// tried rather than its first-paint values.
bridge.onInitializeAttempt = () => {
  setState({ handshakeTick: getState().handshakeTick + 1 });
};

bridge.onTeardown = async () => {
  // Async on purpose: `ui/resource-teardown` is a request and the bridge holds
  // its reply until this resolves, which is the only moment a half-typed draft
  // can still be written. The bridge caps the wait at TEARDOWN_TIMEOUT_MS, so a
  // save that hangs cannot hold the host's frame open.
  await runTeardownSaver();
  disarmResultWatchdog();
  setState({ connected: false });
};

// Render immediately with a skeleton so there is never a blank frame.
const root = document.getElementById("root")!;
root.className = "card";
applyTheme(undefined); // light default until the host tells us otherwise
render(<App bridge={bridge} />, root);

// ── Measured from the first paint, not from the handshake ──────────────────
// This used to start inside the `.then()` below, which meant the host was told
// the card's height ONLY on the success path. Two states were therefore drawn
// and never measured: the pre-handshake frame, and — the one that matters —
// `store.connectError`, the "not shown here" one-liner the card falls back to
// when the host never answers. That line has existed since 2026-08-25 and
// could not have been seen by anyone: nothing ever sent a `size-changed` for
// it, so the host kept the frame at whatever it mounts at, which in Claude is
// the sliver this branch exists to fix.
//
// Starting here costs one `size-changed` notification before `ui/initialize`
// completes. That is a notification, not a request: a host that is not ready
// for it drops it exactly as it drops the `ui/initialize` that went out in the
// same tick, and the ResizeObserver re-measures on the first render after the
// handshake regardless. So the worst case is one ignored message, and the best
// case is a card that has told the host its height before the handshake even
// finishes.
let stopSizeObserver: (() => void) | null = bridge.observeSize();

bridge
  .connect(APP_INFO)
  .then(() => {
    applyHostContext(bridge.hostContext);
    setLocale(bridge.hostContext.locale);
    root.dataset.mode =
      bridge.hostContext.displayMode === "fullscreen" ? "fullscreen" : "inline";
    setState({ connected: true, hostContext: bridge.hostContext });
    // Only now, never at module load: the countdown is for the host being late
    // with a result, not for the host being slow to answer the handshake (that
    // failure has its own timeout and surfaces as `connectError`).
    armResultWatchdog(bridge);
  })
  .catch((e: unknown) => {
    setState({
      connectError: e instanceof Error ? e.message : String(e),
    });
  });

window.addEventListener("pagehide", () => {
  stopSizeObserver?.();
  disarmResultWatchdog();
});
