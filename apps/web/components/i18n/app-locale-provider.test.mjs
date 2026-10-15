// ---------------------------------------------------------------------------
// AppLocaleProvider: which language the dashboard and the auth screens speak,
// and that every string of every language is the one in the catalog.
//
// Run with: npm run test:app-locale
//
// WHY THIS EXISTS. The provider carries four message namespaces (dashboard,
// dashboardChrome, auth, common) in five languages, and decides the language on
// the client: the stored choice, else the browser language, else English. Two
// things about it are deliberate and easy to break without noticing:
//
//   1. The FIRST render is always English, whatever the person's language,
//      because that is what the server sent and hydration has to match it.
//      Their language is applied just after.
//   2. Whatever language is on screen, every string in it must be that
//      language's catalog value. A catalog that is missing, half loaded or
//      swapped for another one does not throw: next-intl prints the key path
//      ("dashboard.settings.languageHeading") where the sentence should be.
//
// So this renders the REAL provider around the real dashboard (Sidebar, Topbar
// and the Settings page, whose language buttons are the only way a person
// changes language) and around the real login screen, in all five languages,
// and reads the DOM.
//
// HOW "EVERY STRING" IS CHECKED WITHOUT A LIST OF KEYS. The English render is
// the reference. Every text node and every title / aria-label / placeholder in
// it that equals an English catalog value is mapped to the key path(s) that
// hold that value. The same tree rendered in another language must then show,
// in the same position, that language's value for one of those keys. Nothing
// is hand-listed, so a string added to the dashboard tomorrow is covered the
// day it is added. `useMessages()` is compared to the catalog files as well,
// which covers the strings this tree happens not to render.
//
// ON WAITING. Reads of the language on screen go through `waitFor`. What is
// asserted is exact; only the moment it appears is left open.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();
// installDom() does not expose storage, and the provider reads the bare global.
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true, writable: true });

const { act } = await import('react');
const { renderToString } = await import('react-dom/server');
const { hydrateRoot } = await import('react-dom/client');
const { useMessages, useLocale, useTranslations } = await import('next-intl');
const { default: AppLocaleProvider, useAppLocale } = await import('./AppLocaleProvider.jsx');
const { DashboardApp } = await import('../dashboard/App.jsx');
const { LoginApp } = await import('../auth/LoginApp.jsx');

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];
const NAMESPACES = ['dashboard', 'dashboardChrome', 'auth', 'common'];
const STORAGE_KEY = 'mcpe-locale';
/** The language buttons on the Settings page, by their own-language names. */
const AUTONYM = { en: 'English', nb: 'Norsk', es: 'Español', fr: 'Français', zh: '中文' };

/** The catalogs, read straight off disk: the reference everything is held to. */
const CATALOG = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  Object.fromEntries(NAMESPACES.map((ns) => [
    ns,
    JSON.parse(readFileSync(new URL(`../../messages/${locale}/${ns}.json`, import.meta.url), 'utf8')),
  ])),
]));

// ---------------------------------------------------------------------------
// Catalog lookups
// ---------------------------------------------------------------------------

