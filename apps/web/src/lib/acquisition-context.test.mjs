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
    source: 'organic_google', landing: 'blog', landingPath: '/blog/connect-claude-to-email',
    locale: 'fr', referrer: 'organic_google', utmSource: 'organic_google',
    utmMedium: 'paid_search', utmCampaign: 'launch',
  });
  assert.equal(JSON.stringify(value).includes('user-123'), false);
});

test('rejects auth, query and unknown route detail from landing path', () => {
  assert.equal(safeLandingPath('/signup/private-address'), '/other');
  assert.equal(safeLandingPath('/blog/a-safe-slug'), '/blog/a-safe-slug');
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
    fileURLToPath(new URL('../../../../supabase/migrations/20260915190000_widen_acquisition_sources.sql', import.meta.url)),
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
