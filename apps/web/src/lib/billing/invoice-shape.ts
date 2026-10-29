/**
 * Reading a Stripe invoice across API versions.
 *
 * Lifted out of the webhook route so it can be run against real event payloads.
 * It is small, and it is also the piece whose failure mode is worst: a null
 * price id becomes a null plan id, which used to render as "Personal" for every
 * customer including a Team subscriber at $79.
 */

import type Stripe from 'stripe';
import { isMailboxAddonPriceId } from '@/lib/stripe/plans';

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * The price id of the plan line of an invoice, across API versions.
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
  // A Business invoice can carry the per-mailbox add-on as a line of its own,
  // and it is not a plan. Take the first line that is not the add-on, so the
  // email names Business rather than nothing.
  //
  // An in-place upgrade invoice (always_invoice proration) leads with the
  // CREDIT for the unused part of the old plan, a negative line on the old
  // price, then the debit for the new one. The plan the invoice is for is the
  // new one, so a charged (positive) line wins over a credit. A renewal or a
  // checkout invoice has no credit line, so it resolves exactly as before.
  const lines = (invoice.lines?.data ?? []) as unknown as Record<string, unknown>[];
  const entries = lines
    .map((line) => ({ id: lineId(line), amount: typeof line.amount === 'number' ? line.amount : null }))
    .filter((entry): entry is { id: string; amount: number | null } => entry.id !== null);
  const plan = entries.filter((entry) => !isMailboxAddonPriceId(entry.id));
  return (
    plan.find((entry) => entry.amount !== null && entry.amount > 0)?.id ??
    plan[0]?.id ??
    entries[0]?.id ??
    null
  );
}

/** Every price id on an invoice's lines, credits included. */
export function invoiceLinePriceIds(invoice: Stripe.Invoice): string[] {
  const lines = (invoice.lines?.data ?? []) as unknown as Record<string, unknown>[];
  return lines.map(lineId).filter((id): id is string => id !== null);
}

/** The subscription id an invoice belongs to, across API versions. */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } } | null;
  };
  return idOf(raw.parent?.subscription_details?.subscription) ?? idOf(raw.subscription) ?? null;
}

function lineId(line: Record<string, unknown>): string | null {
  const pricing = line.pricing as { price_details?: { price?: unknown } } | undefined;
  return idOf(pricing?.price_details?.price) ?? idOf(line.price) ?? idOf(line.plan) ?? null;
}
