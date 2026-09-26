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
// Outlook / Microsoft 365 is live
// ---------------------------------------------------------------------------

/**
 * The Outlook / Microsoft 365 connector launched on 2026-09-25. Before that,
 * every post carried an "in progress, cannot be connected" note, and this file
 * checked that each translation carried it as often as English. Those notes are
 * now false, so the check is inverted: no post or translation may still say
 * Outlook is unavailable.
 *
 * These match the in-progress and coming-soon wording each locale actually
 * used, and there is more than one phrasing per locale: nb wrote both "under
 * utvikling" and "under arbeid", zh both "正在开发中" and "仍在开发中". They are
 * only ever applied to lines that also mention Outlook or Microsoft 365, so a
 * loose phrase like "en cours" cannot match unrelated prose.
 */
const IN_PROGRESS = {
  en: /in progress|not yet generally available|coming soon|can't connect|cannot be connected|not connectable yet/i,
  es: /en desarrollo|pr[oó]ximamente|a[uú]n no disponible|no puedes conectar|no se pueden conectar|todav[ií]a no (?:es )?conectable/i,
  fr: /en cours|bient[oô]t disponible|pas encore disponible|ne pouvez pas connecter|peuvent pas encore|pas encore connectable/i,
  nb: /under utvikling|under arbeid|kommer snart|enn[aå] ikke allment tilgjengelig|kan (?:enn[aå] )?ikke kobles?|ikke mulig [aå] koble til enn[aå]/i,
  zh: /(?:正|仍)在开发中|即将推出|尚未全面开放|尚未在生产环境中提供|无法在生产环境中连接|目前还不能连接/,
};

/**
 * The work/school caveat. Microsoft's default consent policy keeps many
 * employees from approving mailbox access themselves, so an IT admin has to
 * approve the app once for the organisation. Wherever English tells a reader
 * about Microsoft 365 and that admin step on the same line, each translation has
 * to do so just as often, or a locale ends up promising a one-click connect
 * that business readers cannot complete.
 */
const ADMIN_CAVEAT = {
  en: /\bIT admin\b|admin approval/i,
  es: /administrador de TI|aprobaci[oó]n de un administrador/i,
  fr: /administrateur informatique|approbation de l.administrateur/i,
  nb: /IT-ansvarlig|administratorgodkjenning/i,
  zh: /IT 管理员|管理员批准/,
};

const localeFiles = (slug) =>
  readdirSync(join(translationsDir, slug))
    .sort()
    .map((file) => ({ locale: file.replace(/\.js$/, ''), path: join(translationsDir, slug, file) }));

const outlookLines = (source) =>
  contentOf(source)
    .split('\n')
    .filter((line) => line.includes('Outlook') || line.includes('Microsoft 365'));

const inProgressNotes = (source, locale) => {
  const pattern = IN_PROGRESS[locale];
  assert.ok(pattern, `no in-progress pattern for locale ${locale}`);
  return outlookLines(source).filter((line) => pattern.test(line));
};

const adminCaveats = (source, locale) => {
  const pattern = ADMIN_CAVEAT[locale];
  assert.ok(pattern, `no admin-caveat pattern for locale ${locale}`);
  return contentOf(source)
    .split('\n')
    .filter((line) => line.includes('Microsoft 365') && pattern.test(line));
};

const allPostSlugs = readdirSync(postsDir)
  .filter((file) => file.endsWith('.js'))
  .map((file) => file.replace(/\.js$/, ''))
  .sort();

for (const slug of allPostSlugs) {
  test(`${slug}: no locale still says Outlook cannot be connected`, () => {
    const files = [
      { locale: 'en', path: join(postsDir, `${slug}.js`) },
      ...(existsSync(join(translationsDir, slug)) ? localeFiles(slug) : []),
    ];

    for (const { locale, path } of files) {
      const stale = inProgressNotes(read(path), locale);
      assert.deepEqual(
        stale,
        [],
        `${path.slice(here.length + 1)} still says Outlook / Microsoft 365 is unavailable, but it launched: ${stale[0]?.slice(0, 160)}`,
      );
    }
  });
}

for (const slug of translatedSlugs) {
  test(`${slug}: every translation carries the Microsoft 365 admin-approval caveat as often as English`, () => {
    const english = adminCaveats(read(join(postsDir, `${slug}.js`)), 'en');

    for (const { locale, path } of localeFiles(slug)) {
      const translated = adminCaveats(read(path), locale);
      assert.equal(
        translated.length,
        english.length,
        `${slug}/${locale}.js carries ${translated.length} Microsoft 365 admin-approval caveat(s), English carries ${english.length}. ` +
          'A translation must not drop the work/school caveat or add one English does not make.',
      );
    }
  });
}

test('the Outlook guide is indexable now that the connector is live', () => {
  const source = read(join(postsDir, 'connect-outlook-microsoft-365-ai-agent-mcp.js'));
  assert.doesNotMatch(source, /noindex\s*:\s*true/, 'the Outlook guide is still flagged noindex');
});

// ---------------------------------------------------------------------------
// House style: no em dashes
// ---------------------------------------------------------------------------

/**
 * House rule is no em dashes, in any language. The rest of the blog corpus is
 * not clean yet (23 English posts and 72 translations still carry them), so
 * this pins the slugs that have been swept. Add a slug here as it is cleaned.
 */
const EM_DASH_CLEAN_SLUGS = ['connect-claude-to-email', 'connect-outlook-microsoft-365-ai-agent-mcp'];

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
