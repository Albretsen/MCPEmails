import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FREE_ACTION_ALLOWANCE, FREE_ACTION_GRACE_DAYS, PLANS } from '../stripe/plans.ts';

/**
 * The business-positioning copy, pinned.
 *
 * On 2026-09-20 the site stopped describing the buyer as one person with
 * mailboxes of their own, and started describing the buyer who actually pays:
 * one operator running several company mailboxes (info@, sales@, invoices@).
 * That change is copy in five languages across four surfaces, which is exactly
 * the kind of change that rots one string at a time:
 *
 *   - a translator leaves a value in English, or drops a key, and nothing
 *     notices because a missing key renders as an empty cell, not an error;
 *   - someone "tidies" the comparison table back to "Just you" for Pro, which
 *     is true about logins and tells every company it belongs on Team;
 *   - a well-meant edit names a provider or a certification we cannot support.
 *     Outlook / Microsoft 365 sign-in is not shipped, there is no SOC 2 report,
 *     no data-residency choice and no Enterprise tier, and each of those has
 *     already been removed from this site once.
 *
 * Everything here reads files from disk; nothing renders. The rendered checks
 * (status codes, canonical, hreflang, sitemap) are done against a built server
 * before release, not here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const LOCALES = ['en', 'es', 'fr', 'nb', 'zh'] as const;
type Locale = (typeof LOCALES)[number];
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function readText(rel: string): string {
  return readFileSync(path.join(webRoot, rel), 'utf8');
}

function readJson(rel: string): Json {
  return JSON.parse(readText(rel)) as Json;
}

const messages = (locale: Locale, ns: string) => readJson(`messages/${locale}/${ns}.json`);
const imap = (locale: Locale) => readJson(`src/lib/connect/content/${locale}/imap.json`);

/** Every string leaf as [dotted.path, value]. Arrays index as `items.0.q`. */
function leaves(node: Json, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => leaves(child, prefix ? `${prefix}.${i}` : String(i)));
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, child]) => leaves(child, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

function at(node: Json, dotted: string): Json | undefined {
  let cur: Json | undefined = node;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as { [k: string]: Json })[part];
  }
  return cur;
}

function str(node: Json, dotted: string, label: string): string {
  const value = at(node, dotted);
  assert.equal(typeof value, 'string', `${label}: ${dotted} is missing or not a string`);
  return value as string;
}

// U+2014 em dash and U+2015 horizontal bar. The house rule is commas, periods,
// colons or parentheses instead, in every locale.
const EM_DASH = new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']');

// Claims this product cannot support. Matched case-insensitively against the
// strings this change wrote, never against whole legacy files: pricing.json
// legitimately says the self-host stack has no "Outlook one-click OAuth", and
// the IMAP page legitimately says Microsoft 365 cannot be connected.
const BANNED_CLAIMS = /outlook|microsoft\s*365|office\s*365|exchange online|soc\s*-?\s*2|data residency|enterprise|hipaa|iso\s*27001/i;

/** The strings this change wrote in files that also hold older copy. */
const CHANGED_PATHS: Record<'pricing' | 'home' | 'imap', string[]> = {
  pricing: [
    'meta.description',
    'hero.lead',
    'plans.personal.desc',
    'plans.solo.desc',
    'comparison.sections.usage.rows.members',
    'comparison.values.oneSeat',
    'comparison.values.unlimitedCompany',
    'faq.items.5.a',
    'faq.items.6.a',
    'ctaBand.sub',
  ],
  home: [
    'pricing.sub',
    'pricing.tiers.personal.desc',
    'pricing.tiers.solo.desc',
    'pricing.businessLink',
    'footer.linkBusiness',
  ],
  imap: [
    'meta.description',
    'hero.lead',
    'hero.answer',
    'persona.intro',
    'persona.label',
    'setup.0.p',
    'ctaBand.title',
  ],
};

/* ─── /for/business copy ────────────────────────────────────── */