/** Every string leaf of a catalog as [keyPath, value]. */
function leaves(node, prefix = '', out = []) {
  if (typeof node === 'string') out.push([prefix, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const LEAVES = Object.fromEntries(LOCALES.map((l) => [l, new Map(leaves(CATALOG[l]))]));

/** English value -> every key path that holds it. */
const EN_KEYS_BY_VALUE = new Map();
for (const [key, value] of LEAVES.en) {
  if (!EN_KEYS_BY_VALUE.has(value)) EN_KEYS_BY_VALUE.set(value, []);
  EN_KEYS_BY_VALUE.get(value).push(key);
}

// ---------------------------------------------------------------------------
// Reading what is on screen
// ---------------------------------------------------------------------------

const ATTRS = ['title', 'aria-label', 'placeholder'];

/** Every visible string in document order: text nodes, then labelled attributes. */
function strings(root) {
  const out = [];
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === window.Node.TEXT_NODE) {
      if (node.nodeValue.trim() !== '') out.push({ where: 'text', value: node.nodeValue });
    } else {
      for (const attr of ATTRS) {
        if (node.hasAttribute(attr)) out.push({ where: attr, value: node.getAttribute(attr) });
      }
    }
  }
  return out;
}

/**
 * Holds `actual` (a tree rendered in `locale`) to `reference` (the same tree in
 * English). Returns how many strings were catalog strings, so a caller can
 * insist the comparison was not vacuous.
 */
function assertTranslated(reference, actual, locale, what) {
  assert.equal(actual.length, reference.length, `${what} in ${locale}: same number of strings as in English`);
  let checked = 0;
  const failures = [];
  reference.forEach((ref, i) => {
    const keys = EN_KEYS_BY_VALUE.get(ref.value);
    if (!keys) return; // Not a catalog string: a name, a number, hardcoded copy.
    checked += 1;
    const allowed = new Set(keys.map((key) => LEAVES[locale].get(key)));
    if (!allowed.has(actual[i].value)) {
      failures.push(`${keys[0]} (${actual[i].where}): expected ${JSON.stringify([...allowed][0])}, got ${JSON.stringify(actual[i].value)}`);
    }
  });
  assert.deepEqual(failures, [], `${what} in ${locale}: every catalog string is the ${locale} catalog value`);
  return checked;
}

/** A key path printed where a sentence should be: next-intl's missing-message output. */
function keyPathsOnScreen(root) {
  return strings(root)
    .map((s) => s.value)
    .filter((v) => /^(dashboard|dashboardChrome|auth|common)\.[A-Za-z0-9_.]+$/.test(v));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function dashboardProps() {
  return {
    initialRoute: 'settings',
    user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
    workspace: { id: 'ws-0001', slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: true },
    workspaces: [],
    activeWorkspaceId: 'ws-0001',
    mcpUrl: 'https://mcpemails.com/api/mcp',
    userRole: 'owner',
    planLimits: { inboxes: 10, members: 5 },
    stripePrices: {},
    overviewStats: {},
    activityFeed: [],
    inboxes: [],
    apiKeys: [],
    usageData: {},
    auditLog: [],
    members: [],
    pendingInvites: [],
  };
}

/** Reports what the provider hands down on every render. */
function Probe({ seen }) {
  const messages = useMessages();
  const intlLocale = useLocale();
  const app = useAppLocale();
  const t = useTranslations('dashboard');
  seen.renders.push({ intl: intlLocale, app: app.locale, heading: t('settings.languageHeading') });
  seen.messages = messages;
  seen.setLocale = app.setLocale;
  return createElement('p', { id: 'probe' }, t('settings.languageHeading'));
}

function newSeen() {
  return { renders: [], messages: null, setLocale: null };
}

/**
 * Starts every test from the same place: no stored choice, an English browser,
 * `<html lang>` cleared, and `fetch` answering 200 with an empty body.
 */
function reset(t, { stored = null, languages = ['en-US'] } = {}) {
  window.localStorage.clear();
  if (stored) window.localStorage.setItem(STORAGE_KEY, stored);
  document.documentElement.removeAttribute('lang');
  const previousLanguages = Object.getOwnPropertyDescriptor(window.navigator, 'languages');
  Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => languages });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  t.after(() => {
    if (previousLanguages) Object.defineProperty(window.navigator, 'languages', previousLanguages);
    else delete window.navigator.languages;
    globalThis.fetch = previousFetch;
    window.localStorage.clear();
  });
}

async function mountWith(t, children) {
  const view = await mount(createElement(AppLocaleProvider, null, children));
  t.after(() => view.unmount());
  return view;
}

/** The provider around a probe and the real dashboard on its Settings page. */
async function mountDashboard(t, options) {
  reset(t, options);
  const seen = newSeen();
  const view = await mountWith(t, [
    createElement(Probe, { key: 'probe', seen }),
    createElement(DashboardApp, { key: 'app', ...dashboardProps() }),
  ]);
  return { ...view, seen, button: (locale) => languageButton(view.container, locale) };
}

function languageButton(container, locale) {
  return [...container.querySelectorAll('.language-selector button')].find((b) => b.textContent === AUTONYM[locale]);
}

/** Waits until the screen, not just the provider's state, is in `locale`. */
async function settled(view, locale) {
  const heading = CATALOG[locale].dashboard.settings.languageHeading;
  await waitFor(() => view.container.querySelector('#probe')?.textContent === heading,
    { message: `the screen to be in ${locale}` });
}

// ===========================================================================
// The first render is English
// ===========================================================================

