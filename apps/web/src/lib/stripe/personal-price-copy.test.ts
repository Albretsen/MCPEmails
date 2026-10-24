// ---------------------------------------------------------------------------
// Every price the customer reads is a price in the catalogue.
//
// WHY. The Personal price is a number in plans.ts and a sentence in about 190
// other places: five locales of message bundles, a dozen blog posts and their
// translations, llms.txt, the comparison page, the README, and the refusal the
// MCP edge function hands an agent at the Free cap. None of those can read
// plans.ts at runtime (translated prose, static text, a Deno bundle), so they
// carry the number as text. When Pro went from $29 to $15 on 2026-09-01, two
// fallback tables kept quoting $29 for four weeks and nothing failed.
//
// So this does not test a list of known sentences. It extracts EVERY currency
// amount from those surfaces, in every locale's format ($9, 9 $, 86,40 $,
// 9 美元, 9 dollar, 9 USD, and the euro forms €9, 9 €, 86,40 €, EUR 9, 9 euro),
// and requires each one to be a price the catalogue currently sells: some
// tier's monthly, yearly, or yearly-per-month amount. EUR prices carry the
// SAME digits as USD by decision (src/lib/stripe/eur-prices.ts), so one sold
// set covers both currencies, and a euro amount the catalogue does not sell
// fails exactly like a stale dollar amount.
// Reprice a plan in plans.ts and every stale mention of the old number fails
// here, by file and line, until the copy follows.
//
// A few surfaces then get a presence check, so a price that moves cannot pass
// by simply being deleted from the sentence that sells it.
//
// Competitor prices live only in src/lib/compare/email-mcp-servers.mjs, which
// is why that file is checked field by field rather than swept.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { annualOffer } from './annual-offer.ts';
import { euroizeAmounts } from './eur-prices.ts';
import {
  BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
  BUSINESS_EXTRA_INBOX_YEARLY_CENTS,
  PLANS,
} from './plans.ts';
import { rows, entries } from '../compare/email-mcp-servers.mjs';

const WEB = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const REPO = path.resolve(WEB, '../..');
const LOCALES = ['en', 'es', 'fr', 'nb', 'zh', 'de'];

/** Every amount, in cents, that some tier is sold at today. */
const SOLD_CENTS = new Set<number>();
for (const plan of Object.values(PLANS)) {
  SOLD_CENTS.add(plan.monthlyPriceCents);
  if (plan.yearlyPriceCents != null) {
    SOLD_CENTS.add(plan.yearlyPriceCents);
    SOLD_CENTS.add(Math.round(plan.yearlyPriceCents / 12));
  }
}
// Business's per-mailbox price above the included ten is sold too.
SOLD_CENTS.add(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS);
SOLD_CENTS.add(BUSINESS_EXTRA_INBOX_YEARLY_CENTS);
SOLD_CENTS.add(Math.round(BUSINESS_EXTRA_INBOX_YEARLY_CENTS / 12));

/**
 * Amounts that are not prices of ours, by file NAME (in any locale) and exact
 * value in cents. Keep this short and specific: an exemption is a sentence
 * this test stops watching.
 */
const NOT_A_PRICE: Record<string, number[]> = {
  // The liability cap in the terms ("the greater of ... or $100").
  'terms.json': [10000],
};

// $9  $ 9  $86.40  €9  EUR 9  |  9 $  86,40 $  9 美元  9 dollar  9 USD  9 €  9 EUR  9 euros
// Intl writes "9 €" with a no-break space (U+00A0 or U+202F), hence [\s\u202f].
const AMOUNT =
  /(?:\$|€|\bEUR)[\s\u202f]?(\d+(?:[.,]\d{1,2})?)(?!\d)|(?<![\w.,])(\d+(?:[.,]\d{1,2})?)[\s\u202f]?(?:\$|€|美元|欧元|dollars?\b|USD\b|EUR\b|euros?\b)/g;

function toCents(raw: string): number {
  return Math.round(Number(raw.replace(',', '.')) * 100);
}

type Hit = { where: string; cents: number; text: string };

function amountsIn(text: string, where: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    hits.push({ where, cents: toCents(match[1] ?? match[2]), text: match[0] });
  }
  return hits;
}

