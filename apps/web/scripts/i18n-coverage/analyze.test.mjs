// Every namespace a route's client code can read must be handed to the browser
// by that route's provider. See analyze.mjs for how both sides are derived from
// the source. Run: npm run test:i18n-coverage

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, importSpecifiers, translationUses, literalKeys } from './analyze.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Three keys the automations run log reads and no locale defines. They predate
// this suite (found by it, 2026-10-02) and are a dashboard copy bug, not a
// provider-coverage problem, so they are listed rather than fixed here. Listing
// them does not require them to stay missing: defining the keys keeps this
// green.
const KNOWN_MISSING_KEYS = new Set([
  'dashboard.automations.runs.detailKeywordsUnsupported',
  'dashboard.automations.runs.detailLabelAlready',
  'dashboard.automations.runs.detailLabelled',
]);

const real = analyze(webRoot);

test('the app: every namespace a route can read is provided to it', () => {
  const problems = real.violations.filter((v) => !(v.type === 'missing-key' && KNOWN_MISSING_KEYS.has(v.key)));
  assert.deepEqual(problems.map((v) => `${v.type}: ${v.detail}`), []);
});

test('the app: the analysis actually saw the routes and their reads', () => {
  // A vacuous pass (no routes found, no reads found) must not look like a pass.
  const byFile = new Map(real.routes.map((r) => [r.file, r]));
  assert.ok(real.routes.length >= 50, `only ${real.routes.length} route files found`);
  assert.deepEqual(byFile.get('app/(auth)/login/page.js')?.needs, ['auth']);
  assert.deepEqual(byFile.get('app/signup/page.js')?.needs, ['auth']);
  assert.deepEqual(byFile.get('app/authorize/page.js')?.needs, ['auth']);
  assert.deepEqual(byFile.get('app/dashboard/[[...section]]/page.js')?.needs, ['dashboard', 'dashboardChrome']);
  assert.deepEqual(byFile.get('app/[locale]/page.tsx')?.needs, ['compare', 'home']);
  assert.deepEqual(byFile.get('app/[locale]/pricing/page.js')?.needs, ['compare', 'home', 'pricing']);
  assert.deepEqual(byFile.get('app/[locale]/docs/page.js')?.needs, ['compare', 'docs', 'home']);
  assert.deepEqual(byFile.get('app/[locale]/blog/[slug]/page.js')?.needs, ['blog', 'compare', 'home']);
  assert.deepEqual(byFile.get('app/[locale]/for/founders/page.js')?.needs, ['compare', 'forFounders', 'home']);
  assert.ok(byFile.get('app/dashboard/[[...section]]/page.js').keyCount > 500, 'dashboard literal keys were not collected');
  assert.deepEqual(real.locales.slice().sort(), ['en', 'es', 'fr', 'nb', 'zh']);
});

test('the app: nothing outside app/[locale] reads a marketing namespace', () => {
  // The fact that makes it safe to stop sending marketing messages to the app
  // and auth routes: their client code reads only what AppLocaleProvider
  // bundles, or nothing at all.
  const offenders = real.routes
    .filter((r) => !r.file.startsWith('app/[locale]/'))
    .filter((r) => r.needs.some((namespace) => !real.appNamespaces.includes(namespace)))
    .map((r) => `${r.file} needs [${r.needs}]`);
  assert.deepEqual(offenders, []);
});

