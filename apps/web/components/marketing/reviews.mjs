/**
 * Customer reviews shown on the home page.
 *
 * These are real, attributable endorsements from named people, quoted
 * VERBATIM. That is the whole value of the section, so three rules hold:
 *
 *  1. Never edit a quote for tone, length or grammar. Trim only with an
 *     explicit ellipsis, and never in a way that changes the meaning.
 *  2. Never translate them. next-intl carries the section chrome (eyebrow,
 *     heading, sub) in messages/<locale>/home.json; the quotes themselves stay
 *     in the language the reviewer wrote them in, the way every review platform
 *     displays them.
 *  3. Never invent one. This array is also the source for the Review /
 *     aggregateRating structured data emitted by `reviewsJsonLd` in
 *     src/i18n/seo.ts, so a fabricated entry would be a fabricated
 *     machine-readable claim.
 *
 * Adding a review: append an object here. The section is a scroller, so the
 * layout already handles any number of them, and the rating summary and the
 * structured data both recompute from this array.
 *
 * @typedef {object} Review
 * @property {string}  id        Stable slug, used as the React key.
 * @property {string}  quote     The review body, verbatim.
 * @property {string}  [pullQuote] One sentence of `quote`, for the compact
 *   proof bar high on the home page. MUST be a character-for-character slice
 *   of `quote` (enforced by `pullQuotesAreVerbatim`, covered by
 *   reviews.test.mjs). Pick a whole sentence: a mid-sentence trim needs an
 *   explicit ellipsis and usually reads worse than picking a different one.
 * @property {number}  rating    Stars the reviewer actually gave, 1-5.
 * @property {string}  author    The reviewer's name, as they publish it.
 * @property {string}  [role]    Their role, e.g. "Founder".
 * @property {string}  [company] Their company.
 * @property {string}  [url]     Their site. Rendered as a link on the company.
 * @property {string}  [date]    ISO date (YYYY-MM-DD) the review was left.
 * @property {'google'} source   Where it was published.
 * @property {string}  [sourceUrl] Public permalink to this one review. Its
 *   presence is what turns the source badge into a link, so it must open the
 *   review itself: a link to a listing the review is merely somewhere inside
 *   is worse than no link, and belongs left off.
 */

/**
 * Where a review can come from.
 *
 * Google is simply the first one; the card is written against this table, not
 * against Google, so a second platform is a key here plus a `source` on the
 * review. `icon` is optional and names an entry in MarketingPrimitives' `MI`
 * map: a source with no brand glyph falls back to its `short` label as text,
 * which is why adding a platform never blocks on drawing a logo first.
 */
export const REVIEW_SOURCES = {
  google:      { label: 'Google',      short: 'Google',  icon: 'google' },
  github:      { label: 'GitHub',      short: 'GitHub',  icon: 'github' },
  producthunt: { label: 'Product Hunt', short: 'PH' },
  g2:          { label: 'G2',          short: 'G2' },
  trustpilot:  { label: 'Trustpilot',  short: 'Trustpilot' },
  linkedin:    { label: 'LinkedIn',    short: 'LinkedIn' },
  x:           { label: 'X',           short: 'X' },
  /**
   * A review sent to us directly (email, DM) and published with the
   * reviewer's permission. It has no public permalink, so it carries no
   * `sourceUrl` and the card says so rather than implying a platform vouched
   * for it.
   */
  direct:      { label: 'Sent to us directly', short: 'Direct' },
};

