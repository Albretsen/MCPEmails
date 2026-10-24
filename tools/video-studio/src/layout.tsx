/**
 * Where a scene may put things, per format.
 *
 * The landscape cut was designed at 1920x1080 and every scene carries its own
 * padding for it, so for landscape this returns zero insets and the scenes
 * behave exactly as before.
 *
 * The vertical cut (1080x1920) is watched inside an app that draws over the
 * video: the caption, username and music strip across the bottom, the like,
 * comment and share rail down the right, and the tab bar across the top. Text
 * under any of those is unreadable. So `safe` is the rectangle no app covers,
 * and every scene lays its text out inside `content`, which is `safe` minus
 * the bands this storyboard's own overlays (captions, timer) need.
 *
 * The numbers are the union of TikTok's, Reels' and Shorts' published safe
 * zones, rounded outwards:
 *   bottom 20% (384px): caption, handle, sound, and on Shorts the subscribe row
 *   right 15% (162px):  the button rail
 *   top 7% (134px):     tab bar and search
 *   left 6% (64px):     breathing room, nothing draws there
 * verify draws these on the contact sheet so a reader can check a frame.
 */

import React from 'react';
import type { Format } from './storyboard-types';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Layout {
  format: Format;
  vertical: boolean;
  width: number;
  height: number;
  /** The rectangle no platform UI covers. Zero insets for landscape. */
  safe: Insets;
  /** Where scene content goes: `safe` minus the caption and timer bands. */
  content: Insets;
  /** Burned-in captions sit in this band, just above the bottom safe edge. */
  captionBand: { bottom: number; height: number };
  /** The stopwatch sits in this band, just below the top safe edge. */
  timerBand: { top: number; height: number };
  /** Type sizes. Vertical is read on a phone held at arm's length, so text is
   *  larger relative to the canvas than in the landscape cut. */
  type: {
    headline: number;
    sub: number;
    body: number;
    mono: number;
    caption: number;
    cta: number;
  };
}

/** Exported for verify, which draws the same rectangle on the contact sheet. */
export const VERTICAL_SAFE: Insets = { top: 134, right: 162, bottom: 384, left: 64 };

const CAPTION_BAND = 190;
const TIMER_BAND = 110;

export function computeLayout(opts: {
  format: Format;
  width: number;
  height: number;
  captions: boolean;
  timer: boolean;
}): Layout {
  const { format, width, height, captions, timer } = opts;

  if (format !== 'vertical') {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };
    return {
      format,
      vertical: false,
      width,
      height,
      safe: zero,
      content: zero,
      captionBand: { bottom: 76, height: 0 },
      timerBand: { top: 14, height: 0 },
      type: { headline: 96, sub: 34, body: 30, mono: 22, caption: 38, cta: 76 },
    };
  }

  const safe = VERTICAL_SAFE;
  return {
    format,
    vertical: true,
    width,
    height,
    safe,
    content: {
      top: safe.top + (timer ? TIMER_BAND : 0),
      right: safe.right,
      bottom: safe.bottom + (captions ? CAPTION_BAND : 0),
      left: safe.left,
    },
    captionBand: { bottom: safe.bottom + 20, height: CAPTION_BAND - 20 },
    timerBand: { top: safe.top, height: TIMER_BAND },
    type: { headline: 104, sub: 44, body: 40, mono: 30, caption: 52, cta: 84 },
  };
}

const LayoutContext = React.createContext<Layout>(
  computeLayout({ format: 'landscape', width: 1920, height: 1080, captions: false, timer: false }),
);

export const LayoutProvider = LayoutContext.Provider;

export const useLayout = (): Layout => React.useContext(LayoutContext);
