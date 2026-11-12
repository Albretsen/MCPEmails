/**
 * Homepage Lab v06, "By hand, or connected" (staging only, English only).
 *
 * Server component. Client islands: CopyUrl (connector URL copy feedback) and
 * Currency (EUR for EU visitors). Everything else is static HTML, readable
 * with JavaScript off. Layout: a blueprint grid page, a hero with the 3D
 * envelope and its long shadow, security first, five alternating bleed rows
 * comparing each job by hand and connected, the postbox as the anchor of
 * "Connect your inbox", then install steps, review, pricing, FAQ.
 */
import { Fragment } from 'react';
import { PLANS, planDisplayName } from '@/lib/stripe/plans';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { checkoutReassurance } from '@/lib/billing/checkout-reassurance.mjs';
import { REVIEWS } from '../../marketing/reviews.mjs';
import CopyUrl from './CopyUrl';
import { Price, Money, VatNote } from './Currency';
import { CHOICES } from './rng.mjs';
import {
  MCP_URL, nav, hero, security, demo, providers, how, reviews, pricing, faq, whatIs, footer,
} from './copy.mjs';
import s from './Home.module.css';

const A = '/home-lab/assets/a/';
const B = '/home-lab/assets/b/';
const C = '/home-lab/assets/c/';

const FRAUNCES = new URL('./fonts/fraunces-600-opsz144.woff2', import.meta.url).pathname;
const INSTRUMENT = new URL('./fonts/instrument-sans-400-500.woff2', import.meta.url).pathname;

// envelopes-small is a different crop (800x725), so only the hero file is used:
// one candidate keeps the rendered ratio equal to width/height.
const HERO_AVIF = `${B}envelopes-hero.avif`;
const HERO_WEBP = `${B}envelopes-hero.webp`;

/** Real screenshots. Cards switch to the phone crop below 768 px; dashboards keep
 *  the desktop crop and bleed off the right edge at every width. */
const SHOTS = {
  'card-draft': { d: [1364, 776], m: [720, 878], file: 'card-draft-light' },
  'card-approval': { d: [1364, 484], m: [720, 602], file: 'card-approval-light' },
  'dashboard-approvals': { d: [2880, 1800], m: [780, 1688], file: 'dashboard-approvals-light' },
  'dashboard-inboxes': { d: [2880, 1800], m: [780, 1688], file: 'dashboard-inboxes-light' },
  'dashboard-overview': { d: [2880, 1800], m: [780, 1688], file: 'dashboard-overview-light' },
  'card-draft-sent': { d: [1364, 462], m: [720, 548], file: 'card-draft-sent-light' },
};

/** Email addresses and the connector URL are set in mono: anything you could copy. */
const MONO_RE = /(https:\/\/mcpemails\.com\/api\/mcp|\b[a-z][a-z0-9.+-]*@(?:[a-z0-9-]+\.)*[a-z0-9-]*)/gi;

/** `local` uses the system mono stack: the hero must not pull a third font file. */
function T({ children, local = false }) {
  const parts = String(children).split(MONO_RE);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <code key={i} className={local ? s.monoLocal : s.mono}>{part}</code>
      : <Fragment key={i}>{part}</Fragment>,
  );
}

function Shot({ id, alt, kind }) {
  const shot = SHOTS[id];
  const [dw, dh] = shot.d;
  const [mw, mh] = shot.m;
  return (
    <picture className={kind === 'card' ? s.shotCard : s.shotScreen}>
      {kind === 'card' && (
        <>
          <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}${shot.file}-mobile.avif`} width={mw} height={mh} />
          <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}${shot.file}-mobile.webp`} width={mw} height={mh} />
        </>
      )}
      <source type="image/avif" srcSet={`${A}${shot.file}-desktop.avif`} width={dw} height={dh} />
      <img src={`${A}${shot.file}-desktop.webp`} width={dw} height={dh} alt={alt} loading="lazy" decoding="async" />
    </picture>
  );
}

