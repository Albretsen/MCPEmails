import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_LISTED_REVIEWS,
  REVIEWS,
  REVIEW_SOURCES,
  featuredReview,
  initialsOf,
  publishedReviews,
  pullQuotesAreVerbatim,
  reviewsAreListed,
  reviewSummary,
} from './reviews.mjs';

/**
 * These are published quotes from named people, and two of them render in two
 * places at once (the excerpt in the proof bar, the whole thing in the
 * scroller). The tests below are the guard on the claims themselves, not on
 * the layout: a misquote, an invented rating, or an excerpt that drifts from
 * the source is the failure mode worth catching in CI.
 */

test('every pull quote is a verbatim slice of its own review', () => {
  assert.equal(pullQuotesAreVerbatim(), true);
  // Guard the guard: a doctored excerpt must actually fail.
  assert.equal(
    pullQuotesAreVerbatim([{ quote: 'a b c', pullQuote: 'a d' }]),
    false,
  );
});

test('the featured review is the first one carrying a pull quote', () => {
  const featured = featuredReview();
  if (featured) assert.ok(featured.pullQuote.length > 0);
  assert.equal(featuredReview([{ quote: 'x' }]), null);
  assert.equal(
    featuredReview([{ quote: 'x' }, { id: 'b', quote: 'y z', pullQuote: 'y' }]).id,
    'b',
  );
});

test('every review is attributable and plausibly rated', () => {
  const ids = new Set();
  for (const r of REVIEWS) {
    assert.ok(r.id && !ids.has(r.id), `duplicate or missing id: ${r.id}`);
    ids.add(r.id);
    assert.ok(r.quote.trim().length > 0, `${r.id} has no quote`);
    assert.ok(
      Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5,
      `${r.id} has a rating outside 1-5`,
    );
    assert.ok(r.author.trim().length > 0, `${r.id} is unattributed`);
    assert.ok(REVIEW_SOURCES[r.source], `${r.id} has an unknown source`);
    if (r.date) {
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.id} has a non-ISO date`);
    }
  }
});

test('the summary describes exactly the reviews on the page', () => {
  assert.deepEqual(reviewSummary([]), { count: 0, average: 0 });
  assert.deepEqual(reviewSummary([{ rating: 5 }, { rating: 4 }]), {
    count: 2,
    average: 4.5,
  });
  // One decimal place, so `average.toFixed(1)` in the UI and `ratingValue` in
  // the structured data cannot disagree.
  assert.deepEqual(
    reviewSummary([{ rating: 5 }, { rating: 4 }, { rating: 4 }]),
    { count: 3, average: 4.3 },
  );
});

test('initials come from the first two names', () => {
  assert.equal(initialsOf('Torstein Vikse'), 'TV');
  assert.equal(initialsOf('Torstein'), 'T');
  assert.equal(initialsOf('  ada  b  lovelace '), 'AB');
});

test('the scroller only lists once there are enough reviews', () => {
  const stub = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, quote: 'q', rating: 5 }));
  assert.equal(reviewsAreListed(stub(MIN_LISTED_REVIEWS - 1)), false);
  assert.equal(reviewsAreListed(stub(MIN_LISTED_REVIEWS)), true);
});

test('structured data only ever claims what the page renders', () => {
  const featured = { id: 'a', quote: 'One. Two.', pullQuote: 'One.', rating: 5 };
  const other = { id: 'b', quote: 'Three.', rating: 4 };

  // Below the threshold only the proof bar renders, and only its excerpt.
  const hidden = publishedReviews([featured, other]);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].body, 'One.');

  // At the threshold the scroller renders every review in full.
  const shown = publishedReviews([featured, other, { id: 'c', quote: 'Four.', rating: 5 }]);
  assert.equal(shown.length, 3);
  assert.deepEqual(shown.map((r) => r.body), ['One. Two.', 'Three.', 'Four.']);
});
