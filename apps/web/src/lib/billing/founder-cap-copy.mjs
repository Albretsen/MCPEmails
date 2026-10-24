/**
 * The inbox-cap offer's copy while the Business founder price is open.
 *
 * The normal Business cap copy quotes $39 in its own words ("Business includes
 * 10 for $39 a month", "Upgrade to Business, $39/mo"). While the founder price
 * is attached to the price map (`stripePrices.pro.founder`, see
 * src/lib/stripe/founder-offer.ts) those sentences would quote a price
 * checkout no longer charges, so the Business offer switches to founder keys:
 * a body without a price (the founder line under it carries the amounts) and a
 * buy label that takes the founder price as a value.
 *
 * Any other offer, or no founder line, returns the offer's own keys and a null
 * price, so a caller can use this unconditionally.
 *
 * @param {{ plan: string, bodyKey: string, ctaKey: string, noticeBodyKey: string, noticeCtaKey?: string }} offer
 * @param {{ pro?: { founder?: { monthlyCents: number } } } | null | undefined} stripePrices
 */
export function founderCapCopy(offer, stripePrices) {
  const founder = offer?.plan === 'pro' ? stripePrices?.pro?.founder ?? null : null;
  if (!founder) {
    return {
      founder: null,
      bodyKey: offer.bodyKey,
      ctaKey: offer.ctaKey,
      noticeBodyKey: offer.noticeBodyKey,
      noticeCtaKey: offer.noticeCtaKey ?? offer.offers?.[0]?.noticeCtaKey ?? null,
    };
  }
  return {
    founder,
    bodyKey: 'connect.businessCapBodyFounder',
    ctaKey: 'connect.businessCapCtaFounder',
    noticeBodyKey: 'inboxes.capBodyProCapFounder',
    noticeCtaKey: 'inboxes.capCtaBusinessFounder',
  };
}