test('server render: the HTML is English whatever the stored language', async (t) => {
  reset(t, { stored: 'nb', languages: ['nb-NO'] });
  const seen = newSeen();
  const html = renderToString(createElement(AppLocaleProvider, null, createElement(Probe, { seen })));
  assert.equal(html, `<p id="probe">${CATALOG.en.dashboard.settings.languageHeading}</p>`);
  assert.deepEqual(seen.renders, [{ intl: 'en', app: 'en', heading: 'Language' }]);
});

test('first client render: English first, then the stored language', async (t) => {
  reset(t, { stored: 'nb' });
  const seen = newSeen();
  const view = await mountWith(t, createElement(Probe, { seen }));
  await settled(view, 'nb');
  assert.deepEqual(seen.renders[0], { intl: 'en', app: 'en', heading: 'Language' },
    'the first render is English, matching what the server sent');
  assert.deepEqual(seen.renders.at(-1), { intl: 'nb', app: 'nb', heading: CATALOG.nb.dashboard.settings.languageHeading });
  // English is the only thing ever shown before the stored language: never a
  // key path, never a third language.
  for (const render of seen.renders) {
    assert.ok(['Language', CATALOG.nb.dashboard.settings.languageHeading].includes(render.heading),
      `an intermediate render showed ${JSON.stringify(render.heading)}`);
  }
});

test('hydration: server HTML hydrates without a mismatch, then moves to the stored language', async (t) => {
  reset(t, { stored: 'fr' });
  const serverSeen = newSeen();
  const tree = (seen) => createElement(AppLocaleProvider, null, createElement(Probe, { seen }));
  const container = document.createElement('div');
  container.innerHTML = renderToString(tree(serverSeen));
  document.body.appendChild(container);
  const serverHtml = container.innerHTML;

  const errors = [];
  const previousError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  const seen = newSeen();
  let root;
  await act(async () => {
    root = hydrateRoot(container, tree(seen), { onRecoverableError: (err) => errors.push(String(err)) });
  });
  t.after(async () => {
    console.error = previousError;
    await act(async () => { root.unmount(); });
    container.remove();
  });

  assert.equal(seen.renders[0].heading, 'Language', 'the hydrating render is English');
  assert.equal(serverHtml, '<p id="probe">Language</p>');
  await waitFor(() => container.querySelector('#probe').textContent === CATALOG.fr.dashboard.settings.languageHeading,
    { message: 'French after hydration' });
  assert.deepEqual(errors, [], 'no hydration mismatch and no console error');
});

test('an English user renders English only, and nothing else ever', async (t) => {
  const view = await mountDashboard(t);
  await settled(view, 'en');
  await flush(() => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.deepEqual([...new Set(view.seen.renders.map((r) => `${r.intl}/${r.app}/${r.heading}`))], ['en/en/Language']);
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null, 'a language nobody chose is not stored');
  assert.deepEqual(keyPathsOnScreen(view.container), []);
});

// ===========================================================================
// Every language: the whole tree, and the whole catalog
// ===========================================================================

let englishDashboard = null;
let englishLogin = null;

test('reference: the English dashboard and login screens are made of catalog strings', async (t) => {
  const dash = await mountDashboard(t);
  await settled(dash, 'en');
  englishDashboard = strings(dash.container);
  const dashCatalogStrings = englishDashboard.filter((s) => EN_KEYS_BY_VALUE.has(s.value)).length;
  assert.ok(dashCatalogStrings >= 60, `the dashboard tree shows ${dashCatalogStrings} catalog strings; expected at least 60`);

  const login = await mountWith(t, createElement(LoginApp));
  englishLogin = strings(login.container);
  const loginCatalogStrings = englishLogin.filter((s) => EN_KEYS_BY_VALUE.has(s.value)).length;
  assert.ok(loginCatalogStrings >= 12, `the login screen shows ${loginCatalogStrings} catalog strings; expected at least 12`);

  assert.deepEqual(dash.seen.messages, CATALOG.en, 'useMessages() is the English catalog, all four namespaces');
});