test('the app: every route outside app/[locale] that reads messages sits under AppLocaleProvider', () => {
  const offenders = real.routes
    .filter((r) => !r.file.startsWith('app/[locale]/') && r.needs.length > 0 && r.provider !== 'AppLocaleProvider')
    .map((r) => `${r.file} (${r.provider})`);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// The analysis itself, on small synthetic apps. These are what prove the real
// check above is able to fail.
// ---------------------------------------------------------------------------

function makeApp(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'i18n-coverage-'));
  const base = {
    'src/i18n/request.ts': "const MARKETING_NAMESPACES = ['home', 'pricing', 'docs'] as const;\n",
    'messages/en/home.json': JSON.stringify({ hero: { title: 'Hi' }, nav: 'Nav' }),
    'messages/en/pricing.json': JSON.stringify({ title: 'Pricing' }),
    'messages/en/docs.json': JSON.stringify({ title: 'Docs' }),
    'messages/nb/home.json': JSON.stringify({ hero: { title: 'Hei' }, nav: 'Nav' }),
    'messages/nb/pricing.json': JSON.stringify({ title: 'Priser' }),
    'messages/nb/docs.json': JSON.stringify({ title: 'Dokumentasjon' }),
    'components/Nav.jsx': "'use client';\nimport { useTranslations } from 'next-intl';\nexport default function Nav() { const t = useTranslations('home'); return t('nav'); }\n",
    'components/PricingClient.jsx': "'use client';\nimport { useTranslations } from 'next-intl';\nimport Nav from './Nav';\nexport default function P() { const t = useTranslations('pricing'); return <><Nav />{t('title')}</>; }\n",
  };
  for (const [file, content] of Object.entries({ ...base, ...files })) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function run(files) {
  const root = makeApp(files);
  try {
    return analyze(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ROOT_ALL = "import { NextIntlClientProvider } from 'next-intl';\nimport { getMessages } from 'next-intl/server';\nexport default async function L({ children }) { const messages = await getMessages(); return <NextIntlClientProvider locale=\"en\" messages={messages}>{children}</NextIntlClientProvider>; }\n";
const ROOT_NULL = "import { NextIntlClientProvider } from 'next-intl';\nexport default async function L({ children }) { return <NextIntlClientProvider locale=\"en\" messages={null}>{children}</NextIntlClientProvider>; }\n";
const PRICING_PAGE = "import P from '../../../components/PricingClient';\nexport default function Page() { return <P />; }\n";
const clientMessages = (list) => `import ClientMessages from '../../components/i18n/ClientMessages';\nexport default function L({ children }) { return <ClientMessages namespaces={[${list.map((n) => `'${n}'`).join(', ')}]}>{children}</ClientMessages>; }\n`;

test('synthetic: a root provider that passes getMessages() covers everything request.ts loads', () => {
  const result = run({ 'app/layout.js': ROOT_ALL, 'app/[locale]/pricing/page.js': PRICING_PAGE });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.routes.find((r) => r.file.endsWith('pricing/page.js')).needs, ['home', 'pricing']);
});

test('synthetic: a namespace missing from the provider is reported', () => {
  const result = run({
    'app/layout.js': ROOT_NULL,
    'app/[locale]/layout.js': clientMessages(['home']),
    'app/[locale]/pricing/page.js': PRICING_PAGE,
  });
  const found = result.violations.filter((v) => v.type === 'namespace-not-provided');
  assert.equal(found.length, 1);
  assert.equal(found[0].namespace, 'pricing');
  assert.equal(found[0].route, 'app/[locale]/pricing/page.js');
});

test('synthetic: the same route passes once the namespace is listed', () => {
  const result = run({
    'app/layout.js': ROOT_NULL,
    'app/[locale]/layout.js': clientMessages(['home', 'pricing']),
    'app/[locale]/pricing/page.js': PRICING_PAGE,
  });
  assert.deepEqual(result.violations, []);
});

test('synthetic: a nested provider replaces the one above it, it does not add to it', () => {
  const result = run({
    'app/layout.js': ROOT_NULL,
    'app/[locale]/layout.js': clientMessages(['home', 'pricing']),
    'app/[locale]/pricing/layout.js': "import ClientMessages from '../../../components/i18n/ClientMessages';\nexport default function L({ children }) { return <ClientMessages namespaces={['pricing']}>{children}</ClientMessages>; }\n",
    'app/[locale]/pricing/page.js': PRICING_PAGE,
  });
  const found = result.violations.filter((v) => v.type === 'namespace-not-provided');
  assert.deepEqual(found.map((v) => v.namespace), ['home']);
});

test('synthetic: with no messages at the root, a route outside any narrower provider gets nothing', () => {
  const result = run({ 'app/layout.js': ROOT_NULL, 'app/pricing/page.js': "import P from '../../components/PricingClient';\nexport default function Page() { return <P />; }\n" });
  assert.deepEqual(result.violations.filter((v) => v.type === 'namespace-not-provided').map((v) => v.namespace).sort(), ['home', 'pricing']);
});

test('synthetic: reads behind import() and re-exports are followed', () => {
  const result = run({
    'app/layout.js': ROOT_NULL,
    'app/[locale]/layout.js': clientMessages(['home']),
    'app/[locale]/page.js': "import dynamic from 'next/dynamic';\nconst Lazy = dynamic(() => import('../../components/barrel'));\nexport default function Page() { return <Lazy />; }\n",
    'components/barrel.js': "export { default } from './Docs';\n",
    'components/Docs.jsx': "'use client';\nimport { useTranslations } from 'next-intl';\nexport default function D() { const t = useTranslations('docs'); return t('title'); }\n",
  });
  assert.deepEqual(result.violations.filter((v) => v.type === 'namespace-not-provided').map((v) => v.namespace), ['docs']);
});

test('synthetic: a read that cannot be tied to one namespace is refused', () => {
  const result = run({
    'app/layout.js': ROOT_ALL,
    'app/page.js': "import A from '../components/A';\nexport default function Page() { return <A />; }\n",
    'components/A.jsx': "'use client';\nimport { useTranslations, useMessages } from 'next-intl';\nexport default function A({ ns }) { const t = useTranslations(ns); const u = useTranslations(); const m = useMessages(); return null; }\n",
  });
  assert.deepEqual(result.violations.filter((v) => v.type === 'unprovable-read').map((v) => v.detail).sort(), ['useMessages()', 'useTranslations()', 'useTranslations(ns)']);
});

test('synthetic: a provider outside a layout is refused, and so is an unreadable messages prop', () => {
  const result = run({
    'app/layout.js': "import { NextIntlClientProvider } from 'next-intl';\nexport default function L({ children }) { return <NextIntlClientProvider locale=\"en\" messages={pick(all)}>{children}</NextIntlClientProvider>; }\n",
    'app/page.js': "import { NextIntlClientProvider } from 'next-intl';\nexport default function Page() { return <NextIntlClientProvider messages={null}>x</NextIntlClientProvider>; }\n",
  });
  assert.deepEqual(result.violations.map((v) => v.type).sort(), ['provider-outside-layout', 'unrecognised-provider']);
});

test('synthetic: ClientMessages cannot list a namespace the server never loads', () => {
  const result = run({ 'app/layout.js': ROOT_NULL, 'app/[locale]/layout.js': clientMessages(['home', 'billing']) });
  assert.deepEqual(result.violations.map((v) => v.type), ['unknown-namespace']);
});

test('synthetic: a literal key missing from one locale is reported', () => {
  const result = run({
    'app/layout.js': ROOT_ALL,
    'app/page.js': "import A from '../components/A';\nexport default function Page() { return <A />; }\n",
    'components/A.jsx': "'use client';\nimport { useTranslations } from 'next-intl';\nexport default function A() { const t = useTranslations('home'); return <>{t('hero.title')}{t.rich('hero.missing', {})}</>; }\n",
  });
  const missing = result.violations.filter((v) => v.type === 'missing-key');
  assert.deepEqual(missing.map((v) => `${v.locale}:${v.key}`).sort(), ['en:home.hero.missing', 'nb:home.hero.missing']);
});

test('parsing helpers', () => {
  assert.deepEqual(
    importSpecifiers("import a from './a';\nimport './b.css';\nimport { c } from \"@/c\";\nexport * from './d';\nconst e = await import('./e');\nconst f = require('./f');\n").sort(),
    ['./a', './b.css', './d', './e', './f', '@/c'],
  );
  assert.deepEqual(translationUses("const t = useTranslations('home.meta');").map((u) => u.namespace), ['home']);
  assert.deepEqual(
    literalKeys("function A(){ const t = useTranslations('home'); return t('a.b'); }\nfunction B(){ const t = useTranslations('compare'); return t.rich('c', {}) + t(`skip.${x}`); }\n").sort(),
    ['compare.c', 'home.a.b'],
  );
});
