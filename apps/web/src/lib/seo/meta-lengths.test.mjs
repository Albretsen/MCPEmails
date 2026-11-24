import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { BRAND_SUFFIX, TITLE_MAX, DESCRIPTION_MAX, pageTitle, renderedTitle } from './title.mjs';

// Same resolver as src/lib/blog/internal-links.test.mjs (extensionless and
// directory imports in the post registry), plus the "@/" alias for src/.
const srcUrl = new URL('../../', import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('@/')) specifier = ${JSON.stringify(srcUrl)} + specifier.slice(2);
      try {
        return await next(specifier, context);
      } catch (err) {
        if (!/^(\\.\\.?\\/|file:)/.test(specifier)) throw err;
        if (err?.code === 'ERR_MODULE_NOT_FOUND') {
          for (const ext of ['.js', '.mjs', '.ts']) {
            try { return await next(specifier + ext, context); } catch {}
          }
        }
        if (err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return next(specifier + '/index.js', context);
        throw err;
      }
    }
  `)}`,
);

const { POSTS, getLocalizedPost, getPostLocales } = await import('../blog/posts.js');
const { clientUi } = await import('../clients/ui.mjs');
const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de', 'pt', 'ja'];

/** "{count}" and other ICU placeholders measured as a two-digit number. */
const measure = (text) => text.replace(/\{[a-zA-Z]+\}/g, '99');

/**
 * Search-result length budget for every page title and meta description we
 * hold as data: provider pages, client docs, blog posts in every locale, the
 * `meta` blocks in messages/, and the page-local content modules under
 * app/[locale]. The 2026-11-24 crawl found 802 titles over 60 characters and
 * 687 descriptions over 160, mostly translations nobody had measured.
 *
 * A title counts without " · MCPEmails": pageTitle() adds the suffix only when
 * the whole thing still fits (src/lib/seo/title.mjs). A description must fit
 * whole, because Google cuts it mid-sentence.
 *
 * For a live check of the rendered pages, run
 * `node scripts/check-seo-lengths.mjs https://mcpemails.com`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../../..');

/**
 * Strings allowed over budget, by "<kind> <where>". Keep this short and say
 * why. The two guide posts are in the snippet CTR test (wave 2): their title,
 * description and lead are frozen until the read-out window closes on
 * 2026-11-27. Shorten them after that and delete these entries.
 */
const ALLOW = new Set([
  'title blog/connect-claude-to-email fr',
  'title blog/connect-claude-to-email es',
  'title blog/connect-claude-to-email nb',
  'title blog/connect-claude-to-email de',
  'title blog/connect-claude-to-email pt',
  'title blog/connect-claude-to-email ja',
  'title blog/connect-chatgpt-to-email fr',
  'title blog/connect-chatgpt-to-email es',
  'title blog/connect-chatgpt-to-email nb',
  'title blog/connect-chatgpt-to-email de',
  'title blog/connect-chatgpt-to-email pt',
  'title blog/connect-chatgpt-to-email ja',
  'description blog/connect-claude-to-email fr',
  'description blog/connect-claude-to-email es',
  'description blog/connect-claude-to-email nb',
  'description blog/connect-claude-to-email de',
  'description blog/connect-claude-to-email pt',
  'description blog/connect-claude-to-email ja',
  'description blog/connect-chatgpt-to-email en',
  'description blog/connect-chatgpt-to-email fr',
  'description blog/connect-chatgpt-to-email es',
  'description blog/connect-chatgpt-to-email nb',
  'description blog/connect-chatgpt-to-email de',
  'description blog/connect-chatgpt-to-email pt',
  'description blog/connect-chatgpt-to-email ja',
]);

