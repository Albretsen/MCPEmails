import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUSINESS_SEAT_COPY_LOCALES,
  businessSeatCopyFor,
  businessSeatNumbers,
  businessSeatPageCopy,
  rawBusinessSeatCopy,
  withBusinessSeatStory,
} from './business-seat-copy.ts';
import { inboxCapOffer } from './inbox-cap-offer.mjs';
import { buildPurchaseConfirmationEmail, BUSINESS_SEAT_EMAIL_FEATURES } from '../email/purchase-confirmation.ts';
import {
  BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
  BUSINESS_EXTRA_INBOX_YEARLY_CENTS,
  BUSINESS_INCLUDED_INBOXES,
  BUSINESS_MIN_SEATS,
  BUSINESS_PRIVATE_INBOXES_PER_PERSON,
  BUSINESS_SEAT_MONTHLY_CENTS,
  BUSINESS_SEAT_YEARLY_CENTS,
} from '../stripe/plans.ts';
import type { StripePricesMap } from '../stripe/getPrices.ts';

/**
 * Business billed per person: the copy shown while `business_seat_pricing`
 * is on, pinned to the plan data.
 *
 * The copy never writes a Business number itself. Every price, minimum and
 * mailbox count is a placeholder filled from the price map and plans.ts, so
 * a reprice moves every sentence with it. These tests check that the JSON
 * keeps it that way in every locale, that the filled copy quotes exactly the
 * catalogue's numbers, and that the dashboard strings (which cannot take
 * placeholders the same way) still agree with the constants.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Every string leaf as [dotted.path, value]. */
