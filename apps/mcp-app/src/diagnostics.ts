// ---------------------------------------------------------------------------
// Is this build allowed to show the protocol diagnostics line?
//
// The line itself lives in App.tsx. This file is the one place that decides,
// because the previous answer was "always", written in three files that each
// called it INTERNAL v1 ONLY. Nothing that renders a card may make this
// judgement inline again.
//
// What the line contains, for the record, because the severity depends on it:
// host name and version, display mode, four yes/no counters, two timings, and
// the tool name (neutralised and sliced to 64 in store.ts#toolInfoFrom). No
// subject, no address, no body. So this is trust and polish, not disclosure —
// but "no content leaked" is not a reason for a customer to read
// `hs 1 · rx 8/0` under a send they are being asked to approve.
//
// THREE sources, all default-off, in the order they are checked:
//
//   1. The envelope (`diagnostics: true`). The only per-workspace signal a
//      static bundle can have; see contract.ts. NOT SENT BY THE SERVER TODAY,
//      so today this source never fires and the line is off everywhere.
//   2. A build flag, for a bundle deliberately built for internal use:
//      VITE_CARD_DIAGNOSTICS=1 npm run build. Vite inlines `import.meta.env`
//      at build time, so a production build with the variable unset compiles
//      this to a constant false.
//   3. A per-browser switch in the card's own storage, which is how an
//      internal user turns the line on in the real host without a redeploy:
//      localStorage.setItem("mcpemails.card.diag", "1") from the sandbox
//      frame. Worth knowing: if the sandbox origin turns out to be shared
//      between MCP Apps, another app could set this flag — and all it would
//      win is a line of our own protocol counters, which is why this source is
//      acceptable at all.
// ---------------------------------------------------------------------------

import type { Envelope } from "./contract";

export const DIAG_FLAG_KEY = "mcpemails.card.diag";

/** Build-time opt-in. Constant-folded away in an ordinary production build. */
function builtWithDiagnostics(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    return env?.VITE_CARD_DIAGNOSTICS === "1";
  } catch {
    return false;
  }
}

/** Per-browser opt-in. Storage is optional everywhere in this card. */
function flaggedInThisBrowser(): boolean {
  try {
    return localStorage.getItem(DIAG_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether to render the diagnostics line for this envelope.
 *
 * Strict `=== true` on the envelope field: it arrives from the wire like every
 * other field, and a truthy string ("no", "0") must not turn on a line that
 * exists to be off in front of customers.
 */
export function diagnosticsEnabled(env: Envelope | null | undefined): boolean {
  if (env && (env as { diagnostics?: unknown }).diagnostics === true) return true;
  if (builtWithDiagnostics()) return true;
  return flaggedInThisBrowser();
}
