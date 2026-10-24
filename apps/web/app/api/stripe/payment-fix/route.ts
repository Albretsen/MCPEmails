import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { stripe } from '@/lib/stripe/client';
import { verifyPortalCustomerOwnership } from '@/lib/stripe/portal-customer';

/**
 * GET /api/stripe/payment-fix
 *
 * The button on the failed-payment banner (components/dashboard/
 * PaymentIssueBanner.jsx). Sends the signed-in owner straight to the Stripe
 * page that settles the failing invoice:
 *
 *   1. the latest OPEN invoice for their customer -> 302 to its
 *      hosted_invoice_url (pay with a new card, or run the bank's 3-D Secure
 *      confirmation, on one page);
 *   2. no open invoice -> 302 to a billing portal session, pinned to our own
 *      portal configuration exactly like POST /api/stripe/portal;
 *   3. anything else (no customer, refused customer, Stripe error) -> 302 to
 *      /dashboard/settings.
 *
 * The lookup is made on every click, so the link never goes stale and no
 * Stripe URL is ever stored in the page.
 *
 * Not signed in -> 303 to /login with `redirect` pointing back here, the same
 * shape /api/stripe/checkout/start uses.
 *
 * OWNERSHIP. `user_billing.stripe_customer_id` is written only by server code
 * and is trusted, as the portal trusts it; it is still refused if the Stripe
 * customer itself names another user or workspace, or is deleted. The legacy
 * `workspaces.stripe_customer_id` is only a candidate and must prove it is the
 * caller's (src/lib/stripe/portal-customer.ts) before it is used.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = new URL(request.url).origin;
  const settings = () => redirect(new URL('/dashboard/settings', origin), 302);

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    const login = new URL('/login', origin);
    login.searchParams.set('redirect', '/api/stripe/payment-fix');
    return redirect(login, 303);
  }

  try {
    const customerId = await ownedCustomerId(supabase, user);
    if (!customerId) return settings();

    const invoices = await stripe.invoices.list({ customer: customerId, status: 'open', limit: 1 });
    const open = invoices.data[0];
    if (open?.hosted_invoice_url && customerOf(open) === customerId) {
      return redirect(new URL(open.hosted_invoice_url), 302);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
    const portalConfiguration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/dashboard/settings`,
      ...(portalConfiguration ? { configuration: portalConfiguration } : {}),
    });
    return redirect(new URL(session.url), 302);
  } catch (err) {
    console.error('[payment-fix] failed:', err instanceof Error ? err.message : String(err));
    return settings();
  }
}

function redirect(url: URL, status: 302 | 303): NextResponse {
  const response = NextResponse.redirect(url, status);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

function customerOf(invoice: { customer?: string | { id: string } | null }): string | null {
  const c = invoice.customer;
  if (!c) return null;
  return typeof c === 'string' ? c : c.id;
}

type Caller = { id: string; email?: string | null; email_confirmed_at?: string | null };

/**
 * The caller's Stripe customer id, or null when they have none or the only
 * candidate is not provably theirs.
 */
async function ownedCustomerId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  user: Caller,
): Promise<string | null> {
  const { data: billing } = await supabase
    .from('user_billing')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const service = createServiceRoleClient();
  const { data: owned } = await service
    .from('workspaces')
    .select('id, stripe_customer_id, deleted_at')
    .eq('owner_id', user.id);
  const ownedIds = (owned ?? []).map((w) => w.id);

  const trusted = billing?.stripe_customer_id ?? null;
  const candidates: Array<{ id: string; trusted: boolean }> = trusted
    ? [{ id: trusted, trusted: true }]
    : [
        ...new Set(
          (owned ?? [])
            .filter((w) => !w.deleted_at && w.stripe_customer_id)
            .map((w) => w.stripe_customer_id as string),
        ),
      ].map((id) => ({ id, trusted: false }));

  for (const candidate of candidates) {
    let customer;
    try {
      customer = await stripe.customers.retrieve(candidate.id);
    } catch (err) {
      console.error('[payment-fix] customer lookup failed:', err instanceof Error ? err.message : String(err));
      continue;
    }
    const verdict = verifyPortalCustomerOwnership(
      {
        id: customer.id,
        deleted: (customer as { deleted?: unknown }).deleted === true,
        email: 'email' in customer ? customer.email : null,
        metadata: 'metadata' in customer ? customer.metadata : null,
      },
      user,
      ownedIds,
    );
    // A server-written id without ownership metadata (a hand-made customer) is
    // still the caller's; a customer that names someone else never is.
    if (verdict.owned || (candidate.trusted && verdict.reason === 'no_proof')) {
      return candidate.id;
    }
    console.error('[payment-fix] refused customer for user', user.id, `(${verdict.reason})`);
  }
  return null;
}