test('the extractor reads euro amounts as well as dollar ones', () => {
  const read = (text: string) => amountsIn(text, '').map((hit) => hit.cents);
  assert.deepEqual(read('€9 a month, €86.40 a year'), [900, 8640]);
  assert.deepEqual(read('9\u00a0€ pro Monat, 86,40\u202f€ im Jahr'), [900, 8640]);
  assert.deepEqual(read('EUR 39, 374.40 EUR, 3 euros'), [3900, 37440, 300]);
  assert.deepEqual(read('$9, 9 $, 9 USD'), [900, 900, 900]);
  // A euro amount nobody sells is caught like a dollar one.
  assert.deepEqual(read('€11 a month'), [1100]);
  assert.equal(SOLD_CENTS.has(1100), false, 'the probe amount must be one nobody sells');
});

function exempt(fileKey: string, cents: number): boolean {
  const fileName = path.basename(fileKey);
  return NOT_A_PRICE[fileName]?.includes(cents) ?? false;
}

function assertAllSold(hits: Hit[], fileKey: (where: string) => string) {
  const stale = hits.filter((hit) => !SOLD_CENTS.has(hit.cents) && !exempt(fileKey(hit.where), hit.cents));
  assert.deepEqual(
    stale.map((hit) => `${hit.where}: "${hit.text}"`),
    [],
    `amounts the catalogue does not sell (sold: ${[...SOLD_CENTS].sort((a, b) => a - b).map((c) => c / 100).join(', ')})`,
  );
}

function walkStrings(value: unknown, keyPath: string, visit: (text: string, keyPath: string) => void) {
  if (typeof value === 'string') visit(value, keyPath);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walkStrings(child, keyPath ? `${keyPath}.${key}` : key, visit);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function messages(locale: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(WEB, 'messages', locale, file), 'utf8'));
}

function lookup(bundle: Record<string, unknown>, keyPath: string): string {
  const value = keyPath.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], bundle);
  assert.equal(typeof value, 'string', `missing message ${keyPath}`);
  return value as string;
}

/** The ways a locale writes Personal's amounts, for presence checks. */
function spellings(cents: number): string[] {
  const dot = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return [dot, dot.replace('.', ',')];
}

const PERSONAL = PLANS.personal;
const PERSONAL_MONTHLY = spellings(PERSONAL.monthlyPriceCents);
const PERSONAL_YEARLY = spellings(PERSONAL.yearlyPriceCents!);

function mentions(text: string, forms: string[]): boolean {
  return amountsIn(text, '').some((hit) => forms.some((form) => toCents(form) === hit.cents));
}

// ---------------------------------------------------------------------------
// 1. The sweep.
// ---------------------------------------------------------------------------

test('every amount in every message bundle is a price the catalogue sells', () => {
  const hits: Hit[] = [];
  for (const locale of LOCALES) {
    for (const file of readdirSync(path.join(WEB, 'messages', locale))) {
      walkStrings(messages(locale, file), '', (text, keyPath) => {
        hits.push(...amountsIn(text, `messages/${locale}/${file}:${keyPath}`));
      });
    }
  }
  assert.ok(hits.length > 100, 'the extractor found the prices at all');
  assertAllSold(hits, (where) => where.split(':')[0]);
});

test('an EU visitor reads the same sold amounts in EUR, in every locale', () => {
  // The pricing surfaces rewrite their USD amounts as EUR for an EU visitor
  // (euroizeAmounts). Every rewritten amount must still be a sold one, and the
  // rewrite must find as many amounts as the dollar sweep did: a sentence that
  // loses a price on the way to EUR would otherwise pass unnoticed.
  for (const locale of LOCALES) {
    for (const file of ['pricing.json', 'home.json']) {
      walkStrings(messages(locale, file), '', (text, keyPath) => {
        const usd = amountsIn(text, '');
        if (usd.length === 0) return;
        const euro = euroizeAmounts(text, locale);
        assert.ok(!/\$/.test(euro), `messages/${locale}/${file}:${keyPath} keeps a dollar sign in EUR: "${euro}"`);
        const eur = amountsIn(euro, `messages/${locale}/${file}:${keyPath} (EUR)`);
        assert.deepEqual(
          eur.map((hit) => hit.cents),
          usd.map((hit) => hit.cents),
          `messages/${locale}/${file}:${keyPath}: "${euro}"`,
        );
        assertAllSold(eur, (where) => where.split(':')[0]);
      });
    }
  }
});

test('every amount in the blog, llms.txt and the README is a price the catalogue sells', () => {
  const files = [
    ...filesUnder(path.join(WEB, 'src/lib/blog/posts')),
    ...filesUnder(path.join(WEB, 'src/lib/blog/translations')),
    path.join(WEB, 'public/llms.txt'),
    path.join(REPO, 'README.md'),
  ];
  const hits: Hit[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => hits.push(...amountsIn(line, `${path.relative(REPO, file)}:${index + 1}`)));
  }
  assertAllSold(hits, (where) => where.split(':')[0]);
});

