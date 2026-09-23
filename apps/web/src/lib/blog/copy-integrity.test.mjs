import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const postsDir = join(here, 'posts');
const translationsDir = join(here, 'translations');

const read = (path) => readFileSync(path, 'utf8');

/**
 * Pull the `content:` template literal out of a post or translation module.
 * Every one of these files is a single object literal whose `content` is the
 * last field, so the body runs from the backtick after `content:` to the final
 * backtick in the file.
 */
const contentOf = (source) => {
  const field = source.indexOf('content:');
  assert.notEqual(field, -1, 'file has no content field');
  const open = source.indexOf('`', field);
  const close = source.lastIndexOf('`');
  assert.ok(close > open, 'file has no content template literal');
  return source.slice(open + 1, close);
};

const translatedSlugs = readdirSync(translationsDir)
  .filter((entry) => entry !== 'index.js')
  .filter((slug) => existsSync(join(postsDir, `${slug}.js`)))
  .sort();

// ---------------------------------------------------------------------------
// Outlook is not connectable in production
// ---------------------------------------------------------------------------

/**
 * Outlook and Microsoft 365 are built but cannot be connected in production.
 * Where an English post says so, every translation has to say so just as often.
 * A locale that quietly drops the caveat, as zh did on
 * /blog/connect-claude-to-email, tells readers a feature works when it does not.
 *
 * These match the in-progress and coming-soon wording each locale actually
 * uses, and there is more than one phrasing per locale: nb writes both "under
 * utvikling" and "under arbeid", zh both "正在开发中" and "仍在开发中". They are only ever applied to lines that already mention Outlook, so a
 * loose phrase like "en cours" cannot match unrelated prose.
 */
const IN_PROGRESS = {
  en: /in progress|not yet generally available|coming soon|can't connect|cannot be connected/i,
  es: /en desarrollo|pr[oó]ximamente|a[uú]n no disponible|no puedes conectar|no se pueden conectar/i,
  fr: /en cours|bient[oô]t disponible|pas encore disponible|ne pouvez pas connecter|peuvent pas encore/i,
  nb: /under utvikling|under arbeid|kommer snart|enn[aå] ikke allment tilgjengelig|kan (?:enn[aå] )?ikke kobles?/i,
  zh: /(?:正|仍)在开发中|即将推出|尚未全面开放|尚未在生产环境中提供|无法在生产环境中连接/,
};

const inProgressNotes = (source, locale) => {
  const pattern = IN_PROGRESS[locale];
  assert.ok(pattern, `no in-progress pattern for locale ${locale}`);
  return contentOf(source)
    .split('\n')
    .filter((line) => line.includes('Outlook') && pattern.test(line));
};

for (const slug of translatedSlugs) {
  test(`${slug}: every translation carries the Outlook in-progress note as often as English`, () => {
    const english = inProgressNotes(read(join(postsDir, `${slug}.js`)), 'en');

    for (const file of readdirSync(join(translationsDir, slug)).sort()) {
      const locale = file.replace(/\.js$/, '');
      const translated = inProgressNotes(read(join(translationsDir, slug, file)), locale);

      assert.equal(
        translated.length,
        english.length,
        `${slug}/${file} carries ${translated.length} Outlook in-progress note(s), English carries ${english.length}. ` +
          'A translation must not promise an Outlook connection the English source says is unavailable.',
      );
    }
  });
}

test('no locale advertises an Outlook connect step that English does not', () => {
  // The zh regression told readers to "sign in with Microsoft and authorize
  // access" on a page whose English source offers no such step.
  const connectStep = /Outlook \/ Microsoft 365/;

  for (const slug of translatedSlugs) {
    const englishOffers = connectStep.test(contentOf(read(join(postsDir, `${slug}.js`))));

    for (const file of readdirSync(join(translationsDir, slug))) {
      const translated = contentOf(read(join(translationsDir, slug, file)));

      if (connectStep.test(translated)) {
        assert.ok(
          englishOffers,
          `${slug}/${file} presents an "Outlook / Microsoft 365" connect step that the English source does not`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// House style: no em dashes
// ---------------------------------------------------------------------------

/**
 * House rule is no em dashes, in any language. The rest of the blog corpus is
 * not clean yet (23 English posts and 72 translations still carry them), so
 * this pins the slugs that have been swept. Add a slug here as it is cleaned.
 */
const EM_DASH_CLEAN_SLUGS = ['connect-claude-to-email'];

for (const slug of EM_DASH_CLEAN_SLUGS) {
  const files = [
    join(postsDir, `${slug}.js`),
    ...readdirSync(join(translationsDir, slug)).map((file) => join(translationsDir, slug, file)),
  ];

  for (const path of files) {
    const label = path.slice(here.length + 1);
    test(`${label} uses no em dash`, () => {
      const source = read(path);
      const index = source.indexOf('—');
      assert.equal(
        index,
        -1,
        `${label} contains an em dash near: ${source.slice(Math.max(0, index - 40), index + 40)}`,
      );
    });
  }
}

test('an ordered list that resumes after a code block keeps its number', async () => {
  const { renderMarkdown } = await import('./markdown.js');
  const { html } = renderMarkdown('1. One\n2. Two\n\n```\nhttps://example.com\n```\n\n4. Four\n5. Five\n');
  assert.match(html, /<ol>\s*<li>One<\/li>/);
  assert.match(html, /<ol start="4"><li>Four<\/li><li>Five<\/li><\/ol>/);
});