function leaves(node: Json, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (Array.isArray(node)) return node.flatMap((c, i) => leaves(c, prefix ? `${prefix}.${i}` : String(i)));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, c]) => leaves(c, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** The price map as withBusinessSeatPrices leaves it with the switch on. */
function seatPrices(monthlyCents = BUSINESS_SEAT_MONTHLY_CENTS, yearlyCents = BUSINESS_SEAT_YEARLY_CENTS): StripePricesMap {
  return {
    pro: {
      monthlyCents,
      yearlyCents,
      monthlyPriceConfigured: true,
      yearlyPriceConfigured: true,
      perPerson: { minPeople: BUSINESS_MIN_SEATS },
    },
  };
}

const usd = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const has = (text: string, n: string | number) => new RegExp(`(^|[^\\d.,])${String(n).replace('.', '\\.')}([^\\d]|$)`).test(text);

test('every locale has the same keys as English, nothing empty', () => {
  const reference = leaves(rawBusinessSeatCopy('en') as unknown as Json).map(([k]) => k).sort();
  assert.ok(reference.length > 40, `expected a full set of copy, found ${reference.length}`);
  for (const locale of BUSINESS_SEAT_COPY_LOCALES) {
    const entries = leaves(rawBusinessSeatCopy(locale) as unknown as Json);
    assert.deepEqual(entries.map(([k]) => k).sort(), reference, `${locale}: keys differ from en`);
    for (const [key, value] of entries) assert.ok(value.trim(), `${locale}: ${key} is empty`);
  }
});

test('every locale uses the same placeholders as English, key by key', () => {
  const english = new Map(leaves(rawBusinessSeatCopy('en') as unknown as Json));
  for (const locale of BUSINESS_SEAT_COPY_LOCALES) {
    for (const [key, value] of leaves(rawBusinessSeatCopy(locale) as unknown as Json)) {
      assert.deepEqual(placeholders(value), placeholders(english.get(key)!), `${locale}: ${key} placeholders`);
    }
  }
});

test('the JSON never writes a Business price or the add-on price itself', () => {
  const seat = usd(BUSINESS_SEAT_MONTHLY_CENTS);
  const yearly = usd(BUSINESS_SEAT_YEARLY_CENTS).replace('.', '[.,]');
  const addon = usd(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS);
  for (const locale of BUSINESS_SEAT_COPY_LOCALES) {
    for (const [key, value] of leaves(rawBusinessSeatCopy(locale) as unknown as Json)) {
      assert.ok(!has(value, seat), `${locale}: ${key} writes ${seat} instead of {price}`);
      assert.ok(!new RegExp(yearly).test(value), `${locale}: ${key} writes the yearly price`);
      assert.ok(
        !new RegExp(`\\$\\s?${addon}(\\D|$)|(^|\\D)${addon}\\s?\\$`).test(value),
        `${locale}: ${key} writes the add-on price instead of {addon}`,
      );
      assert.ok(!/\$39|39 \$|\$374|\$29\b/.test(value), `${locale}: ${key} quotes the flat or founder price`);
    }
  }
});

test('with the switch on, the English Business copy quotes the plan data', () => {
  const copy = businessSeatPageCopy('en', seatPrices());
  assert.ok(copy);
  const price = usd(BUSINESS_SEAT_MONTHLY_CENTS);
  const yearly = usd(BUSINESS_SEAT_YEARLY_CENTS);
  const yearlyMonth = usd(Math.round(BUSINESS_SEAT_YEARLY_CENTS / 12));
  const addon = usd(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS);
  assert.equal(copy.card.billedYearly, `Billed $${yearly}/year per person`);
  assert.match(copy.card.minimum, new RegExp(`^${BUSINESS_MIN_SEATS} people minimum\\.`));
  assert.match(copy.card.minimum, /anyone without one of their own is free, whatever their role/);
  assert.ok(copy.card.features.includes(`Private mailboxes for each person, up to ${BUSINESS_PRIVATE_INBOXES_PER_PERSON} each`));
  assert.ok(copy.card.features.includes(`${BUSINESS_INCLUDED_INBOXES} company-wide mailboxes included, then $${addon} a month each`));
  assert.match(copy.pricing.heroLead, new RegExp(`\\$${price} per person a month`));
  assert.match(copy.pricing.faq['9'], new RegExp(`\\$${yearly.replace('.', '\\.')} per person a year \\(\\$${yearlyMonth.replace('.', '\\.')} a month\\)`));
  assert.match(copy.pricing.faq['9'], new RegExp(`\\$${usd(BUSINESS_EXTRA_INBOX_YEARLY_CENTS).replace('.', '\\.')} a year`));
  assert.match(copy.pricing.ctaSub, new RegExp(`\\$${price} per person a month for a team, ${BUSINESS_MIN_SEATS} people minimum`));
  assert.equal(
    copy.pricing.values.inboxes,
    `Up to ${BUSINESS_PRIVATE_INBOXES_PER_PERSON} private per person, plus ${BUSINESS_INCLUDED_INBOXES} company-wide, then $${addon} a month each`,
  );
});

test('every locale fills every placeholder, in its own number format', () => {
  for (const locale of BUSINESS_SEAT_COPY_LOCALES) {
    const copy = businessSeatCopyFor(locale, seatPrices());
    assert.ok(copy, locale);
    for (const [key, value] of leaves(copy as unknown as Json)) {
      assert.ok(!/\{\w+\}/.test(value), `${locale}: ${key} has an unfilled placeholder: ${value}`);
    }
    const yearly = leaves(copy as unknown as Json).find(([k]) => k === 'card.billedYearly')![1];
    const sep = ['en', 'ja'].includes(locale) ? '.' : ',';
    assert.ok(yearly.includes(usd(BUSINESS_SEAT_YEARLY_CENTS).replace('.', sep)), `${locale}: ${yearly}`);
  }
  // zh is frozen and renders the English copy.
  assert.deepEqual(businessSeatCopyFor('zh', seatPrices()), businessSeatCopyFor('en', seatPrices()));
});

test('a reprice moves every sentence with it', () => {
  const copy = businessSeatPageCopy('en', seatPrices(2500, 24000));
  assert.ok(copy);
  assert.match(copy.pricing.heroLead, /\$25 per person a month/);
  assert.equal(copy.card.billedYearly, 'Billed $240/year per person');
  assert.doesNotMatch(JSON.stringify(copy), /\$(19|29)\b/);
});

test('switch off: no per-person price map, no copy', () => {
  const flat: StripePricesMap = {
    pro: { monthlyCents: 3900, yearlyCents: 37440, monthlyPriceConfigured: true, yearlyPriceConfigured: true },
  };
  assert.equal(businessSeatPageCopy('en', flat), null);
  assert.equal(businessSeatPageCopy('en', undefined), null);
  assert.equal(businessSeatNumbers(flat), null);
});

test('no copy rule is broken in any locale', () => {
  const EM_DASH = new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']');
  const BANNED = /soc\s*-?\s*2|\bsso\b|single sign|saml|hipaa|iso\s*27001|enterprise|30 days|30 dager|30 días|30 jours|30 Tage|30 dias|30日/i;
  for (const locale of BUSINESS_SEAT_COPY_LOCALES) {
    for (const [key, value] of leaves(businessSeatCopyFor(locale, seatPrices()) as unknown as Json)) {
      assert.ok(!EM_DASH.test(value), `${locale}: ${key} has an em dash`);
      assert.ok(!value.includes('<'), `${locale}: ${key} has a literal <`);
      assert.ok(!BANNED.test(value), `${locale}: ${key} claims "${value.match(BANNED)?.[0]}"`);
      assert.ok(!/MCP Emails|Mcpemails/.test(value), `${locale}: ${key} misspells MCPEmails`);
      assert.ok(!/[‘’]/.test(value), `${locale}: ${key} has a curly apostrophe`);
    }
  }
});

