import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  SOURCES,
  acquisitionFromLocation,
  acquisitionFromParams,
  appendAcquisitionParams,
  isNewAccountSignup,
  landingFromPath,
  safeLandingPath,
  sourceFromHost,
  sourceFromUtm,
} from './acquisition-context.mjs';

test('captures public landing, locale and coarse UTM buckets without raw query values', () => {
  const value = acquisitionFromLocation(
    new URL('https://mcpemails.com/fr/blog/connect-claude-to-email?utm_source=google&utm_medium=cpc&utm_campaign=summer-launch-user-123'),
    new URL('https://www.google.com/search?q=private'),
  );
  assert.deepEqual(value, {
    source: 'google_ads', landing: 'blog', landingPath: '/blog/connect-claude-to-email',
    locale: 'fr', referrer: 'organic_google', utmSource: 'google_ads',
    utmMedium: 'paid_search', utmCampaign: 'launch',
  });
  assert.equal(JSON.stringify(value).includes('user-123'), false);
});

/* ------------------------------------------------------- Google Ads */

// An ad click carries google.com as its referrer, exactly like an organic
// result. Counting it as organic_google would flatter the SEO channel with
// paid traffic and leave the ad test with nothing to read.
test('an auto-tagged ad click is google_ads, and the click id is not kept', () => {
  const value = acquisitionFromLocation(
    new URL('https://mcpemails.com/connect/fastmail?gclid=Cj0KCQjw-secret-click-id'),
    new URL('https://www.google.com/'),
  );
  assert.equal(value.source, 'google_ads');
  assert.equal(value.referrer, 'organic_google');
  assert.equal(value.utmSource, null);
  assert.equal(value.utmMedium, 'paid_search');
  assert.equal(value.landingPath, '/connect/fastmail');
  assert.equal(JSON.stringify(value).includes('secret'), false);
});

test('iOS click ids (gbraid, wbraid) count as ad clicks too', () => {
  for (const key of ['gbraid', 'wbraid']) {
    const value = acquisitionFromLocation(new URL(`https://mcpemails.com/?${key}=x`), new URL('https://www.google.com/'));
    assert.equal(value.source, 'google_ads', key);
  }
});

test('utm_source=google_ads is google_ads without a click id', () => {
  const value = acquisitionFromLocation(
    new URL('https://mcpemails.com/blog/connect-claude-to-email?utm_source=google_ads&utm_medium=cpc&utm_campaign=claude'),
    null,
  );
  assert.equal(value.source, 'google_ads');
  assert.equal(value.utmSource, 'google_ads');
  assert.equal(value.utmMedium, 'paid_search');
});

test('an organic Google visit stays organic_google', () => {
  const value = acquisitionFromLocation(new URL('https://mcpemails.com/connect/yahoo'), new URL('https://www.google.com/'));
  assert.equal(value.source, 'organic_google');
  assert.equal(value.utmMedium, null);
  assert.equal(sourceFromUtm('google'), 'organic_google');
  assert.equal(sourceFromUtm('googleads'), 'google_ads');
  assert.equal(sourceFromUtm('adwords'), 'google_ads');
});

test('rejects auth, query and unknown route detail from landing path', () => {
  assert.equal(safeLandingPath('/signup/private-address'), '/other');
  assert.equal(safeLandingPath('/blog/a-safe-slug'), '/blog/a-safe-slug');
});

/* ---------------------------------------------------- landing page paths */

// Stored as `/other` until 2026-10-04, which hid whether the persona and
// comparison pages produce customers.
const NEW_LANDING_PATHS = [
  '/for/business', '/for/founders', '/best-email-mcp-servers', '/email-mcp-servers-compared',
  '/connect', '/about', '/changelog',
];
const ALREADY_KEPT_LANDING_PATHS = [
  '/', '/blog', '/blog/a-safe-slug', '/connect/fastmail', '/docs', '/docs/clients', '/docs/providers',
  '/pricing', '/security', '/self-hosting', '/native-connectors-vs-mcp',
];
// Look-alikes, app and auth routes, and anything carrying free text.
const REFUSED_LANDING_PATHS = [
  '/for', '/for/', '/for/business/extra', '/for/Business', '/for/../admin', '/for/business?plan=pro',
  '/for/business#pricing', '/for/busi ness', '/for/business%2Fextra', '/for/jane@example.com',
  '/for//business', '/forbusiness', '/x/for/business',
  '/best-email-mcp-servers/extra', '/Best-Email-MCP-Servers', '/best-email-mcp-servers?q=1',
  '/about/team', '/About', '/changelog/2026-10-03', '/connect/a/b',
  '/signup', '/login', '/dashboard', '/admin/growth', '/auth/callback', '/authorize', '/invite/abc',
  '/privacy', '/terms', '/status',
];

