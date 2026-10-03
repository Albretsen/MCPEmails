import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/base.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { restoreQueryCache } from "./data";

/* Restore the persisted query cache BEFORE the first render, so a reload
 * paints the last known mailbox with no spinner. IndexedDB normally answers in
 * a few milliseconds; if it is slow or blocked we render anyway. */
const RESTORE_BUDGET_MS = 250;

async function boot(): Promise<void> {
  await Promise.race([restoreQueryCache(), new Promise((r) => setTimeout(r, RESTORE_BUDGET_MS))]);
  const root = document.getElementById("root");
  if (!root) throw new Error("#root is missing from index.html");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
