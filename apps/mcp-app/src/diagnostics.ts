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
// subject, no address, no body. So this is trust and polish, not disclosure,
// but "no content leaked" is not a reason for a customer to read
// `hs 1 · rx 8/0` under a send they are being asked to approve. Seven
// non-internal workspaces were reading exactly that.
//
// TWO sources, both default-off, in the order they are checked:
//
//   1. The envelope (`diagnostics: true`). The only per-workspace signal a
//      static bundle can have; see contract.ts. The server authors it in one
//      place, `supabase/functions/mcp-server/card-diagnostics.ts`, from
//      `workspaces.card_diagnostics` (applied 2026-09-17, default false,
//      seeded to our own workspaces). In practice this is the only source a
//      shipped card has.
//   2. A build flag, for a bundle deliberately built for local work:
//      VITE_CARD_DIAGNOSTICS=1 npm run build. Vite bakes `import.meta.env`
//      into the output as a module-local object literal holding only the
//      VITE_-prefixed variables that were set at build time, so an ordinary
//      production build ships `{BASE_URL, DEV, MODE, PROD, SSR}` with no such
//      key and this reads false. Verified in the built bundle, not assumed.
//      (Read through a cast rather than as `import.meta.env.VITE_...`, which
//      would let Vite fold the branch away entirely, because this package
//      compiles with `types: []` and has no vite/client types.)
//
// A THIRD SOURCE WAS REMOVED on 2026-09-17: a `mcpemails.card.diag` key in the
// card's own localStorage, which existed so an internal user could turn the
// line on in the real host without a redeploy. Source 1 does that job better,
// per workspace and revocable, with no devtools on a sandbox frame. What the
// key added was the only input to this decision that we do not author: any
// same-origin page could write it, and whether Claude's sandbox gives each MCP
// App its own origin is a host detail we cannot read from inside the frame. All
// it could win was a line of our own protocol counters, so this was never
// severe, but a writable input kept for a convenience we no longer need is a
// bad trade. Do not add it back.
// ---------------------------------------------------------------------------

import type { Envelope } from "./contract";

/** Build-time opt-in. False in any ordinary production build; see above. */
function builtWithDiagnostics(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    return env?.VITE_CARD_DIAGNOSTICS === "1";
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
 *
 * A card with no envelope at all (a cancelled call, a foreign payload) has no
 * workspace to ask about, so it falls through to the build flag, which is false
 * everywhere but a local build.
 */
export function diagnosticsEnabled(env: Envelope | null | undefined): boolean {
  if (env && (env as { diagnostics?: unknown }).diagnostics === true) return true;
  return builtWithDiagnostics();
}
