/**
 * Which Stripe Billing Portal configuration a customer gets.
 *
 * WHY TWO. Stripe's "Collect a cancellation reason" puts an optional question
 * between the Cancel button and the final confirmation (tested in the sandbox
 * on 2026-11-05: the subscription is untouched until the second click, and the
 * question can be skipped). German law (BGB 312k, BGH I ZR 200/25) is strict
 * about anything standing between a customer and the cancel, so customers in
 * Europe keep the configuration without the question. Everyone else gets the
 * reason, which is far more likely to be answered there than in the email we
 * send after the cancellation (1 answer from about 10 sent by 2026-11-05).
 *
 * THE RULE. The reason configuration is used only when we positively know the
 * customer is outside Europe: the request's country is known and not
 * European, and the country recorded at signup, when there is one, is not
 * European either. Anything unknown falls back to the base configuration, so a
 * mistake can only ever leave the question out, never put it in front of a
 * European customer.
 *
 * "Europe" here is the EU plus the rest of the EEA (Iceland, Liechtenstein,
 * Norway), Switzerland and the United Kingdom.
 */
import { EU_COUNTRIES } from '@/lib/stripe/currency';
import { sanitizedCountry } from '@/lib/acquisition-country.mjs';

type Env = Record<string, string | undefined>;

export const EUROPEAN_COUNTRIES: ReadonlySet<string> = new Set([
  ...EU_COUNTRIES,
  'IS', 'LI', 'NO', 'CH', 'GB',
]);

export function isEuropeanCountry(country: string | null | undefined): boolean {
  const code = sanitizedCountry(country);
  return code !== null && EUROPEAN_COUNTRIES.has(code);
}

/**
 * The portal configuration id to pin, or undefined for the account default.
 *
 * `requestCountry` is Vercel's `x-vercel-ip-country` for this request,
 * `signupCountry` the workspace's `acquisition_country`. Both may be null.
 */
export function portalConfigurationFor(
  input: { requestCountry: string | null | undefined; signupCountry: string | null | undefined },
  env: Env = process.env,
): string | undefined {
  const base = env.STRIPE_PORTAL_CONFIGURATION_ID || undefined;
  const withReason = env.STRIPE_PORTAL_CONFIGURATION_ID_CANCEL_REASON || undefined;
  if (!withReason) return base;

  const requestCountry = sanitizedCountry(input.requestCountry);
  if (!requestCountry || EUROPEAN_COUNTRIES.has(requestCountry)) return base;
  if (isEuropeanCountry(input.signupCountry)) return base;
  return withReason;
}
