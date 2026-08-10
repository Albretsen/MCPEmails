import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquisitionFromLocation,
  acquisitionFromParams,
  appendAcquisitionParams,
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
