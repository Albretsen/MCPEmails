/**
 * Homepage Lab v08, "The Spec Sheet" (staging only, English only).
 *
 * Museum white. The hero shows one 3D object (the draft card as a slip with
 * a stamp) and the real draft-send clip; after that the page uses real
 * screenshots only. The body is a long read with a sticky left index and a
 * thin cobalt reading-progress line: a customer quote, one long key/value
 * spec sheet with screenshots between its groups, the security model, a
 * founder letter, pricing, the FAQ and a closing call to action. Every
 * section header carries the date its subject last changed in git
 * (dates.mjs), and most sections end with a short note to the agent.
 *
 * Server component. Client islands: Currency.jsx (USD or EUR) and
 * LoopClip.jsx (the hero clip, poster only under reduced motion).
 */
import { PLANS, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { REVIEWS, REVIEW_SOURCES } from '../../marketing/reviews.mjs';
import Currency from './Currency';
import LoopClip from './LoopClip';
import { UPDATED, humanDate } from './dates.mjs';
import { FIRST_FIGURE_SIDE, ZEBRA, CAPTION_PREFIX, ACCENT_KEY, INDEX_STYLE } from './rng.mjs';
import { MCP_URL, nav, hero, index, quotes, spec, security, letter, pricing, faq, start, footer } from './copy.mjs';
import s from './Home.module.css';

const A = '/home-lab/assets/a/';
const B = '/home-lab/assets/b/';
/** The lead paints in Literata 400; it is preloaded with a real link element. */
const LITERATA_URL = new URL('./fonts/literata-400-latin.woff2', import.meta.url).pathname;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const numeral = (i) => (INDEX_STYLE === 'roman' ? ROMAN[i] : String(i + 1).padStart(2, '0'));

/* ---------- small pieces ---------- */

function Updated({ dateKey }) {
  const iso = UPDATED[dateKey].date;
  return (
    <p className={s.updated}>
      Last updated <time dateTime={iso}>{humanDate(iso)}</time>, from git
    </p>
  );
}

function SectionHead({ n, id, title, dateKey }) {
  return (
    <div className={s.sectionHead}>
      <p className={s.sectionNum} aria-hidden="true">{numeral(n)}</p>
      <h2 id={id} className={s.h2}>{title}</h2>
      <Updated dateKey={dateKey} />
    </div>
  );
}

function AgentNote({ children }) {
  return (
    <p className={s.agentNote}>
      <span className={s.agentLabel}>Note to the agent:</span> {children}
    </p>
  );
}

function Shot({ shot, alt, className = '' }) {
  return (
    <picture>
      <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}${shot.mobile}.avif`} width={shot.mw} height={shot.mh} />
      <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}${shot.mobile}.webp`} width={shot.mw} height={shot.mh} />
      <source type="image/avif" srcSet={`${A}${shot.desktop}.avif`} />
      <img
        className={`${s.shot} ${className}`}
        src={`${A}${shot.desktop}.webp`}
        width={shot.w}
        height={shot.h}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

function Caption({ n, children }) {
  return (
    <figcaption className={s.caption}>
      <span className={s.captionNum}>{CAPTION_PREFIX} {n}</span>
      <span>{children}</span>
    </figcaption>
  );
}

function SpecTable({ rows, caption }) {
  return (
    <table className={s.spec}>
      <caption className={s.visuallyHidden}>{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.key === ACCENT_KEY ? s.accentRow : undefined}>
            <th scope="row">{r.key}</th>
            <td>
              {r.value}
              {r.code && (
                <>
                  {' '}
                  <code className={s.code}>{r.code}</code>
                </>
              )}
              {r.links && (
                <span className={s.rowLinks}>
                  {r.links.map((l) => (
                    <a key={l.href} href={l.href}>{l.label}</a>
                  ))}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- prices ---------- */

// Watch the ids: `solo` is sold as Pro and `pro` as Business (plans.ts).
const TIERS = [
  { key: 'free', copy: 'free' },
  { key: 'personal', copy: 'personal' },
  { key: 'solo', copy: 'solo', accent: true },
  { key: 'pro', copy: 'business' },
];

function priceFor(stripePrices, key) {
  const live = stripePrices?.[key]?.monthlyCents;
  const cents = live != null && live > 0 ? live : PLANS[key].monthlyPriceCents;
  const eurCents = eurCentsFor(stripePrices?.[key]?.eurMonthlyCents, cents) ?? cents;
  return { cents, usd: formatUsdCopy(cents, 'en'), eur: formatMoneyCents(eurCents, 'eur', 'en') };
}

/** Text with dollar amounts, rendered in EUR for an EU visitor. */
function Money({ text, eurEnabled }) {
  const eur = euroizeAmounts(text, 'en');
  if (eur === text) return text;
  return <Currency eurEnabled={eurEnabled} usd={text} eur={eur} />;
}

/** Customer copy never quotes an action cap. */
const noCaps = (line) => !/email actions/i.test(line);

/**
 * Figure numbers and sides for the screenshots between spec groups, worked
 * out once. Fig. 1 is the object and Fig. 2 the clip; sides alternate from
 * the seeded FIRST_FIGURE_SIDE.
 */
const SPEC_FIGS = (() => {
  const out = {};
  let n = 2;
  let side = FIRST_FIGURE_SIDE;
  for (const g of spec.groups) {
    if (!g.figure) continue;
    n += 1;
    out[g.id] = { n, side };
    side = side === 'right' ? 'left' : 'right';
  }
  return { byGroup: out, last: n };
})();

/* ---------- the page ---------- */

/**
 * @param {{
 *   stripePrices?: any,
 *   eurEnabled?: boolean,
 *   businessSeat?: any,
 *   faqItems?: { q: string, a: string }[],
 *   locale?: string,
 * }} props  see HomeLabProps in ../HomeLab.tsx
 */
export default function Home({ stripePrices, eurEnabled = false, businessSeat = null, faqItems = [], locale = 'en' }) {
  const review = REVIEWS[0];
  const reviewSource = review ? REVIEW_SOURCES[review.source] : null;
  const seat = businessSeat?.card ?? null;

  const tierRows = TIERS.map((tier) => {
    const price = priceFor(stripePrices, tier.key);
    const isBusiness = tier.key === 'pro';
    const href =
      tier.key === 'free'
        ? withReadingLang('/signup', locale)
        : withReadingLang(pricingUpgradeHref(tier.key, false, false, locale), locale);
    return { ...tier, price, isBusiness, href, name: planDisplayName(tier.key) };
  });

  const sections = [
    { id: 'v08-quotes', label: quotes.h2 },
    { id: 'v08-spec', label: spec.h2 },
    { id: 'v08-security', label: security.h2 },
    { id: 'v08-letter', label: letter.h2 },
    { id: 'v08-pricing', label: pricing.h2 },
    { id: 'v08-faq', label: faq.h2 },
    { id: 'v08-start', label: 'Start' },
  ];

  return (
    <div className={s.page} style={{ '--v08-zebra': ZEBRA }}>
      <link rel="preload" href={LITERATA_URL} as="font" type="font/woff2" crossOrigin="anonymous" />
      {/* ================= HEADER ================= */}
      <header className={s.header}>
        <div className={s.wrap}>
          <div className={s.headerRow}>
            <a href="/" className={s.logoLink}>
              <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" className={s.logo} />
            </a>
            <nav aria-label={nav.label} className={s.nav}>
              <ul className={s.navList}>
                {nav.links.map((l) => (
                  <li key={l.href}><a href={l.href}>{l.label}</a></li>
                ))}
              </ul>
              <a href="/login" className={s.navSignIn}>{nav.signIn}</a>
              <a href="/signup" className={s.btnPrimarySm}>{nav.start}</a>
            </nav>
          </div>
        </div>
      </header>

      <main id="main">
        {/* ================= HERO ================= */}
        <section className={s.hero} aria-labelledby="v08-h1">
          <div className={s.wrap}>
            <div className={s.heroGrid}>
              <div className={s.heroText}>
                <h1 id="v08-h1" className={s.h1}>{hero.h1}</h1>
                <p className={s.lead}>{hero.lead}</p>
                <div className={s.ctaRow}>
                  <a href="/signup" className={s.btnPrimary}>{hero.ctaPrimary}</a>
                  <a href="/connect" className={s.btnSecondary}>{hero.ctaSecondary}</a>
                </div>
                <ul className={s.facts}>
                  {hero.facts.map((f) => <li key={f}>{f}</li>)}
                </ul>
                <p className={s.heroBusiness}>
                  {hero.business} <a href="/for/business">{hero.businessLink}</a>.
                </p>
                <Updated dateKey="hero" />
              </div>

              <figure className={s.object}>
                <picture>
                  <source
                    type="image/avif"
                    srcSet={`${B}card-small.avif 800w, ${B}card-hero.avif 1600w`}
                    sizes="(min-width: 1024px) 600px, calc(100vw - 32px)"
                  />
                  <source
                    type="image/webp"
                    srcSet={`${B}card-small.webp 800w, ${B}card-hero.webp 1600w`}
                    sizes="(min-width: 1024px) 600px, calc(100vw - 32px)"
                  />
                  <img
                    src={`${B}card-hero.webp`}
                    width={1600}
                    height={816}
                    alt={hero.objectAlt}
                    loading="lazy"
                    decoding="async"
                    className={s.objectImg}
                  />
                </picture>
                <figcaption className={s.caption}>
                  <span className={s.captionNum}>{CAPTION_PREFIX} 1</span>
                  <span>
                    <strong className={s.captionTitle}>{hero.objectLabel}.</strong> {hero.objectCaption}
                  </span>
                </figcaption>
              </figure>
            </div>

            <figure className={s.clip}>
              <LoopClip videoLabel={hero.clipVideoLabel} pauseLabel={hero.pause} playLabel={hero.play}>
                <picture>
                  <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}card-draft-send-light-mobile-poster.avif`} width={784} height={720} />
                  <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}card-draft-send-light-mobile-poster.webp`} width={784} height={720} />
                  <source type="image/avif" srcSet={`${A}card-draft-send-light-desktop-poster.avif`} />
                  <img
                    className={s.clipPoster}
                    src={`${A}card-draft-send-light-desktop-poster.webp`}
                    width={1428}
                    height={840}
                    alt={hero.clipAlt}
                    loading="lazy"
                    decoding="async"
                  />
                </picture>
              </LoopClip>
              <figcaption className={s.caption}>
                <span className={s.captionNum}>{CAPTION_PREFIX} 2</span>
                <span>
                  <strong className={s.captionTitle}>{hero.clipLabel}.</strong> {hero.clipCaption}
                </span>
              </figcaption>
            </figure>
            <AgentNote>{hero.agentNote}</AgentNote>
          </div>
        </section>

        {/* ================= THE LONG READ ================= */}
        <div className={s.wrap}>
          <div className={s.read}>
            <nav className={s.index} aria-label={index.label}>
              <div className={s.indexInner}>
                <p className={s.indexLabel}>{index.label}</p>
                <div className={s.rail} aria-hidden="true"><span className={s.railFill} /></div>
                <ol className={s.indexList}>
                  {sections.map((sec, i) => (
                    <li key={sec.id}>
                      <a href={`#${sec.id}`}>
                        <span className={s.indexNum}>{numeral(i)}</span>
                        <span>{sec.label}</span>
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            </nav>

            <div className={s.readBody}>
              {/* ---------- 01 QUOTES ---------- */}
              <section className={s.section} aria-labelledby="v08-quotes">
                <SectionHead n={0} id="v08-quotes" title={quotes.h2} dateKey="quotes" />
                <p className={s.intro}>{quotes.intro}</p>
                {review && (
                  <figure className={s.quote}>
                    <blockquote className={s.quoteText} cite={review.sourceUrl}>
                      <p>{review.quote}</p>
                    </blockquote>
                    <figcaption className={s.quoteBy}>
                      <span className={s.quoteName}>{review.author}</span>
                      <span>
                        {review.role}, <a href={review.url} rel="noopener">{review.company}</a>
                      </span>
                      <span className={s.quoteMeta}>
                        {quotes.ratingLabel}. {quotes.via}{' '}
                        <a href={review.sourceUrl} rel="noopener">{reviewSource?.label}</a>
                      </span>
                    </figcaption>
                  </figure>
                )}
                <AgentNote>{quotes.agentNote}</AgentNote>
              </section>

              {/* ---------- 02 SPEC SHEET ---------- */}
              <section className={s.section} id="features" aria-labelledby="v08-spec">
                <SectionHead n={1} id="v08-spec" title={spec.h2} dateKey="spec" />
                <p className={s.intro}>{spec.intro}</p>

                {spec.groups.map((g) => {
                  const fig = SPEC_FIGS.byGroup[g.id];
                  return (
                    <div key={g.id} className={s.group} id={g.id === 'how' ? 'how' : `spec-${g.id}`}>
                      <div className={s.groupHead}>
                        <h3 className={s.h3}>{g.h3}</h3>
                        <Updated dateKey={g.dateKey} />
                      </div>
                      <p className={s.groupLede}>{g.lede}</p>
                      <SpecTable rows={g.rows} caption={g.h3} />
                      {g.agentNote && <AgentNote>{g.agentNote}</AgentNote>}

                      {g.figure && (
                        <figure className={`${s.figure} ${fig.side === 'right' ? s.figRight : s.figLeft} ${g.figure.narrow ? s.figNarrow : ''}`}>
                          {g.figure.svg && (
                            <picture>
                              <source media="(max-width: 767px)" srcSet={g.figure.mobile} width={g.figure.mw} height={g.figure.mh} />
                              <img
                                className={s.diagram}
                                src={g.figure.desktop}
                                width={g.figure.w}
                                height={g.figure.h}
                                alt={g.figure.alt}
                                loading="lazy"
                                decoding="async"
                              />
                            </picture>
                          )}
                          {g.figure.pair && (
                            <div className={s.pair}>
                              <Shot shot={g.figure.top} alt={g.figure.top.alt} />
                              <Shot shot={g.figure.bottom} alt={g.figure.bottom.alt} />
                            </div>
                          )}
                          {!g.figure.svg && !g.figure.pair && <Shot shot={g.figure} alt={g.figure.alt} />}
                          <Caption n={fig.n}>{g.figure.caption}</Caption>
                        </figure>
                      )}
                    </div>
                  );
                })}
              </section>

              {/* ---------- 03 SECURITY ---------- */}
              <section className={s.section} aria-labelledby="v08-security">
                <SectionHead n={2} id="v08-security" title={security.h2} dateKey="security" />
                <p className={s.intro}>{security.intro}</p>
                <ol className={s.statements}>
                  {security.items.map((it) => (
                    <li key={it.n} className={s.statement}>
                      <span className={s.statementNum} aria-hidden="true">{it.n}</span>
                      <h3 className={s.statementH}>{it.h}</h3>
                      <p>{it.p}</p>
                    </li>
                  ))}
                </ol>
                <figure className={`${s.figure} ${s.figWide}`}>
                  <picture>
                    <source media="(max-width: 600px)" srcSet={security.figure.mobileSrc} width={security.figure.mobileW} height={security.figure.mobileH} />
                  <img
                    className={s.diagram}
                    src={security.figure.src}
                    width={security.figure.w}
                    height={security.figure.h}
                    alt={security.figure.alt}
                    loading="lazy"
                    decoding="async"
                  />
                  </picture>
                  <Caption n={SPEC_FIGS.last + 1}>{security.figure.caption}</Caption>
                </figure>
                <p className={s.linkLine}>
                  {security.links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
                </p>
                <AgentNote>{security.agentNote}</AgentNote>
              </section>

              {/* ---------- 04 LETTER ---------- */}
              <section className={s.section} aria-labelledby="v08-letter">
                <SectionHead n={3} id="v08-letter" title={letter.h2} dateKey="letter" />
                <article className={s.letter}>
                  <p className={s.salutation}>{letter.salutation}</p>
                  {letter.paragraphs.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
                  <p className={s.signature}>
                    <span className={s.signName}>{letter.signName}</span>
                    <span className={s.signRole}>{letter.signRole}</span>
                  </p>
                  <div className={s.ps}>
                    <p><strong className={s.psLabel}>{letter.psLabel}</strong> {letter.psIntro}</p>
                    <ul>
                      {letter.ps.map((x) => <li key={x}>{x}</li>)}
                    </ul>
                  </div>
                  <p className={s.linkLine}>
                    {letter.links.map((l) => (
                      <a key={l.href} href={l.href} rel={l.external ? 'noopener' : undefined}>{l.label}</a>
                    ))}
                  </p>
                </article>
                <AgentNote>{letter.agentNote}</AgentNote>
              </section>

              {/* ---------- 05 PRICING ---------- */}
              <section className={s.section} id="pricing" aria-labelledby="v08-pricing">
                <SectionHead n={4} id="v08-pricing" title={pricing.h2} dateKey="pricing" />
                <p className={s.intro}>
                  {pricing.sub} <Money eurEnabled={eurEnabled} text={seat ? pricing.subSeat : pricing.subFlat} />
                </p>
                <div className={s.plans}>
                  {tierRows.map((t) => {
                    const c = pricing.tiers[t.copy];
                    const bSeat = t.isBusiness ? seat : null;
                    const features = (bSeat ? bSeat.features : c.features).filter(noCaps);
                    return (
                      <article key={t.key} className={`${s.plan} ${t.accent ? s.planAccent : ''}`}>
                        <div className={s.planHead}>
                          <h3 className={s.planName}>{t.name}</h3>
                          {t.accent && <p className={s.planFlag}>{pricing.mostPopular}</p>}
                        </div>
                        <p className={s.planPrice}>
                          <Currency eurEnabled={eurEnabled} usd={t.price.usd} eur={t.price.eur} />{' '}
                          <span className={s.planPer}>
                            {t.price.cents === 0 ? pricing.perForever : bSeat ? bSeat.per : pricing.perMonth}
                          </span>
                        </p>
                        {t.price.cents > 0 && eurEnabled && (
                          <Currency eurEnabled={eurEnabled} usd={null} eur={<p className={s.planNote}>{pricing.inclVat}</p>} />
                        )}
                        {bSeat && <p className={s.planNote}>{bSeat.minimum}</p>}
                        <p className={s.planDesc}>{bSeat ? bSeat.desc : c.desc}</p>
                        <ul className={s.planList}>
                          {features.map((f) => <li key={f}><Money eurEnabled={eurEnabled} text={f} /></li>)}
                        </ul>
                        <a href={t.href} className={t.accent ? s.btnPrimary : s.btnSecondary}>{c.cta}</a>
                      </article>
                    );
                  })}
                </div>
                <p className={s.priceFoot}>
                  {pricing.foot} <a href="mailto:hello@mcpemails.com">{pricing.footContact}</a>.{' '}
                  <a href="/pricing">{pricing.footCompare}</a>. {pricing.footBusiness}{' '}
                  <a href="/for/business">{pricing.footBusinessLink}</a>.
                </p>
                <AgentNote>{pricing.agentNote}</AgentNote>
              </section>

              {/* ---------- 06 FAQ ---------- */}
              <section className={s.section} id="faq" aria-labelledby="v08-faq">
                <SectionHead n={5} id="v08-faq" title={faq.h2} dateKey="faq" />
                <p className={s.intro}>{faq.intro}</p>
                <div className={s.faq}>
                  {faqItems.map((item) => (
                    <div key={item.q} className={s.faqItem}>
                      <h3 className={s.faqQ}>{item.q}</h3>
                      <p className={s.faqA}><Money eurEnabled={eurEnabled} text={item.a} /></p>
                    </div>
                  ))}
                </div>
                <AgentNote>{faq.agentNote}</AgentNote>
              </section>

              {/* ---------- 07 START ---------- */}
              <section className={`${s.section} ${s.start}`} aria-labelledby="v08-start">
                <SectionHead n={6} id="v08-start" title={start.h2} dateKey="start" />
                <p className={s.intro}>{start.p}</p>
                <div className={s.ctaRow}>
                  <a href="/signup" className={s.btnPrimary}>{start.ctaPrimary}</a>
                  <a href="/connect" className={s.btnSecondary}>{start.ctaSecondary}</a>
                </div>
                <p className={s.signInLine}><a href="/login">{start.signIn}</a></p>
                <AgentNote>{start.agentNote}</AgentNote>
              </section>
            </div>
          </div>
        </div>
      </main>

      {/* ================= FOOTER ================= */}
      <footer className={s.footer}>
        <div className={s.wrap}>
          <div className={s.footGrid}>
            <div className={s.footBrand}>
              <a href="/" className={s.logoLink}>
                <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" className={s.logo} loading="lazy" />
              </a>
              <p>{footer.tagline}</p>
              <dl className={s.footContact}>
                <dt>{footer.endpointLabel}</dt>
                <dd><code className={s.code}>{MCP_URL}</code></dd>
                <dt>{footer.supportLabel}</dt>
                <dd><a href="mailto:support@mcpemails.com">support@mcpemails.com</a></dd>
                <dt>{footer.salesLabel}</dt>
                <dd><a href="mailto:hello@mcpemails.com">hello@mcpemails.com</a></dd>
              </dl>
            </div>
            {footer.columns.map((col) => (
              <div key={col.h}>
                <p className={s.footHeading}>{col.h}</p>
                <ul className={s.footLinks}>
                  {col.links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}
                </ul>
              </div>
            ))}
          </div>
          <p className={s.langs}>
            <span className={s.footHeading}>{footer.languagesLabel}</span>
            {footer.languages.map((l) => (
              <a key={l.href} href={l.href} hrefLang={l.lang} lang={l.lang}>{l.label}</a>
            ))}
          </p>
          <p className={s.legal}>{footer.copyright} {footer.legal}</p>
          <p className={s.legal}>{footer.entity} {footer.colophon}</p>
        </div>
      </footer>
    </div>
  );
}
