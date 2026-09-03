/**
 * The public API. Two functions, and everything a caller needs to name a
 * variant. Anything that wants to know which variant to render calls
 * getExperimentVariant (or getExperimentDecision, when it also wants to
 * explain itself, as the admin panel does).
 *
 * Callers that live inside a request and want the subject id read for them
 * should use request.ts instead; this module takes the subject as an argument
 * so it stays testable and usable from a background job.
 */
import { createExperimentStore } from './store.ts';
import { resolveVariant, warnUnknownExperiment, type ExperimentStore } from './resolve.ts';
import type { VariantDecision } from './constants.ts';

export interface ExperimentLookupOptions {
  overrides?: Record<string, string>;
  fallback?: string;
  store?: ExperimentStore;
}

/** Which variant this subject gets, and why. Never throws. */
export async function getExperimentDecision(
  key: string,
  subjectId: string | null,
  options: ExperimentLookupOptions = {},
): Promise<VariantDecision> {
  const store = options.store ?? createExperimentStore();
  let experiment = null;
  try {
    experiment = await store.getExperiment(key);
  } catch (error) {
    console.error('[experiments] experiment lookup failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!experiment) warnUnknownExperiment(key);

  return resolveVariant({
    experiment,
    subjectId,
    overrides: options.overrides,
    fallback: options.fallback,
    assign: store.assign.bind(store),
  });
}

/** The same lookup, when the caller only needs the variant id. */
export async function getExperimentVariant(
  key: string,
  subjectId: string | null,
  options: ExperimentLookupOptions = {},
): Promise<string> {
  const decision = await getExperimentDecision(key, subjectId, options);
  return decision.variantId;
}

export {
  HOMEPAGE_DEMO_VIDEO,
  OVERRIDE_COOKIE,
  SUBJECT_COOKIE,
  SUBJECT_COOKIE_MAX_AGE_SECONDS,
  SUBJECT_HEADER,
  SUBJECT_ID_PATTERN,
  VARIANT_ID_PATTERN,
} from './constants.ts';
export type {
  ExperimentRecord,
  ExperimentStatus,
  ExperimentVariant,
  ExperimentVariantStats,
  RetentionGoal,
  VariantDecision,
} from './constants.ts';
export type { ExperimentStore } from './resolve.ts';
export { clearExperimentCache } from './store.ts';