test('/for/business: the team story is laid over the page, meta untouched', async () => {
  const numbers = businessSeatNumbers(seatPrices())!;
  for (const locale of BUSINESS_SEAT_COPY_LOCALES) {
    const base = JSON.parse(readFileSync(path.join(webRoot, `messages/${locale}/forBusiness.json`), 'utf8'));
    const story = withBusinessSeatStory(base, locale, numbers) as typeof base;
    assert.deepEqual(story.meta, base.meta, `${locale}: meta must not change`);
    assert.deepEqual(story.pains, base.pains, `${locale}: the operator story stays`);
    assert.ok(story.team.items.private.p, `${locale}: team section`);
    assert.ok(story.pricing.items.business.h, `${locale}: Business card`);
    assert.deepEqual(Object.keys(story.pricing.items), ['free', 'personal', 'pro', 'business']);
    assert.equal(story.faq.items.length, base.faq.items.length + 1, `${locale}: one added question`);
    assert.equal(story.faq.items[1].a, base.faq.items[1].a, `${locale}: untouched answers stay`);
    assert.notEqual(story.faq.items[5].a, base.faq.items[5].a, `${locale}: the colleague answer is rewritten`);
    // The flat price is gone from every string the story wrote.
    for (const [key, value] of leaves({ hero: story.hero, team: story.team, pricing: story.pricing, faq: story.faq, ctaBand: story.ctaBand })) {
      assert.ok(!/\$39|39 \$|\$39\b|月\$39/.test(value), `${locale}: ${key} still quotes $39`);
      assert.ok(!/\{\w+\}/.test(value), `${locale}: ${key} unfilled`);
    }
  }
  // The view renders the six team cards by these keys.
  const view = readFileSync(path.join(webRoot, 'components/marketing/BusinessView.jsx'), 'utf8');
  const match = view.match(/const TEAM_KEYS = \[([^\]]+)\]/);
  assert.ok(match);
  const keys = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), Object.keys(rawBusinessSeatCopy('en').forBusiness.team.items).sort());
});

/* ─── Dashboard strings (messages/, no placeholders for the counts) ─── */

const DASH_LOCALES = ['en', 'nb', 'es', 'fr', 'de', 'pt', 'ja'] as const;
const msg = (locale: string, ns: string) =>
  JSON.parse(readFileSync(path.join(webRoot, `messages/${locale}/${ns}.json`), 'utf8'));

