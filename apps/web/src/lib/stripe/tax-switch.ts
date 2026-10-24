/**
 * The checkout switches for the EUR launch (planned for 2026-12-07): Stripe Tax,
 * and the payment method configuration Checkout offers.
 *
 * WHY THESE DEFAULT OFF, when STRIPE_ADAPTIVE_PRICING defaults on. Adaptive
 * Pricing was already live when its switch was written, so its switch is a kill
 * switch: unset must keep what customers already had. These two are the
 * opposite case. Nothing here is live yet, and turning Stripe Tax on before the
 * EUR currency options exist on the prices would add VAT on top of the USD
 * amounts for every EU buyer. So unset, empty, a typo or anything unexpected
 * means OFF, and only an explicit 'true' / 'on' / '1' / 'yes' turns a switch on.
 *
 * READ AT CALL TIME, never captured at module scope: a warm lambda keeps
 * whatever it booted with, so a module-scope const would make flipping the
 * variable in Vercel appear to work and change nothing until the next deploy
 * (same WHY as src/lib/billing/lifecycle-mode.ts).
 */

type Env = Record<string, string | undefined>;

const ON_VALUES = new Set(['true', 'on', '1', 'yes']);

/** A default-off switch: true only for an explicit on-value. */
export function switchOn(raw: string | undefined): boolean {
  if (raw == null) return false;
  return ON_VALUES.has(raw.trim().toLowerCase());
}

/**
 * STRIPE_AUTOMATIC_TAX: Stripe Tax on Checkout.
 *
 * Turn it on only together with the EUR currency options (or after them), and
 * only once the registrations are in place in the Stripe dashboard: EU
 * non-Union OSS and Norway MVA. Stripe calculates tax only where the account is
 * registered, so a buyer in a country with no registration sees no tax line.
 */
export function automaticTaxEnabled(env: Env = process.env): boolean {
  return switchOn(env.STRIPE_AUTOMATIC_TAX);
}

/**
 * The extra `stripe.checkout.sessions.create` parameters Stripe Tax needs, or an
 * empty object when the switch is off, so a session created with the switch off
 * carries exactly the keys it carried before this file existed.
 *
 *   automatic_tax       Stripe works out the tax from the buyer's location and
 *                       the price's tax_behavior. EUR amounts come from
 *                       currency_options with tax_behavior=inclusive, so a
 *                       German buyer pays the 9 EUR they were shown and Stripe
 *                       extracts the VAT from it. The USD prices stay
 *                       exclusive: a buyer charged in USD sees tax added on top
 *                       where we are registered.
 *   tax_id_collection   Lets a business enter its VAT ID, which turns the sale
 *                       into a reverse-charge B2B sale with no VAT charged.
 *   customer_update     REQUIRED, not cosmetic. Every session we create passes
 *                       an existing `customer` (getOrCreateStripeCustomer), and
 *                       Stripe refuses automatic_tax and tax_id_collection on
 *                       an existing customer unless Checkout may write the
 *                       address and name it collects back onto that customer.
 */
export function checkoutTaxParams(env: Env = process.env):
  | {
    automatic_tax: { enabled: true };
    tax_id_collection: { enabled: true };
    customer_update: { name: 'auto'; address: 'auto' };
  }
  | Record<string, never> {
  if (!automaticTaxEnabled(env)) return {};
  return {
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    customer_update: { name: 'auto', address: 'auto' },
  };
}

const PMC_ID = /^pmc_[A-Za-z0-9]+$/;

/**
 * STRIPE_PMC_ID: the payment method configuration Checkout should offer (card,
 * Link, SEPA Direct Debit, iDEAL, Bancontact, PayPal and so on, as set up in the
 * Stripe dashboard).
 *
 * Unset means today's behaviour: Stripe picks the account's default
 * configuration, which this repo cannot see or review. Setting it pins the
 * configuration in code, so the payment methods a buyer is offered stop
 * depending on which configuration happens to be marked default in the
 * dashboard. A value that is not shaped like a configuration id is ignored with
 * a log line rather than sent, because Stripe would refuse the whole session
 * over it and nobody could buy anything.
 */
export function paymentMethodConfigurationId(env: Env = process.env): string | undefined {
  const raw = env.STRIPE_PMC_ID?.trim();
  if (!raw) return undefined;
  if (!PMC_ID.test(raw)) {
    console.error('[checkout] STRIPE_PMC_ID is not a payment method configuration id; ignored.');
    return undefined;
  }
  return raw;
}
