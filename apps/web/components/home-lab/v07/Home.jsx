/**
 * Homepage Lab v07, "The Front Page" (staging only, English only).
 *
 * A newspaper front page: masthead with the Oslo date and Stockholm, a lead
 * story about the draft card across eight columns, a four-column side rail,
 * then providers as field-guide plates, how it works, changelog dispatches,
 * pricing, readers' questions and a colophon. Server component; the only
 * client island is Currency.jsx (USD or EUR prices).
 */
import { getEntries } from '@/lib/changelog/entries.mjs';
import { PLANS, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { REVIEWS, REVIEW_SOURCES } from '../../marketing/reviews.mjs';
import Currency from './Currency';
import { osloToday, shortDate } from './today.mjs';
import {
  ACCENT_PLATE, MAT_TONE, RULE_STYLE, RAIL_PROVIDERS_FIRST, DISPATCH_COUNT,
} from './rng.mjs';
import {
  REPO_URL, CODE_URL, NPM_URL, MCP_URL,
  masthead, lead, rail, providers, how, dispatches, pricing, faq, colophon, footer,
} from './copy.mjs';
import s from './Home.module.css';

const A = '/home-lab/assets/a/';
// The two faces on the first screen: the dek (LCP) is Plex Sans, the H1 Plex Sans Condensed.
const SANS_FONT = new URL('./fonts/plex-sans-400-sub.woff2', import.meta.url).pathname;
const COND_FONT = new URL('./fonts/plex-cond-600-sub.woff2', import.meta.url).pathname;
const C = '/home-lab/assets/c/';

/* ---------- small pieces ---------- */

function Pic({ name, w, h, alt, eager = false, className, mobile = null }) {
  return (
    <picture>
      {mobile && (
        <>
          <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}${mobile.name}.avif`} width={mobile.w} height={mobile.h} />
          <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}${mobile.name}.webp`} width={mobile.w} height={mobile.h} />
        </>
      )}
      <source type="image/avif" srcSet={`${A}${name}.avif`} />
      <source type="image/webp" srcSet={`${A}${name}.webp`} />
      <img
        src={`${A}${name}.webp`}
        width={w}
        height={h}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding={eager ? 'sync' : 'async'}
        fetchPriority={eager ? 'high' : undefined}
        className={className}
      />
    </picture>
  );
}

