import type { FolderRole } from "../../api/types";

/* Swipe-action maths for phone rows. Pure: the gesture handler feeds it
 * numbers and applies the answers.
 *
 *   swipe right = archive, swipe left = trash
 *   commit at 38% of the row width, or on a fast flick
 *   vertical scrolling always wins a diagonal */

export type SwipeAction = "archive" | "trash";
export type SwipeIntent = "horizontal" | "vertical" | null;
export interface SwipeAllowed {
  archive: boolean;
  trash: boolean;
}

/** Movement (px) before the gesture is classified. */
export const SWIPE_SLOP = 10;
/** Horizontal must beat vertical by this factor to count as a swipe. */
export const SWIPE_DOMINANCE = 1.5;
export const SWIPE_COMMIT_FRACTION = 0.38;
/** px per ms. A flick commits below the distance threshold. */
export const SWIPE_FLICK_VELOCITY = 0.5;
export const SWIPE_FLICK_MIN_DISTANCE = 28;
/** How far a row follows the finger in a direction that does nothing. */
const RESIST = 0.2;
const RESIST_MAX = 28;

/** Classifies a touch from its total movement. null = too early to say. */
export function swipeIntent(dx: number, dy: number): SwipeIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE_SLOP && ay < SWIPE_SLOP) return null;
  return ax > ay * SWIPE_DOMINANCE ? "horizontal" : "vertical";
}

export function swipeDirection(dx: number): SwipeAction | null {
  return dx > 0 ? "archive" : dx < 0 ? "trash" : null;
}

/** What each direction may do for a row in `role`. Drafts and scheduled sends
 *  are not mail to file; archiving the archive or trashing the trash is a no-op. */
export function swipeAllowed(role: FolderRole | null, locked = false): SwipeAllowed {
  if (locked || role === "drafts" || role === "scheduled") return { archive: false, trash: false };
  return { archive: role !== "archive", trash: role !== "trash" };
}

/** Where the row sits for a finger offset: 1:1 in an allowed direction (never
 *  past the row's own width), a short resisted pull otherwise. */
export function swipeOffset(dx: number, width: number, allowed: SwipeAllowed): number {
  const action = swipeDirection(dx);
  if (!action) return 0;
  if (!allowed[action]) return Math.sign(dx) * Math.min(RESIST_MAX, Math.abs(dx) * RESIST);
  return Math.max(-width, Math.min(width, dx));
}

/** The row has been dragged past the commit point. */
export function swipeArmed(dx: number, width: number, allowed: SwipeAllowed): boolean {
  const action = swipeDirection(dx);
  return !!action && allowed[action] && width > 0 && Math.abs(dx) >= width * SWIPE_COMMIT_FRACTION;
}

/** The action to run when the finger lifts, or null to spring back.
 *  `velocity` is px/ms, signed like `dx`. */
export function swipeOutcome(dx: number, width: number, velocity: number, allowed: SwipeAllowed): SwipeAction | null {
  const action = swipeDirection(dx);
  if (!action || !allowed[action] || width <= 0) return null;
  if (Math.abs(dx) >= width * SWIPE_COMMIT_FRACTION) return action;
  const sameWay = Math.sign(velocity) === Math.sign(dx);
  if (sameWay && Math.abs(velocity) >= SWIPE_FLICK_VELOCITY && Math.abs(dx) >= SWIPE_FLICK_MIN_DISTANCE) return action;
  return null;
}

/** Velocity (px/ms) from the last two samples; 0 when they are too far apart
 *  in time to mean anything (the finger rested before lifting). */
export function swipeVelocity(x0: number, t0: number, x1: number, t1: number): number {
  const dt = t1 - t0;
  if (dt <= 0 || dt > 120) return 0;
  return (x1 - x0) / dt;
}
