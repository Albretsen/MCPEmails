/**
 * The "never paid" rule for delayed SEPA Direct Debit subscriptions.
 *
 * WHY THIS EXISTS. A SEPA debit takes up to six business days to confirm, and
 * Stripe makes the subscription `active` while that first debit is still
 * processing. The webhook grants the plan on `active`, so a SEPA buyer gets the
 * product at once: provisional access, decided 2026-10-24 because making a
 * buyer wait a week costs more conversions than the occasional failed debit.
 *
 * THE HOLE IT WOULD LEAVE. `past_due` and `unpaid` stay entitled for everyone
 * (ENTITLED_STATUSES in app/api/stripe/webhook/route.ts): that is the dunning
 * grace that keeps a paying customer whose card was declined on renewal. For a
 * card buyer those statuses can only come after a payment that worked, because
 * a card declined at checkout leaves the subscription `incomplete`. A SEPA
 * buyer whose FIRST debit bounces goes straight from `active` to `past_due`, so
 * the same grace would hand a month of the product to someone who never paid
 * anything, and keep handing it over through every retry.
 *
 * THE RULE. A `past_due` or `unpaid` subscription is NOT entitled when its
 * payment method is `sepa_debit` AND it has never had a paid invoice. Every
 * other subscription keeps exactly today's behaviour. iDEAL and Bancontact
 * renew as SEPA debits but their first payment is instant, so their buyers
 * always have a paid invoice and the rule never reaches them.
 *
 * FAIL OPEN. The answer needs Stripe calls (the payment method and the invoice
 * list are not on the event). Any error, or any missing piece of evidence,
 * keeps today's behaviour: entitled. Wrongly cutting off a paying customer is
 * the worse mistake, and the next subscription event asks again.
 */
import type Stripe from 'stripe';

/** The dunning statuses that keep a subscription entitled today. */
const GRACE_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid']);

/**
 * The pure rule. `hasPaidInvoice` is null when it could not be determined,
 * which counts as "may have paid" (fail open).
 */
export function isNeverPaidSepa(input: {
  status: string;
  paymentMethodType: string | null;
  hasPaidInvoice: boolean | null;
}): boolean {
  return (
    GRACE_STATUSES.has(input.status) &&
    input.paymentMethodType === 'sepa_debit' &&
    input.hasPaidInvoice === false
  );
}

/** The slice of the Stripe client these lookups use, so a test can stub it. */
export interface SepaLookupClient {
  paymentMethods: {
    retrieve(id: string): Promise<Pick<Stripe.PaymentMethod, 'type'>>;
  };
  invoices: {
    list(params: {
      subscription: string;
      status: 'paid';
      limit: number;
    }): Promise<{ data: unknown[] }>;
  };
}

/**
 * Whether the subscription has ever had a paid invoice: true, false, or null
 * when Stripe could not be asked. One call, `limit: 1`, because the question
 * is "any at all".
 */
export async function hasPaidInvoice(
  client: SepaLookupClient,
  subscriptionId: string,
): Promise<boolean | null> {
  try {
    const paid = await client.invoices.list({
      subscription: subscriptionId,
      status: 'paid',
      limit: 1,
    });
    return paid.data.length > 0;
  } catch (err) {
    console.error(`[stripe-webhook] could not list paid invoices for ${subscriptionId}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The subscription's default payment method type, or null if unknown. */
async function paymentMethodType(
  client: SepaLookupClient,
  subscription: Pick<Stripe.Subscription, 'id' | 'default_payment_method'>,
): Promise<string | null> {
  const method = subscription.default_payment_method;
  if (!method) return null;
  if (typeof method === 'object') return method.type ?? null;
  try {
    return (await client.paymentMethods.retrieve(method)).type ?? null;
  } catch (err) {
    console.error(`[stripe-webhook] could not retrieve payment method of ${subscription.id}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The rule against live Stripe data. Makes no call at all for a subscription
 * outside `past_due` / `unpaid`, so the common path (active, trialing,
 * canceled) costs nothing, and makes the invoice call only for a SEPA one.
 */
export async function neverPaidSepa(
  client: SepaLookupClient,
  subscription: Pick<Stripe.Subscription, 'id' | 'status' | 'default_payment_method'>,
): Promise<boolean> {
  if (!GRACE_STATUSES.has(subscription.status)) return false;
  const type = await paymentMethodType(client, subscription);
  if (type !== 'sepa_debit') return false;
  const paid = await hasPaidInvoice(client, subscription.id);
  const verdict = isNeverPaidSepa({ status: subscription.status, paymentMethodType: type, hasPaidInvoice: paid });
  if (verdict) {
    console.error(
      `[stripe-webhook] subscription ${subscription.id} is ${subscription.status} on SEPA Direct Debit with no paid invoice: provisional access ends.`,
    );
  }
  return verdict;
}
