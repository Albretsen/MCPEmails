import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blogPostCanonicalLocale,
  blogPostLanguageAlternates,
} from './seo.mjs';

const url = (locale, path) => `https://example.test${locale === 'en' ? '' : `/${locale}`}${path}`;

test('blog hreflang contains only real translations plus x-default', () => {
  assert.deepEqual(
    blogPostLanguageAlternates(['en', 'fr'], '/blog/a-post', url),
    {
      en: 'https://example.test/blog/a-post',
      fr: 'https://example.test/fr/blog/a-post',
      'x-default': 'https://example.test/blog/a-post',
    },
  );
});

test('fallback content canonicalizes structured data to English', () => {
  assert.equal(blogPostCanonicalLocale({ translated: false }, 'fr'), 'en');
  assert.equal(blogPostCanonicalLocale({ translated: true }, 'fr'), 'fr');
});