/** A framed print: thin ink frame, cream mat, caption in small caps under it. */
function Print({ children, caption, n, className = '' }) {
  return (
    <figure className={`${s.print} ${className}`}>
      <div className={s.mat}>{children}</div>
      {caption && (
        <figcaption className={s.printCap}>
          {n && <span className={s.printNum}>{n}</span>}
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

function Kicker({ children }) {
  return <p className={s.kicker}>{children}</p>;
}

function SectionHead({ kicker, id, children }) {
  return (
    <div className={s.sectionHead}>
      <Kicker>{kicker}</Kicker>
      <h2 id={id} className={s.h2}>{children}</h2>
    </div>
  );
}

const LOGOS = {
  gmail: [27.71, 'Gmail'],
  outlook: [25.66, 'Outlook / Microsoft 365'],
  icloud: [29.94, 'iCloud Mail'],
  fastmail: [26, 'Fastmail'],
  yahoo: [25.73, 'Yahoo Mail'],
  yandex: [26, 'Yandex Mail'],
  gmx: [42.03, 'GMX'],
  webde: [24, 'WEB.DE'],
  imap: [26, 'Any IMAP inbox'],
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

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
  return {
    cents,
    usd: formatUsdCopy(cents, 'en'),
    eur: formatMoneyCents(eurCents, 'eur', 'en'),
  };
}

/** Text with dollar amounts, rendered in EUR for an EU visitor. */
function Money({ text, eurEnabled }) {
  const eur = euroizeAmounts(text, 'en');
  if (eur === text) return text;
  return <Currency eurEnabled={eurEnabled} usd={text} eur={eur} />;
}

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
  const today = osloToday();
  const entries = getEntries().slice(0, DISPATCH_COUNT);
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

  const railProviders = (
    <article className={s.railItem} key="providers">
      <Kicker>{rail.providers.kicker}</Kicker>
      <h3 className={s.h3}>{rail.providers.h}</h3>
      <p>{rail.providers.p}</p>
      <a className={s.more} href="#providers">{rail.providers.link}</a>
    </article>
  );

  const railPlans = (
    <article className={s.railItem} key="plans">
      <Kicker>{rail.plans.kicker}</Kicker>
      <h3 className={s.h3}>{rail.plans.h}</h3>
      <table className={s.railTable}>
        <tbody>
          {tierRows.map((t) => (
            <tr key={t.key}>
              <th scope="row">{t.name}</th>
              <td>
                <Currency eurEnabled={eurEnabled} usd={t.price.usd} eur={t.price.eur} />
                {t.price.cents > 0 && (
                  <span className={s.railPer}>{t.isBusiness && seat ? rail.plans.perPerson : rail.plans.perMonth}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <a className={s.more} href="#pricing">{rail.plans.link}</a>
    </article>
  );

  return (
    <div className={s.page} data-rule={RULE_STYLE} style={{ '--v07-mat': MAT_TONE }}>
      <link rel="preload" href={SANS_FONT} as="font" type="font/woff2" crossOrigin="anonymous" />
      <link rel="preload" href={COND_FONT} as="font" type="font/woff2" crossOrigin="anonymous" />
      {/* ================= MASTHEAD ================= */}
      <header className={s.masthead}>
        <div className={s.wrap}>
          <div className={s.edition}>
            <span>
              {masthead.editionPrefix} <time dateTime={today.iso}>{today.label}</time>
            </span>
            <span className={s.editionPlace}>
              <strong>{masthead.place}</strong> <span className={s.editionNote}>{masthead.placeNote}</span>
            </span>
            <span className={s.editionPrice}>{masthead.price}</span>
          </div>
          <div className={s.nameplate}>
            <a href="/" className={s.logoLink}>
              <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" className={s.logo} />
            </a>
            <p className={s.strap}>{masthead.strap}</p>
          </div>
          <nav className={s.nav} aria-label={masthead.navLabel}>
            <ul className={s.navList}>
              {masthead.nav.map((item) => (
                <li key={item.href}><a href={item.href}>{item.label}</a></li>
              ))}
            </ul>
            <div className={s.navActions}>
              <a href="/login" className={s.navSignIn}>{masthead.signIn}</a>
              <a href="/signup" className={s.btnPrimary}>{masthead.start}</a>
            </div>
          </nav>
        </div>
      </header>

      <main id="features">
        {/* ================= FRONT PAGE: LEAD + RAIL ================= */}
        <div className={`${s.wrap} ${s.front}`}>
          <article className={s.lead}>
            <Kicker>
              {lead.kicker} <span className={s.kickerSep} aria-hidden="true">/</span> {lead.kickerTopic}
            </Kicker>
            <h1 className={s.h1}>
              <span className={s.h1a}>{lead.h1a}</span> <span className={s.h1b}>{lead.h1b}</span>
            </h1>
            <p className={s.dek}>{lead.dek}</p>
            <div className={s.ctaRow}>
              <a href="/signup" className={s.btnPrimary}>{lead.ctaPrimary}</a>
              <a href="/docs/clients" className={s.btnSecondary}>{lead.ctaSecondary}</a>
            </div>
            <ul className={s.ctaMeta}>
              {lead.ctaMeta.map((m) => <li key={m}>{m}</li>)}
            </ul>

            {/* Hero: three frames, same size, captioned 1, 2, 3 */}
            <div className={s.frames} role="group" aria-label={lead.framesLabel}>
              <Print n="1" caption={<><b>{lead.frames[0].title}.</b> {lead.frames[0].caption}</>} className={s.frame}>
                <Pic
                  name="dashboard-connect-providers-light-mobile" w={780} h={1688}
                  alt="MCPEmails Connect an inbox dialog with provider tiles for IMAP / SMTP, Gmail, iCloud Mail, Yahoo Mail, Zoho Mail, Yandex Mail, Fastmail and Outlook."
                  className={`${s.frameImg} ${s.focusConnect}`}
                />
              </Print>
              <Print n="2" caption={<><b>{lead.frames[1].title}.</b> {lead.frames[1].caption}</>} className={s.frame}>
                <Pic
                  name="card-draft-light-mobile" w={720} h={878}
                  alt="MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons."
                  className={`${s.frameImg} ${s.focusAsk}`}
                />
              </Print>
              <Print n="3" caption={<><b>{lead.frames[2].title}.</b> {lead.frames[2].caption}</>} className={s.frame}>
                <Pic
                  name="card-approval-light-mobile" w={720} h={602}
                  alt="MCPEmails approval card in a chat: a reply to billing@supplier.example waiting for approval, with Reject and Approve in browser buttons and the note that no agent can approve a send."
                  className={`${s.frameImg} ${s.focusApprove}`}
                />
              </Print>
            </div>

            <div className={s.leadBody}>
              {lead.body.map((block) => (
                <section key={block.h} className={s.leadBlock}>
                  <h2 className={s.h3}>{block.h}</h2>
                  {block.p?.map((p) => <p key={p}>{p}</p>)}
                  {block.steps && (
                    <>
                      <ol className={s.steps}>
                        {block.steps.map((st) => <li key={st}>{st}</li>)}
                      </ol>
                      <p className={s.endpoint}>
                        <span className={s.label}>Server URL</span>
                        <code>{MCP_URL}</code>
                      </p>
                      <p>{block.after}</p>
                    </>
                  )}
                  {block.prompts && (
                    <ul className={s.prompts}>
                      {block.prompts.map((pr) => <li key={pr}>{pr}</li>)}
                    </ul>
                  )}
                </section>
              ))}
            </div>

            {/* Motion: before/after crossfade, 5 s loop, paused on hover */}
            <figure className={s.fade} aria-label={lead.crossfade.label}>
              <div className={s.mat}>
                <div className={s.fadeStage} tabIndex={0}>
                  <Pic
                    name="card-draft-light-desktop" w={1364} h={776}
                    mobile={{ name: 'card-draft-light-mobile', w: 720, h: 878 }}
                    alt="Before: the MCPEmails draft card in a chat, a reply to jordan@example.com with Save and Send buttons."
                    className={s.fadeBefore}
                  />
                  <Pic
                    name="card-draft-sent-light-desktop" w={1364} h={462}
                    mobile={{ name: 'card-draft-sent-light-mobile', w: 720, h: 548 }}
                    alt="After: the same card reads Sent to jordan@example.com, with the subject and the start of the message."
                    className={s.fadeAfter}
                  />
                </div>
              </div>
              <figcaption className={s.printCap}>
                <span className={s.fadeCapBefore}>{lead.crossfade.before}</span>{' '}
                <span className={s.fadeCapAfter}>{lead.crossfade.after}</span>{' '}
                <span className={s.fadeNote}>{lead.crossfade.note}</span>
              </figcaption>
            </figure>
          </article>

          <aside className={s.rail} aria-labelledby="v07-rail">
            <h2 id="v07-rail" className={s.railH2}>{rail.h2}</h2>
            {RAIL_PROVIDERS_FIRST ? [railProviders, railPlans] : [railPlans, railProviders]}

            {review && (
              <article className={s.railItem}>
                <Kicker>{rail.letter.kicker}</Kicker>
                <h3 className={s.h3}>{rail.letter.h}</h3>
                <blockquote className={s.letter} cite={review.url}>
                  <p>&ldquo;{review.quote}&rdquo;</p>
                </blockquote>
                <p className={s.letterBy}>
                  {review.author}, {review.role},{' '}
                  {review.url ? <a href={review.url} rel="noopener">{review.company}</a> : review.company}
                </p>
                <p className={s.letterMeta}>
                  <span aria-hidden="true" className={s.stars}>{'★'.repeat(review.rating)}</span>{' '}
                  {rail.letter.rated.replace('{rating}', String(review.rating)).replace('{source}', reviewSource.label)}
                  {review.sourceUrl && (
                    <>
                      {' · '}
                      <a href={review.sourceUrl} rel="noopener">{rail.letter.readOn.replace('{source}', reviewSource.label)}</a>
                    </>
                  )}
                </p>
              </article>
            )}

            <article className={s.railItem}>
              <Kicker>{rail.stockholm.kicker}</Kicker>
              <h3 className={s.h3}>{rail.stockholm.h}</h3>
              <p>{rail.stockholm.p}</p>
              <a className={s.more} href="/security">{rail.stockholm.link}</a>
            </article>

            <article className={s.railItem}>
              <Kicker>{rail.business.kicker}</Kicker>
              <h3 className={s.h3}>{rail.business.h}</h3>
              <p>{rail.business.p}</p>
              <a className={s.more} href="/for/business">{rail.business.link}</a>{' '}
              <a className={s.more} href="/for/founders">{rail.business.linkFounders}</a>
            </article>

            <article className={s.railItem}>
              <Kicker>{rail.wire.kicker}</Kicker>
              <h3 className={s.h3}>{rail.wire.h}</h3>
              <ul className={s.railWire}>
                {entries.slice(0, 3).map((e) => (
                  <li key={`${e.date}-${e.title}`}>
                    <time dateTime={e.date} className={s.label}>{shortDate(e.date)}</time>
                    <span>{e.title}</span>
                  </li>
                ))}
              </ul>
              <a className={s.more} href="#dispatches">{rail.wire.link}</a>
            </article>

            <article className={s.railItem}>
              <Kicker>{rail.open.kicker}</Kicker>
              <h3 className={s.h3}>{rail.open.h}</h3>
              <p>{rail.open.p}</p>
              <a className={s.more} href={REPO_URL} rel="noopener">{rail.open.repo}</a>{' '}
              <a className={s.more} href={NPM_URL} rel="noopener">{rail.open.npm}</a>{' '}
              <a className={s.more} href={CODE_URL} rel="noopener">{rail.open.code}</a>
            </article>
          </aside>
        </div>

        {/* ================= PROVIDERS ================= */}
        <section className={s.section} aria-labelledby="providers">
          <div className={s.wrap}>
            <SectionHead kicker={providers.kicker} id="providers">{providers.h2}</SectionHead>
            <p className={s.intro}>{providers.intro}</p>
            <ol className={s.plates}>
              {providers.plates.map((pl, i) => {
                const logo = pl.logo ? LOGOS[pl.logo] : null;
                return (
                  <li key={pl.name} className={`${s.plate} ${i === ACCENT_PLATE ? s.plateAccent : ''}`}>
                    <div className={s.plateHead}>
                      <span className={s.plateNum}>Plate {ROMAN[i]}</span>
                    </div>
                    <div className={s.plateSpecimen}>
                      {logo ? (
                        <img
                          src={`${C}logo-${pl.logo}-colour.svg`}
                          width={Math.round(logo[0] * 1.5)}
                          height={48}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className={s.tile} aria-hidden="true">{pl.tile}</span>
                      )}
                    </div>
                    <h3 className={s.plateName}>{pl.name}</h3>
                    <dl className={s.plateFacts}>
                      <dt>{providers.connectsLabel}</dt>
                      <dd>{pl.connects}</dd>
                      <dt>{providers.notesLabel}</dt>
                      <dd>{pl.notes}</dd>
                    </dl>
                    <a className={s.more} href={pl.href} aria-label={`${providers.guide}: ${pl.name}`}>{providers.guide}</a>
                  </li>
                );
              })}
            </ol>
            <p className={s.sectionLinks}>
              <a href="/connect">{providers.allGuides}</a>
              <a href="/docs/providers">{providers.docs}</a>
              <a href="/tools/email-settings-lookup">{providers.lookup}</a>
            </p>
          </div>
        </section>

        {/* ================= HOW IT WORKS ================= */}
        <section className={s.section} id="how" aria-labelledby="v07-how">
          <div className={s.wrap}>
            <SectionHead kicker={how.kicker} id="v07-how">{how.h2}</SectionHead>
            <div className={s.howGrid}>
              <div className={s.howExplainer}>
                <h3 className={s.h3}>{how.whatIs.h}</h3>
                {how.whatIs.p.map((p) => <p key={p}>{p}</p>)}
                <ul className={s.linkList}>
                  {how.whatIs.links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}
                </ul>
              </div>
              <ol className={s.howSteps}>
                {how.steps.map((st, i) => (
                  <li key={st.h}>
                    <span className={s.stepNum} aria-hidden="true">{i + 1}</span>
                    <h3 className={s.h3}>{st.h}</h3>
                    <p>{st.p}</p>
                  </li>
                ))}
              </ol>
            </div>

            <Print caption="The call, end to end: chat app, MCPEmails, your provider." className={s.flowPrint}>
              <picture>
                <source media="(max-width: 700px)" srcSet={`${C}diagram-flow-mobile-animated.svg`} width={358} height={252} />
                <img
                  src={`${C}diagram-flow-animated.svg`}
                  width={960}
                  height={432}
                  loading="lazy"
                  alt="How it works: your chat app asks MCPEmails over MCP, MCPEmails fetches your inbox live, and you review each draft in the chat and click Send before it goes out from your own address."
                  className={s.diagram}
                />
              </picture>
            </Print>

            {/* Chat and inbox side by side, joined by a hairline */}
            <div className={s.liveHead}>
              <h3 className={s.h3}>{how.live.h}</h3>
              <p>{how.live.p}</p>
            </div>
            <figure className={s.live}>
              <div className={s.liveStage}>
                <div className={`${s.mat} ${s.liveLeft}`}>
                  <Pic
                    name="card-draft-light-desktop" w={1364} h={776}
                    alt="In the chat: the MCPEmails draft card, a reply to jordan@example.com with the subject Re: Moving Thursday's design review."
                  />
                </div>
                <div className={`${s.mat} ${s.liveRight}`}>
                  <div className={s.crop}>
                    <Pic
                      name="dashboard-approvals-light-desktop" w={2880} h={1800}
                      alt="In the MCPEmails dashboard: the Approvals page, where Re: Moving Thursday design review waits with Reject and Review & approve buttons."
                      className={s.cropImg}
                    />
                  </div>
                </div>
                <svg className={s.hairline} viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
                  <rect x="57" y="114" width="142" height="16" />
                  <rect x="667" y="114.5" width="101" height="14" />
                  <path d="M199 122 H667" />
                  <circle cx="199" cy="122" r="3" />
                  <circle cx="667" cy="121.5" r="3" />
                </svg>
              </div>
              <figcaption className={s.liveCaps}>
                <span className={s.printCap}><span className={s.printNum}>A</span>{how.live.captionChat}</span>
                <span className={s.printCap}><span className={s.printNum}>B</span>{how.live.captionInbox}</span>
                <span className={s.srOnly}>{how.live.lineLabel}</span>
              </figcaption>
            </figure>

            <div className={s.stored}>
              <div>
                <h3 className={s.h3}>{how.stored.h}</h3>
                {how.stored.p.map((p) => <p key={p}>{p}</p>)}
                <p className={s.sectionLinks}>
                  {how.stored.links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
                </p>
              </div>
              <Print caption={how.stored.caption}>
                <img
                  src={`${C}diagram-stored-animated.svg`}
                  width={960}
                  height={400}
                  loading="lazy"
                  alt="MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored."
                  className={s.diagram}
                />
              </Print>
            </div>
          </div>
        </section>

        {/* ================= DISPATCHES ================= */}
        <section className={s.section} aria-labelledby="dispatches">
          <div className={s.wrap}>
            <SectionHead kicker={dispatches.kicker} id="dispatches">{dispatches.h2}</SectionHead>
            <p className={s.intro}>{dispatches.intro}</p>
            <ol className={s.wire}>
              {entries.map((e) => (
                <li key={`${e.date}-${e.title}`} className={s.dispatch}>
                  <p className={s.dispatchMeta}>
                    <time dateTime={e.date}>{shortDate(e.date)}</time>
                    <span className={s.dispatchKind}>{dispatches.kinds[e.kind] ?? e.kind}</span>
                  </p>
                  <h3 className={s.dispatchTitle}>{e.title}</h3>
                  <p>{e.body}</p>
                </li>
              ))}
            </ol>
            <p className={s.sectionLinks}><a href="/changelog">{dispatches.all}</a></p>
          </div>
        </section>

        {/* ================= PRICING ================= */}
        <section className={s.section} aria-labelledby="pricing">
          <div className={s.wrap}>
            <SectionHead kicker={pricing.kicker} id="pricing">{pricing.h2}</SectionHead>
            <p className={s.intro}>
              <Money
                eurEnabled={eurEnabled}
                text={businessSeat ? pricing.subSeat : pricing.sub}
              />
            </p>
            <div className={s.classifieds}>
              {tierRows.map((t) => {
                const c = pricing.tiers[t.copy];
                const bSeat = t.isBusiness ? seat : null;
                const features = bSeat ? bSeat.features : c.features;
                return (
                  <article key={t.key} className={`${s.ad} ${t.accent ? s.adAccent : ''}`}>
                    {t.accent && <p className={s.adFlag}>{pricing.mostPopular}</p>}
                    <h3 className={s.adName}>{t.name}</h3>
                    <p className={s.adPrice}>
                      <Currency eurEnabled={eurEnabled} usd={t.price.usd} eur={t.price.eur} />
                      <small>{t.price.cents === 0 ? pricing.perForever : bSeat ? bSeat.per : pricing.perMonth}</small>
                    </p>
                    {t.price.cents > 0 && eurEnabled && (
                      <Currency eurEnabled={eurEnabled} usd={null} eur={<p className={s.adNote}>{pricing.inclVat}</p>} />
                    )}
                    {bSeat && <p className={s.adNote}>{bSeat.minimum}</p>}
                    <p className={s.adDesc}>{bSeat ? bSeat.desc : c.desc}</p>
                    <ul className={s.adList}>
                      {features.map((f) => <li key={f}><Money eurEnabled={eurEnabled} text={f} /></li>)}
                    </ul>
                    <a href={t.href} className={t.accent ? s.btnPrimary : s.btnSecondary}>{c.cta}</a>
                  </article>
                );
              })}
            </div>
            <p className={s.priceFoot}>
              {pricing.footStored} {pricing.footContact} <a href="mailto:hello@mcpemails.com">{pricing.footContactLink}</a>.{' '}
              <a href="/pricing">{pricing.footCompare}</a>. {pricing.footBusiness}{' '}
              <a href="/for/business">{pricing.footBusinessLink}</a>.
            </p>
          </div>
        </section>

        {/* ================= FAQ ================= */}
        <section className={s.section} id="faq" aria-labelledby="v07-faq">
          <div className={s.wrap}>
            <SectionHead kicker={faq.kicker} id="v07-faq">{faq.h2}</SectionHead>
            <div className={s.faq}>
              {faqItems.map((item) => (
                <div key={item.q} className={s.faqItem}>
                  <h3 className={s.faqQ}>{item.q}</h3>
                  <p className={s.faqA}><Money eurEnabled={eurEnabled} text={item.a} /></p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= COLOPHON ================= */}
        <section className={`${s.section} ${s.colophon}`} aria-labelledby="v07-colophon">
          <div className={s.wrap}>
            <SectionHead kicker={colophon.kicker} id="v07-colophon">{colophon.h2}</SectionHead>
            <div className={s.colGrid}>
              <div className={s.colOpen}>
                <h3 className={s.h3}>{colophon.open.h}</h3>
                <p>{colophon.open.p}</p>
                <ul className={s.openLinks}>
                  <li><a href={REPO_URL} rel="noopener"><span className={s.label}>GitHub</span>{colophon.open.repo}</a></li>
                  <li><a href={NPM_URL} rel="noopener"><span className={s.label}>npm</span>{colophon.open.npm}</a></li>
                  <li><a href="/docs"><span className={s.label}>Docs</span>{colophon.open.docs}</a></li>
                </ul>
                <p className={s.sectionLinks}>
                  <a href={CODE_URL} rel="noopener">{colophon.open.code}</a>
                  <a href="/self-hosting">{colophon.open.selfHost}</a>
                  <a href="/developers">{colophon.open.developers}</a>
                  <a href="/docs/api">{colophon.open.api}</a>
                </p>
              </div>
              <div>
                <h3 className={s.h3}>{colophon.type.h}</h3>
                <p>{colophon.type.p}</p>
              </div>
              <div>
                <h3 className={s.h3}>{colophon.publisher.h}</h3>
                <p>{colophon.publisher.p}</p>
                <p className={s.sectionLinks}>
                  <a href="/about">{colophon.publisher.about}</a>
                  <a href="/status">{colophon.publisher.status}</a>
                  <a href="/help">{colophon.publisher.help}</a>
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ================= FOOTER ================= */}
      <footer className={s.footer}>
        <div className={s.wrap}>
          <div className={s.footGrid}>
            <div className={s.footBrand}>
              <a href="/" className={s.logoLink}>
                <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" className={s.footLogo} loading="lazy" />
              </a>
              <p>{footer.tagline}</p>
              <dl className={s.footContact}>
                <dt>{footer.endpointLabel}</dt>
                <dd><code>{MCP_URL}</code></dd>
                <dt>{footer.contactLabel}</dt>
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
            <span className={s.label}>{footer.languagesLabel}</span>
            {footer.languages.map((l) => (
              <a key={l.href} href={l.href} hrefLang={l.lang} lang={l.lang}>{l.label}</a>
            ))}
          </p>
          <p className={s.legal}>
            <span>{footer.copyright}</span> <span>{footer.legal}</span>
          </p>
          <p className={s.legal}>{colophon.publisher.p}</p>
        </div>
      </footer>
    </div>
  );
}
