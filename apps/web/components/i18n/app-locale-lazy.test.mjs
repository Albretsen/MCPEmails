// ---------------------------------------------------------------------------
// AppLocaleProvider when a catalog is SLOW, late, or does not arrive.
//
// Run with: npm run test:app-locale
//
// app-locale-provider.test.mjs proves every language ends up right. It cannot
// prove anything about the time in between, because under a test every catalog
// arrives at once and in order. Now that four of the five languages are
// fetched on demand, the time in between is real, and it is where this could
// go wrong in ways a person would see:
//
//   - a flash of key paths, or of nothing, while a catalog is on its way;
//   - a slow answer for an EARLIER click landing after a later one and putting
//     the screen in a language the picker says is not selected;
//   - a failed fetch leaving the dashboard broken instead of in English.
//
// So here the catalog module is replaced by one whose loads this file settles
// by hand, in any order, or rejects. The provider, the dashboard, the Settings
// language buttons and the messages are all real.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

const window = installDom();
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true, writable: true });

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];
const NAMESPACES = ['dashboard', 'dashboardChrome', 'auth', 'common'];
const STORAGE_KEY = 'mcpe-locale';
const AUTONYM = { en: 'English', nb: 'Norsk', es: 'Español', fr: 'Français', zh: '中文' };

const CATALOG = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  Object.fromEntries(NAMESPACES.map((ns) => [
    ns,
    JSON.parse(readFileSync(new URL(`../../messages/${locale}/${ns}.json`, import.meta.url), 'utf8')),
  ])),
]));
const heading = (locale) => CATALOG[locale].dashboard.settings.languageHeading;

// ---------------------------------------------------------------------------
// A catalog module under this file's control
// ---------------------------------------------------------------------------

/** Catalogs that have "arrived". English always has, as in the real module. */
let ready = new Map([['en', CATALOG.en]]);
/** One entry per call to loadAppCatalog that has not been settled yet. */
let loads = [];

mock.module(new URL('./app-locale-catalogs.mjs', import.meta.url).href, {
  namedExports: {
    peekAppCatalog: (locale) => ready.get(locale) ?? null,
    loadAppCatalog: (locale) => {
      if (ready.has(locale)) return Promise.resolve(ready.get(locale));
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      loads.push({
        locale,
        arrive: () => { ready.set(locale, CATALOG[locale]); resolve(CATALOG[locale]); },
        fail: () => reject(new Error(`ChunkLoadError: ${locale}`)),
      });
      return promise;
    },
  },
});

const { useMessages, useLocale, useTranslations } = await import('next-intl');
const { default: AppLocaleProvider, useAppLocale } = await import('./AppLocaleProvider.jsx');
const { DashboardApp } = await import('../dashboard/App.jsx');

function Probe({ seen }) {
  const intl = useLocale();
  const app = useAppLocale();
  const messages = useMessages();
  const t = useTranslations('dashboard');
  seen.renders.push({ intl, app: app.locale, heading: t('settings.languageHeading') });
  seen.messages = messages;
  return createElement('p', { id: 'probe' }, t('settings.languageHeading'));
}