/** @type {Review[]} */
export const REVIEWS = [
  {
    id: 'torstein-vikse',
    // Verbatim, including "MCPemails" and the lower-case "claude". Do not
    // tidy the spelling: it is his sentence, not ours.
    quote:
      'MCPemails has made my business 10x more efficient. Being able to connect all our emails into one MCP was a game changer. Now I can only ask claude to handle everything. Highly recommended!',
    // The mechanism sentence rather than the "10x" one: this page earns trust
    // through precision, and above the fold a superlative reads as marketing
    // while this reads as a description a buyer can evaluate.
    pullQuote: 'Being able to connect all our emails into one MCP was a game changer.',
    rating: 5,
    // Google shows him as "Torstein". The full name and company are how he
    // publishes himself (vikse.dev), and he sent us that page alongside the
    // review, so the attribution is his own and checkable.
    author: 'Torstein Vikse',
    role: 'Founder',
    company: 'Vikse Development AS',
    url: 'https://vikse.dev/',
    // Google publishes no exact timestamp on a review, only "3 days ago" as
    // read on 2026-09-16.
    date: '2026-09-13',
    source: 'google',
    // The permalink Maps' own "Share" gives for this one review. It opens the
    // review by itself rather than the place page, which is the whole point:
    // the Google mark in the proof bar has to land a reader on exactly the
    // sentence quoted above it, not on a listing they then have to search.
    // Verified 2026-09-16 in a browser with no Google session, so it is a
    // public URL and not a signed-in-owner view.
    //
    // This is what share.google/9ynsnfJM4kFzLXDuo resolves to, with Google's
    // own share-surface tracking (`source`, `kgs`, `utm_source`) dropped and
    // nothing else touched. The long opaque id IS the review, and
    // 0x0:0x40013a8d36c2b552 is the place, the CID in every Maps URL for MCP
    // Emails. `hl=en-US` is deliberate even though the site is served in five
    // languages: it makes Google show the English the reviewer actually wrote,
    // which is the text quoted verbatim on this page. Drop it and a Norwegian
    // reader gets a machine translation of a quote we present as his words.
    //
    // (The comment this replaces said no permalink existed. That was true on
    // 2026-09-16 only because the reviews were still held by Google's filter;
    // they republished the same day. See the reviews-withheld note.)
    sourceUrl:
      'https://www.google.com/maps/reviews/data=!4m8!14m7!1m6!2m5!1sCi9DQUlRQUNvZENodHljRjlvT2s5RGNWbEllazFaYUZOblNWQnBVM1puVFZZNFNtYxAB!2m1!1s0x0:0x40013a8d36c2b552!3m1!1s2@1:CAIQACodChtycF9oOk9DcVlIek1ZaFNnSVBpU3ZnTVY4Smc%7C%7C?hl=en-US',
  },
];

/** Initials for the monogram avatar: "Torstein Vikse" -> "TV". */
export function initialsOf(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/**
 * Mean rating and count over the reviews the page actually renders.
 *
 * Deliberately computed from REVIEWS rather than read off the Google profile:
 * the summary a visitor sees, and the aggregateRating we emit, must both
 * describe exactly the reviews on the page. (Google's profile currently counts
 * three 5-star reviews but renders none of their bodies anywhere, so their
 * count is not something this page can show or substantiate.)
 */
export function reviewSummary(reviews = REVIEWS) {
  const count = reviews.length;
  if (!count) return { count: 0, average: 0 };
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return { count, average: Math.round((sum / count) * 10) / 10 };
}

/**
 * The review featured in the compact proof bar near the top of the home page,
 * or null when none is marked.
 *
 * Only one review is featured at a time: the bar exists to put a single strong
 * sentence in front of visitors who never scroll as far as the full scroller,
 * so a second one there would defeat the point. The first review carrying a
 * `pullQuote` wins, which makes promoting a different one a one-line edit.
 */
export function featuredReview(reviews = REVIEWS) {
  return reviews.find((r) => r.pullQuote) ?? null;
}

/**
 * True when every `pullQuote` is a verbatim slice of its own review body.
 *
 * This is the one place a published quote could quietly become a misquote:
 * the bar shows an excerpt, the card shows the whole thing, and nothing but
 * this check stops the two from drifting apart after an innocent copy edit.
 * reviews.test.mjs asserts it.
 */
export function pullQuotesAreVerbatim(reviews = REVIEWS) {
  return reviews.every((r) => !r.pullQuote || r.quote.includes(r.pullQuote));
}

/**
 * How many reviews it takes before the full scroller is worth showing.
 *
 * Below this the section is not rendered at all. One or two testimonials laid
 * out as a whole section with a "1 review" counter reads as thin rather than
 * as proof, and invites exactly the question you do not want asked. The proof
 * bar still runs, because a single quoted sentence in a slim strip makes no
 * claim about volume.
 *
 * Nothing needs editing when the third review lands: append it to REVIEWS and
 * the section, its anchor, and the "read the full review" link all appear.
 */
export const MIN_LISTED_REVIEWS = 3;

/** Whether the full `Reviews` scroller (and its `#reviews` anchor) renders. */
export function reviewsAreListed(reviews = REVIEWS) {
  return reviews.length >= MIN_LISTED_REVIEWS;
}

/**
 * Exactly the review text the page puts in front of a visitor, as `body`.
 *
 * Structured data is built from this and not from REVIEWS, because below
 * MIN_LISTED_REVIEWS the only review on the page is the featured excerpt in the
 * proof bar. Emitting full bodies, or a count, for reviews nobody can read
 * would be the "marked up content is not visible" problem in Google's
 * guidelines, and more to the point it would not be true.
 */
export function publishedReviews(reviews = REVIEWS) {
  if (reviewsAreListed(reviews)) {
    return reviews.map((r) => ({ ...r, body: r.quote }));
  }
  const featured = featuredReview(reviews);
  return featured ? [{ ...featured, body: featured.pullQuote }] : [];
}
