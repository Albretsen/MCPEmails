/**
 * Request-scoped wrappers. Server only: these read next/headers, which opts
 * the calling route into dynamic rendering. Nothing a unit test loads may
 * import this file.
 */
import { cookies, headers } from 'next/headers';
import { isValidSubjectId } from './bucketing.ts';
import { parseOverrideCookie } from './cookies.ts';
import { OVERRIDE_COOKIE, SUBJECT_COOKIE, SUBJECT_HEADER, type VariantDecision } from './constants.ts';
import { getExperimentDecision, type ExperimentLookupOptions } from './index.ts';

/**
 * The visitor's anonymous id for this request.
 *
 * The header comes first and the cookie second, and the order matters on
 * exactly one request per visitor: the first one. The proxy mints the id and
 * sets it on the request headers before the render, then attaches the cookie
 * to the response. Reading the cookie alone would mean the very first page
 * view, the one where a new visitor arrives on the homepage, has no subject
 * and is never bucketed.
 */
export async function getExperimentSubjectId(): Promise<string | null> {
  const fromHeader = (await headers()).get(SUBJECT_HEADER);
  if (isValidSubjectId(fromHeader)) return fromHeader;

  const fromCookie = (await cookies()).get(SUBJECT_COOKIE)?.value;
  if (isValidSubjectId(fromCookie)) return fromCookie;

  return null;
}

/** Variants the admin has pinned for themselves, from the override cookie. */
export async function getOwnerOverrides(): Promise<Record<string, string>> {
  return parseOverrideCookie((await cookies()).get(OVERRIDE_COOKIE)?.value);
}

/** getExperimentDecision with the subject and overrides read off the request. */
export async function getExperimentDecisionForRequest(
  key: string,
  options: Omit<ExperimentLookupOptions, 'overrides'> & { overrides?: Record<string, string> } = {},
): Promise<VariantDecision> {
  const [subjectId, overrides] = await Promise.all([getExperimentSubjectId(), getOwnerOverrides()]);
  return getExperimentDecision(key, subjectId, {
    ...options,
    overrides: options.overrides ?? overrides,
  });
}

/** The same, when the caller only needs the variant id. */
export async function getExperimentVariantForRequest(
  key: string,
  options: ExperimentLookupOptions = {},
): Promise<string> {
  const decision = await getExperimentDecisionForRequest(key, options);
  return decision.variantId;
}
