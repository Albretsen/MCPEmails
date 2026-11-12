'use client';

/**
 * The pricing catalogue: one printed plate per plan, then one shared order
 * form. A client island only because an EU visitor sees euro prices once
 * /api/geo answers (useDisplayCurrency, same rule as Sections.jsx Pricing);
 * the server render is complete in USD, so the plates read with JS off.
 */

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';
import { CheckoutReassurance } from '../../CheckoutReassurance';
import { PLANS as CATALOGUE, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { pricing as copy } from './copy.mjs';
import { plateNumeral } from './rng.mjs';
import s from './Home.module.css';

// `solo` is sold as Pro and `pro` is sold as Business: names always come from
// planDisplayName, never from these ids.
const TIERS = [
  { id: 'free', copyKey: 'free' },
  { id: 'personal', copyKey: 'personal' },
  { id: 'solo', copyKey: 'solo' },
  { id: 'pro', copyKey: 'business' },
];

/**
 * @param {{ stripePrices?: any, eurEnabled?: boolean, businessSeat?: any, locale?: string }} props
 */
export default function Plates({ stripePrices, eurEnabled = false, businessSeat = null, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  const eur = currency === 'eur';
  const money = (text) => (eur ? euroizeAmounts(text, locale) : text);
  const signupHref = withReadingLang('/signup', locale);

  return (
    <>
      <ol className={s.plates}>
        {TIERS.map((tier, i) => {
          const plate = copy.plates[tier.copyKey];
          const live = stripePrices?.[tier.id]?.monthlyCents;
          const monthlyCents = live != null && live > 0 ? live : CATALOGUE[tier.id].monthlyPriceCents;
          const price = eur
            ? formatMoneyCents(
                eurCentsFor(stripePrices?.[tier.id]?.eurMonthlyCents, monthlyCents) ?? monthlyCents,
                'eur',
                locale,
              )
            : formatUsdCopy(monthlyCents, locale);
          const seat = tier.id === 'pro' ? businessSeat?.card ?? null : null;
          const per = tier.id === 'free' ? copy.perForever : seat ? seat.per : copy.perMonth;
          const includes = (seat ? seat.features : plate.includes).map(money);
          const href =
            tier.id === 'free'
              ? null
              : withReadingLang(pricingUpgradeHref(tier.id, false, false, locale), locale);
          const name = planDisplayName(tier.id);
          const numeral = plateNumeral(i + 1);
          return (
            <li key={tier.id} className={s.plate} aria-labelledby={`v04-plate-${tier.id}`}>
              <div className={s.plateHead}>
                <span className={s.plateWord}>{copy.plateWord}</span>
                <span className={s.plateNum} aria-hidden="true">{numeral}</span>
              </div>
              <h3 id={`v04-plate-${tier.id}`} className={s.plateName}>
                <span className={s.srOnly}>{copy.plateWord} {numeral}: </span>
                {name}
              </h3>
              <dl className={s.spec}>
                <div>
                  <dt>{copy.specPrice}</dt>
                  <dd>
                    <span className={s.price}>{price}</span> {per}
                    {eur && monthlyCents > 0 ? <span className={s.vat}> {copy.inclVat}</span> : null}
                  </dd>
                </div>
                <div>
                  <dt>{copy.specInboxes}</dt>
                  <dd>{seat ? plate.inboxesSeat : plate.inboxes}</dd>
                </div>
                <div>
                  <dt>{copy.specFor}</dt>
                  <dd>{plate.for}</dd>
                </div>
              </dl>
              {seat ? <p className={s.plateDesc}>{money(seat.desc)}</p> : plate.desc ? <p className={s.plateDesc}>{money(plate.desc)}</p> : null}
              {seat ? <p className={s.plateMin}>{seat.minimum}</p> : null}
              <ul className={s.includes}>
                {includes.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {href ? (
                <div className={s.plateOrder}>
                  <a href={href}>
                    {copy.order} {copy.plateWord.toLowerCase()} {numeral}: {name}
                  </a>
                  <CheckoutReassurance locale={locale} style={{ color: 'inherit', fontFamily: 'inherit', fontSize: 12 }} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className={s.orderForm}>
        <div>
          <h3 className={s.orderTitle}>{copy.sharedTitle}</h3>
          <p>{copy.sharedP}</p>
        </div>
        <div className={s.orderAction}>
          <a className={s.btnPrimary} href={signupHref}>{copy.sharedCta}</a>
          <span className={s.mono}>{copy.sharedNote}</span>
        </div>
      </div>
    </>
  );
}
