/**
 * One place that knows how to open a browser for this tool, so a capture and a
 * reset see exactly the same product.
 *
 * The launch flags are not decoration. Colours and text rendering drift between
 * machines otherwise, and a re-record on a different laptop then fails to cut
 * against the takes already in the storyboard.
 */

import { existsSync } from 'node:fs';
import { paths } from './common.mjs';

export const VIEWPORT = { width: 1920, height: 1080 };

export const LAUNCH_ARGS = [
  // Pin the colour profile. Without it macOS applies the display profile and
  // the brand blue lands a few points off between machines.
  '--force-color-profile=srgb',
  // Subpixel antialiasing produces colour fringing that survives H.264 badly.
  '--disable-lcd-text',
  // A scrollbar drifting in and out of frame is the single most common thing
  // that makes a screen recording look like a test artifact.
  '--hide-scrollbars',
  '--font-render-hinting=none',
];

export async function launch({ headless = true } = {}) {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless, args: LAUNCH_ARGS });
}

/**
 * A context carrying the saved demo session.
 *
 * `record` turns on video. The returned `startedAt` is the reading every
 * timeline timestamp is measured from: Playwright begins recording when the
 * context is created, so one performance.now() here is the shared zero.
 */
export async function demoContext(browser, { record = false, requiresSession = true, theme = 'dark' } = {}) {
  if (requiresSession && !existsSync(paths.authState)) {
    throw new Error(
      'No saved demo session at .auth/demo.json.\n' +
      'Run: npm run auth\n' +
      'A human signs in by hand, once. Never type a password into the login form from a script.',
    );
  }

  const useSession = requiresSession && existsSync(paths.authState);

  const context = await browser.newContext({
    ...(useSession ? { storageState: paths.authState } : {}),
    viewport: VIEWPORT,
    // Retina, so text in the recording is sharp enough to survive the auto
    // zoom pushing in on it.
    deviceScaleFactor: 2,
    colorScheme: theme,
    // The product's own animations are part of what is being demonstrated, so
    // do not let the OS setting suppress them.
    reducedMotion: 'no-preference',
    locale: 'en-US',
    timezoneId: 'Europe/Oslo',
    ...(record
      ? { recordVideo: { dir: paths.capturesRaw, size: VIEWPORT } }
      : {}),
  });

  // Seed the app's stored light/dark preference. It keeps it in localStorage
  // under "mcpe-theme" and reads it before first paint; it does NOT follow
  // prefers-color-scheme, so the colorScheme option above does nothing on its
  // own.
  //
  // This is a REQUEST, not a guarantee, and the difference matters. Measured
  // against production on 2026-08-31: the marketing pages overwrite the value
  // back to "light" during hydration, so a capture of them comes back light
  // whatever is set here. The dashboard honours the account's own preference,
  // which is why the practical fix is to set the theme by hand once, in the
  // demo account, during `npm run auth`.
  //
  // Because the request can be ignored, capture.mjs MEASURES the recording's
  // actual appearance afterwards and records it in the timeline, and verify
  // warns when it does not match the storyboard. A light recording letterboxed
  // into a dark cut reads as a mistake, and it should not be able to reach a
  // deliverable unnoticed.
  await context.addInitScript((wanted) => {
    try {
      localStorage.setItem('mcpe-theme', wanted);
    } catch {
      // Private mode, or storage disabled. The capture is still usable, it
      // just comes back in the app's default theme.
    }
  }, theme);

  const startedAt = performance.now();
  return { context, startedAt };
}

/**
 * Which workspace is this session actually looking at?
 *
 * The cookie is tried first because it is what the SERVER reads to decide, so
 * when it exists it is definitive. But it is only written when someone switches
 * workspace: an account with a single workspace never has it, which is the
 * common case and was enough to make reset's first guard unsatisfiable. It
 * aborted with "could not read the active workspace cookie" on exactly the
 * accounts it was written for.
 *
 * The fallback reads the id out of the server-rendered payload on the page,
 * which is the server's own statement of which workspace it just rendered for
 * this session. That is authoritative enough to gate a destructive action on,
 * and it is the same value the cookie would carry.
 *
 * Returns { id, source }, or { id: null } when neither is available, which must
 * stay a refusal.
 */
export async function readActiveWorkspace(page, context) {
  const cookies = await context.cookies();
  const fromCookie = cookies.find((c) => c.name === 'mcpe_active_ws')?.value;
  if (fromCookie) return { id: fromCookie, source: 'cookie' };

  const html = await page.content();
  // The payload is embedded inside a JS string, so its quotes are escaped.
  // Match both forms rather than assuming one.
  const m = html.match(
    /\\?"workspace\\?"\s*:\s*\{\\?"id\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (m) return { id: m[1], source: 'page payload' };

  return { id: null, source: null };
}
