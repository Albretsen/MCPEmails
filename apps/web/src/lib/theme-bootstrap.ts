/**
 * The theme bootstrap script — the ONE inline `<script>` this app ships.
 *
 * It must run before first paint, otherwise a visitor whose stored theme is
 * "dark" gets a white flash while React hydrates. That rules out loading it as
 * an external file (an extra blocking round trip in <head>) and rules out
 * running it from a component effect (too late — paint has already happened).
 * So it stays inline, and the Content-Security-Policy has to make room for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES IN ITS OWN MODULE
 * ─────────────────────────────────────────────────────────────────────────────
 * `script-src` no longer contains 'unsafe-inline' (see src/lib/csp.ts), so this
 * script only executes because its SHA-256 hash is listed in the policy. The
 * hash is computed at runtime, in the proxy, from THIS EXACT STRING — so the
 * policy and the markup can never drift apart. Inline the string back into a
 * layout and the next person who edits a space character silently kills the
 * theme on every page, with no build error and no test failure.
 *
 * Two files render it:
 *   - app/layout.js       (every real page)
 *   - app/global-error.js (the root-layout crash screen, which replaces the
 *                          root layout entirely and so cannot inherit it)
 *
 * Both MUST render it via `dangerouslySetInnerHTML={{ __html: ... }}` with no
 * added whitespace. React writes `__html` into the stream verbatim, and the
 * browser hashes exactly the bytes between the tags — a single extra newline
 * changes the digest and the script is blocked.
 *
 * Keep it dependency-free and side-effect-light: it runs before anything else
 * on the page, and a throw here would leave the document unstyled.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  try {
    var t = localStorage.getItem("mcpe-theme") || "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();`;
