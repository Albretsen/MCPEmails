import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';

/**
 * The site's three webfonts, self-hosted.
 *
 * Until 2026-10-03 these came from a CSS `@import` of fonts.googleapis.com at
 * the top of styles/colors_and_type.css. That is a render-blocking chain on
 * every page (HTML -> our CSS -> Google's CSS -> fonts.gstatic.com), measured
 * at 700 to 1,180 ms on mobile. next/font/google fetches the same Google CSS
 * ONCE, AT BUILD TIME, copies the font files into /_next/static/media (same
 * origin, content-hashed, cached immutably) and inlines the @font-face rules
 * into our own stylesheet. The browser never talks to Google.
 *
 * THIS FILE IS IMPORTED FOR ITS SIDE EFFECT ONLY (app/layout.js and
 * app/global-error.js). Nothing uses the returned `className` / `variable`,
 * and that is deliberate:
 *
 *  - The bundler emits the @font-face rules under the fonts' real family
 *    names ("Geist", "Geist Mono", "Instrument Serif"), which are exactly the
 *    names the --font-sans / --font-mono / --font-display tokens in
 *    colors_and_type.css already start with. So every existing font-family
 *    declaration resolves as it always did, with no token changed.
 *    scripts/built-output/fonts.test.mjs fails if a bundler ever hashes those
 *    names, because the tokens would then silently fall through to system
 *    fonts.
 *
 *  - next/font also generates a metric-adjusted fallback face per family
 *    ("Geist Fallback": local Arial with size-adjust and ascent overrides) and
 *    puts it in the generated `className`. Using that class would insert the
 *    adjusted Arial into the stack AHEAD of ui-sans-serif: a different font
 *    while the webfont loads, and a different font for every glyph Geist does
 *    not have (Chinese falls through either way, but Greek, arrows and other
 *    symbols would start rendering in Arial). `adjustFontFallback: false` asks
 *    for no such face; Turbopack in Next 16.3 emits it regardless, so the real
 *    guarantee is that nothing references it, which the same test pins.
 *
 * WEIGHTS ARE LISTED, NOT `variable`. Geist is a variable font, and the files
 * served are the variable files either way. Listing the weights produces one
 * @font-face per weight, as the Google import did, so an in-between weight in
 * our CSS (550, 620, 650, 680 and 750 are all in use) keeps snapping to the
 * nearest declared weight. A `100 900` range would render them literally and
 * visibly change the weight of that text.
 *
 * SUBSETS. Every subset Google serves (latin, latin-ext, cyrillic,
 * cyrillic-ext, vietnamese, and symbols2 for the mono) is kept as its own
 * unicode-range face and downloaded only when a page uses a character from it,
 * as before. `subsets` only chooses which file is PRELOADED. None of the three
 * families contains CJK glyphs; Chinese text renders in a system font, as
 * before.
 *
 * PRELOAD. Only Geist's latin file, the one face every page renders its first
 * paint in. Geist Mono and Instrument Serif are used on some pages and not
 * others (the auth screens use neither), and a preload on a page that never
 * uses the font is a download that did not happen before.
 *
 * Build-time note: `next build` now needs to reach fonts.googleapis.com.
 */
export const geist = Geist({
  weight: ['300', '400', '500', '600', '700'],
  subsets: ['latin'],
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
});

export const geistMono = Geist_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
});

export const instrumentSerif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
});
