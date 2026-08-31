/**
 * Vendored from snapcn (https://snapcn.dev), MIT. Copied, not depended on, per
 * the shadcn model: this is now our source and we may edit it.
 *
 * Only the motion/timeline core is taken. snapcn's theme.ts and color.ts are
 * deliberately left behind: they model colour in oklch through `culori`, and
 * this project already has a resolved literal palette in src/theme.ts that
 * matches the shipping product. Its input/answer-stream components are left
 * behind too, because they reach shadcn/ui's Tailwind-based `input` and this
 * project must not take a Tailwind dependency.
 *
 * Source: registry/snap-cn-ui/core/timeline.ts
 */

import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Step } from "./types";

export function framesFor(
  d: number | { seconds: number },
  fps: number,
): number {
  return typeof d === "number" ? d : Math.round(d.seconds * fps);
}

export function revealCount(
  localFrame: number,
  fps: number,
  len: number,
  cps: number,
): number {
  const over = (len / cps) * fps;
  if (over <= 0) return len;
  return Math.max(0, Math.min(len, Math.floor((localFrame / over) * len)));
}

export function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

export function revealedText(full: string, count: number): string {
  const c = Math.max(0, Math.min(full.length, Math.floor(count)));
  return full.slice(0, c);
}

export interface TypewriterOptions {
  cps?: number;
  speed?: number;
  startFrame?: number;
}

export interface TypewriterState {
  text: string;
  count: number;
  done: boolean;
  typing: boolean;
}

export function useTypewriter(
  full: string,
  options: TypewriterOptions = {},
): TypewriterState {
  const { cps = 20, speed = 1, startFrame = 0 } = options;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame * speed - startFrame;
  const count = local <= 0 ? 0 : revealCount(local, fps, full.length, cps);
  return {
    text: revealedText(full, count),
    count,
    done: count >= full.length,
    typing: count > 0 && count < full.length,
  };
}

export function useCurrentState<S extends string>(
  steps: Step<S>[],
  defaultState: S,
  speed = 1,
): S {
  const effectiveFrame = useCurrentFrame() * speed;
  let current = defaultState;
  let bestAt = -Infinity;
  steps.forEach((step) => {
    if (step.at <= effectiveFrame && step.at >= bestAt) {
      bestAt = step.at;
      current = step.state;
    }
  });
  return current;
}

export function useStateTransition<S extends string>(
  steps: Step<S>[],
  defaultState: S,
  speed = 1,
  defaultDuration = 8,
): { from: S; to: S; progress: number } {
  const effectiveFrame = useCurrentFrame() * speed;
  const started = steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.at - b.step.at || a.index - b.index)
    .filter((e) => e.step.at <= effectiveFrame)
    // Same-`at` ties: the later array entry wins and the earlier tied
    // entries never display, so they can never act as a `from` state.
    .filter(
      (e, i, arr) => i === arr.length - 1 || arr[i + 1].step.at !== e.step.at,
    );
  if (started.length === 0)
    return { from: defaultState, to: defaultState, progress: 1 };
  const to = started[started.length - 1].step;
  const from = started.length >= 2 ? started[started.length - 2].step : null;
  const dur = to.duration ?? defaultDuration;
  const progress = dur > 0 ? clamp01((effectiveFrame - to.at) / dur) : 1;
  return { from: from ? from.state : defaultState, to: to.state, progress };
}
