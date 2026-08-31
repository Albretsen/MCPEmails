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
 * Source: registry/snap-cn-ui/core/types.ts
 */

export interface Step<S extends string = string> {
  at: number;
  state: S;
  duration?: number;
}