test('forBusiness exists in all five locales with identical keys and no empty values', () => {
  const reference = leaves(messages('en', 'forBusiness')).map(([k]) => k).sort();
  assert.ok(reference.length > 60, `expected a full page of copy, found ${reference.length} strings`);
  for (const locale of LOCALES) {
    const entries = leaves(messages(locale, 'forBusiness'));
    assert.deepEqual(
      entries.map(([k]) => k).sort(),
      reference,
      `${locale}: forBusiness.json keys differ from en`,
    );
    for (const [key, value] of entries) {
      assert.ok(value.trim().length > 0, `${locale}: forBusiness ${key} is empty`);
    }
  }
});

test('forBusiness carries every key the page renders', () => {
  // BusinessView reads copy by key with no fallback, so a key it names and the
  // JSON lacks is a render crash in production, not a blank. The key lists are
  // read out of the component so the two cannot drift apart silently.
  const view = readText('components/marketing/BusinessView.jsx');
  const lists: Record<string, string> = {
    PAIN_KEYS: 'pains.items',
    DOES_KEYS: 'does.items',
    SAFETY_KEYS: 'safety.items',
    PLAN_KEYS: 'pricing.items',
  };
  const copy = messages('en', 'forBusiness');
  for (const [constant, base] of Object.entries(lists)) {
    const match = view.match(new RegExp(`const ${constant} = \\[([^\\]]+)\\]`));
    assert.ok(match, `BusinessView no longer declares ${constant}`);
    const keys = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, `${constant} is empty`);
    for (const key of keys) {
      str(copy, `${base}.${key}.h`, 'en forBusiness');
      str(copy, `${base}.${key}.p`, 'en forBusiness');
    }
  }
  for (const key of [
    'meta.title', 'meta.description', 'hero.titleLine1', 'hero.titleLine2', 'hero.lead',
    'safety.link', 'providers.ctaImap', 'providers.ctaGmail', 'providers.ctaIonos',
    'providers.ctaMatrix', 'pricing.note', 'pricing.cta', 'faq.items.0.q', 'faq.items.0.a',
    'ctaBand.title', 'ctaBand.ctaPrimary', 'ctaBand.ctaSecondary',
  ]) {
    str(copy, key, 'en forBusiness');
  }
});

test('the forBusiness translations are translations, not English copies', () => {
  // A handful of one-word labels are genuinely the same word in two languages.
  // Anything longer that matches English is an untranslated string.
  const SAME_WORD_ALLOWED = new Set(['Routine', 'Control']);
  const english = new Map(leaves(messages('en', 'forBusiness')));
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    let identical = 0;
    for (const [key, value] of leaves(messages(locale, 'forBusiness'))) {
      if (value !== english.get(key)) continue;
      identical += 1;
      assert.ok(
        SAME_WORD_ALLOWED.has(value),
        `${locale}: forBusiness ${key} is still English ("${value.slice(0, 60)}")`,
      );
    }
    assert.ok(identical <= 2, `${locale}: ${identical} strings are identical to English`);
  }
});

test('the forBusiness prices and the Free allowance come from the plan catalogue', () => {
  // The page quotes three prices and the Free allowance in prose, in five
  // languages. plans.ts is the source; a reprice must fail here, not ship a
  // page that contradicts checkout.
  const dollars = (id: 'personal' | 'solo' | 'pro') => String(PLANS[id].monthlyPriceCents / 100);
  assert.equal(PLANS.personal.limits.maxInboxes, 3, 'the page says Personal covers up to three');
  assert.equal(PLANS.solo.limits.maxInboxes, Infinity, 'the page says Pro has no mailbox limit');
  assert.equal(PLANS.solo.limits.maxMembers, 1, 'the page says Pro is one login');
  for (const locale of LOCALES) {
    const copy = messages(locale, 'forBusiness');
    const personal = str(copy, 'pricing.items.personal.h', locale);
    const pro = str(copy, 'pricing.items.pro.h', locale);
    const team = str(copy, 'pricing.note', locale);
    const free = str(copy, 'pricing.items.free.p', locale);
    assert.match(personal, new RegExp(`(^|\\D)${dollars('personal')}(\\D|$)`), `${locale}: Personal price`);
    assert.match(pro, new RegExp(`(^|\\D)${dollars('solo')}(\\D|$)`), `${locale}: Pro price`);
    assert.match(team, new RegExp(`(^|\\D)${dollars('pro')}(\\D|$)`), `${locale}: Team price`);
    assert.ok(free.includes(String(FREE_ACTION_ALLOWANCE)), `${locale}: Free allowance in "${free}"`);
    assert.ok(free.includes(String(FREE_ACTION_GRACE_DAYS)), `${locale}: Free grace days in "${free}"`);
  }
});