for (const locale of LOCALES.filter((l) => l !== 'en')) {
  test(`${locale}: a stored choice renders the whole dashboard from the ${locale} catalog`, async (t) => {
    assert.ok(englishDashboard, 'the English reference test ran first');
    const view = await mountDashboard(t, { stored: locale });
    await settled(view, locale);

    assert.deepEqual(view.seen.messages, CATALOG[locale], `useMessages() is the ${locale} catalog, all four namespaces`);
    assert.deepEqual(view.seen.renders.at(-1), {
      intl: locale, app: locale, heading: CATALOG[locale].dashboard.settings.languageHeading,
    });
    assert.equal(document.documentElement.lang, locale);
    assert.deepEqual(keyPathsOnScreen(view.container), [], 'no key path is printed in place of a string');

    const checked = assertTranslated(englishDashboard, strings(view.container), locale, 'the dashboard');
    assert.ok(checked >= 60, `only ${checked} strings were compared`);

    assert.equal(view.button(locale).getAttribute('aria-pressed'), 'true', 'the language picker marks the active language');
    assert.equal(view.button('en').getAttribute('aria-pressed'), 'false');
  });

  test(`${locale}: the login screen is rendered from the ${locale} catalog`, async (t) => {
    assert.ok(englishLogin, 'the English reference test ran first');
    reset(t, { stored: locale });
    const seen = newSeen();
    const view = await mountWith(t, [
      createElement(Probe, { key: 'probe', seen }),
      createElement(LoginApp, { key: 'login' }),
    ]);
    await settled(view, locale);
    const screen = strings(view.container).slice(1); // Drop the probe's own line.
    const checked = assertTranslated(englishLogin, screen, locale, 'the login screen');
    assert.ok(checked >= 12, `only ${checked} strings were compared`);
    assert.deepEqual(keyPathsOnScreen(view.container), []);
    assert.equal(view.container.querySelector('h1').textContent, CATALOG[locale].auth.login.title);
  });
}

test('the five catalogs are five different languages (the comparison above is not vacuous)', () => {
  const headings = LOCALES.map((l) => CATALOG[l].dashboard.settings.languageHeading);
  assert.equal(new Set(headings).size, 5);
  const titles = LOCALES.map((l) => CATALOG[l].auth.login.title);
  assert.equal(new Set(titles).size, 5);
  const nav = LOCALES.map((l) => CATALOG[l].dashboardChrome.sidebar.navSettings);
  assert.equal(new Set(nav).size, 5);
});

// ===========================================================================
// How the language is chosen (unchanged, pinned)
// ===========================================================================

const BROWSER_LANGUAGES = [
  [['nb-NO'], 'nb'],
  [['no'], 'nb'],
  [['nn-NO'], 'nb'],
  [['es-MX', 'en'], 'es'],
  [['fr-CA'], 'fr'],
  [['zh-Hans-CN'], 'zh'],
  [['de-DE', 'fr-FR'], 'fr'],
  [['de-DE'], 'en'],
  [['en-GB', 'nb'], 'en'],
];

for (const [languages, expected] of BROWSER_LANGUAGES) {
  test(`with no stored choice, a browser set to ${languages.join(', ')} gets ${expected}`, async (t) => {
    reset(t, { languages });
    const seen = newSeen();
    const view = await mountWith(t, createElement(Probe, { seen }));
    await settled(view, expected);
    assert.equal(seen.renders.at(-1).app, expected);
    assert.equal(seen.renders.at(-1).intl, expected);
    assert.equal(document.documentElement.lang, expected);
    assert.equal(window.localStorage.getItem(STORAGE_KEY), null, 'detection alone stores nothing');
  });
}

test('a stored choice beats the browser language', async (t) => {
  reset(t, { stored: 'es', languages: ['nb-NO'] });
  const seen = newSeen();
  const view = await mountWith(t, createElement(Probe, { seen }));
  await settled(view, 'es');
  assert.equal(seen.renders.at(-1).app, 'es');
});

test('a stored value that is not a supported language is ignored', async (t) => {
  reset(t, { stored: 'de', languages: ['fr-FR'] });
  const seen = newSeen();
  const view = await mountWith(t, createElement(Probe, { seen }));
  await settled(view, 'fr');
  assert.equal(window.localStorage.getItem(STORAGE_KEY), 'de', 'and it is left as it was');
});

// ===========================================================================
// Switching language in Settings
// ===========================================================================

