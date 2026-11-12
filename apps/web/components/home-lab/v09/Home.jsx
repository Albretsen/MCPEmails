/**
 * Homepage Lab v09, "Re: your questions" (staging only, English only).
 *
 * The page is a stack of emails. A short hero, an index that reads like an
 * inbox, then every FAQ question open as an H2, filed in four folders (Setup,
 * Safety, Teams, Billing), with the seven numbered messages from us sitting
 * between the folders. Each block carries a From / To / Subject / Date header.
 * Pricing and spec tables sit on ledger lines with tabular figures and cobalt
 * totals. Server component; the only client islands are the EUR price swap and
 * the approval clip player.
 */
import { PLANS as CATALOGUE, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { checkoutReassurance } from '@/lib/billing/checkout-reassurance.mjs';
import { REVIEWS, REVIEW_SOURCES } from '../../marketing/reviews.mjs';
import * as C from './copy.mjs';
import { ENVELOPE_CROPS, HEADER_TINT, HERO_STACK, LEDGER_PITCH, UNREAD } from './rng.mjs';
import Money from './Money';
import Clip from './Clip';
import s from './Home.module.css';

const A = '/home-lab/assets/a/';
const B = '/home-lab/assets/b/';
const CA = '/home-lab/assets/c/';
// Real <link rel="preload"> elements (react-dom preload() does not reach the
// HTML head here). Same asset URLs the CSS module's @font-face resolves to.
const WORK_URL = new URL('./fonts/work-sans-400-500-latin.woff2', import.meta.url).pathname;
const SPECTRAL_URL = new URL('./fonts/spectral-300-italic-latin.woff2', import.meta.url).pathname;
const cx = (...names) => names.filter(Boolean).join(' ');

/* ───────────── Small building blocks ───────────── */

/** <picture> with AVIF + WebP and an optional phone-width crop. */
function Pic({ base, name, w, h, alt, mobile, className }) {
  return (
    <picture className={className}>
      {mobile && (
        <source media="(max-width: 767px)" type="image/avif" srcSet={`${base}${mobile.name}.avif`} width={mobile.w} height={mobile.h} />
      )}
      {mobile && (
        <source media="(max-width: 767px)" type="image/webp" srcSet={`${base}${mobile.name}.webp`} width={mobile.w} height={mobile.h} />
      )}
      <source type="image/avif" srcSet={`${base}${name}.avif`} />
      <source type="image/webp" srcSet={`${base}${name}.webp`} />
      <img
        src={`${base}${name}.webp`}
        width={w}
        height={h}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

/**
 * The email header block every section opens with. `subject` is the node that
 * goes in the Subject row: an H1 or H2 for a message from us, a plain line for
 * a folder of questions.
 */
function MailHead({ no, from, to, subject, date, folder, incoming = false }) {
  return (
    <div className={cx(s.head, incoming && s.headIn)}>
      {(no || folder) && (
        <p className={s.headTag}>
          {folder ? (
            <>
              <span className={s.headTagLabel}>{C.labels.folder}</span> {folder}
            </>
          ) : (
            <>
              <span className={s.headTagLabel}>{C.labels.no}</span> {no}
            </>
          )}
        </p>
      )}
      <dl className={s.headRows}>
        <div className={s.headRow}>
          <dt>{C.labels.from}</dt>
          <dd>{from}</dd>
        </div>
        <div className={s.headRow}>
          <dt>{C.labels.to}</dt>
          <dd>{to}</dd>
        </div>
        <div className={cx(s.headRow, s.headSubject)}>
          <dt>{C.labels.subject}</dt>
          <dd>{subject}</dd>
        </div>
        <div className={s.headRow}>
          <dt>{C.labels.date}</dt>
          <dd>{date}</dd>
        </div>
      </dl>
    </div>
  );
}

/** One numbered message from us. */
function Mail({ id, no, to, date, title, headingId, children, className }) {
  return (
    <article id={id} className={cx(s.mail, className)} aria-labelledby={headingId}>
      <MailHead
        no={no}
        from={C.US}
        to={to}
        date={date}
        subject={
          <h2 id={headingId} className={s.h2}>
            {title}
          </h2>
        }
      />
      <div className={s.body}>{children}</div>
    </article>
  );
}

/** A 3D envelope render, cropped differently for each step, with its number. */
function Envelope({ n }) {
  const crop = ENVELOPE_CROPS[n - 1];
  return (
    <span className={s.marker} style={{ '--x': `${crop.x}%`, '--y': `${crop.y}%`, '--r': `${crop.r}deg` }}>
      <picture>
        <source type="image/avif" srcSet={`${B}envelopes-small.avif`} />
        <source type="image/webp" srcSet={`${B}envelopes-small.webp`} />
        <img src={`${B}envelopes-small.webp`} width="800" height="725" alt="" loading="lazy" decoding="async" />
      </picture>
      <span className={s.markerNum} aria-hidden="true">
        {n}
      </span>
    </span>
  );
}

/** A spec table on ledger lines. */
function Ledger({ caption, cols, rows, className }) {
  return (
    <div className={cx(s.ledgerWrap, className)}>
      <table className={s.ledger}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0].key ?? String(r[0])}>
              {r.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" data-label={cols[i]}>
                    {cell.node ?? cell}
                  </th>
                ) : (
                  <td key={i} data-label={cols[i]}>
                    {cell.node ?? cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinkRow({ links }) {
  return (
    <ul className={s.linkRow}>
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href}>{l.label}</a>
        </li>
      ))}
    </ul>
  );
}

/* ───────────── FAQ folders ───────────── */

function groupFaq(faqItems) {
  const used = new Set();
  const groups = C.groups.map((g) => {
    const items = faqItems.filter((item, i) => {
      if (used.has(i)) return false;
      const hit = g.match.some((m) => item.q.includes(m));
      if (hit) used.add(i);
      return hit;
    });
    return { ...g, items };
  });
  // Anything the matcher did not place still shows, in Setup, so the visible
  // FAQ always equals the FAQPage JSON-LD.
  const rest = faqItems.filter((_, i) => !used.has(i));
  if (rest.length) groups[0].items = [...groups[0].items, ...rest];
  return groups;
}

function Folder({ group, eurEnabled, locale, children }) {
  return (
    <section id={group.id} className={s.folder} aria-label={`${group.name} questions`}>
      <MailHead
        folder={group.name}
        incoming
        from={group.from}
        to={C.US}
        date={group.date}
        subject={
          <span className={s.folderSubject}>
            {group.subject} <span className={s.count}>({group.items.length})</span>
          </span>
        }
      />
      <p className={s.folderIntro}>{group.intro}</p>
      <div className={s.qs}>
        {group.items.map((item) => (
          <article key={item.q} id={C.questionId(item.q)} className={s.q}>
            <div className={s.qHead}>
              <span className={s.re} aria-hidden="true">
                {C.faq.re}
              </span>
              <h2 className={s.qTitle}>{item.q}</h2>
            </div>
            <p className={s.qAnswer}>
              {item.a.includes('$') ? (
                <Money usd={item.a} eur={euroizeAmounts(item.a, locale)} eurEnabled={eurEnabled} />
              ) : (
                item.a
              )}
            </p>
          </article>
        ))}
      </div>
      {children}
    </section>
  );
}

/* ───────────── Pricing data (live Stripe prices, catalogue fallback) ───────────── */

function buildTiers({ stripePrices, businessSeat, locale }) {
  const rows = [
    { id: 'free', priceKey: 'free', per: C.pricing.perForever, href: '/signup' },
    { id: 'personal', priceKey: 'personal', per: C.pricing.perMonth, href: pricingUpgradeHref('personal', false, false, locale) },
    { id: 'solo', priceKey: 'solo', per: C.pricing.perMonth, href: pricingUpgradeHref('solo', false, false, locale), accent: true },
    { id: 'business', priceKey: 'pro', per: C.pricing.perMonth, href: pricingUpgradeHref('pro', false, false, locale) },
  ];
  return rows.map((row) => {
    const live = stripePrices?.[row.priceKey]?.monthlyCents;
    const cents = live != null && live > 0 ? live : CATALOGUE[row.priceKey].monthlyPriceCents;
    const eurCents = eurCentsFor(stripePrices?.[row.priceKey]?.eurMonthlyCents, cents) ?? cents;
    const seat = row.id === 'business' ? businessSeat?.card ?? null : null;
    const copy = C.pricing.tiers[row.id];
    const features = seat ? seat.features : copy.features;
    return {
      ...row,
      name: planDisplayName(row.priceKey),
      cents,
      usd: formatUsdCopy(cents, locale),
      eur: formatMoneyCents(eurCents, 'eur', locale),
      per: seat ? seat.per : row.per,
      minimum: seat ? seat.minimum : null,
      yearly: seat ? seat.billedYearly : null,
      desc: seat ? seat.desc : copy.desc,
      features: features.map((f) => ({ usd: f, eur: euroizeAmounts(f, locale) })),
      cta: copy.cta,
    };
  });
}

/* ───────────── Page ───────────── */

/**
 * @param {{
 *   stripePrices?: any,
 *   eurEnabled?: boolean,
 *   businessSeat?: any,
 *   faqItems?: { q: string, a: string }[],
 *   locale?: string,
 * }} props
 */
export default function Home({ stripePrices, eurEnabled = false, businessSeat = null, faqItems = [], locale = 'en' }) {
  const tiers = buildTiers({ stripePrices, businessSeat, locale });
  const [setup, safety, teams, billing] = groupFaq(Array.isArray(faqItems) ? faqItems : []);
  const review = REVIEWS[0];
  const allQuestions = [setup, safety, teams, billing].flatMap((g) => g.items.map((i) => ({ q: i.q, group: g.name })));

  const indexRows = [
    { href: '#what', no: '01', from: C.US, subject: C.what.title, when: C.what.date },
    { href: `#${setup.id}`, folder: setup.name, from: setup.from, subject: `${setup.subject} (${setup.items.length})`, when: setup.date },
    { href: '#providers', no: '02', from: C.US, subject: C.providers.title, when: C.providers.date },
    { href: '#clients', no: '03', from: C.US, subject: C.clients.title, when: C.clients.date },
    { href: `#${safety.id}`, folder: safety.name, from: safety.from, subject: `${safety.subject} (${safety.items.length})`, when: safety.date },
    { href: '#security', no: '04', from: C.US, subject: C.security.title, when: C.security.date },
    { href: '#approval', no: '05', from: C.US, subject: C.approval.title, when: C.approval.date },
    { href: `#${teams.id}`, folder: teams.name, from: teams.from, subject: `${teams.subject} (${teams.items.length})`, when: teams.date },
    { href: '#pricing', no: '06', from: C.US, subject: C.pricing.title, when: C.pricing.date },
    { href: `#${billing.id}`, folder: billing.name, from: billing.from, subject: `${billing.subject} (${billing.items.length})`, when: billing.date },
    { href: '#questions', no: '07', from: C.US, subject: C.questions.title, when: C.questions.date },
  ];

  return (
    <div
      className={cx(s.page, HEADER_TINT === 'cobalt' ? s.tintCobalt : s.tintPaper)}
      style={{ '--pitch': `${LEDGER_PITCH}px` }}
    >
      <link rel="preload" href={WORK_URL} as="font" type="font/woff2" crossOrigin="anonymous" />
      <link rel="preload" href={SPECTRAL_URL} as="font" type="font/woff2" crossOrigin="anonymous" />
      <a className={s.skip} href="#main">
        Skip to content
      </a>

      <header className={s.header}>
        <div className={s.headerInner}>
          <a href="/" className={s.logo}>
            <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" />
          </a>
          <nav aria-label={C.nav.aria} className={s.nav}>
            <ul>
              {C.nav.links.map((l) => (
                <li key={l.href}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <div className={s.headerCtas}>
            <a href="/login" className={s.signIn}>
              {C.nav.signIn}
            </a>
            <a href="/signup" className={cx(s.btn, s.btnPrimary, s.btnSmall)}>
              {C.nav.start}
            </a>
          </div>
        </div>
      </header>

      <main id="main" className={s.main}>
        {/* ── Hero: the first message ── */}
        <article className={cx(s.mail, s.hero)} aria-labelledby="v09-h1">
          <MailHead
            from={C.US}
            to={
              <>
                {C.YOU.info}, {C.YOU.invoices}
              </>
            }
            date={C.hero.date}
            subject={
              <h1 id="v09-h1" className={s.h1}>
                <span className={s.kicker}>{C.hero.kicker}.</span> <span className={s.display}>{C.hero.display}</span>
              </h1>
            }
          />
          <div className={s.heroGrid}>
            <div className={s.heroText}>
              <p className={s.lead}>{C.hero.lead}</p>
              <div className={s.ctas}>
                <a href="/signup" className={cx(s.btn, s.btnPrimary)}>
                  {C.hero.ctaPrimary}
                </a>
                <a href="/docs/clients" className={cx(s.btn, s.btnLine)}>
                  {C.hero.ctaSecondary}
                </a>
              </div>
              <ul className={s.facts}>
                {C.hero.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
                <li>
                  <a href="/connect">{C.hero.ctaTertiary}</a>
                </li>
              </ul>
              <p className={s.heroSecond}>{C.hero.second}</p>
            </div>
            <div className={cx(s.heroFigs, HERO_STACK === 'offset' ? s.figsOffset : s.figsUnder)}>
              <p className={s.ask}>
                <span className={s.askLabel}>{C.hero.askLabel}</span>
                <q>{C.hero.ask}</q>
              </p>
              <figure className={s.fig}>
                <Pic
                  base={A}
                  name="card-approval-light-desktop"
                  w={1364}
                  h={484}
                  alt={C.hero.fig1.alt}
                  mobile={{ name: 'card-approval-light-mobile', w: 720, h: 602 }}
                  className={s.shot}
                />
                <figcaption>{C.hero.fig1.caption}</figcaption>
              </figure>
              <figure className={cx(s.fig, s.figSecond)}>
                <Pic
                  base={A}
                  name="card-draft-light-desktop"
                  w={1364}
                  h={776}
                  alt={C.hero.fig2.alt}
                  mobile={{ name: 'card-draft-light-mobile', w: 720, h: 878 }}
                  className={s.shot}
                />
                <figcaption>{C.hero.fig2.caption}</figcaption>
              </figure>
            </div>
          </div>
        </article>

        {/* ── Index ── */}
        <article id="index" className={cx(s.mail, s.indexMail)} aria-labelledby="v09-index">
          <MailHead
            from={C.US}
            to={C.YOU.team}
            date={C.index.date}
            subject={
              <h2 id="v09-index" className={s.h2}>
                {C.index.subject}
              </h2>
            }
          />
          <div className={s.body}>
            <p className={s.intro}>{C.index.intro}</p>
            <ol className={s.inbox}>
              {indexRows.map((r) => {
                const unread = r.no === UNREAD;
                return (
                  <li key={r.href} className={cx(s.inboxRow, r.folder && s.inboxFolder, unread && s.inboxUnread)}>
                    <a href={r.href}>
                      <span className={s.inboxNo}>
                        {unread && <span className={s.dot} aria-label={C.index.unread} role="img" />}
                        {r.no ?? r.folder}
                      </span>
                      <span className={s.inboxFrom}>{r.from}</span>
                      <span className={s.inboxSubject}>{r.subject}</span>
                      <span className={s.inboxWhen}>{r.when}</span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </div>
        </article>

        {/* ── 01 What it is + how it works ── */}
        <Mail id="what" no={C.what.no} to={C.what.to} date={C.what.date} title={C.what.title} headingId="v09-what">
          <div id="features" className={s.prose}>
            <p className={s.intro}>{C.what.p1}</p>
            <p>{C.what.p2}</p>
            <p>{C.what.p3}</p>
          </div>
          <LinkRow links={C.what.links} />
          <div id="how" className={s.how}>
            <h3 className={s.h3}>{C.what.howTitle}</h3>
            <p className={s.howIntro}>{C.what.howIntro}</p>
            <ol className={s.steps}>
              {C.what.steps.map((step, i) => (
                <li key={step.h} className={s.step}>
                  <Envelope n={i + 1} />
                  <div>
                    <h4 className={s.stepTitle}>
                      <span className={s.visuallyHidden}>
                        {C.what.stepLabel} {i + 1}:{' '}
                      </span>
                      {step.h}
                    </h4>
                    <p>{step.p}</p>
                    {step.code && <code className={s.code}>{step.code}</code>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </Mail>

        <Folder group={setup} eurEnabled={eurEnabled} locale={locale} />

        {/* ── 02 Providers ── */}
        <Mail id="providers" no={C.providers.no} to={C.providers.to} date={C.providers.date} title={C.providers.title} headingId="v09-providers">
          <p className={s.intro}>{C.providers.intro}</p>
          <picture className={s.wall}>
            <source media="(max-width: 767px)" srcSet={`${CA}logo-wall-colour-mobile.svg`} width="358" height="620" />
            <img src={`${CA}logo-wall-colour.svg`} width="960" height="240" alt={C.providers.wallAlt} loading="lazy" decoding="async" />
          </picture>
          <Ledger
            caption={C.providers.tableCaption}
            cols={C.providers.cols}
            rows={C.providers.rows.map((r) => [
              { key: r.name, node: r.name },
              r.how,
              { node: <a href={r.href}>{r.link}</a> },
            ])}
          />
          <p className={s.after}>{C.providers.after}</p>
          <LinkRow links={C.providers.links} />
        </Mail>

        {/* ── 03 Clients ── */}
        <Mail id="clients" no={C.clients.no} to={C.clients.to} date={C.clients.date} title={C.clients.title} headingId="v09-clients">
          <p className={s.intro}>{C.clients.intro}</p>
          <p className={s.endpoint}>
            <span className={s.endpointLabel}>{C.clients.endpointLabel}</span>
            <code className={s.code}>{C.MCP_URL}</code>
          </p>
          <Ledger
            caption={C.clients.title}
            cols={C.clients.cols}
            rows={C.clients.rows.map((r) => [{ key: r.name, node: r.name }, r.where, r.auth])}
          />
          <p className={s.after}>{C.clients.after}</p>
          <LinkRow links={C.clients.links} />
        </Mail>

        <Folder group={safety} eurEnabled={eurEnabled} locale={locale} />

        {/* ── 04 Security ── */}
        <Mail id="security" no={C.security.no} to={C.security.to} date={C.security.date} title={C.security.title} headingId="v09-security">
          <p className={s.intro}>{C.security.intro}</p>
          <div className={s.diagram}>
            <img src={`${CA}diagram-stored.svg`} width="960" height="400" alt={C.security.diagramAlt} loading="lazy" decoding="async" />
          </div>
          <Ledger
            caption={C.security.ledgerCaption}
            cols={C.security.cols}
            rows={C.security.rows.map((r) => [
              { key: r.item, node: r.item },
              { node: <span className={r.kept === 'No' ? s.keptNo : s.keptYes}>{r.kept}</span> },
              r.how,
            ])}
          />
          <div className={s.points}>
            {C.security.points.map((p) => (
              <div key={p.h} className={s.point}>
                <h3 className={s.h3}>{p.h}</h3>
                <p>{p.p}</p>
              </div>
            ))}
          </div>
          <LinkRow links={C.security.links} />
        </Mail>

        {/* ── 05 Approval ── */}
        <Mail id="approval" no={C.approval.no} to={C.approval.to} date={C.approval.date} title={C.approval.title} headingId="v09-approval">
          <p className={s.intro}>{C.approval.intro}</p>
          <div className={s.approvalGrid}>
            <figure className={s.fig}>
              <div className={s.clipBox}>
                <Clip
                  className={s.clip}
                  src={`${A}card-approval-flow-light-desktop.mp4`}
                  webm={`${A}card-approval-flow-light-desktop.webm`}
                  posterAvif={`${A}card-approval-flow-light-desktop-poster.avif`}
                  posterWebp={`${A}card-approval-flow-light-desktop-poster.webp`}
                  posterClassName={s.poster}
                  width={1428}
                  height={600}
                  label={C.approval.clipLabel}
                />
              </div>
              <figcaption>{C.approval.clipCaption}</figcaption>
            </figure>
            <figure className={s.fig}>
              <Pic
                base={A}
                name="card-sent-light-desktop"
                w={1364}
                h={138}
                alt={C.approval.receiptAlt}
                mobile={{ name: 'card-sent-light-mobile', w: 720, h: 172 }}
                className={s.shot}
              />
              <figcaption>{C.approval.receiptCaption}</figcaption>
            </figure>
          </div>
          <div className={s.points}>
            {C.approval.points.map((p) => (
              <div key={p.h} className={s.point}>
                <h3 className={s.h3}>{p.h}</h3>
                <p>{p.p}</p>
              </div>
            ))}
          </div>
        </Mail>

        <Folder group={teams} eurEnabled={eurEnabled} locale={locale}>
          {/* The one published review, as the message it was. */}
          {review && (
            <article id="reviews" className={cx(s.mail, s.reviewMail)} aria-labelledby="v09-reviews">
              <MailHead
                incoming
                from={
                  <>
                    {review.author}, {review.role},{' '}
                    {review.url ? <a href={review.url}>{review.company}</a> : review.company}
                  </>
                }
                to={C.US}
                date={<time dateTime={review.date}>{C.review.date}</time>}
                subject={
                  <h2 id="v09-reviews" className={s.h2}>
                    {C.review.heading}
                  </h2>
                }
              />
              <div className={s.body}>
                <blockquote className={s.quote}>
                  <p>{review.quote}</p>
                </blockquote>
                <p className={s.quoteMeta}>
                  <span className={s.stars} aria-hidden="true">
                    {'★'.repeat(review.rating)}
                  </span>{' '}
                  <span>{C.review.ratingLabel}</span>
                  {' · '}
                  {review.sourceUrl ? (
                    <a href={review.sourceUrl}>{C.review.via}</a>
                  ) : (
                    REVIEW_SOURCES[review.source]?.label
                  )}
                  {' · '}
                  <span>{C.review.note}</span>
                </p>
              </div>
            </article>
          )}
        </Folder>

        {/* ── 06 Plans ── */}
        <Mail id="pricing" no={C.pricing.no} to={C.pricing.to} date={C.pricing.date} title={C.pricing.title} headingId="v09-pricing">
          <p className={s.intro}>{C.pricing.intro}</p>
          <div className={s.plans}>
            {tiers.map((t) => (
              <section key={t.id} className={cx(s.plan, t.accent && s.planAccent)} aria-labelledby={`v09-plan-${t.id}`}>
                <div className={s.planHead}>
                  <h3 id={`v09-plan-${t.id}`} className={s.planName}>
                    {t.name}
                    {t.accent && <span className={s.planFlag}>{C.pricing.popular}</span>}
                  </h3>
                  <p className={s.total}>
                    <span className={s.totalNum}>
                      <Money usd={t.usd} eur={t.eur} eurEnabled={eurEnabled} />
                    </span>
                    <span className={s.per}>{t.per}</span>
                  </p>
                </div>
                {t.cents > 0 && (
                  <p className={s.vat}>
                    <Money usd="" eur={C.pricing.inclVat} eurEnabled={eurEnabled} />
                  </p>
                )}
                <p className={s.planDesc}>{t.desc}</p>
                {t.minimum && (
                  <p className={s.planMin}>
                    {t.yearly && (
                      <>
                        <Money usd={t.yearly} eur={euroizeAmounts(t.yearly, locale)} eurEnabled={eurEnabled} />.{' '}
                      </>
                    )}
                    {t.minimum}
                  </p>
                )}
                <ul className={s.planLines}>
                  {t.features.map((f) => (
                    <li key={f.usd}>
                      <Money usd={f.usd} eur={f.eur} eurEnabled={eurEnabled} />
                    </li>
                  ))}
                </ul>
                <a href={t.href} className={cx(s.btn, t.accent ? s.btnPrimary : s.btnLine, s.planBtn)}>
                  {t.cta}
                </a>
                <p className={s.reassure}>{t.cents > 0 ? checkoutReassurance(locale) : C.pricing.freeNote}</p>
              </section>
            ))}
          </div>
          {tiers[3].minimum && (
            <div className={s.seat}>
              <h3 className={s.h3}>{C.pricing.seatTitle}</h3>
              <p>{C.pricing.seatBody}</p>
            </div>
          )}
          <p className={s.footnote}>
            {C.pricing.footnoteBefore} <a href="/pricing">{C.pricing.compare}</a> ·{' '}
            <a href="mailto:hello@mcpemails.com">{C.pricing.contact}</a> · <a href="/for/business">{C.pricing.business}</a>
          </p>
        </Mail>

        <Folder group={billing} eurEnabled={eurEnabled} locale={locale} />

        {/* ── 07 Questions ── */}
        <Mail id="questions" no={C.questions.no} to={C.questions.to} date={C.questions.date} title={C.questions.title} headingId="v09-questions">
          <p className={s.intro}>{C.questions.intro}</p>
          <ol className={s.qIndex}>
            {allQuestions.map((item) => (
              <li key={item.q}>
                <a href={`#${C.questionId(item.q)}`}>
                  <span className={s.qIndexGroup}>{item.group}</span>
                  <span>{item.q}</span>
                </a>
              </li>
            ))}
          </ol>
          <div className={s.contact}>
            <h3 className={s.h3}>{C.questions.contactTitle}</h3>
            <dl className={s.contactList}>
              {C.questions.contact.map((c) => (
                <div key={c.href}>
                  <dt>{c.label}</dt>
                  <dd>
                    <a href={c.href}>{c.value}</a>
                  </dd>
                </div>
              ))}
            </dl>
            <LinkRow links={C.questions.more} />
          </div>
          <div className={s.closing}>
            <p className={s.closingLine}>{C.questions.closing}</p>
            <div className={s.ctas}>
              <a href="/signup" className={cx(s.btn, s.btnPrimary)}>
                {C.hero.ctaPrimary}
              </a>
              <a href="/connect" className={cx(s.btn, s.btnLine)}>
                {C.hero.ctaTertiary}
              </a>
            </div>
          </div>
        </Mail>
      </main>

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerBrand}>
            <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" loading="lazy" />
            <p>{C.footer.tagline}</p>
            <dl className={s.contactList}>
              {C.questions.contact.map((c) => (
                <div key={c.href}>
                  <dt>{c.label}</dt>
                  <dd>
                    <a href={c.href}>{c.value}</a>
                  </dd>
                </div>
              ))}
              <div>
                <dt>{C.footer.endpointLabel}</dt>
                <dd>
                  <code className={s.code}>{C.MCP_URL}</code>
                </dd>
              </div>
            </dl>
            <LinkRow links={C.footer.account} />
          </div>
          {C.footer.columns.map((col) => (
            <div key={col.h} className={s.footerCol}>
              <p className={s.footerHead}>{col.h}</p>
              <ul>
                {col.links.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className={s.footerBase}>
          <p className={s.langs}>
            <span>{C.footer.languagesLabel}:</span>{' '}
            {C.footer.languages.map((l) => (
              <a key={l.code} href={l.href} hrefLang={l.code} aria-current={l.code === 'en' ? 'true' : undefined}>
                {l.label}
              </a>
            ))}
          </p>
          <p>
            {C.footer.copyright} {C.footer.legal}
          </p>
          <p>{C.footer.entity}</p>
        </div>
      </footer>
    </div>
  );
}