/* ─── Copy rules, every surface this change touched ─────────── */

test('no em dash in any locale, on any surface this change touched', () => {
  for (const locale of LOCALES) {
    const surfaces: [string, Json][] = [
      ['forBusiness.json', messages(locale, 'forBusiness')],
      ['pricing.json', messages(locale, 'pricing')],
      ['home.json', messages(locale, 'home')],
      ['imap.json', imap(locale)],
    ];
    for (const [name, json] of surfaces) {
      for (const [key, value] of leaves(json)) {
        assert.ok(!EM_DASH.test(value), `${locale}/${name} ${key} contains an em dash`);
      }
    }
  }
  const grid = readText('components/marketing/Sections.jsx').match(/const EXAMPLES = \[[\s\S]*?\n\];/);
  assert.ok(grid, 'Sections.jsx no longer declares EXAMPLES');
  assert.ok(!EM_DASH.test(grid[0]), 'the homepage prompt grid contains an em dash');
});

test('none of the new copy makes a claim the product cannot support', () => {
  for (const locale of LOCALES) {
    for (const [key, value] of leaves(messages(locale, 'forBusiness'))) {
      assert.ok(!BANNED_CLAIMS.test(value), `${locale}: forBusiness ${key} claims "${value.match(BANNED_CLAIMS)?.[0]}"`);
    }
    const files = { pricing: messages(locale, 'pricing'), home: messages(locale, 'home'), imap: imap(locale) };
    for (const [file, paths] of Object.entries(CHANGED_PATHS) as [keyof typeof files, string[]][]) {
      for (const key of paths) {
        const value = str(files[file], key, `${locale} ${file}`);
        assert.ok(value.trim().length > 0, `${locale}: ${file} ${key} is empty`);
        assert.ok(!BANNED_CLAIMS.test(value), `${locale}: ${file} ${key} claims "${value.match(BANNED_CLAIMS)?.[0]}"`);
      }
    }
  }
  const grid = readText('components/marketing/Sections.jsx').match(/const EXAMPLES = \[[\s\S]*?\n\];/);
  assert.ok(grid && !BANNED_CLAIMS.test(grid[0]), 'the homepage prompt grid names a banned claim');
});

test('the changed strings are translated in every non-English locale', () => {
  const english = { pricing: messages('en', 'pricing'), home: messages('en', 'home'), imap: imap('en') };
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    const files = { pricing: messages(locale, 'pricing'), home: messages(locale, 'home'), imap: imap(locale) };
    for (const [file, paths] of Object.entries(CHANGED_PATHS) as [keyof typeof files, string[]][]) {
      for (const key of paths) {
        assert.notEqual(
          str(files[file], key, `${locale} ${file}`),
          str(english[file], key, `en ${file}`),
          `${locale}: ${file} ${key} is still English`,
        );
      }
    }
  }
});

test('next-intl strings carry no quoted ICU escapes', () => {
  // An apostrophe directly before "<" or "{" is an ICU escape. It renders
  // literally in production, so the rule is to reword, never to escape. Only
  // the strings that pass through next-intl matter; forBusiness and imap are
  // read as plain JSON.
  for (const locale of LOCALES) {
    const files = { pricing: messages(locale, 'pricing'), home: messages(locale, 'home') };
    for (const file of ['pricing', 'home'] as const) {
      for (const key of CHANGED_PATHS[file]) {
        const value = str(files[file], key, `${locale} ${file}`);
        assert.ok(!/'[<{]|[>}]'/.test(value), `${locale}: ${file} ${key} has an ICU quote escape`);
      }
    }
    const link = str(files.home, 'pricing.businessLink', locale);
    assert.match(link, /<business>[^<]+<\/business>/, `${locale}: businessLink lost its <business> tag`);
  }
});

/* ─── Plan descriptions and the comparison table ────────────── */

