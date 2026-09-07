/**
 * Reading a Stripe invoice across API versions.
 *
 * Lifted out of the webhook route so it can be run against real event payloads.
 * It is small, and it is also the piece whose failure mode is worst: a null
 * price id becomes a null plan id, which used to render as "Personal" for every
 * customer including a Team subscriber at $79.
 */

import type Stripe from 'stripe';

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * The price id on the first line of an invoice, across API versions.
 *
 * The live webhook endpoint is pinned to its own API version, which is not
 * necessarily the one src/lib/stripe/client.ts is pinned to, and the shape of a
 * line item changed: `line.pricing.price_details.price` is the current form and
 * `line.price` / `line.plan` are what older versions serialise. Reading only the
 * current form returns null on an older endpoint.
 *
 * All three shapes are probed, most-current first, because the cost of being
 * wrong is naming the wrong plan in an email about money.
 */
export function invoiceLinePriceId(invoice: Stripe.Invoice): string | null {
  const line = invoice.lines?.data?.[0] as unknown as Record<string, unknown> | undefined;
  if (!line) return null;
  const pricing = line.pricing as { price_details?: { price?: unknown } } | undefined;
  return idOf(pricing?.price_details?.price) ?? idOf(line.price) ?? idOf(line.plan) ?? null;
}
