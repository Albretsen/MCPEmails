import { preload } from 'react-dom';
import '../fonts/fonts.css';

/**
 * The site's three webfonts, self-hosted from files committed in apps/web/fonts.
 *
 * HISTORY. Until 2026-10-03 these came from a CSS `@import` of
 * fonts.googleapis.com at the top of styles/colors_and_type.css: a
 * render-blocking chain on every page (HTML -> our CSS -> Google's CSS ->
 * fonts.gstatic.com), measured at 700 to 1,180 ms on mobile. They were then
 * briefly loaded through next/font/google, which removed the chain but made
 * `next build` fetch from Google, so a build could fail on a network it did
 * not need before. Now nothing talks to Google at build time or at run time.
 *
 * HOW. fonts/fonts.css holds the 47 @font-face rules Google served, verbatim,
 * with each `src` pointing at the local copy of the same file. The bundler
 * copies the files to /_next/static/media under content-hashed names, which
 * Next serves with a one-year immutable cache.
 *
 * WHY NOT next/font/local. It names the family after the JavaScript variable
 * the call is assigned to (`const geistLatin = localFont(...)` produces
 * `font-family: geistLatin`), rejects a `font-family` declaration, and takes
 * one unicode-range per call. Our families need a space in the name ("Geist
 * Mono", "Instrument Serif") and five or six unicode-range subsets each under
 * ONE family name, so it cannot express them; getting close would mean eleven
 * differently named families and rewriting the --font-* tokens. Plain
 * @font-face rules keep the real family names, so the tokens in
 * colors_and_type.css and every font-family declaration are untouched, and
 * there is no generated "Fallback" face at all: the fallback stacks are
 * exactly what the tokens say.
 *
 * WHAT MUST NOT CHANGE in fonts/fonts.css (scripts/fonts and
 * scripts/built-output pin all of it):
 *  - one rule per WEIGHT, not a `100 900` range. Geist is a variable font, but
 *    our CSS uses in-between weights (550, 620, 650, 680, 750) that snap to
 *    the nearest declared weight today; a range would render them literally.
 *  - every subset (latin, latin-ext, cyrillic, cyrillic-ext, vietnamese, and
 *    symbols2 for the mono). A subset file is only downloaded when a page uses
 *    a character from its unicode-range. None of the families has CJK glyphs;
 *    Chinese renders in a system font, as it always has.
 *  - font-display: swap.
 *
 * PRELOAD. Exactly one file: Geist latin, the face every page paints its first
 * text in. Geist Mono and Instrument Serif are used on some pages and not on
 * others (the auth screens use neither), and a preload on a page that never
 * uses the font is a download that did not happen before.
 */

// Resolved by the bundler to the same hashed /_next/static/media URL that the
// `src` in fonts.css compiles to, so the preload and the @font-face rule name
// one resource and the file is fetched once.
const GEIST_LATIN = new URL('../fonts/geist-latin.woff2', import.meta.url).pathname;

/**
 * Call during render of the root layout. Next sends it as a `Link: rel=preload`
 * response header, ahead of the HTML. `crossOrigin` is required even for a
 * same-origin font: fonts are always fetched in CORS mode, and a preload
 * without it is fetched a second time.
 */
export function preloadFonts() {
  preload(GEIST_LATIN, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
}