test('Personal and Pro are described as company plans, identically everywhere', () => {
  for (const locale of LOCALES) {
    const pricing = messages(locale, 'pricing');
    const home = messages(locale, 'home');
    for (const [tier, homeTier] of [['personal', 'personal'], ['solo', 'solo']] as const) {
      assert.equal(
        str(pricing, `plans.${tier}.desc`, locale),
        str(home, `pricing.tiers.${homeTier}.desc`, locale),
        `${locale}: the ${tier} description differs between /pricing and the home page`,
      );
    }
  }
  // The JSON-LD Offer descriptions come from plans.ts, in English.
  const pricing = messages('en', 'pricing');
  assert.equal(str(pricing, 'plans.personal.desc', 'en'), PLANS.personal.description);
  assert.equal(str(pricing, 'plans.solo.desc', 'en'), PLANS.solo.description);
  assert.match(PLANS.personal.description, /business/i);
  assert.match(PLANS.solo.description, /business/i);
});

test('the consumer framing does not come back on the English pricing surfaces', () => {
  // "Every mailbox you own" is the phrase that did the damage: a company does
  // not own sales@, it operates it. "Side business" and "one more" describe a
  // life, not a company.
  const STALE = /you own|side business|and one more|still one person/i;
  const surfaces: [string, Json][] = [
    ['pricing.json', messages('en', 'pricing')],
    ['home.json', messages('en', 'home')],
    ['docs.json cta', at(messages('en', 'docs'), 'cta') ?? null],
    ['forFounders.json faq', at(messages('en', 'forFounders'), 'faq') ?? null],
  ];
  for (const [name, json] of surfaces) {
    for (const [key, value] of leaves(json)) {
      assert.ok(!STALE.test(value), `en/${name} ${key} still says "${value.match(STALE)?.[0]}"`);
    }
  }
  assert.ok(!STALE.test(PLANS.personal.description) && !STALE.test(PLANS.solo.description));
});

test('Pro still reads as one seat, truthfully', () => {
  // The repositioning must not overclaim: Pro is one login. The FAQ answer that
  // compares the tiers has to keep saying so, and Team stays the multi-person
  // plan.
  assert.equal(PLANS.solo.limits.maxMembers, 1);
  const answer = str(messages('en', 'pricing'), 'faq.items.5.a', 'en');
  assert.match(answer, /Pro is still one seat/);
  assert.match(answer, /Team is for when more than one person/);
});

test('"Just you" is gone from the comparison table, in every locale', () => {
  const OLD_VALUES = ['Just you', 'Solo tú', 'Vous seul', 'Bare deg', '仅你自己'];
  for (const locale of LOCALES) {
    const pricing = messages(locale, 'pricing');
    assert.equal(at(pricing, 'comparison.values.ownerOnly'), undefined, `${locale}: values.ownerOnly is back`);
    str(pricing, 'comparison.values.oneSeat', locale);
    str(pricing, 'comparison.values.unlimitedCompany', locale);
    for (const [key, value] of leaves(pricing)) {
      for (const old of OLD_VALUES) {
        assert.ok(!value.includes(old), `${locale}: pricing ${key} still says "${old}"`);
      }
    }
  }
  assert.equal(str(messages('en', 'pricing'), 'comparison.values.oneSeat', 'en'), '1 seat');
  assert.equal(str(messages('en', 'pricing'), 'comparison.sections.usage.rows.members', 'en'), 'Seats');
});

test('the comparison table wires Pro to the seat count and the company-mailbox value', () => {
  const client = readText('components/marketing/PricingClient.jsx');
  assert.ok(!client.includes('values.ownerOnly'), 'PricingClient still references values.ownerOnly');
  const row = (key: string) => {
    const match = client.match(new RegExp(`\\{ key: '${key}',[^}]*\\}`));
    assert.ok(match, `PricingClient has no '${key}' row`);
    return match[0];
  };
  assert.match(row('members'), /solo: 'values\.oneSeat'/);
  assert.match(row('members'), /pro: 'values\.unlimited'/);
  assert.match(row('inboxes'), /solo: 'values\.unlimitedCompany'/);

  // A missing message key renders an empty cell instead of failing the build,
  // so every values.* key the table names has to exist in every locale.
  const referenced = new Set([...client.matchAll(/'values\.([A-Za-z0-9]+)'/g)].map((m) => m[1]));
  assert.ok(referenced.size >= 10, 'expected the table to reference its value keys');
  for (const locale of LOCALES) {
    for (const key of referenced) {
      str(messages(locale, 'pricing'), `comparison.values.${key}`, locale);
    }
  }
});

