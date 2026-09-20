/**
 * Which plan an inbox-cap block should sell, and the copy keys that sell it.
 *
 * EXTRACTED, NOT INVENTED. This decision used to live inline in ConnectModal,
 * where it was the only thing in the product that knew how to price a blocked
 * connect. That was fine while the modal was the only surface carrying the
 * offer. It is not fine now that the offer also has to survive the modal being
 * closed (see the cap notice on the Inboxes page), because two surfaces quoting
 * two different plans for the same block is worse than either surface alone: a
 * user reads $5 in the modal, closes it, sees $15 on the page behind, and now
 * neither number is trustworthy.
 *
 * THE RULE: the cheapest plan that actually clears the cap that was just hit.
 * Free stops at one inbox, so Personal (three, $5) clears it, and sending
 * someone to $15 Pro to add a second mailbox prices the upgrade far above the
 * problem. Personal itself stops at three, so from there only Pro (unlimited)
 * is a way forward, and offering Personal to a Personal subscriber would sell
 * them the plan they are already on.
 *
 * Keyed off the CAP rather than off a plan id, because the cap is the server's
 * own number, counted at the moment of the refusal, so it stays right even when
 * the plan changed in another tab. An unknown cap means the Free assumption,
 * which is what the "connects one inbox" heading already says.
 *
 * The grandfathered cohort has no cap at all and never reaches either surface,
 * so nobody holding unlimited inboxes can be routed at Personal from here.
 *
 * THE ONE EXCEPTION: A BUSINESS-SHAPED FREE WORKSPACE IS SHOWN BOTH.
 * "Cheapest plan that clears the cap" assumes the person wants ONE more
 * mailbox. Measured on production on 2026-09-20, that is true of a consumer and
 * false of the buyer who actually pays: one operator running several company
 * mailboxes (info@, sales@, invoices@ on one domain), holding four to nine on
 * Pro. A workspace with a mailbox on a business domain converts at this paywall
 * at about 22%, against under 2% for a consumer one, and it was being shown
 * Personal alone. One customer who needed nine mailboxes was offered three,
 * abandoned, and only bought Pro because they found the pricing page unaided.
 *
 * So for that workspace, at the Free cap only, the offer is Personal AND Pro,
 * side by side, each with its own checkout. Personal stays, and stays FIRST:
 * most customers buy it, and the point is to stop hiding Pro, not to start
 * hiding Personal. A consumer-shaped Free workspace gets exactly what it got
 * before. The Personal cap is untouched by shape: from three there is one way
 * forward, and it is Pro for everybody.
 *
 * `businessShaped` is decided by the caller (see lib/segment/consumer-domains)
 * and passed in, so this stays a pure function of two values, and two surfaces
 * that pass the same two values cannot disagree.
 *
 * RETURN SHAPE. The top-level fields are the PRIMARY offer and mean what they
 * always meant, so a caller that only reads `.plan` (the server's
 * `upgrade_url` in check-inbox-limit.ts) is unaffected: a Free cap still
 * answers `personal`. `offers` is every plan to put a buy button on, in display
 * order, and always has at least one entry; `dual` is `offers.length > 1`. The
 * `notice*` keys are the same offer's copy on the Inboxes page, which lives in
 * the `dashboard` namespace rather than `dashboardChrome`.
 *
 * @typedef {object} InboxCapPlanOffer
 * @property {'personal'|'solo'} plan  Internal plan id the checkout accepts.
 * @property {string} ctaKey           `dashboardChrome` key: monthly buy label.
 * @property {string} noticeCtaKey     `dashboard` key: the same label on the page notice.
 * @property {string|null} pitchKey    `dashboardChrome` key: one-line pitch on a dual card.
 * @property {string[]} featureKeys    `dashboardChrome` keys: the plan's real deltas.
 *
 * @param {number|null|undefined} maxInboxes - The cap that was hit.
 * @param {{businessShaped?: boolean}} [context]
 * @returns {{
 *   plan: string, titleKey: string, bodyKey: string, ctaKey: string,
 *   featureKeys: string[], noticeBodyKey: string, dual: boolean,
 *   offers: InboxCapPlanOffer[],
 * }}
 */