test('switching: each language button re-renders the dashboard in that language, without a reload', async (t) => {
  const view = await mountDashboard(t);
  await settled(view, 'en');
  const reference = strings(view.container);

  for (const locale of ['nb', 'es', 'fr', 'zh', 'en']) {
    await flush(() => view.button(locale).click());
    await settled(view, locale);
    assert.equal(window.localStorage.getItem(STORAGE_KEY), locale, `${locale} is stored`);
    assert.equal(document.documentElement.lang, locale);
    assert.equal(view.seen.renders.at(-1).app, locale);
    assert.equal(view.seen.renders.at(-1).intl, locale);
    assert.deepEqual(view.seen.messages, CATALOG[locale]);
    assert.equal(view.button(locale).getAttribute('aria-pressed'), 'true');
    assertTranslated(reference, strings(view.container), locale, 'the dashboard after switching');
    assert.deepEqual(keyPathsOnScreen(view.container), []);
  }
});

test('switching: the picker marks the new language at once, and the screen never shows a key path on the way', async (t) => {
  const view = await mountDashboard(t);
  await settled(view, 'en');
  await flush(() => view.button('nb').click());
  assert.equal(view.button('nb').getAttribute('aria-pressed'), 'true', 'the pressed state follows the click directly');
  assert.equal(window.localStorage.getItem(STORAGE_KEY), 'nb', 'and the choice is stored directly');
  await settled(view, 'nb');
  const allowed = new Set(['Language', CATALOG.nb.dashboard.settings.languageHeading]);
  for (const render of view.seen.renders) {
    assert.ok(allowed.has(render.heading), `a render on the way showed ${JSON.stringify(render.heading)}`);
  }
});

test('switching: setLocale ignores a language that is not supported', async (t) => {
  const view = await mountDashboard(t, { stored: 'nb' });
  await settled(view, 'nb');
  await flush(() => { view.seen.setLocale('de'); view.seen.setLocale(undefined); view.seen.setLocale(''); });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(view.seen.renders.at(-1).app, 'nb');
  assert.equal(window.localStorage.getItem(STORAGE_KEY), 'nb');
  assert.equal(view.container.querySelector('#probe').textContent, CATALOG.nb.dashboard.settings.languageHeading);
});

// ===========================================================================
// Rapid switching: the last selection wins
// ===========================================================================

/** Asserts the whole screen is in `locale` and stays there. */
async function assertEndsOn(view, locale) {
  await settled(view, locale);
  // Long enough for anything started by an earlier click to land.
  await flush(() => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.equal(view.container.querySelector('#probe').textContent, CATALOG[locale].dashboard.settings.languageHeading,
    'a slower, earlier selection must not overwrite the last one');
  assert.equal(view.seen.renders.at(-1).app, locale);
  assert.equal(view.seen.renders.at(-1).intl, locale);
  assert.deepEqual(view.seen.messages, CATALOG[locale]);
  assert.equal(document.documentElement.lang, locale);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), locale);
  assert.equal(view.button(locale).getAttribute('aria-pressed'), 'true');
  for (const other of LOCALES.filter((l) => l !== locale)) {
    assert.equal(view.button(other).getAttribute('aria-pressed'), 'false');
  }
  assert.deepEqual(keyPathsOnScreen(view.container), []);
}

test('rapid switching: four clicks in one tick end on the last one', async (t) => {
  const view = await mountDashboard(t);
  await settled(view, 'en');
  await flush(() => {
    view.button('nb').click();
    view.button('es').click();
    view.button('fr').click();
    view.button('zh').click();
  });
  await assertEndsOn(view, 'zh');
});

test('rapid switching: clicks on consecutive ticks, with no waiting between, end on the last one', async (t) => {
  const view = await mountDashboard(t);
  await settled(view, 'en');
  for (const locale of ['zh', 'fr', 'es', 'nb', 'fr']) {
    await flush(() => view.button(locale).click());
  }
  await assertEndsOn(view, 'fr');
});

test('rapid switching: away and straight back to English ends on English', async (t) => {
  const view = await mountDashboard(t);
  await settled(view, 'en');
  await flush(() => { view.button('nb').click(); view.button('en').click(); });
  await assertEndsOn(view, 'en');
});

test('rapid switching: a click before the stored language has been applied still wins', async (t) => {
  reset(t, { stored: 'nb' });
  const seen = newSeen();
  // Render and click inside one act, so the click lands before anything the
  // mount started for the stored language can have finished.
  const view = await mountWith(t, [
    createElement(Probe, { key: 'probe', seen }),
    createElement(DashboardApp, { key: 'app', ...dashboardProps() }),
  ]);
  await flush(() => languageButton(view.container, 'es').click());
  await assertEndsOn({ ...view, seen, button: (l) => languageButton(view.container, l) }, 'es');
});
