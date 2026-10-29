/**
 * An in-memory Stripe for the referral tests. TEST SUPPORT ONLY; nothing in
 * the app imports this. It implements exactly the calls in ReferralStripeApi
 * and keeps the state they act on (customer balances, balance transactions,
 * paid invoices, charges, payment methods, subscriptions), so a test asserts
 * on what Stripe would hold afterwards, not on which calls were made.
 *
 * Idempotency keys behave as Stripe's do within their 24 hours: a repeated
 * key returns the first result and changes nothing.
 */

import type { ReferralStripeApi } from './server.ts';

export interface FakeCharge {
  id: string;
  amount: number;
  refunded: boolean;
  amount_refunded: number;
  disputed: boolean;
  fingerprint: string | null;
}

export interface FakeBalanceTxn {
  id: string;
  customer: string;
  amount: number;
  currency: string | null;
  metadata: Record<string, string>;
}

export class FakeStripe {
  readonly balances = new Map<string, number>();
  readonly emails = new Map<string, string>();
  /** customer.currency; absent = never billed (null). */
  readonly currencies = new Map<string, string>();
  /** subscription.currency per subscription id; absent = 'usd'. */
  readonly subscriptionCurrencies = new Map<string, string>();
  readonly txns: FakeBalanceTxn[] = [];
  readonly paidInvoices = new Map<string, number[]>();
  readonly charges = new Map<string, FakeCharge>();
  readonly cardFingerprints = new Map<string, string[]>();
  readonly subscriptions = new Map<string, string>();
  readonly invoicePayments = new Map<string, string>();
  readonly idempotency = new Map<string, FakeBalanceTxn>();
  calls: string[] = [];
  /** Make the next call named here throw once. */
  failNext = new Set<string>();
  private seq = 1;

  private guard(name: string): void {
    this.calls.push(name);
    if (this.failNext.has(name)) {
      this.failNext.delete(name);
      throw new Error(`FakeStripe: ${name} failed`);
    }
  }

  customer(id: string, options: { balance?: number; email?: string; currency?: string } = {}): this {
    this.balances.set(id, options.balance ?? 0);
    if (options.email) this.emails.set(id, options.email);
    if (options.currency) this.currencies.set(id, options.currency);
    return this;
  }

  /** The API, typed as the slice the code under test asks for. */
  api(): ReferralStripeApi {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the API methods are plain objects, not class members
    const self = this;
    const api = {
      customers: {
        async retrieve(id: string) {
          self.guard('customers.retrieve');
          if (!self.balances.has(id)) return { id, deleted: true };
          return {
            id,
            balance: self.balances.get(id),
            email: self.emails.get(id) ?? null,
            currency: self.currencies.get(id) ?? null,
          };
        },
        async list(params: { email?: string }) {
          self.guard('customers.list');
          const data = [...self.emails.entries()]
            .filter(([, email]) => email === params.email)
            .map(([id, email]) => ({ id, email }));
          return { data };
        },
        async createBalanceTransaction(
          customer: string,
          params: { amount: number; currency?: string; metadata?: Record<string, string> },
          options?: { idempotencyKey?: string },
        ) {
          self.guard('customers.createBalanceTransaction');
          const key = options?.idempotencyKey;
          if (key && self.idempotency.has(key)) return self.idempotency.get(key);
          const txn: FakeBalanceTxn = {
            id: `cbtxn_${self.seq++}`,
            customer,
            amount: params.amount,
            currency: params.currency ?? null,
            metadata: params.metadata ?? {},
          };
          self.txns.push(txn);
          self.balances.set(customer, (self.balances.get(customer) ?? 0) + params.amount);
          if (key) self.idempotency.set(key, txn);
          return txn;
        },
        async listBalanceTransactions(customer: string) {
          self.guard('customers.listBalanceTransactions');
          return { data: self.txns.filter((t) => t.customer === customer).reverse() };
        },
        async listPaymentMethods(customer: string) {
          self.guard('customers.listPaymentMethods');
          return {
            data: (self.cardFingerprints.get(customer) ?? []).map((fingerprint, i) => ({
              id: `pm_${customer}_${i}`,
              card: { fingerprint },
            })),
          };
        },
      },
      invoices: {
        async list(params: { customer?: string }) {
          self.guard('invoices.list');
          const amounts = self.paidInvoices.get(params.customer ?? '') ?? [];
          return { data: amounts.map((amount_paid, i) => ({ id: `in_${i}`, amount_paid, status: 'paid' })) };
        },
        async retrieve(id: string) {
          self.guard('invoices.retrieve');
          const charge = self.invoicePayments.get(id);
          return {
            id,
            payments: {
              data: charge ? [{ payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', latest_charge: charge } } }] : [],
            },
          };
        },
      },
      charges: {
        async retrieve(id: string) {
          self.guard('charges.retrieve');
          const c = self.charges.get(id);
          if (!c) throw new Error(`No such charge: ${id}`);
          return {
            id: c.id,
            amount: c.amount,
            refunded: c.refunded,
            amount_refunded: c.amount_refunded,
            disputed: c.disputed,
            payment_method_details: c.fingerprint ? { card: { fingerprint: c.fingerprint } } : null,
          };
        },
      },
      subscriptions: {
        async retrieve(id: string) {
          self.guard('subscriptions.retrieve');
          return {
            id,
            status: self.subscriptions.get(id) ?? 'canceled',
            currency: self.subscriptionCurrencies.get(id) ?? 'usd',
          };
        },
      },
    };
    return api as unknown as ReferralStripeApi;
  }
}
