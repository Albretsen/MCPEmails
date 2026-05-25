/**
 * Stripe server-side client.
 *
 * Import this only in server-side code (Server Components, Route Handlers,
 * Server Actions). Never import in client bundles — it requires STRIPE_SECRET_KEY.
 *
 * Usage:
 *   import { stripe } from '@/lib/stripe/client';
 *   const customer = await stripe.customers.create({ email });
 */

import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error(
    'STRIPE_SECRET_KEY is not set. Add it to .env.local (sk_test_*) or your deployment environment.',
  );
}

export const stripe = new Stripe(stripeSecretKey, {
  // Pin the API version so upgrades are explicit and never silent.
  apiVersion: '2025-04-30.basil',
  // Improve debuggability — the app name appears in Stripe dashboard logs.
  appInfo: {
    name: 'MCPEmails',
    version: '1.0.0',
    url: 'https://mcpemails.com',
  },
  // TypeScript strict mode — do not use `any` for Stripe objects.
  typescript: true,
});
