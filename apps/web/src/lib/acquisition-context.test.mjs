import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquisitionFromLocation,
  acquisitionFromParams,
  appendAcquisitionParams,
  isNewAccountSignup,
  safeLandingPath,
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
