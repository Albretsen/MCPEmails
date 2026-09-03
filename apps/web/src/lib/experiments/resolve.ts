/**
 * The decision function. Every caller, homepage or admin preview or API route,
 * ends up here, so the precedence rules live in exactly one place.
 *
 * No next imports, no database import: the store is injected, which is what
 * lets the tests drive every branch with a fake.
 */
import { hashUnit, isValidSubjectId, pickVariant } from './bucketing.ts';
import type { ExperimentRecord, VariantDecision } from './constants.ts';

export interface ExperimentStore {
  getExperiment(key: string): Promise<ExperimentRecord | null>;
  assign(key: string, subjectId: string, variantId: string): Promise<string>;
}

/** Keys already warned about, so an unknown experiment logs once, not per request. */
const warnedUnknown = new Set<string>();

export interface ResolveVariantArgs {
  experiment: ExperimentRecord | null;
  subjectId: string | null;
  overrides?: Record<string, string>;
  fallback?: string;
  assign: ExperimentStore['assign'];
}

/**
 * Precedence, highest first:
 *
 *  1. No such experiment. Return the fallback. A missing row is a
 *     configuration mistake, not a reason to break a page.
 *  2. Concluded with a winner. Everyone sees the winner, including people who
 *     hold an assignment to the losing arm. Concluding is how you ship.
 *  3. An owner override for this key. Not recorded as an assignment, so
 *     previewing a variant never pollutes the results.
 *  4. Draft. Everyone sees variants[0], the control. A draft is an experiment
 *     that is not running yet, so nobody is exposed and nothing is recorded.
 *  5. Running. Bucket by hash, then write the assignment down and return what
 *     the database says is stored. That stored value is the answer forever
 *     after, which is why changing weights mid-flight moves only new subjects.
 */
export async function resolveVariant(args: ResolveVariantArgs): Promise<VariantDecision> {
  const { experiment, subjectId, overrides, fallback } = args;

  if (!experiment) return { variantId: fallback ?? 'control', reason: 'unknown' };

  const key = experiment.key;
  const variants = experiment.variants ?? [];
  const control = variants[0]?.id ?? fallback ?? 'control';

  if (experiment.status === 'concluded' && experiment.winner_variant_id) {
    return { variantId: experiment.winner_variant_id, reason: 'winner' };
  }

  const override = overrides?.[key];
  if (override && variants.some((variant) => variant.id === override)) {
    return { variantId: override, reason: 'override' };
  }

  if (experiment.status !== 'running') return { variantId: control, reason: 'draft' };

  // Running, but this request has no usable subject id (a bot with no cookies,
  // or a route the proxy does not run on). Show the control and record
  // nothing: an exposure we cannot follow to an outcome is only noise.
  if (!isValidSubjectId(subjectId)) return { variantId: control, reason: 'draft' };

  const picked = pickVariant(variants, hashUnit(subjectId, key));
  try {
    const stored = await args.assign(key, subjectId, picked);
    return { variantId: stored || picked, reason: 'assigned' };
  } catch (error) {
    console.error('[experiments] assign failed, serving the hashed variant', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { variantId: picked, reason: 'assigned' };
  }
}

/** Warn once per unknown experiment key. Called by the public API. */
export function warnUnknownExperiment(key: string): void {
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  console.warn(`[experiments] no experiment named "${key}"; serving the fallback variant`);
}
