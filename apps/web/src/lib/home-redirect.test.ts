import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cameFromThisSite, isHomePath, isSignedInHomeCandidate } from './home-redirect.ts';

const AUTH = 'sb-swvaxorwumispmjaaszb-auth-token';
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function candidate(
  path: string,
  { headers = {}, cookies = [AUTH], method = 'GET' }: { headers?: Record<string, string>; cookies?: string[]; method?: string } = {},
) {
  return isSignedInHomeCandidate({
    method,
    url: new URL(path, 'https://mcpemails.com'),
    headers: new Headers({ accept: HTML, 'sec-fetch-dest': 'document', ...headers }),
    cookieNames: cookies,
  });
}

test('home paths: root and locale roots only', () => {
  for (const p of ['/', '/nb', '/nb/', '/de', '/zh', '/fr', '/es']) assert.equal(isHomePath(p), true, p);
  for (const p of ['/pricing', '/nb/pricing', '/en', '/dashboard', '/blog', '/no', '/nbx']) assert.equal(isHomePath(p), false, p);
});

test('typed URL or bookmark with a session cookie is a candidate', () => {
  assert.equal(candidate('/'), true);
  assert.equal(candidate('/nb'), true);
  assert.equal(candidate('/', { cookies: [`${AUTH}.0`, `${AUTH}.1`] }), true);
});

test('arriving from a search engine or another site is a candidate', () => {
  assert.equal(candidate('/', { headers: { referer: 'https://www.google.com/' } }), true);
  assert.equal(candidate('/', { headers: { referer: 'https://chatgpt.com/' } }), true);
  // A look-alike domain is not this site.
  assert.equal(candidate('/', { headers: { referer: 'https://evilmcpemails.com/' } }), true);
});

test('coming from any page on the site keeps the homepage', () => {
  for (const ref of [
    'https://mcpemails.com/dashboard',
    'https://mcpemails.com/dashboard/settings',
    'https://mcpemails.com/pricing',
    'https://mcpemails.com/',
    'https://app.mcpemails.com/',
    'https://www.mcpemails.com/',
  ]) {
    assert.equal(candidate('/', { headers: { referer: ref } }), false, ref);
  }
});

test('no session cookie, other paths and non-GET are never candidates', () => {
  assert.equal(candidate('/', { cookies: [] }), false);
  assert.equal(candidate('/', { cookies: ['mcpe_sid', 'sb-x-auth-token-code-verifier'] }), false);
  assert.equal(candidate('/pricing'), false);
  assert.equal(candidate('/nb/pricing'), false);
  assert.equal(candidate('/blog'), false);
  assert.equal(candidate('/', { method: 'POST' }), false);
  assert.equal(candidate('/', { method: 'HEAD' }), false);
});

test('client-side navigations, prefetches and subresources are skipped', () => {
  // Next's router fetch: Accept is the flight type, Sec-Fetch-Dest is empty.
  assert.equal(candidate('/', { headers: { accept: 'text/x-component', 'sec-fetch-dest': 'empty' } }), false);
  assert.equal(candidate('/', { headers: { accept: '*/*' } }), false);
  assert.equal(candidate('/', { headers: { accept: '' } }), false);
  assert.equal(candidate('/', { headers: { 'sec-fetch-dest': 'empty' } }), false);
  assert.equal(candidate('/', { headers: { 'sec-fetch-dest': 'iframe' } }), false);
  // An older browser without Sec-Fetch-* still qualifies on Accept alone.
  assert.equal(
    isSignedInHomeCandidate({ method: 'GET', url: new URL('https://mcpemails.com/'), headers: new Headers({ accept: HTML }), cookieNames: [AUTH] }),
    true,
  );
});

test('auth flow params and ?home keep the homepage', () => {
  for (const q of ['?code=abc', '?token_hash=x', '?error=access_denied', '?error_description=x', '?home', '?home=1']) {
    assert.equal(candidate(`/${q}`), false, q);
  }
  // Ordinary tracking params do not.
  assert.equal(candidate('/?utm_source=chatgpt.com'), true);
});

test('cameFromThisSite ignores junk referers', () => {
  const url = new URL('https://mcpemails.com/');
  assert.equal(cameFromThisSite(null, url), false);
  assert.equal(cameFromThisSite('not a url', url), false);
  assert.equal(cameFromThisSite('http://localhost:3000/dashboard', new URL('http://localhost:3000/')), true);
});