/* ─── The homepage prompt grid ──────────────────────────────── */

test('the homepage prompt grid keeps at least two company-mailbox prompts', () => {
  const source = readText('components/marketing/Sections.jsx');
  const grid = source.match(/const EXAMPLES = \[[\s\S]*?\n\];/);
  assert.ok(grid, 'Sections.jsx no longer declares EXAMPLES');
  const prompts = [...grid[0].matchAll(/prompt: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(prompts.length, 6, 'the grid is laid out for six cards');
  const departmental = prompts.filter((p) => /\b(sales|info|invoices|support|billing|accounts)@/.test(p));
  assert.ok(departmental.length >= 2, `only ${departmental.length} prompt(s) name a company role address`);
  // Tool chips must be real tool names.
  const REAL_TOOLS = new Set([
    'inbox_list', 'email_read', 'email_organize', 'email_delete', 'email_compose',
    'email_search_and_move', 'folder', 'folder_list', 'draft', 'draft_list',
    'schedule', 'schedule_list', 'contact_search', 'automation', 'automation_read',
  ]);
  for (const match of grid[0].matchAll(/tools: \[([^\]]*)\]/g)) {
    for (const tool of match[1].matchAll(/"([^"]+)"/g)) {
      assert.ok(REAL_TOOLS.has(tool[1]), `the grid shows a tool that does not exist: ${tool[1]}`);
    }
  }
});

/* ─── /connect/imap ─────────────────────────────────────────── */

test('/connect/imap leads with the company-mailbox operator and links to /for/business', () => {
  for (const locale of LOCALES) {
    const content = imap(locale);
    assert.equal(str(content, 'persona.href', locale), '/for/business');
    str(content, 'persona.intro', locale);
    str(content, 'persona.label', locale);
  }
  const en = imap('en');
  assert.match(str(en, 'hero.lead', 'en'), /^Connect every mailbox your company runs/);
  // The SEO targets survive the rewrite.
  const pitch = ['meta.title', 'meta.description', 'hero.titleLine1', 'hero.titleLine2', 'hero.lead', 'hero.answer']
    .map((key) => str(en, key, 'en'))
    .join(' ');
  for (const term of ['IMAP', 'SMTP', 'MCP', 'AI agent']) {
    assert.ok(pitch.includes(term), `/connect/imap lost the target term "${term}"`);
  }
  // Free is one inbox. The page must keep saying so, and must not promise more.
  assert.equal(PLANS.free.limits.maxInboxes, 1);
  assert.match(str(en, 'setup.0.p', 'en'), /free plan connects one inbox/i);
  assert.match(str(en, 'hero.meta0', 'en'), /^1 inbox free/);
});

/* ─── Registration ──────────────────────────────────────────── */

test('/for/business is routed, in the sitemap, linked, and kept out of the global bundle', () => {
  // A marketing path missing from MARKETING_PATHS never reaches its own route:
  // it falls through to the Supabase branch of the proxy and 404s.
  assert.match(readText('proxy.ts'), /'\/for\/business',/);
  assert.match(readText('app/sitemap.ts'), /path: '\/for\/business'/);
  const sections = readText('components/marketing/Sections.jsx');
  assert.ok(sections.includes('href="/for/business"'), 'the home page / footer no longer links to /for/business');
  assert.ok(readText('public/llms.txt').includes('https://mcpemails.com/for/business'));

  // Everything in MARKETING_NAMESPACES is serialised into the HTML of every
  // marketing page. This page loads its own copy on the server instead.
  const request = readText('src/i18n/request.ts');
  const namespaces = request.match(/MARKETING_NAMESPACES = \[([^\]]+)\]/);
  assert.ok(namespaces, 'request.ts no longer declares MARKETING_NAMESPACES');
  assert.ok(!namespaces[1].includes('forBusiness'), 'forBusiness must not be a global next-intl namespace');
  assert.doesNotMatch(
    readText('components/marketing/BusinessView.jsx'),
    /^\s*['"]use client['"]/,
    'BusinessView must stay a server component, or its copy has to become a global namespace',
  );
});