async function mountDashboard(t, { stored = null } = {}) {
  ready = new Map([['en', CATALOG.en]]);
  loads = [];
  window.localStorage.clear();
  if (stored) window.localStorage.setItem(STORAGE_KEY, stored);
  document.documentElement.removeAttribute('lang');
  Object.defineProperty(window.navigator, 'languages', { configurable: true, get: () => ['en-US'] });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const seen = { renders: [], messages: null };
  const view = await mount(createElement(AppLocaleProvider, null, [
    createElement(Probe, { key: 'probe', seen }),
    createElement(DashboardApp, {
      key: 'app',
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
    }),
  ]));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    process.off('unhandledRejection', onUnhandled);
    window.localStorage.clear();
  });

  const c = view.container;
  const api = {
    ...view,
    seen,
    unhandled,
    button: (locale) => [...c.querySelectorAll('.language-selector button')].find((b) => b.textContent === AUTONYM[locale]),
    click: (locale) => flush(() => api.button(locale).click()),
    onScreen: () => c.querySelector('#probe').textContent,
    /** Settles the oldest unsettled load for `locale`. */
    settle: (locale, how) => flush(() => {
      const i = loads.findIndex((l) => l.locale === locale);
      assert.ok(i >= 0, `a load for ${locale} is pending`);
      const [load] = loads.splice(i, 1);
      load[how]();
    }),
    pendingLoads: () => loads.map((l) => l.locale),
    /** Key paths printed where sentences should be. */
    keyPaths: () => {
      const out = [];
      const walker = document.createTreeWalker(c, window.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/^(dashboard|dashboardChrome|auth|common)\.[A-Za-z0-9_.]+$/.test(node.nodeValue)) out.push(node.nodeValue);
      }
      return out;
    },
    /** The whole screen is consistently in `locale`. */
    assertShows(locale, message) {
      assert.equal(api.onScreen(), heading(locale), message);
      assert.equal(seen.renders.at(-1).intl, locale, 'next-intl formats in the language on screen');
      assert.deepEqual(seen.messages, CATALOG[locale], 'all four namespaces come from the same language');
      assert.equal(document.documentElement.lang, locale, '<html lang> names the language on screen');
      assert.deepEqual(api.keyPaths(), [], 'no key path is printed in place of a string');
    },
    assertPicked(locale) {
      assert.equal(seen.renders.at(-1).app, locale, 'useAppLocale() reports the choice');
      assert.equal(window.localStorage.getItem(STORAGE_KEY), locale, 'the choice is stored');
      for (const other of LOCALES) {
        assert.equal(api.button(other).getAttribute('aria-pressed'), String(other === locale));
      }
    },
  };
  return api;
}

const pause = () => flush(() => new Promise((resolve) => setTimeout(resolve, 20)));

// ===========================================================================
// While a catalog is on its way
// ===========================================================================

test('English needs no load at all', async (t) => {
  const view = await mountDashboard(t);
  await pause();
  assert.deepEqual(view.pendingLoads(), [], 'an English user fetches nothing');
  view.assertShows('en');
  assert.deepEqual([...new Set(view.seen.renders.map((r) => `${r.intl}/${r.app}`))], ['en/en']);
});

test('a stored language still loading: the screen is whole and English until it arrives', async (t) => {
  const view = await mountDashboard(t, { stored: 'nb' });
  await pause();
  assert.deepEqual(view.pendingLoads(), ['nb']);
  view.assertShows('en', 'English stays on screen while Norwegian loads');
  assert.equal(view.seen.renders.at(-1).app, 'nb', 'the choice is already known');

  await view.settle('nb', 'arrive');
  view.assertShows('nb');
  view.assertPicked('nb');
  // Nothing but English and Norwegian was ever rendered on the way.
  assert.deepEqual([...new Set(view.seen.renders.map((r) => r.heading))], [heading('en'), heading('nb')]);
});

test('switching to a language still loading: the picker moves at once, the strings follow when ready', async (t) => {
  const view = await mountDashboard(t);
  await view.click('fr');
  view.assertPicked('fr');
  view.assertShows('en', 'the screen keeps the language it had');
  await pause();
  view.assertShows('en');

  await view.settle('fr', 'arrive');
  view.assertShows('fr');
  view.assertPicked('fr');
});

test('switching away from a loaded language keeps THAT language on screen while the next one loads', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.settle('nb', 'arrive');
  view.assertShows('nb');

  await view.click('zh');
  view.assertPicked('zh');
  view.assertShows('nb', 'Norwegian stays until Chinese is ready; no detour through English');
  await view.settle('zh', 'arrive');
  view.assertShows('zh');
});

test('a language that has loaded once is shown instantly the second time', async (t) => {
  const view = await mountDashboard(t);
  await view.click('es');
  await view.settle('es', 'arrive');
  await view.click('en');
  view.assertShows('en');
  await view.click('es');
  assert.deepEqual(view.pendingLoads(), [], 'no second fetch');
  view.assertShows('es');
});