test('persona, comparison and hub pages keep their own landing path', () => {
  for (const path of NEW_LANDING_PATHS) {
    assert.equal(safeLandingPath(path), path, path);
  }
});

test('a locale prefix is stripped from the new landing paths, as for every other page', () => {
  for (const locale of ['nb', 'es', 'fr', 'zh']) {
    for (const path of NEW_LANDING_PATHS) {
      assert.equal(safeLandingPath(`/${locale}${path}`), path, `/${locale}${path}`);
      assert.equal(safeLandingPath(`/${locale}${path}/`), path, `/${locale}${path}/`);
    }
  }
  // `en` is the unprefixed locale, so /en/... is not one of our routes.
  assert.equal(safeLandingPath('/en/for/business'), '/other');
  // A locale appearing twice is not a locale prefix.
  assert.equal(safeLandingPath('/nb/nb/for/business'), '/other');
});

test('a trailing slash is dropped, never stored', () => {
  for (const path of NEW_LANDING_PATHS) {
    assert.equal(safeLandingPath(`${path}/`), path, `${path}/`);
  }
  assert.equal(safeLandingPath('/pricing/'), '/pricing');
  assert.equal(safeLandingPath('/for/business//'), '/other');
});

test('look-alikes, app routes and free text still collapse to /other', () => {
  for (const input of REFUSED_LANDING_PATHS) {
    assert.equal(safeLandingPath(input), '/other', input);
  }
});

test('paths that were already kept are unchanged', () => {
  for (const path of ALREADY_KEPT_LANDING_PATHS) {
    assert.equal(safeLandingPath(path), path, path);
  }
});

test('a real visit to a persona page is recorded with its path and no query detail', () => {
  const value = acquisitionFromLocation(
    new URL('https://mcpemails.com/nb/for/business/?utm_source=linkedin&ref=jane@example.com#pricing'),
    new URL('https://www.linkedin.com/feed/'),
  );
  assert.equal(value.landingPath, '/for/business');
  assert.equal(value.locale, 'nb');
  assert.equal(value.source, 'linkedin');
  // The coarse category is deliberately left alone: these pages stay `other`
  // there, and the path column is what tells them apart.
  assert.equal(value.landing, 'other');
  assert.equal(landingFromPath('/best-email-mcp-servers'), 'other');
  assert.equal(JSON.stringify(value).includes('jane'), false);
});

test('the new paths survive the OAuth query round trip unchanged', () => {
  for (const path of NEW_LANDING_PATHS) {
    const params = new URLSearchParams();
    appendAcquisitionParams(params, { source: 'direct', landing: 'other', landingPath: path, locale: 'en', referrer: 'direct' });
    assert.equal(acquisitionFromParams(params).landingPath, path, path);
  }
  // A hand-edited callback URL cannot smuggle anything else in.
  const forged = new URLSearchParams({ acq: 'direct', landing_path: '/for/business/../../admin?x=1' });
  assert.equal(acquisitionFromParams(forged).landingPath, '/other');
});

test('query transport round trips only validated categories', () => {
  const params = new URLSearchParams();
  appendAcquisitionParams(params, {
    source: 'reddit', landing: 'home', landingPath: '/', locale: 'nb', referrer: 'reddit',
    utmSource: null, utmMedium: 'social', utmCampaign: 'community',
  });
  assert.deepEqual(acquisitionFromParams(params), {
    source: 'reddit', landing: 'home', landingPath: '/', locale: 'nb', referrer: 'reddit',
    utmSource: null, utmMedium: 'social', utmCampaign: 'community',
  });
});

test('only an account created by this exchange is treated as a signup', () => {
  const now = Date.parse('2026-08-31T12:00:00Z');
  // The account Supabase just created during this OAuth callback.
  assert.equal(isNewAccountSignup('2026-08-31T11:59:59Z', now), true);
  // A returning user who signed up before attribution shipped: their workspace
  // still has a NULL source, and stamping it now would record a false first touch.
  assert.equal(isNewAccountSignup('2026-06-24T09:00:00Z', now), false);
  // Clock skew in either direction stays inside the window.
  assert.equal(isNewAccountSignup('2026-08-31T12:00:30Z', now), true);
  assert.equal(isNewAccountSignup('2026-08-31T11:55:00Z', now), false);
  // Missing or unparseable timestamps must never count as a signup.
  assert.equal(isNewAccountSignup(null, now), false);
  assert.equal(isNewAccountSignup('not-a-date', now), false);
});

/* ------------------------------------------------------- referrer hosts */

