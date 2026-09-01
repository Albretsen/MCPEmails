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
 * @param {number|null|undefined} maxInboxes - The cap that was hit.
 * @returns {{plan: string, titleKey: string, bodyKey: string, ctaKey: string, featureKeys: string[]}}
 */
export function inboxCapOffer(maxInboxes) {
  const targetsPersonal = (maxInboxes ?? 1) <= 1;
  return targetsPersonal
    ? {
        plan: 'personal',
        titleKey: 'connect.personalUpgradeTitle',
        bodyKey: 'connect.personalUpgradeBody',
        ctaKey: 'connect.personalUpgradeCta',
        featureKeys: [
          'connect.personalFeatureInboxes',
          'connect.personalFeatureRateLimit',
          'connect.featureTeam',
          'connect.featureSupport',
        ],
      }
    : {
        plan: 'solo',
        titleKey: 'connect.upgradeTitle',
        bodyKey: 'connect.upgradeBody',
        ctaKey: 'connect.viewUpgradeOptions',
        featureKeys: [
          'connect.featureInboxes',
          'connect.featureRateLimit',
          'connect.featureTeam',
          'connect.featureSupport',
        ],
      };
}
