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
 * Source: registry/snap-cn-ui/core/motion.ts
 */

export const easings = {
  linear: (t: number): number => t,
  out: (t: number): number => 1 - (1 - t) ** 3,
  in: (t: number): number => t * t * t,
  inOut: (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2,
} as const;

export type EasingName = keyof typeof easings;

export const springs = {
  snappy: { damping: 18, stiffness: 220, mass: 0.7 },
  soft: { damping: 14, stiffness: 120, mass: 0.9 },
  bouncy: { damping: 10, stiffness: 180, mass: 0.8 },
} as const;

export type SpringName = keyof typeof springs;