test('every allowlisted directory, AI client and search engine gets its own bucket', () => {
  // The whole point of the 2026-09-15 widening: these all used to be `other`,
  // which is where the answer to "which listing sends buyers" was hiding.
  const expected = {
    'claude.ai': 'claude',
    'anthropic.com': 'claude',
    'chatgpt.com': 'chatgpt',
    'chat.openai.com': 'chatgpt',
    'openai.com': 'chatgpt',
    'perplexity.ai': 'perplexity',
    'lobehub.com': 'lobehub',
    'pulsemcp.com': 'pulsemcp',
    'mcpservers.org': 'mcpservers',
    'mcp.so': 'mcp_so',
    'freemcp.space': 'freemcp',
    'x.com': 'x_twitter',
    'twitter.com': 'x_twitter',
    't.co': 'x_twitter',
    'news.ycombinator.com': 'hacker_news',
    'linkedin.com': 'linkedin',
    'lnkd.in': 'linkedin',
    'bing.com': 'organic_bing',
    'duckduckgo.com': 'organic_duckduckgo',
    'google.com': 'organic_google',
    'reddit.com': 'reddit',
    'github.com': 'github',
    'smithery.ai': 'smithery',
    'glama.ai': 'glama',
    'cursor.com': 'cursor',
  };
  for (const [host, source] of Object.entries(expected)) {
    assert.equal(sourceFromHost(host), source, host);
    assert.equal(SOURCES.has(source), true, source);
  }
});

test('the Cursor listing lives on cursor.directory, not on cursor.com', () => {
  // Matching only cursor.com filed every referral from the listing as `other`.
  assert.equal(sourceFromHost('cursor.directory'), 'cursor');
  assert.equal(sourceFromHost('www.cursor.directory'), 'cursor');
});

test('host matching stays exact-or-subdomain, case-insensitive, trailing dot stripped', () => {
  assert.equal(sourceFromHost('WWW.LobeHub.COM'), 'lobehub');
  assert.equal(sourceFromHost('mcp.so.'), 'mcp_so');
  assert.equal(sourceFromHost('go.pulsemcp.com'), 'pulsemcp');
  // A lookalike that merely ends with the string must not match: only a real
  // subdomain (dot-prefixed) or the domain itself counts.
  assert.equal(sourceFromHost('notlobehub.com'), 'other');
  assert.equal(sourceFromHost('reddit.com.evil.example'), 'other');
});

test('an unknown host is still bucketed as other, never stored raw', () => {
  assert.equal(sourceFromHost('some-random-blog.example'), 'other');
  assert.equal(sourceFromHost('mail.internal.example.org'), 'other');
});

test('utm_source recognises the same names by substring', () => {
  assert.equal(sourceFromUtm('LobeHub'), 'lobehub');
  assert.equal(sourceFromUtm('mcp.so'), 'mcp_so');
  assert.equal(sourceFromUtm('mcpservers.org'), 'mcpservers');
  assert.equal(sourceFromUtm('freemcp.space'), 'freemcp');
  assert.equal(sourceFromUtm('anthropic'), 'claude');
  assert.equal(sourceFromUtm('openai-directory'), 'chatgpt');
  assert.equal(sourceFromUtm('cursor.directory'), 'cursor');
  assert.equal(sourceFromUtm('hackernews'), 'hacker_news');
  assert.equal(sourceFromUtm('twitter'), 'x_twitter');
  assert.equal(sourceFromUtm('lnkd.in'), 'linkedin');
  assert.equal(sourceFromUtm('duckduckgo'), 'organic_duckduckgo');
  // A bare `x` needle would match nearly every string, so X is only ever
  // recognised through twitter, x.com and t.co.
  assert.equal(sourceFromUtm('mailbox'), 'other');
  assert.equal(sourceFromUtm(''), null);
  assert.equal(sourceFromUtm(null), null);
});

/**
 * The regression that paid for this test: ChatGPT stamps
 * `utm_source=chatgpt.com` onto the links it surfaces, "chatgp{t.co}m"
 * contains the `t.co` needle, and `t.co` is tried first, so from 2026-09-15 to
 * 09-17 every ChatGPT signup was filed as X and `chatgpt` held zero rows. The
 * needles above are ordered so that none contains another, which is a check on
 * the LIST; these are the checks on the VALUE.
 */
test('a needle buried inside a longer word is not a match', () => {
  assert.equal(sourceFromUtm('chatgpt.com'), 'chatgpt');
  assert.equal(sourceFromUtm('mailbox.com'), 'other');
  assert.equal(sourceFromUtm('inbox.com'), 'other');
  assert.equal(sourceFromUtm('contact.com'), 'other');
  assert.equal(sourceFromUtm('linux.com'), 'other');
});