export function inboxCapOffer(maxInboxes, context) {
  const atFreeCap = (maxInboxes ?? 1) <= 1;
  // Strictly `true`. A truthy string or a stray object from a caller that
  // wired the prop wrong must not quietly change what a paywall sells.
  const businessShaped = context?.businessShaped === true;

  if (!atFreeCap) {
    const pro = proOffer();
    return {
      plan: pro.plan,
      titleKey: 'connect.upgradeTitle',
      bodyKey: 'connect.upgradeBody',
      ctaKey: pro.ctaKey,
      featureKeys: [...pro.featureKeys],
      noticeBodyKey: 'inboxes.capBodyPro',
      dual: false,
      offers: [pro],
    };
  }

  const personal = personalOffer();
  if (!businessShaped) {
    return {
      plan: personal.plan,
      titleKey: 'connect.personalUpgradeTitle',
      bodyKey: 'connect.personalUpgradeBody',
      ctaKey: personal.ctaKey,
      featureKeys: [...personal.featureKeys],
      noticeBodyKey: 'inboxes.capBodyPersonal',
      dual: false,
      offers: [personal],
    };
  }

  return {
    // Personal is still the primary: it is what `.plan` readers link to, and
    // it is the first card.
    plan: personal.plan,
    titleKey: 'connect.businessUpgradeTitle',
    bodyKey: 'connect.businessUpgradeBody',
    ctaKey: personal.ctaKey,
    featureKeys: [...personal.featureKeys],
    noticeBodyKey: 'inboxes.capBodyBusiness',
    dual: true,
    offers: [
      { ...personal, pitchKey: 'connect.businessPersonalPitch' },
      { ...proOffer(), pitchKey: 'connect.businessProPitch' },
    ],
  };
}

/** Fresh objects every call, so no caller can mutate another caller's offer. */
function personalOffer() {
  return {
    plan: 'personal',
    ctaKey: 'connect.personalUpgradeCta',
    noticeCtaKey: 'inboxes.capCtaPersonal',
    pitchKey: null,
    featureKeys: [
      'connect.personalFeatureInboxes',
      'connect.personalFeatureRateLimit',
      'connect.featureTeam',
      'connect.featureSupport',
    ],
  };
}

function proOffer() {
  return {
    plan: 'solo',
    ctaKey: 'connect.viewUpgradeOptions',
    noticeCtaKey: 'inboxes.capCtaPro',
    pitchKey: null,
    featureKeys: [
      'connect.featureInboxes',
      'connect.featureRateLimit',
      'connect.featureTeam',
      'connect.featureSupport',
    ],
  };
}

/**
 * Split a dual offer's feature lines into what DIFFERS and what is the same.
 *
 * Two cards side by side that each end in "Cancel any time" and "Email
 * support" spend half their height saying nothing about the choice in front of
 * the buyer. The lines every plan shares are listed once under the cards, and
 * each card keeps only the lines that tell it apart (the inbox count and the
 * burst limit). Order is preserved on both sides.
 *
 * With one offer there is nothing to compare against, so everything stays on
 * the plan and `shared` is empty: the single-offer panel renders as it always
 * has.
 *
 * @param {Array<{plan: string, featureKeys: string[]}>} offers
 * @returns {{shared: string[], byPlan: Record<string, string[]>}}
 */
export function splitSharedFeatures(offers) {
  const list = Array.isArray(offers) ? offers : [];
  const shared =
    list.length > 1
      ? list[0].featureKeys.filter(key => list.every(offer => offer.featureKeys.includes(key)))
      : [];
  const byPlan = {};
  for (const offer of list) {
    byPlan[offer.plan] = offer.featureKeys.filter(key => !shared.includes(key));
  }
  return { shared, byPlan };
}

/**
 * What ONE interval control may offer when it governs several buy buttons.
 *
 * A single-plan panel shows each interval's price inside the toggle. Two plans
 * have two prices, so the dual panel's toggle is price-free and each card
 * states its own number. Two rules keep that honest:
 *
 *   1. Annual is offered only when EVERY plan on screen has a yearly price. A
 *      toggle reading "Annual" above a button that can only sell monthly is a
 *      control that lies about one of the two things it controls.
 *   2. The "Save N%" badge appears only when every plan saves the SAME percent.
 *      One badge over two different savings would overstate one of them.
 *
 * @param {Array<{savingPercent?: number|null}|null|undefined>} annualOffers One
 *   entry per plan on screen, null where that plan has no yearly price.
 * @returns {{annualAvailable: boolean, savingPercent: number|null}}
 */
export function sharedIntervalChoice(annualOffers) {
  const list = Array.isArray(annualOffers) ? annualOffers : [];
  const annualAvailable = list.length > 0 && list.every(offer => offer != null);
  if (!annualAvailable) return { annualAvailable: false, savingPercent: null };
  const first = list[0].savingPercent ?? null;
  const uniform = first !== null && list.every(offer => offer.savingPercent === first);
  return { annualAvailable: true, savingPercent: uniform ? first : null };
}

/**
 * Whether a buy button should send `interval=year`.
 *
 * The interval state is shared by every button on the panel, so each button
 * checks that its OWN plan can be bought yearly. It always can when the toggle
 * was offered (rule 1 above); this is the belt to that pair of braces, because
 * the failure it prevents is a customer sent to a `price_not_configured`
 * refusal from the one screen built to take their money.
 *
 * MONTHLY IS THE DEFAULT AND STAYS THE DEFAULT: anything but an explicit
 * 'year' answers false.
 *
 * @param {string} interval
 * @param {object|null|undefined} annualOffer This plan's annual offer, or null.
 */
export function buysAnnual(interval, annualOffer) {
  return interval === 'year' && annualOffer != null;
}
