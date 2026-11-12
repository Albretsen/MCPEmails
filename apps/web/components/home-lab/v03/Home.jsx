/**
 * Homepage Lab variant v03, "The Letter" (staging only, English only).
 *
 * The page is a printed letter from MCPEmails: letterhead, date, a Re: line
 * as the H1, "Dear reader,", two parallel tracks (your team, you) from the
 * hero down to pricing, postmarks as the only ornament, real changelog
 * entries dating every chapter, a signature and Start free as the P.S.
 *
 * Server component. Interaction lives in two islands: HeroClip (play the one
 * clip on request) and Money (USD or EUR, like the live Pricing component).
 */
import homeMessages from '../../../messages/en/home.json';
import { getEntries } from '@/lib/changelog/entries.mjs';
import { PLANS as CATALOGUE, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { REVIEWS } from '../../marketing/reviews.mjs';
import styles from './Home.module.css';
import Postmark from './Postmark';
import HeroClip from './HeroClip';
import Money from './Money';
import { TINTED_TRACK, SIGNATURE_SIDE } from './rng.mjs';
import {
  MCP_URL, letterhead, hero, whatIs, tracks, day, approval, security, teams,
  pricing as pricingCopy, faq as faqCopy, changelog as changelogCopy, closing, footer,
} from './copy.mjs';

const FONT_URL = new URL('./fonts/archivo-latin-400-800-wdth62-100.woff2', import.meta.url).pathname;
const A = '/home-lab/assets/a';
const C = '/home-lab/assets/c';

/** Characters this page never prints: a long dash, or markup that would render literally. */
const UNPRINTABLE = /[\u2014<]/;

function longDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** Render the light markup the FAQ messages may carry (<b>, <strong>, <code>, <em>). */
function rich(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  const out = [];
  const re = /<(b|strong|code|em)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const Tag = m[1] === 'b' ? 'strong' : m[1];
    out.push(<Tag key={k++}>{m[2]}</Tag>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Track({ which, children }) {
  return (
    <div className={styles.track} data-track={which} data-tinted={TINTED_TRACK === which ? '' : undefined}>
      <p className={styles.trackLabel}>{tracks[which]}</p>
      {children}
    </div>
  );
}

function Shipped({ entry }) {
  if (!entry) return null;
  return (
    <p className={styles.shipped}>
      <span className={styles.shippedLabel}>{changelogCopy.shipped}</span>
      <time dateTime={entry.date}>{shortDate(entry.date)}</time>
      <a className={styles.link} href="/changelog">{entry.title}</a>
    </p>
  );
}

function Chapter({ id, kicker, title, intro, entry, children }) {
  return (
    <section className={styles.chapter} id={id} aria-labelledby={`${id}-h`}>
      <div className={styles.margin}>
        <p className={styles.kicker}>{kicker}</p>
        <Shipped entry={entry} />
      </div>
      <div className={styles.chapterBody}>
        <h2 id={`${id}-h`} className={styles.h2}>{title}</h2>
        {intro && <p className={styles.intro}>{intro}</p>}
        {children}
      </div>
    </section>
  );
}

function Still({ name, alt, w, h, caption, narrow = false }) {
  return (
    <figure className={narrow ? `${styles.still} ${styles.stillNarrow}` : styles.still}>
      <picture>
        <source type="image/avif" srcSet={`${A}/${name}.avif`} />
        <img src={`${A}/${name}.webp`} width={w} height={h} alt={alt} loading="lazy" decoding="async" />
      </picture>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}

function LinkList({ links, className }) {
  return (
    <ul className={className || styles.linkList}>
      {links.map((l) => (
        <li key={l.href}><a className={styles.link} href={l.href}>{l.label}</a></li>
      ))}
    </ul>
  );
}

/**
 * @param {{ stripePrices: unknown, eurEnabled: boolean, businessSeat: unknown,
 *   faqItems: { q: string, a: string }[], locale: string }} props
 */
export default function Home({ stripePrices, eurEnabled = false, businessSeat = null, faqItems = [], locale = 'en' }) {

  // Plan features and the default pricing sub are facts kept in the live
  // home messages; this variant is English only, so it reads the en file.
  const tiersMsg = homeMessages.pricing.tiers;
  const prices = /** @type {Record<string, any> | null} */ (stripePrices);
  const seat = /** @type {{ card: any, home: any } | null} */ (businessSeat);

  /* Changelog: newest first, read at render. Each chapter is dated by the
     newest entry that matches it; the last chapter lists the newest six. */
  const entries = getEntries().filter((e) => !UNPRINTABLE.test(`${e.title} ${e.body}`));
  const used = new Set();
  const newest = (re) => {
    const hit = entries.find((e) => !used.has(e) && re.test(e.title));
    if (hit) used.add(hit);
    return hit ?? null;
  };
  const ch = {
    approval: newest(/ask before|approv/i),
    day: newest(/morning brief|snooze|draft/i),
    security: newest(/password|deletion|encrypt|stored/i),
    teams: newest(/workspace|invite|member/i),
    providers: newest(/setup guides|server settings|connect/i),
  };
  const latest = entries.slice(0, 6);
  const letterDate = entries[0]?.date ?? '2026-11-12';

  /* Pricing, as in components/marketing/Sections.jsx Pricing. */
  const tiers = [
    { key: 'free', priceKey: 'free', planId: 'free', per: pricingCopy.perForever, href: '/signup', accent: false },
    { key: 'personal', priceKey: 'personal', planId: 'personal', per: pricingCopy.perMonth, href: pricingUpgradeHref('personal', false, false, locale), accent: false },
    { key: 'solo', priceKey: 'solo', planId: 'solo', per: pricingCopy.perMonth, href: pricingUpgradeHref('solo', false, false, locale), accent: true },
    { key: 'business', priceKey: 'pro', planId: 'pro', per: pricingCopy.perMonth, href: pricingUpgradeHref('pro', false, false, locale), accent: false },
  ].map((tier) => {
    const live = prices?.[tier.priceKey]?.monthlyCents;
    const cents = live != null && live > 0 ? live : CATALOGUE[tier.priceKey].monthlyPriceCents;
    const usd = formatUsdCopy(cents, locale);
    const eurCents = eurCentsFor(prices?.[tier.priceKey]?.eurMonthlyCents, cents) ?? cents;
    const eur = formatMoneyCents(eurCents, 'eur', locale);
    const seatCard = tier.key === 'business' ? seat?.card ?? null : null;
    const features = seatCard ? seatCard.features : tiersMsg[tier.key].features;
    return {
      ...tier,
      name: planDisplayName(tier.planId),
      usd,
      eur,
      paid: cents > 0,
      seatCard,
      desc: seatCard ? seatCard.desc : pricingCopy.desc[tier.key],
      features: Array.isArray(features) ? features : [],
    };
  });
  // Our own sentence, not the shared sub: customer copy never mentions action caps.
  const pricingSub = seat ? pricingCopy.sub : pricingCopy.subFlat;
  const review = REVIEWS[0];
  const faqList = Array.isArray(faqItems) ? faqItems : [];

  return (
    <div className={styles.page}>
      {/* Real preload elements, first in the body: react-dom preload() only
          reaches the RSC payload here (home-lab/builder-rules.md). The poster
          is preloaded for desktop only, where it is the LCP; on phones it sits
          below the first screen and the LCP is the H1 text. */}
      <link rel="preload" href={FONT_URL} as="font" type="font/woff2" crossOrigin="anonymous" />
      <link rel="preload" href={`${A}/card-draft-send-light-desktop-poster.avif`} as="image" type="image/avif" media="(min-width: 768px)" fetchPriority="high" />
      <div className={styles.sheet}>
        <header className={styles.letterhead}>
          <div className={styles.lhTop}>
            <a href="/" className={styles.brand} aria-label={letterhead.homeLabel}>
              <img src="/logo-wordmark.svg" width={280} height={48} alt="MCPEmails" />
            </a>
            <address className={styles.lhAddress}>
              {letterhead.address.map((line) => <span key={line}>{line}</span>)}
              <a className={styles.link} href={`mailto:${letterhead.contact}`}>{letterhead.contact}</a>
            </address>
          </div>
          <nav className={styles.lhNav} aria-label={letterhead.navLabel}>
            <ul>
              {letterhead.nav.map((l) => (
                <li key={l.href}><a className={styles.link} href={l.href}>{l.label}</a></li>
              ))}
            </ul>
            <a className={styles.btnPrimary} href="/signup">{letterhead.cta}</a>
          </nav>
        </header>

        <main>
          {/* ---------- The letter opens: date, Re: line, Dear reader ---------- */}
          <section className={styles.opening} aria-labelledby="v03-h1">
            <p className={styles.dateline}>
              {hero.place}, <time dateTime={letterDate}>{longDate(letterDate)}</time>
            </p>
            <div className={styles.heroGrid}>
              <div className={styles.heroText}>
                <h1 id="v03-h1" className={styles.h1}>
                  <span className={styles.re}>{hero.re}</span>
                  <span className={styles.poster}>{hero.poster}</span>
                </h1>
              </div>
              <figure className={styles.heroFigure}>
                <HeroClip alt={hero.clip.alt} videoLabel={hero.clip.videoLabel} play={hero.clip.play} playLong={hero.clip.playLong} />
                <figcaption className={styles.caption}>{hero.clip.caption}</figcaption>
              </figure>
              <div className={styles.heroBody}>
                <div className={styles.salutation}>{hero.salutation}</div>
                <p className={styles.lead}>{hero.lead}</p>
                {hero.body.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <div className={styles.ctaRow}>
                  <a className={styles.btnPrimary} href="/signup">{hero.ctaPrimary}</a>
                  <a className={styles.btnQuiet} href="/connect">{hero.ctaSecondary}</a>
                </div>
                <p className={styles.note}>
                  {hero.ctaNote} <a className={styles.link} href="/docs/clients">MCP client setup</a>
                </p>
              </div>
              <div className={styles.whatIs}>
                <h2 className={styles.h2small}>{whatIs.h}</h2>
                {whatIs.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <LinkList links={whatIs.links} />
              </div>
            </div>
          </section>

          <Postmark date={letterDate} index={0} />

          {/* ---------- Chapter one: how it works, one day ---------- */}
          <Chapter id="how" kicker={day.kicker} title={day.h} intro={day.intro} entry={ch.day}>
            <ol className={styles.steps}>
              {day.steps.map((s) => (
                <li key={s.n} className={styles.step}>
                  <span className={styles.stepN} aria-hidden="true">{s.n}</span>
                  <h3 className={styles.h3}>{s.h}</h3>
                  <p className={styles.para}>{s.p}</p>
                </li>
              ))}
            </ol>
            <p className={styles.endpoint}>
              <span className={styles.endpointLabel}>{day.urlLabel}</span>
              <code>{MCP_URL}</code>
            </p>
            {day.times.map((slot) => (
              <div key={slot.time} className={styles.slot}>
                <h3 className={styles.slotHead}>
                  <time>{slot.time}</time> <span>{slot.label}</span>
                </h3>
                <div className={styles.tracks}>
                  <Track which="team">
                    <h4 className={styles.h4}>{slot.team.h}</h4>
                    {slot.team.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                  </Track>
                  <Track which="you">
                    <h4 className={styles.h4}>{slot.you.h}</h4>
                    {slot.you.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                  </Track>
                </div>
              </div>
            ))}
          </Chapter>

          <Postmark date={ch.approval?.date ?? letterDate} index={1} />

          {/* ---------- Chapter two: approval ---------- */}
          <Chapter id="features" kicker={approval.kicker} title={approval.h} intro={approval.intro} entry={ch.approval}>
            <div className={styles.tracks}>
              <Track which="team">
                <h3 className={styles.h3}>{approval.team.h}</h3>
                {approval.team.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <Still name="card-approval-light-mobile" w={720} h={602} alt={approval.team.img.alt} caption={approval.team.img.caption} />
              </Track>
              <Track which="you">
                <h3 className={styles.h3}>{approval.you.h}</h3>
                {approval.you.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <Still name="card-draft-sent-light-mobile" w={720} h={548} alt={approval.you.img.alt} caption={approval.you.img.caption} />
              </Track>
            </div>
          </Chapter>

          <Postmark date={ch.security?.date ?? letterDate} index={2} />

          {/* ---------- Chapter three: what we keep, Stockholm ---------- */}
          <Chapter id="security" kicker={security.kicker} title={security.h} intro={security.intro} entry={ch.security}>
            <figure className={styles.exhibit}>
              <img src={`${C}/diagram-stored.svg`} width={960} height={400} alt={security.diagram.alt} loading="lazy" decoding="async" />
              <figcaption className={styles.caption}>{security.diagram.caption}</figcaption>
            </figure>
            <div className={styles.tracks}>
              <Track which="team">
                <h3 className={styles.h3}>{security.team.h}</h3>
                {security.team.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <LinkList links={security.team.links} />
              </Track>
              <Track which="you">
                <h3 className={styles.h3}>{security.you.h}</h3>
                {security.you.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <LinkList links={security.you.links} />
              </Track>
            </div>
          </Chapter>

          <Postmark date={ch.teams?.date ?? letterDate} index={3} />

          {/* ---------- Chapter four: teams, providers, a review ---------- */}
          <Chapter id="teams" kicker={teams.kicker} title={teams.h} intro={teams.intro} entry={ch.teams}>
            <div className={styles.tracks}>
              <Track which="team">
                <h3 className={styles.h3}>{teams.team.h}</h3>
                {teams.team.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                {seat && <p className={styles.para}>{teams.team.seat}</p>}
                {review && (
                  <figure className={styles.review}>
                    <h4 className={styles.h4}>{teams.review.h}</h4>
                    <blockquote className={styles.reviewQuote}>
                      <p>{review.quote}</p>
                    </blockquote>
                    <figcaption className={styles.reviewBy}>
                      <span>{review.author}, {review.role},{' '}</span>
                      <a className={styles.link} href={review.url} rel="noopener">{review.company}</a>
                      <span className={styles.reviewMeta}>
                        Rated {review.rating} out of 5.{' '}
                        <a className={styles.link} href={review.sourceUrl} rel="noopener">{teams.review.via}</a>
                      </span>
                    </figcaption>
                  </figure>
                )}
              </Track>
              <Track which="you">
                <h3 className={styles.h3}>{teams.you.h}</h3>
                {teams.you.p.map((p) => <p key={p} className={styles.para}>{p}</p>)}
                <Still name="dashboard-connect-providers-light-mobile" w={780} h={1688} alt={teams.you.img.alt} caption={teams.you.img.caption} narrow />
              </Track>
            </div>
            <div className={styles.providers} id="providers">
              <h3 className={styles.h3}>{teams.providers.h}</h3>
              <p className={styles.para}>{teams.providers.p}</p>
              <figure className={styles.wall}>
                <picture>
                  <source media="(max-width: 767px)" srcSet={`${C}/logo-wall-mono-mobile.svg`} width={358} height={620} />
                  <img src={`${C}/logo-wall-mono.svg`} width={960} height={240} alt={teams.providers.wallAlt} loading="lazy" decoding="async" />
                </picture>
              </figure>
              <LinkList links={teams.providers.links} className={styles.providerLinks} />
              <Shipped entry={ch.providers} />
              <LinkList links={teams.providers.more} />
            </div>
          </Chapter>

          <Postmark date={letterDate} index={4} />

          {/* ---------- Pricing: both tracks end here ---------- */}
          <section className={styles.chapter} id="pricing" aria-labelledby="pricing-h">
            <div className={styles.margin}>
              <p className={styles.kicker}>{pricingCopy.kicker}</p>
            </div>
            <div className={styles.chapterBody}>
              <h2 id="pricing-h" className={styles.h2}>{pricingCopy.h}</h2>
              <p className={styles.intro}>
                <Money usd={pricingSub} eur={euroizeAmounts(pricingSub, locale)} eurEnabled={eurEnabled} />
              </p>
              <div className={styles.priceList}>
                {tiers.map((tier) => (
                  <div key={tier.key} className={styles.price} data-accent={tier.accent ? '' : undefined}>
                    <p className={styles.priceTrack}>{pricingCopy.tracks[tier.key]}</p>
                    <h3 className={styles.priceName}>{tier.name}</h3>
                    <p className={styles.priceNum}>
                      <Money usd={tier.usd} eur={tier.eur} eurEnabled={eurEnabled} />
                      <small> {tier.seatCard ? tier.seatCard.per : tier.per}</small>
                    </p>
                    {tier.paid && eurEnabled && (
                      <p className={styles.priceSmall}>
                        <Money usd="" eur={pricingCopy.vat} eurEnabled={eurEnabled} />
                      </p>
                    )}
                    {tier.seatCard && <p className={styles.priceSmall}>{tier.seatCard.minimum}</p>}
                    <p className={styles.priceDesc}>{tier.desc}</p>
                    <ul className={styles.priceFeatures}>
                      {tier.features.map((f) => (
                        <li key={f}><Money usd={f} eur={euroizeAmounts(f, locale)} eurEnabled={eurEnabled} /></li>
                      ))}
                    </ul>
                    <a className={tier.accent ? styles.btnPrimary : styles.btnQuiet} href={tier.href}>
                      {pricingCopy.cta[tier.key]}
                    </a>
                  </div>
                ))}
              </div>
              <p className={styles.note}>{pricingCopy.footnote}</p>
              <ul className={styles.inlineLinks}>
                <li><a className={styles.link} href="/pricing">{pricingCopy.compare}</a></li>
                <li><a className={styles.link} href="/for/business">{pricingCopy.business}</a></li>
                <li><a className={styles.link} href="mailto:hello@mcpemails.com">{pricingCopy.contact}</a></li>
              </ul>
            </div>
          </section>

          <Postmark date={letterDate} index={5} />

          {/* ---------- FAQ: every item of home.faq.items, shown in full ---------- */}
          <section className={styles.chapter} id="faq" aria-labelledby="faq-h">
            <div className={styles.margin}>
              <p className={styles.kicker}>{faqCopy.kicker}</p>
            </div>
            <div className={styles.chapterBody}>
              <h2 id="faq-h" className={styles.h2}>{faqCopy.h}</h2>
              <p className={styles.intro}>{faqCopy.intro}</p>
              <div className={styles.faq}>
                {faqList.map((item) => (
                  <div key={item.q} className={styles.faqItem}>
                    <h3 className={styles.faqQ}>{item.q}</h3>
                    <p className={styles.faqA}>
                      {item.a.includes('<')
                        ? rich(item.a)
                        : <Money usd={item.a} eur={euroizeAmounts(item.a, locale)} eurEnabled={eurEnabled} />}
                    </p>
                  </div>
                ))}
              </div>
              <p className={styles.note}>
                {faqCopy.more} <a className={styles.link} href="/help">Help center</a>
              </p>
            </div>
          </section>

          <Postmark date={letterDate} index={6} />

          {/* ---------- Recently shipped, from the public changelog ---------- */}
          <section className={styles.chapter} id="changelog" aria-labelledby="changelog-h">
            <div className={styles.margin}>
              <p className={styles.kicker}>{changelogCopy.kicker}</p>
            </div>
            <div className={styles.chapterBody}>
              <h2 id="changelog-h" className={styles.h2}>{changelogCopy.h}</h2>
              <p className={styles.intro}>{changelogCopy.intro}</p>
              <ol className={styles.log}>
                {latest.map((e) => (
                  <li key={`${e.date}-${e.title}`} className={styles.logItem}>
                    <p className={styles.logMeta}>
                      <time dateTime={e.date}>{shortDate(e.date)}</time>
                      <span className={styles.logKind}>{changelogCopy.kinds[e.kind] ?? e.kind}</span>
                    </p>
                    <h3 className={styles.logTitle}>{e.title}</h3>
                    <p className={styles.para}>{e.body}</p>
                  </li>
                ))}
              </ol>
              <p><a className={styles.link} href="/changelog">{changelogCopy.all}</a></p>
            </div>
          </section>

          {/* ---------- Signature and the P.S. ---------- */}
          <section className={styles.closing} data-side={SIGNATURE_SIDE} aria-label="Signature and postscript">
            <div className={styles.signature}>
              <p className={styles.signoff}>{closing.signoff}</p>
              <p className={styles.signName}>{closing.name}</p>
              <p className={styles.signRole}>{closing.role}</p>
              <a className={styles.link} href="/about">{closing.about}</a>
            </div>
            <div className={styles.ps}>
              <p className={styles.psText}><strong className={styles.psMark}>{closing.ps}</strong> {closing.psText}</p>
              <div className={styles.ctaRow}>
                <a className={styles.btnPrimary} href="/signup">{closing.psCta}</a>
                <a className={styles.btnQuiet} href="/connect">{closing.psSecondary}</a>
              </div>
            </div>
          </section>
        </main>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footInner}>
          <div className={styles.footLead}>
            <img src="/logo-wordmark.svg" width={280} height={48} alt="MCPEmails" loading="lazy" />
            <p>{footer.tagline}</p>
            <p className={styles.footSmall}>
              <span className={styles.footLabel}>{footer.mcpLabel}</span> <code>{MCP_URL}</code>
            </p>
            <ul className={styles.footContact}>
              {footer.contact.map((c) => <li key={c.href}><a className={styles.link} href={c.href}>{c.label}</a></li>)}
            </ul>
          </div>
          {footer.groups.map((g) => (
            <div key={g.h} className={styles.footGroup}>
              <h2 className={styles.footH}>{g.h}</h2>
              <LinkList links={g.links} className={styles.footList} />
            </div>
          ))}
        </div>
        <div className={styles.footBottom}>
          <ul className={styles.langs} aria-label={footer.languagesLabel}>
            {footer.languages.map((l) => (
              <li key={l.href}>
                <a className={styles.link} href={l.href} hrefLang={l.lang} aria-current={l.lang === 'en' ? 'true' : undefined}>{l.label}</a>
              </li>
            ))}
          </ul>
          <p className={styles.footSmall}>{footer.facts}</p>
          <p className={styles.footSmall}>{footer.legal} {footer.copyright}</p>
        </div>
      </footer>
    </div>
  );
}