function collect() {
  const out = [];
  const add = (where, meta) => {
    if (!meta || typeof meta !== 'object') return;
    if (typeof meta.title === 'string') out.push({ kind: 'title', where, text: meta.title });
    if (typeof meta.description === 'string') out.push({ kind: 'description', where, text: meta.description });
  };

  // Provider pages and client docs: content/<locale>/<slug>.json, meta block.
  for (const dir of ['src/lib/connect/content', 'src/lib/clients/content']) {
    const base = join(web, dir);
    for (const locale of readdirSync(base)) {
      if (!statSync(join(base, locale)).isDirectory()) continue;
      for (const f of readdirSync(join(base, locale))) {
        if (!f.endsWith('.json')) continue;
        const json = JSON.parse(readFileSync(join(base, locale, f), 'utf8'));
        add(`${dir.split('/')[2]}/${f.replace(/\.json$/, '')} ${locale}`, json.meta);
      }
    }
  }

  // Blog posts, in every locale they are published in.
  for (const post of POSTS) {
    for (const locale of getPostLocales(post)) {
      const p = getLocalizedPost(post.slug, locale);
      add(`blog/${post.slug} ${locale}`, { title: p.title, description: p.description });
    }
  }

  // Per-assistant guides under a provider page: client-guides/<locale>.json.
  // The guide copy is nested by provider and client, so walk for `meta`.
  const guides = join(web, 'src/lib/connect/client-guides');
  for (const f of readdirSync(guides)) {
    if (!f.endsWith('.json')) continue;
    const walkGuide = (node, path) => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'meta') add(`client-guides/${f}:${path.join('.')}`, v);
        else walkGuide(v, [...path, k]);
      }
    };
    walkGuide(JSON.parse(readFileSync(join(guides, f), 'utf8')), []);
  }

  // The /docs/clients hub, whose title carries the client count.
  for (const locale of LOCALES) add(`clients/ui ${locale}`, clientUi(locale).meta);

  // messages/<locale>/<ns>.json: every object at a key named `meta`.
  const walk = (node, path, where) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'meta' && v && typeof v === 'object' && !Array.isArray(v)) add(`${where}:${[...path, k].join('.')}`, v);
      walk(v, [...path, k], where);
    }
  };
  const messages = join(web, 'messages');
  for (const locale of readdirSync(messages)) {
    const dir = join(messages, locale);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) walk(JSON.parse(readFileSync(join(dir, f), 'utf8')), [], `messages/${locale}/${f}`);
    }
  }
  return out;
}

/** Page-local copy modules (app/[locale]/**\/content.mjs), via their exports. */
async function collectContentModules() {
  const out = [];
  const files = [];
  const find = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) find(p);
      else if (f === 'content.mjs') files.push(p);
    }
  };
  find(join(web, 'app/[locale]'));
  const seen = new WeakSet();
  const walk = (node, path, where) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'meta' && v && typeof v === 'object') {
        if (typeof v.title === 'string') out.push({ kind: 'title', where: `${where}:${path.join('.')}`, text: v.title });
        if (typeof v.description === 'string') out.push({ kind: 'description', where: `${where}:${path.join('.')}`, text: v.description });
      }
      walk(v, [...path, k], where);
    }
  };
  const skipped = [];
  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch {
      // Modules importing the "@/" alias cannot load under plain node.
      skipped.push(relative(web, file));
      continue;
    }
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') walk(value, [name], relative(web, file));
    }
  }
  return { out, skipped, files: files.length };
}

test('pageTitle adds the brand suffix only when the whole title fits', () => {
  const short = 'Connect GMX to Claude';
  assert.equal(pageTitle(short), short);
  assert.equal(renderedTitle(short), `${short}${BRAND_SUFFIX}`);
  const long = 'x'.repeat(TITLE_MAX - BRAND_SUFFIX.length + 1);
  assert.deepEqual(pageTitle(long), { absolute: long });
  assert.equal(renderedTitle(long), long);
  assert.ok(renderedTitle('x'.repeat(TITLE_MAX - BRAND_SUFFIX.length)).length <= TITLE_MAX);
});

test('every title is at most 60 characters and every description at most 160', async () => {
  const items = collect();
  const mods = await collectContentModules();
  items.push(...mods.out);
  // Guard against the scan quietly finding nothing.
  assert.ok(items.length > 2000, `only ${items.length} strings found`);
  assert.ok(mods.out.length > 40, `only ${mods.out.length} strings from content modules`);
  assert.ok(mods.skipped.length <= 2, `content modules that failed to load: ${mods.skipped.join(', ')}`);

  const over = [];
  const unusedAllow = new Set(ALLOW);
  for (const { kind, where, text } of items) {
    const max = kind === 'title' ? TITLE_MAX : DESCRIPTION_MAX;
    if (measure(text).length <= max) continue;
    const key = `${kind} ${where}`;
    if (ALLOW.has(key)) {
      unusedAllow.delete(key);
      continue;
    }
    over.push(`${kind} ${measure(text).length}/${max} ${where}: ${text}`);
  }
  assert.deepEqual(over, [], `over budget:\n${over.join('\n')}`);
});

test('the brand is "MCPEmails" in every title', () => {
  const bad = collect().filter(({ kind, text }) => kind === 'title' && /mcp ?emails/i.test(text) && !/MCPEmails/.test(text));
  assert.deepEqual(bad.map((b) => `${b.where}: ${b.text}`), []);
});
