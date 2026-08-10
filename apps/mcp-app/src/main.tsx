import { render } from "preact";
import { HostBridge } from "./bridge";
import { App } from "./components/App";
import { setLocale } from "./format";
import "./styles.css";
import { classifyResult, setState } from "./store";
import { applyHostContext, applyTheme } from "./theme";

const APP_INFO = { name: "mcp-emails-review-card", version: "1.0.0" };

const bridge = new HostBridge();

// --- handlers first ---------------------------------------------------------
// Phase-0 Q7.12: tool-input and tool-result are one-shot and can be delivered
// immediately after the handshake, so every handler is attached before
// connect() is called, not after.

bridge.onToolResult = (params) => {
  // `status` matters as much as `envelope`: a result that is not ours at all
  // (an opted-out inbox, a non-plannable email_organize action) must leave the
  // card silent rather than warn under a successful operation. See store.ts.
  const { envelope, status } = classifyResult(params);
  setState(envelope ? { envelope, resultStatus: status } : { resultStatus: status });
};

bridge.onToolInput = () => {
  // The card renders the server's envelope, never the agent's raw arguments —
  // they are attacker-influenced and carry no fields the envelope lacks.
};

bridge.onHostContextChanged = () => {
  // The host does not apply the theme for us (Q7.1); re-apply on every change.
  applyHostContext(bridge.hostContext);
  setLocale(bridge.hostContext.locale);
  setState({ hostContext: bridge.hostContext });
};

bridge.onTeardown = () => {
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
  })
  .catch((e: unknown) => {
    setState({
      connectError: e instanceof Error ? e.message : String(e),
    });
  });

window.addEventListener("pagehide", () => stopSizeObserver?.());
