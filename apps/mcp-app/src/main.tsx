import { render } from "preact";
import { HostBridge } from "./bridge";
import { App } from "./components/App";
import { setLocale } from "./format";
import "./styles.css";
import {
  armResultWatchdog,
  disarmResultWatchdog,
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

let stopSizeObserver: (() => void) | null = null;

bridge
  .connect(APP_INFO)
  .then(() => {
    applyHostContext(bridge.hostContext);
    setLocale(bridge.hostContext.locale);
    root.dataset.mode =
      bridge.hostContext.displayMode === "fullscreen" ? "fullscreen" : "inline";
    setState({ connected: true, hostContext: bridge.hostContext });
    stopSizeObserver = bridge.observeSize();
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