test('the dashboard per-person lines exist in every locale and quote the constants', () => {
  const addon = usd(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS);
  for (const locale of DASH_LOCALES) {
    const dash = msg(locale, 'dashboard');
    const chrome = msg(locale, 'dashboardChrome');
    const plans = dash.billing.plans;
    for (const k of ['businessSeatFeaturePrivate', 'businessSeatFeatureCompany', 'businessSeatFeatureRoles', 'businessSeatFeatureRules', 'businessSeatFeatureAudit']) {
      assert.equal(typeof plans[k], 'string', `${locale}: billing.plans.${k}`);
    }
    for (const k of ['businessCapBodySeat', 'businessCapCtaSeat', 'businessSeatFeaturePrivate', 'businessSeatFeatureCompany', 'businessSeatFeatureRules']) {
      assert.equal(typeof chrome.connect[k], 'string', `${locale}: connect.${k}`);
    }
    for (const k of ['capBodyProCapSeat', 'capCtaBusinessSeat']) {
      assert.equal(typeof dash.inboxes[k], 'string', `${locale}: inboxes.${k}`);
    }
    for (const text of [plans.businessSeatFeaturePrivate, chrome.connect.businessSeatFeaturePrivate]) {
      assert.ok(has(text, BUSINESS_PRIVATE_INBOXES_PER_PERSON), `${locale}: "${text}"`);
    }
    for (const text of [plans.businessSeatFeatureCompany, chrome.connect.businessSeatFeatureCompany]) {
      assert.ok(has(text, BUSINESS_INCLUDED_INBOXES), `${locale}: "${text}"`);
      assert.ok(has(text, addon), `${locale}: "${text}"`);
    }
    for (const text of [dash.inboxes.capBodyProCapSeat, chrome.connect.businessCapBodySeat]) {
      assert.ok(has(text, BUSINESS_MIN_SEATS), `${locale}: minimum in "${text}"`);
      assert.ok(has(text, BUSINESS_INCLUDED_INBOXES), `${locale}: included in "${text}"`);
      assert.ok(!/39/.test(text), `${locale}: "${text}" quotes the flat price`);
    }
  }
});

test('the Pro-cap offer sells per-person Business only with the switch on', () => {
  const flat = inboxCapOffer(10, {});
  assert.equal(flat.bodyKey, 'connect.businessCapBody');
  assert.ok(flat.featureKeys.includes('connect.businessFeatureMembers'));
  const seat = inboxCapOffer(10, { seatPricing: true });
  assert.equal(seat.plan, 'pro');
  assert.equal(seat.bodyKey, 'connect.businessCapBodySeat');
  assert.equal(seat.noticeBodyKey, 'inboxes.capBodyProCapSeat');
  assert.equal(seat.ctaKey, 'connect.businessCapCtaSeat');
  assert.equal(seat.offers[0].noticeCtaKey, 'inboxes.capCtaBusinessSeat');
  assert.ok(!seat.featureKeys.includes('connect.businessFeatureMembers'), 'no "members at no extra cost"');
  const chrome = msg('en', 'dashboardChrome');
  for (const key of seat.featureKeys) {
    assert.equal(typeof chrome.connect[key.replace('connect.', '')], 'string', key);
  }
  // Below Pro's cap nothing changes.
  assert.deepEqual(inboxCapOffer(1, { seatPricing: true }), inboxCapOffer(1, {}));
});

test('the purchase email lists the per-person features for a seat subscription only', () => {
  const base = {
    planId: 'pro' as const,
    interval: 'month' as const,
    amountTotalCents: 3800,
    currency: 'usd',
  };
  const seat = buildPurchaseConfirmationEmail({ ...base, perPerson: true });
  assert.match(seat.body, new RegExp(`${BUSINESS_MIN_SEATS} people minimum`));
  assert.ok(seat.body.includes(`- ${BUSINESS_SEAT_EMAIL_FEATURES[1]}`));
  assert.doesNotMatch(seat.body, /no extra cost/);
  const flat = buildPurchaseConfirmationEmail(base);
  assert.match(flat.body, /no extra cost/);
  assert.doesNotMatch(flat.body, /people minimum/);
});