test('the comparison page quotes our own prices from the catalogue', () => {
  // Competitor prices are the point of this page, so only OUR fields are swept.
  // Some rows are ticks (booleans), not text; only text can quote a price.
  const textRows = rows.filter(
    (row): row is Extract<(typeof rows)[number], { us: string }> => typeof row.us === 'string',
  );
  const ours = [
    ...textRows.map((row) => ({ where: `rows[${row.label}].us`, text: row.us })),
    ...entries
      .filter((entry) => entry.us)
      .map((entry) => ({ where: `entries[${entry.name}].price`, text: entry.price })),
  ];
  assertAllSold(
    ours.flatMap(({ where, text }) => amountsIn(text, where)),
    () => 'compare',
  );
  const cheapest = textRows.find((row) => row.label === 'Cheapest paid');
  assert.ok(cheapest, 'the comparison still has a Cheapest paid row');
  assert.ok(mentions(cheapest.us, PERSONAL_MONTHLY), 'Cheapest paid names Personal monthly');
  assert.ok(mentions(cheapest.us, PERSONAL_YEARLY), 'Cheapest paid names Personal yearly');
});

test('the refusal an agent reads at the Free cap quotes the Personal price', () => {
  // A Deno bundle, so it cannot import plans.ts; this is its only tie to it.
  const source = readFileSync(path.join(REPO, 'supabase/functions/mcp-server/usage-limit-message.ts'), 'utf8');
  const match = source.match(/export const FREE_CAP_UPGRADE_PRICE = "([^"]+)";/);
  assert.ok(match, 'FREE_CAP_UPGRADE_PRICE is still a string literal');
  assert.equal(match[1], `$${PERSONAL.monthlyPriceCents / 100} per month`);
});

// ---------------------------------------------------------------------------
// 2. Presence. The sweep alone would pass a sentence that lost its price.
// ---------------------------------------------------------------------------

const MONTHLY_KEYS: Array<[string, string]> = [
  ['pricing.json', 'hero.titleLine2'],
  ['pricing.json', 'hero.lead'],
  ['pricing.json', 'meta.description'],
  ['pricing.json', 'ctaBand.sub'],
  ['dashboard.json', 'inboxes.capBodyPersonal'],
  ['dashboard.json', 'inboxes.capCtaPersonal'],
  ['dashboard.json', 'usage.capBodyReached'],
  ['dashboard.json', 'usage.capCta'],
  ['dashboardChrome.json', 'connect.personalUpgradeCta'],
];

const YEARLY_KEYS: Array<[string, string]> = [['pricing.json', 'hero.titleLine2Yearly']];

test('the sentences that sell Personal state its current price, in every locale', () => {
  for (const locale of LOCALES) {
    for (const [file, key] of MONTHLY_KEYS) {
      const text = lookup(messages(locale, file), key);
      assert.ok(mentions(text, PERSONAL_MONTHLY), `${locale}/${file} ${key} states Personal monthly: "${text}"`);
    }
    for (const [file, key] of YEARLY_KEYS) {
      const text = lookup(messages(locale, file), key);
      assert.ok(mentions(text, PERSONAL_YEARLY), `${locale}/${file} ${key} states Personal yearly: "${text}"`);
    }
    // The annual-discount answer, found by content rather than by position:
    // FAQ items get inserted, and an index silently points at another answer.
    const faq = (messages(locale, 'pricing.json').faq as { items: Array<{ a: string }> }).items;
    assert.ok(
      faq.some((item) => mentions(item.a, PERSONAL_YEARLY)),
      `${locale}/pricing.json: some FAQ answer states Personal yearly`,
    );
  }
});

test('the annual discount the copy advertises is the one the catalogue charges', () => {
  // "Save ~20%" is prose in every locale. It stays true only while every
  // yearly price rounds to 20% off twelve monthlies, computed the way the
  // upgrade dialogs compute it (Team's $756 is 20.25%, Personal's $86.40 and
  // Pro's $144 are exact).
  for (const plan of Object.values(PLANS)) {
    if (!plan.monthlyPriceCents || plan.yearlyPriceCents == null) continue;
    const offer = annualOffer({
      monthlyPriceCents: plan.monthlyPriceCents,
      yearlyPriceCents: plan.yearlyPriceCents,
      yearlyPriceConfigured: true,
    });
    assert.equal(offer?.savingPercent, 20, `${plan.id} yearly is ~20% off`);
  }
});