test('a name still matches where a label can start', () => {
  // Left-anchored, not whole-word: loose matching is the point of this table.
  assert.equal(sourceFromUtm('chatgptplugin'), 'chatgpt');
  assert.equal(sourceFromUtm('chat.openai.com'), 'chatgpt');
  assert.equal(sourceFromUtm('www.x.com'), 'x_twitter');
  assert.equal(sourceFromUtm('t.co/aBc123'), 'x_twitter');
  assert.equal(sourceFromUtm('twitter.com'), 'x_twitter');
  assert.equal(sourceFromUtm('news.ycombinator.com'), 'hacker_news');
});

/* --------------------------------------------------------- SQL/JS drift */

/**
 * The allowlist exists twice: here, and in the migration that pins the three
 * CHECK constraints and the signup trigger. Postgres cannot import the JS set
 * and the browser cannot query the constraint, so the only thing standing
 * between the two copies is this test. A name added on one side and not the
 * other is not a soft failure: the CHECK rejects the signup write, or the
 * trigger silently NULLs the value, which is how 168 signups lost their
 * attribution in August with nothing in CI noticing.
 */
test('the SQL allowlists and the JS SOURCES set hold exactly the same members', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../../../supabase/migrations/20260929190000_acquisition_source_google_ads.sql', import.meta.url)),
    'utf8',
  );

  // Every `IN ( ... )` list in that migration that mentions 'direct' is an
  // acquisition-source allowlist: three CHECK constraints plus the trigger's
  // three guards.
  const lists = [...sql.matchAll(/IN \(([^)]*)\)/g)]
    .map((match) => match[1].match(/'([a-z_]+)'/g)?.map((quoted) => quoted.slice(1, -1)) ?? [])
    .filter((members) => members.includes('direct'));

  assert.ok(lists.length >= 6, `expected at least 6 allowlists in the migration, found ${lists.length}`);
  for (const members of lists) {
    assert.deepEqual([...members].sort(), [...SOURCES].sort());
  }
});

/* ------------------------------------------------ landing paths, SQL/JS */

const LANDING_PATH_MIGRATION = '20261005113000_attribute_business_landing_pages.sql';
const PREVIOUS_TRIGGER_MIGRATION = '20260929190000_acquisition_source_google_ads.sql';

function migration(name) {
  return readFileSync(fileURLToPath(new URL(`../../../../supabase/migrations/${name}`, import.meta.url)), 'utf8');
}

/** Every landing-path pattern in a migration, comment lines excluded. */
function landingPathPatterns(sql) {
  const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  return [...code.matchAll(/'(\^\/\(\|other\|[^']*\$)'/g)].map((match) => match[1]);
}

test('the CHECK constraint and the signup trigger pin one and the same landing-path pattern', () => {
  const patterns = landingPathPatterns(migration(LANDING_PATH_MIGRATION));
  // One in the CHECK constraint, one in handle_new_user(). If they differ, a
  // path passes one and is rejected or NULLed by the other.
  assert.equal(patterns.length, 2);
  assert.equal(patterns[0], patterns[1]);
});

test('the database accepts every landing path the JS emits, and nothing the JS refuses', () => {
  // The pattern uses only syntax that means the same in POSIX and JS regex.
  const sqlPattern = new RegExp(landingPathPatterns(migration(LANDING_PATH_MIGRATION))[0]);

  for (const path of [...NEW_LANDING_PATHS, ...ALREADY_KEPT_LANDING_PATHS, '/other']) {
    assert.equal(safeLandingPath(path), path, path);
    assert.equal(sqlPattern.test(path), true, `database rejects ${path}`);
  }
  // What the JS collapses to /other must not be storable by another route
  // either: the trigger reads signup metadata the browser controls.
  for (const input of REFUSED_LANDING_PATHS) {
    assert.equal(sqlPattern.test(input), false, `database accepts ${input}`);
  }
});

/**
 * The trap this repo has already fallen into once: handle_new_user() can only
 * be changed by replacing its whole body, and a body retyped from a stale copy
 * silently dropped attribution for 168 signups. The new migration must be the
 * previous newest definition with the landing-path line changed and nothing
 * else.
 */
test('the redefined signup trigger differs from the previous one in the landing-path line only', () => {
  const body = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.handle_new_user()')).split('\n');
  const before = body(migration(PREVIOUS_TRIGGER_MIGRATION));
  const after = body(migration(LANDING_PATH_MIGRATION));

  assert.equal(after.length, before.length);
  const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
  assert.equal(changed.length, 1);
  assert.match(before[changed[0]], /^ {2}IF v_landing_path !~ /);
  assert.match(after[changed[0]], /^ {2}IF v_landing_path !~ .* THEN v_landing_path := NULL; END IF;$/);
});