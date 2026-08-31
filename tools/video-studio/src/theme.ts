/**
 * Brand tokens, COPIED as literal strings from apps/web/styles/colors_and_type.css
 * and apps/web/styles/theme.css. Deliberately not imported.
 *
 * Two reasons, and the second is the binding one:
 *
 * 1. tools/video-studio is outside the root workspace glob and must never
 *    depend on apps/web. Importing across that line would couple a marketing
 *    tool to the shipping product's build.
 *
 * 2. It would not work anyway. Remotion renders each frame in a headless
 *    browser and serialises styles; CSS custom properties declared in an app
 *    stylesheet are not present in that document. Every value here is therefore
 *    already RESOLVED: `--brand` in the app is `var(--cobalt-500)`, which is
 *    #2547E5, so that is what is written below.
 *
 * If the app's palette changes, this file is updated by hand. That is the
 * intended cost of the isolation.
 */

export type ThemeName = 'dark' | 'light';

export interface Theme {
  name: ThemeName;
  bgPage: string;
  bgSurface: string;
  bgSunken: string;
  fg1: string;
  fg2: string;
  fg3: string;
  fg4: string;
  fgOnBrand: string;
  border1: string;
  border2: string;
  brand: string;
  brandHover: string;
  brandSoft: string;
  live: string;
  liveSoft: string;
  amber: string;
  red: string;
  /** Callout bubbles and caption plates sit on top of video, so they need
   *  their own opaque-ish ground rather than a surface token. */
  overlay: string;
  overlayFg: string;
  shadow3: string;
  shadow4: string;
  fontSans: string;
  fontMono: string;
  fontDisplay: string;
}

const FONT_SANS =
  '"Geist", ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
const FONT_MONO =
  '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';
const FONT_DISPLAY =
  '"Instrument Serif", "Iowan Old Style", Georgia, serif';

export const DARK: Theme = {
  name: 'dark',
  bgPage: '#0B1020',
  bgSurface: '#131932',
  bgSunken: '#1B2244',
  fg1: '#EAECF5',
  fg2: '#BFC4D9',
  fg3: '#8389A6',
  fg4: '#5A6080',
  fgOnBrand: '#FFFFFF',
  border1: '#232A4D',
  border2: '#2E3660',
  brand: '#5973F5', // cobalt-400: the dark theme lifts the brand for contrast
  brandHover: '#889EFF',
  brandSoft: 'rgba(89,115,245,0.12)',
  live: '#1FCB8B',
  liveSoft: 'rgba(31,203,139,0.12)',
  amber: '#F0A53E',
  red: '#E5484D',
  overlay: 'rgba(11,16,32,0.92)',
  overlayFg: '#EAECF5',
  shadow3: '0 2px 4px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.5)',
  shadow4: '0 8px 24px rgba(0,0,0,0.5), 0 24px 56px rgba(0,0,0,0.6)',
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  fontDisplay: FONT_DISPLAY,
};

export const LIGHT: Theme = {
  name: 'light',
  bgPage: '#F5F6FA',
  bgSurface: '#FFFFFF',
  bgSunken: '#ECEEF4',
  fg1: '#0B1020',
  fg2: '#2F3447',
  fg3: '#626A7D',
  fg4: '#9AA1B6',
  fgOnBrand: '#FFFFFF',
  border1: '#DEE1EB',
  border2: '#C6CBDA',
  brand: '#2547E5', // cobalt-500
  brandHover: '#1B36C2',
  brandSoft: '#EEF2FF',
  live: '#1FCB8B',
  liveSoft: '#E4FBF1',
  amber: '#F0A53E',
  red: '#E5484D',
  overlay: 'rgba(255,255,255,0.94)',
  overlayFg: '#0B1020',
  shadow3: '0 2px 4px rgba(11,16,32,0.08), 0 8px 24px rgba(11,16,32,0.10)',
  shadow4: '0 8px 24px rgba(11,16,32,0.10), 0 24px 56px rgba(11,16,32,0.12)',
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  fontDisplay: FONT_DISPLAY,
};

export const getTheme = (name: ThemeName): Theme =>
  name === 'light' ? LIGHT : DARK;

/**
 * Remotion's headless Chrome has no network access to Google Fonts during a
 * render, and a missing webfont silently reflows every text scene. The stacks
 * above all end in a system font that exists on macOS and on Linux CI, so a
 * render never falls back to Times. If a cut must ship in Geist exactly,
 * install the family locally and load it with @remotion/google-fonts.
 */
export const FALLBACK_NOTE =
  'Fonts resolve through the system stack unless @remotion/google-fonts is wired up.';