function Header() {
  return (
    <header className={s.header}>
      <div className={s.headerInner}>
        <a href="/" className={s.logo} aria-label="MCPEmails home">
          <img src="/logo-wordmark.svg" width={280} height={48} alt="MCPEmails" />
        </a>
        <nav aria-label={nav.label} className={s.nav}>
          <ul className={s.navList}>
            {nav.links.map((l) => (
              <li key={l.href}><a href={l.href}>{l.text}</a></li>
            ))}
          </ul>
          <div className={s.navActions}>
            <a href="/login" className={s.navSignIn}>{nav.signIn}</a>
            <a href="/signup" className={`${s.btn} ${s.btnPrimary}`}>{nav.start}</a>
          </div>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className={s.hero} aria-labelledby="v06-h1">
      <div className={s.heroText}>
        <h1 id="v06-h1" className={s.display}>{hero.h1}</h1>
        <p className={s.lead}>{hero.lead}</p>
        <p><T local>{hero.team}</T></p>
        <div className={s.ctaRow}>
          <a href="/signup" className={`${s.btn} ${s.btnPrimary}`}>{hero.ctaPrimary}</a>
          <a href="/docs/clients" className={`${s.btn} ${s.btnSecondary}`}>{hero.ctaSecondary}</a>
        </div>
        <ul className={s.facts}>
          {hero.facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      </div>
      <div className={`${s.envelope} ${CHOICES.shadowSide === 'left' ? s.shadowLeft : ''}`}>
        <picture className={s.envelopeShadow}>
          <source type="image/avif" srcSet={HERO_AVIF} />
          <img src={HERO_WEBP} width={1600} height={1154} alt="" decoding="async" />
        </picture>
        <picture className={s.envelopeObject}>
          <source type="image/avif" srcSet={HERO_AVIF} />
          <img src={HERO_WEBP} width={1600} height={1154} alt={hero.envelopeAlt} fetchPriority="high" decoding="async" />
        </picture>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section id={security.id} className={s.section} aria-labelledby="v06-security">
      <div className={s.wrap}>
        <div className={s.head}>
          <h2 id="v06-security" className={s.display}>{security.h2}</h2>
          <p>{security.intro}</p>
        </div>
        <div className={s.qaGrid}>
          {security.items.map((item) => (
            <div key={item.q} className={s.qa}>
              <p className={s.tag}>{item.tag}</p>
              <h3 className={s.h3}>{item.q}</h3>
              <p>{item.a}</p>
            </div>
          ))}
        </div>
        <figure className={s.diagram}>
          <img src={`${C}diagram-stored.svg`} width={960} height={400} alt={security.diagramAlt} loading="lazy" decoding="async" />
          <figcaption className={s.small}>{security.caption}</figcaption>
        </figure>
        <p className={s.linkRow}>
          <a href="/security">{security.more}</a>
          <a href="/dpa">{security.dpa}</a>
          <a href="/privacy">{security.privacy}</a>
        </p>
      </div>
    </section>
  );
}

function Demo() {
  return (
    <section id={demo.id} className={s.demo} aria-labelledby="v06-demo">
      <div className={s.wrap}>
        <div className={s.head}>
          <h2 id="v06-demo" className={s.display}>{demo.h2}</h2>
          <p>{demo.intro}</p>
        </div>
      </div>
      {demo.rows.map((row, i) => {
        const tinted = CHOICES.tintOdd ? i % 2 === 0 : i % 2 === 1;
        const kind = row.shot.startsWith('card') ? 'card' : 'screen';
        return (
          <article key={row.h3} className={`${s.row} ${tinted ? s.rowTint : ''}`}>
            <div className={s.rowText}>
              <p className={s.rowNum}>{String(i + 1).padStart(2, '0')} / 05</p>
              <h3 className={s.h3}><T>{row.h3}</T></h3>
              <div className={s.compare}>
                <div className={s.hand}>
                  <p className={s.label}>{demo.byHand}</p>
                  <ol className={s.handList}>
                    {row.hand.map((step) => <li key={step}><span><T>{step}</T></span></li>)}
                  </ol>
                </div>
                <div className={s.conn}>
                  <p className={s.label}>{demo.connected}</p>
                  <p><T>{row.connected}</T></p>
                </div>
              </div>
            </div>
            <figure className={`${s.rowShot} ${kind === 'card' ? s.rowShotCard : ''}`}>
              <Shot id={row.shot} alt={row.alt} kind={kind} />
              <figcaption className={s.small}>{row.caption}</figcaption>
            </figure>
          </article>
        );
      })}
    </section>
  );
}

/** Label positions for the postbox leader lines, in % of the figure. */
const SLOT = { x: 24, y: 30 };
const labelTop = (i, n) => 6 + (i * 88) / (n - 1);

function Providers() {
  const n = providers.slots.length;
  return (
    <section id={providers.id} className={s.section} aria-labelledby="v06-providers">
      <div className={`${s.wrap} ${s.providers} ${CHOICES.postboxSide === 'right' ? s.providersFlip : ''}`}>
        <figure className={s.postbox}>
          <picture className={s.postboxImg}>
            <source type="image/avif" srcSet={`${B}postbox-small.avif 555w, ${B}postbox-hero.avif 1399w`} sizes="(min-width: 960px) 300px, 45vw" />
            <img
              src={`${B}postbox-small.webp`}
              srcSet={`${B}postbox-small.webp 555w, ${B}postbox-hero.webp 1399w`}
              sizes="(min-width: 960px) 300px, 45vw"
              width={1399}
              height={1600}
              alt={providers.postboxAlt}
              loading="lazy"
              decoding="async"
            />
          </picture>
          <svg className={s.leaders} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {providers.slots.map((slot, i) => {
              const y = labelTop(i, n) + 2.6;
              return (
                <polyline
                  key={slot.name}
                  points={`${SLOT.x},${SLOT.y} 50,${y} 55,${y}`}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            <circle cx={SLOT.x} cy={SLOT.y} r="0.9" />
          </svg>
          <ul className={s.slots}>
            {providers.slots.map((slot, i) => (
              <li key={slot.name} style={{ '--top': `${labelTop(i, n)}%` }}>
                <a href={slot.href}>{slot.name}</a>
              </li>
            ))}
          </ul>
        </figure>
        <div className={s.providersText}>
          <h2 id="v06-providers" className={s.display}>{providers.h2}</h2>
          <p>{providers.lead}</p>
          <dl className={s.howList}>
            {providers.how.map((item) => (
              <div key={item.q}>
                <dt>{item.q}</dt>
                <dd>{item.a}</dd>
              </div>
            ))}
          </dl>
          <p className={s.linkRow}>
            {providers.links.map((l) => <a key={l.href} href={l.href}>{l.text}</a>)}
          </p>
        </div>
      </div>
    </section>
  );
}

function How() {
  return (
    <section id={how.id} className={`${s.section} ${s.sectionTint}`} aria-labelledby="v06-how">
      <div className={s.wrap}>
        <div className={s.head}>
          <h2 id="v06-how" className={s.display}>{how.h2}</h2>
          <p>{how.lead}</p>
        </div>
        <ol className={s.steps}>
          {how.steps.map((step, i) => (
            <li key={step.h3}>
              <p className={s.rowNum}>{`Step ${i + 1}`}</p>
              <h3 className={s.h3}>{step.h3}</h3>
              <p><T>{step.p}</T></p>
            </li>
          ))}
        </ol>

        <div className={s.urlBox}>
          <span className={s.label}>{how.urlLabel}</span>
          <code className={s.urlValue}>{MCP_URL}</code>
          <CopyUrl value={MCP_URL} label={how.copy} done={how.copied} className={s.copyBtn} doneClassName={s.copyBtnDone} />
        </div>

        <div className={s.install}>
          <div className={s.clients}>
            {how.clients.map((client) => (
              <div key={client.name} className={s.client}>
                <h3 className={s.h3}>{`In ${client.name}`}</h3>
                <p className={s.small}>{client.where}</p>
                <ol className={s.clientSteps}>
                  {client.steps.map((step) => <li key={step}>{step}</li>)}
                </ol>
                <a href={client.href}>{client.link}</a>
              </div>
            ))}
          </div>
          <figure className={s.installShot}>
            <Shot id="card-draft-sent" alt={how.cardAlt} kind="card" />
            <figcaption className={s.small}>{how.cardCaption}</figcaption>
            <p className={s.small}>{how.proofNote}</p>
          </figure>
        </div>
        <p>{how.others}</p>
        <p className={s.linkRow}>
          {how.otherLinks.map((l) => <a key={l.href} href={l.href}>{l.text}</a>)}
        </p>
      </div>
    </section>
  );
}

function Reviews() {
  const review = REVIEWS[0];
  if (!review) return null;
  return (
    <section id={reviews.id} className={s.section} aria-labelledby="v06-reviews">
      <div className={`${s.wrap} ${s.review}`}>
        <div className={s.head}>
          <h2 id="v06-reviews" className={s.display}>{reviews.h2}</h2>
          <p>{reviews.lead}</p>
        </div>
        <figure className={s.quote}>
          <blockquote cite={review.sourceUrl}>
            <p>{review.quote}</p>
          </blockquote>
          <figcaption>
            <span aria-label={reviews.rated(review.rating)} className={s.stars}>{'★'.repeat(review.rating)}</span>
            <span>
              {review.author}, {review.role},{' '}
              {review.url ? <a href={review.url} rel="noopener">{review.company}</a> : review.company}
            </span>
            {review.sourceUrl && <a href={review.sourceUrl} rel="noopener">{reviews.source}</a>}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function Pricing({ stripePrices, eurEnabled, businessSeat }) {
  const tiers = [
    { key: 'free', priceKey: 'free', per: pricing.perForever, href: '/signup' },
    { key: 'personal', priceKey: 'personal', per: pricing.perMonth, href: pricingUpgradeHref('personal', false, false, 'en') },
    { key: 'solo', priceKey: 'solo', per: pricing.perMonth, href: pricingUpgradeHref('solo', false, false, 'en'), accent: true },
    { key: 'business', priceKey: 'pro', per: pricing.perMonth, href: pricingUpgradeHref('pro', false, false, 'en') },
  ];
  return (
    <section id={pricing.id} className={`${s.section} ${s.sectionTint}`} aria-labelledby="v06-pricing">
      <div className={s.wrap}>
        <div className={s.head}>
          <h2 id="v06-pricing" className={s.display}>{pricing.h2}</h2>
          <p>{pricing.lead}</p>
        </div>
        <ul className={s.plans}>
          {tiers.map((tier) => {
            const live = stripePrices?.[tier.priceKey];
            const usdCents = live?.monthlyCents != null && live.monthlyCents > 0
              ? live.monthlyCents
              : PLANS[tier.priceKey].monthlyPriceCents;
            const seat = tier.key === 'business' ? businessSeat?.card ?? null : null;
            const copy = pricing.tiers[tier.key];
            const features = seat ? seat.features : copy.features;
            return (
              <li key={tier.key} className={`${s.plan} ${tier.accent ? s.planAccent : ''}`}>
                <p className={s.label}>{tier.accent ? pricing.popular : ' '}</p>
                <h3 className={s.h3}>{planDisplayName(tier.priceKey)}</h3>
                <p className={s.planPrice}>
                  <span className={s.display}>
                    <Price usdCents={usdCents} eurCents={live?.eurMonthlyCents} eurEnabled={eurEnabled} />
                  </span>
                  <span className={s.small}>{seat ? seat.per : tier.per}</span>
                </p>
                {usdCents > 0 && <VatNote eurEnabled={eurEnabled} label={pricing.inclVat} className={s.small} />}
                {seat && <p className={s.small} data-business-seat-minimum="">{seat.minimum}</p>}
                <p>{seat ? seat.desc : copy.desc}</p>
                <ul className={s.features}>
                  {features.map((f) => <li key={f}><Money text={f} eurEnabled={eurEnabled} /></li>)}
                </ul>
                <div className={s.planCta}>
                  <a className={`${s.btn} ${tier.accent ? s.btnPrimary : s.btnSecondary}`} href={tier.href}>{copy.cta}</a>
                  {tier.key === 'free'
                    ? <p className={s.small}>{pricing.freeNote}</p>
                    : <p className={s.small} data-checkout-reassurance="subscription">{checkoutReassurance('en')}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className={s.team}>
          <h3 className={s.h3}>{pricing.team.h3}</h3>
          <p><T>{pricing.team.p}</T></p>
          <p>{pricing.team.solo}</p>
          <p><a href="/for/business">{pricing.team.link}</a></p>
        </div>
        <p className={s.small}>
          {pricing.footnote} {pricing.contact}{' '}
          <a href="mailto:hello@mcpemails.com" className={s.mono}>hello@mcpemails.com</a>.{' '}
          <a href="/pricing">{pricing.compare}</a>.
        </p>
      </div>
    </section>
  );
}

function Faq({ items, eurEnabled }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <section id={faq.id} className={s.section} aria-labelledby="v06-faq">
      <div className={s.wrap}>
        <div className={s.head}>
          <h2 id="v06-faq" className={s.display}>{faq.h2}</h2>
          <p>{faq.lead}</p>
        </div>
        <div className={s.faq}>
          {items.map((item) => (
            <div key={item.q} className={s.faqItem}>
              <h3 className={s.h3}>{item.q}</h3>
              <p>{item.a.includes('$') ? <Money text={item.a} eurEnabled={eurEnabled} /> : <T>{item.a}</T>}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WhatIs() {
  return (
    <section id={whatIs.id} className={`${s.section} ${s.sectionTint}`} aria-labelledby="v06-whatis">
      <div className={`${s.wrap} ${s.whatIs}`}>
        <div>
          <h2 id="v06-whatis" className={s.display}>{whatIs.h2}</h2>
          <p>{whatIs.p1}</p>
          <p>{whatIs.p2}</p>
          <p>{whatIs.p3}</p>
        </div>
        <div>
          <ul className={s.linkList}>
            {whatIs.links.map((l) => <li key={l.href}><a href={l.href}>{l.text}</a></li>)}
          </ul>
          <p>{whatIs.ctaLead}</p>
          <div className={s.ctaRow}>
            <a href="/signup" className={`${s.btn} ${s.btnPrimary}`}>{hero.ctaPrimary}</a>
            <a href="/docs/clients" className={`${s.btn} ${s.btnSecondary}`}>{hero.ctaSecondary}</a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className={s.footer}>
      <div className={s.wrap}>
        <div className={s.footerGrid}>
          <div className={s.footerBrand}>
            <a href="/" aria-label="MCPEmails home">
              <img src="/logo-wordmark.svg" width={280} height={48} alt="MCPEmails" loading="lazy" />
            </a>
            <p>{footer.tagline}</p>
            <p>
              <span className={s.footerLabel}>{footer.contactLabel}</span>{' '}
              <a href="mailto:support@mcpemails.com" className={s.mono}>support@mcpemails.com</a>
            </p>
            <p>
              <span className={s.footerLabel}>{footer.salesLabel}</span>{' '}
              <a href="mailto:hello@mcpemails.com" className={s.mono}>hello@mcpemails.com</a>
            </p>
            <p className={s.footerUrl}>
              <span className={s.footerLabel}>{footer.urlLabel}</span>{' '}
              <code className={s.mono}>{MCP_URL}</code>{' '}
              <CopyUrl value={MCP_URL} label={how.copy} done={how.copied} className={s.copyBtn} doneClassName={s.copyBtnDone} />
            </p>
          </div>
          {footer.columns.map((col) => (
            <div key={col.h}>
              <h2 className={s.footerHead}>{col.h}</h2>
              <ul className={s.footerLinks}>
                {col.links.map(([href, text]) => <li key={href}><a href={href}>{text}</a></li>)}
              </ul>
            </div>
          ))}
        </div>
        <p className={s.langs} aria-label={footer.languageLabel}>
          {footer.languages.map(([href, text, lang]) => (
            <a key={href} href={href} hrefLang={lang} lang={lang} aria-current={href === '/' ? 'true' : undefined}>{text}</a>
          ))}
        </p>
        <p>{footer.copyright} {footer.legal}</p>
        <p>{footer.legalEntity}</p>
      </div>
    </footer>
  );
}

/**
 * @param {{
 *   stripePrices?: any,
 *   eurEnabled?: boolean,
 *   businessSeat?: any,
 *   faqItems?: { q: string, a: string }[],
 *   locale?: string,
 * }} props
 */
export default function Home({ stripePrices, eurEnabled = false, businessSeat = null, faqItems = [] }) {
  return (
    <div className={s.root} style={{ '--major': `${CHOICES.majorGrid}px`, '--mono-ink': CHOICES.monoInk }}>
      {/* Real link elements: react-dom preload() only reaches the RSC payload here
          because the head is flushed before the variant renders. The two first-view
          fonts (H1 and lead), and the envelope where it is the desktop LCP. */}
      <link rel="preload" href={FRAUNCES} as="font" type="font/woff2" crossOrigin="anonymous" />
      <link rel="preload" href={INSTRUMENT} as="font" type="font/woff2" crossOrigin="anonymous" />
      <link rel="preload" href={HERO_AVIF} as="image" type="image/avif" media="(min-width: 960px)" fetchPriority="high" />
      <Header />
      <main>
        <Hero />
        <Security />
        <Demo />
        <Providers />
        <How />
        <Reviews />
        <Pricing stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} />
        <Faq items={faqItems} eurEnabled={eurEnabled} />
        <WhatIs />
      </main>
      <Footer />
    </div>
  );
}
