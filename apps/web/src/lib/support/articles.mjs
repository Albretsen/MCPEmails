/**
 * Help center articles, in one locale.
 *
 * Sources, in display order:
 *  1. "Common fixes": the troubleshooting articles in help-content/<locale>.json
 *     (the v1 set, title from `articlesHeading`).
 *  2. One category per area file, `articles/<locale>/<area>.json`, in the fixed
 *     order of HELP_AREAS. A locale without its own file for an area gets the
 *     English file for that area; an area with no file at all is left out.
 *
 * Only the four area files are read, each by its own name. Nothing globs the
 * directory, so notes or other files kept next to them are never loaded.
 *
 * Every article is checked against the shape the UI renders. One that does not
 * fit is dropped rather than rendered half-broken, and an id seen earlier (in
 * any category) is dropped too, since the id is the page anchor. articles.test.mjs
 * holds the shipped files to having nothing dropped.
 */

import { HELP_LOCALES } from './help-content.mjs';

/** Area files in display order. The value is the file name without `.json`. */
export const HELP_AREAS = ['getting-started', 'using-email', 'safety-automation', 'account-team'];

/** The category id of the troubleshooting articles. Not an area file. */
export const COMMON_FIXES = 'common-fixes';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// One literal file name per import, so the bundler's context module for each
// covers exactly `articles/<any locale>/<that area>.json` and nothing else.
const IMPORTERS = {
  'getting-started': (l) => import(`./articles/${l}/getting-started.json`),
  'using-email': (l) => import(`./articles/${l}/using-email.json`),
  'safety-automation': (l) => import(`./articles/${l}/safety-automation.json`),
  'account-team': (l) => import(`./articles/${l}/account-team.json`),
};

/** The parsed area file, or null when it does not exist or will not load. */
export async function loadAreaFile(locale, area) {
  const importer = IMPORTERS[area];
  if (!importer || !HELP_LOCALES.includes(locale)) return null;
  try {
    const mod = await importer(locale);
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

const isText = (v) => typeof v === 'string' && v.trim().length > 0 && !v.includes('<');
const textList = (v) => Array.isArray(v) && v.every(isText);

/** The article in the shape the UI renders, or null when it does not fit. */
export function normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, title, summary } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (!isText(title) || !isText(summary)) return null;
  const body = raw.body === undefined ? [] : raw.body;
  const steps = raw.steps === undefined ? [] : raw.steps;
  const links = raw.links === undefined ? [] : raw.links;
  if (!textList(body) || !textList(steps)) return null;
  if (body.length === 0 && steps.length === 0) return null;
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    if (!l || !isText(l.label) || typeof l.href !== 'string' || !l.href.startsWith('/') || l.href.startsWith('//')) {
      return null;
    }
  }
  const keywords = typeof raw.keywords === 'string' && !raw.keywords.includes('<') ? raw.keywords : '';
  return {
    id,
    title,
    summary,
    keywords,
    body,
    steps,
    links: links.map((l) => ({ label: l.label, href: l.href })),
  };
}

function normalizeCategory(area, file, seen) {
  if (!file || typeof file !== 'object' || !Array.isArray(file.articles)) return null;
  const articles = [];
  for (const raw of file.articles) {
    const a = normalizeArticle(raw);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    articles.push(a);
  }
  if (articles.length === 0) return null;
  const title = isText(file.title) ? file.title : area;
  return { area, title, lead: isText(file.lead) ? file.lead : '', articles };
}

/**
 * `{ categories: [{ area, title, lead, articles }] }` for a locale.
 *
 * `help` is the locale's help content (help-content.mjs). `load` replaces the
 * file loader in tests.
 */
export async function getHelpArticles(locale, { help, load = loadAreaFile } = {}) {
  const l = HELP_LOCALES.includes(locale) ? locale : 'en';
  const seen = new Set();
  const categories = [];

  const fixes = normalizeCategory(
    COMMON_FIXES,
    { title: help?.articlesHeading, lead: help?.articlesLead, articles: help?.articles ?? [] },
    seen,
  );
  if (fixes) categories.push(fixes);

  // A locale's own file wins; a missing or unusable one falls back to English.
  const files = await Promise.all(
    HELP_AREAS.map(async (area) => [l === 'en' ? null : await load(l, area), await load('en', area)]),
  );
  HELP_AREAS.forEach((area, i) => {
    const [own, en] = files[i];
    const category = normalizeCategory(area, own, seen) ?? normalizeCategory(area, en, seen);
    if (category) categories.push(category);
  });

  return { categories };
}

/** Every article of every category, in display order. */
export function flattenArticles(categories) {
  return (categories ?? []).flatMap((c) => c.articles);
}