// ===========================================================================
// Rapid switching with slow, out-of-order answers
// ===========================================================================

test('rapid switching: the LATER click wins even when the earlier load finishes last', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.click('fr');
  assert.deepEqual(view.pendingLoads(), ['nb', 'fr']);

  await view.settle('fr', 'arrive');
  view.assertShows('fr');
  await view.settle('nb', 'arrive'); // The slow, earlier one lands now.
  await pause();
  view.assertShows('fr', 'the earlier selection must not overwrite the later one');
  view.assertPicked('fr');
});

test('rapid switching: an earlier load finishing FIRST does not put its language on screen', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.click('fr');

  await view.settle('nb', 'arrive');
  await pause();
  view.assertShows('en', 'Norwegian is no longer the choice, so it is not shown');
  view.assertPicked('fr');
  await view.settle('fr', 'arrive');
  view.assertShows('fr');
});

test('rapid switching: four clicks, answers in scrambled order, end on the last click', async (t) => {
  const view = await mountDashboard(t);
  await flush(() => {
    view.button('nb').click();
    view.button('es').click();
    view.button('fr').click();
    view.button('zh').click();
  });
  view.assertPicked('zh');
  for (const locale of ['fr', 'zh', 'nb', 'es']) {
    await view.settle(locale, 'arrive');
    await pause();
  }
  view.assertShows('zh');
  view.assertPicked('zh');
  // On the way, the screen was only ever English or the final language.
  assert.deepEqual([...new Set(view.seen.renders.map((r) => r.heading))], [heading('en'), heading('zh')]);
});

test('rapid switching: back to English while a load is pending stays English when it lands', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.click('en');
  view.assertShows('en');
  await view.settle('nb', 'arrive');
  await pause();
  view.assertShows('en', 'a late Norwegian catalog does not take the screen back');
  view.assertPicked('en');
});

test('rapid switching: A, B, A with A loading throughout ends on A', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.click('fr');
  await view.click('nb');
  await view.settle('fr', 'arrive');
  await pause();
  view.assertShows('en', 'French is not the choice any more');
  await view.settle('nb', 'arrive');
  await pause();
  view.assertShows('nb');
  view.assertPicked('nb');
});

// ===========================================================================
// A catalog that does not arrive
// ===========================================================================

test('a failed load falls back to English: whole screen, nothing thrown, choice kept', async (t) => {
  const view = await mountDashboard(t, { stored: 'nb' });
  await pause();
  await view.settle('nb', 'fail');
  await pause();
  view.assertShows('en', 'English, which is always bundled');
  assert.deepEqual(view.unhandled, [], 'the failure is not an unhandled rejection');
  assert.equal(window.localStorage.getItem(STORAGE_KEY), 'nb', 'the stored choice is not rewritten');
  assert.ok(view.button('nb'), 'the dashboard is still rendered and usable');
});

test('a failed load while another language is on screen falls back to English, not to a stale language', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.settle('nb', 'arrive');
  await view.click('fr');
  await view.settle('fr', 'fail');
  await pause();
  view.assertShows('en');
  assert.deepEqual(view.unhandled, []);
});

test('choosing the language again after a failure retries, and succeeds', async (t) => {
  const view = await mountDashboard(t);
  await view.click('es');
  await view.settle('es', 'fail');
  await pause();
  view.assertShows('en');

  await view.click('es');
  assert.deepEqual(view.pendingLoads(), ['es'], 'a second click starts a new load');
  await view.settle('es', 'arrive');
  view.assertShows('es');
  view.assertPicked('es');
});

test('a failure of an EARLIER choice does not disturb a later one', async (t) => {
  const view = await mountDashboard(t);
  await view.click('nb');
  await view.click('fr');
  await view.settle('fr', 'arrive');
  view.assertShows('fr');
  await view.settle('nb', 'fail');
  await pause();
  view.assertShows('fr', 'a stale failure must not send the screen to English');
  assert.deepEqual(view.unhandled, []);
});
