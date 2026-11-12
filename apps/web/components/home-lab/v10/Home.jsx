/**
 * Homepage Lab v10, "The Annotated Inbox" (staging only, English only).
 *
 * An editorial long read: one 640px text column, a wide right margin holding
 * product shots as marginalia, Swiss rules between and inside sections, and a
 * museum label under every visual with the date it shipped. Server component;
 * the only client islands are the before/after divider, the self-drawing
 * how-it-works rule, the clip player and the EUR price swap.
 */
import { PLANS as CATALOGUE, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { checkoutReassurance } from '@/lib/billing/checkout-reassurance.mjs';
import { REVIEWS } from '../../marketing/reviews.mjs';
import * as C from './copy.mjs';
import { COBALT, DEFAULT_CLIENT, DIVIDER_START, FIGURE_TINT, NUMBER_STYLE } from './rng.mjs';
import Compare from './Compare';
import DrawLine from './DrawLine';
import Clip from './Clip';
import Money from './Money';
import MonoFont from './MonoFont';
import s from './Home.module.css';

const A = '/home-lab/assets/a/';
/** The lead paragraph (the LCP text) paints in Plex: preload exactly the file the CSS uses. */
const LEAD_FONT = new URL('./fonts/ibm-plex-sans-latin.woff2', import.meta.url).pathname;
/** Space Mono: loaded by MonoFont when section 01 nears the screen. */
const MONO_FONT = new URL('./fonts/space-mono-400-latin.woff2', import.meta.url).pathname;
const CA = '/home-lab/assets/c/';
const cx = (...names) => names.filter(Boolean).join(' ');

/** <picture> with AVIF + WebP, and an optional phone-width crop. */
function Pic({ name, w, h, alt, mobile, priority = false, className }) {
  return (
    <picture className={cx(s.pic, className)}>
      {mobile && (
        <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}${mobile.name}.avif`} width={mobile.w} height={mobile.h} />
      )}
      {mobile && (
        <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}${mobile.name}.webp`} width={mobile.w} height={mobile.h} />
      )}
      <source type="image/avif" srcSet={`${A}${name}.avif`} />
      <source type="image/webp" srcSet={`${A}${name}.webp`} />
      <img
        src={`${A}${name}.webp`}
        width={w}
        height={h}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : undefined}
      />
    </picture>
  );
}

/** Museum label: what it is, the medium, a note, and the real ship date. */
function Label({ data, left = false }) {
  return (
    <figcaption className={s.label}>
      <span className={s.labelTitle}>{data.title}</span>
      <span className={s.labelMedium}>{data.medium}</span>
      {data.note && <span className={s.labelNote}>{data.note}</span>}
      <span className={s.labelDate}>
        {left ? C.labels.leftWord : C.labels.shippedWord}{' '}
        <time dateTime={data.shipped}>{C.museumDate(data.shipped)}</time>
        {data.entry && (
          <>
            {' · '}
            <a href="/changelog">
              {C.labels.changelog}: {data.entry}
            </a>
          </>
        )}
      </span>
    </figcaption>
  );
}

/** Section head: heavy rule, number tab, H2. */
function Head({ n, id, title, cobalt = false }) {
  const num = NUMBER_STYLE === 'section' ? `§ ${n}` : String(n).padStart(2, '0');
  return (
    <div className={s.head}>
      <span className={cx(s.num, cobalt && s.cobalt)} aria-hidden="true">
        {num}
      </span>
      <h2 id={id} className={s.h2}>
        {title}
      </h2>
    </div>
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
  const review = REVIEWS[0];
  const tint = FIGURE_TINT === 'cobalt' ? s.tintCobalt : s.tintInk;

  return (
    <div className={cx(s.page, tint)}>
      <link rel="preload" href={LEAD_FONT} as="font" type="font/woff2" crossOrigin="anonymous" />
      <MonoFont url={MONO_FONT} />
      <a className={s.skip} href="#main">
        Skip to content
      </a>
      <header className={s.header}>
        <div className={s.headerInner}>
          <a href="/" className={s.logo} aria-label="MCPEmails home">
            <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" />
          </a>
          <nav aria-label={C.nav.label} className={s.nav}>
            <ul>
              {C.nav.links.map((l) => (
                <li key={l.href} className={s.navHideSm}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
              <li>
                <a href="/login">{C.nav.signIn}</a>
              </li>
              <li>
                <a href="/signup" className={s.navCta}>
                  {C.nav.start}
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main">
        {/* ── Hero: the draft card, and the connector per client ── */}
        <section className={cx(s.section, s.hero)} aria-labelledby="v10-h1">
          <div className={s.row}>
            <div className={s.col}>
              <h1 id="v10-h1" className={s.h1}>
                <span className={s.h1Kicker}>{C.hero.kicker}</span>{' '}
                <span className={s.h1Main}>{C.hero.title}</span>
              </h1>
              <p className={s.lead}>{C.hero.lead}</p>
              <p className={s.business}>
                {C.hero.business.before}{' '}
                {C.hero.business.addresses.map((a, i) => (
                  <span key={a}>
                    <span className={s.addrHero}>{a}</span>
                    {i < C.hero.business.addresses.length - 2 ? ', ' : i === C.hero.business.addresses.length - 2 ? ' and ' : ''}
                  </span>
                ))}{' '}
                {C.hero.business.after} <a href="/for/business">{C.hero.business.link}</a>.
              </p>
              <div className={s.ctas}>
                <a href="/signup" className={cx(s.btn, s.btnPrimary)}>
                  {C.hero.primary}
                </a>
                <a href="/docs/clients" className={cx(s.btn, s.btnLine)}>
                  {C.hero.secondary}
                </a>
              </div>
              <p className={s.meta}>{C.hero.meta}</p>
              <div className={s.tabsBlock}>
              <h2 className={s.h3like}>{C.tabs.title}</h2>
              <p>{C.tabs.intro}</p>
              <div className={s.tabs}>
                <fieldset className={s.tabList}>
                  <legend className={s.srOnly}>{C.tabs.legend}</legend>
                  {C.tabs.clients.map((c) => (
                    <label key={c.id} className={s.tab}>
                      <input
                        type="radio"
                        name="v10-client"
                        value={c.id}
                        defaultChecked={c.id === DEFAULT_CLIENT}
                        data-client={c.id}
                      />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </fieldset>
                {C.tabs.clients.map((c) => (
                  <div key={c.id} className={s.panel} data-panel={c.id}>
                    <h3 className={s.panelTitle}>
                      {c.name}: <span className={s.panelSurface}>{c.surface}</span>
                    </h3>
                    <p className={s.panelAuth}>{c.auth}</p>
                    <ol className={s.steps}>
                      {c.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    <div className={s.code}>
                      <span className={s.codeLabel}>{c.codeLabel}</span>
                      <pre>
                        <code>{c.code}</code>
                      </pre>
                    </div>
                    <p className={s.panelResult}>{c.result}</p>
                    <p className={s.panelLinks}>
                      <a href={c.docs.href}>{c.docs.label}</a>
                      {c.guide && (
                        <>
                          {' · '}
                          <a href={c.guide.href}>{c.guide.label}</a>
                        </>
                      )}
                    </p>
                  </div>
                ))}
              </div>
              <p className={s.small}>
                <a href={C.tabs.more.href}>{C.tabs.more.label}</a>
              </p>
              </div>
            </div>
            <figure className={cx(s.margin, s.heroFigure)}>
              <div className={s.sticky}>
              <Pic
                name="card-draft-light-desktop"
                w={1364}
                h={776}
                alt="MCPEmails draft card in a chat: a reply to jordan@example.com about moving Thursday's design review, saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons."
                mobile={{ name: 'card-draft-light-mobile', w: 720, h: 878 }}
              />
              <Label data={C.labels.draftCard} />
              </div>
            </figure>
          </div>

        </section>

        {/* ── Walkthrough: demo before explanation ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-walk" data-v10-mono="">
          <Head n={1} id="v10-walk" title={C.walkthrough.title} cobalt />
          <div className={s.row}>
            <div className={s.col}>
              {C.walkthrough.intro.map((p) => (
                <p key={p} className={s.intro}>
                  {p}
                </p>
              ))}
            </div>
          </div>
          <ol className={s.walk}>
            {C.walkthrough.steps.map((step, i) => (
              <li key={step.h} className={s.row}>
                <div className={s.col}>
                  <h3 className={s.h3}>
                    <span className={s.stepNo}>{String(i + 1).padStart(2, '0')}</span> {step.h}
                  </h3>
                  {step.prompt && (
                    <p className={s.prompt}>
                      <span className={s.promptMark} aria-hidden="true">
                        &gt;
                      </span>{' '}
                      {step.prompt}
                    </p>
                  )}
                  <p>{step.p}</p>
                </div>
                <div className={s.margin}>
                  {i === 1 && (
                    <p className={s.note}>
                      <span className={s.noteLabel}>{C.walkthrough.marginNote.label}</span>
                      <span>{C.walkthrough.marginNote.text}</span>
                    </p>
                  )}
                  {i === 2 && (
                    <figure>
                      <Clip
                        src={`${A}card-draft-send-light-desktop.mp4`}
                        mobileSrc={`${A}card-draft-send-light-mobile.mp4`}
                        poster={`${A}card-draft-send-light-desktop-poster`}
                        mobilePoster={{ base: `${A}card-draft-send-light-mobile-poster`, w: 784, h: 720 }}
                        width={1428}
                        height={840}
                        label="Screen recording: an MCPEmails draft card in a chat, Send is clicked, a five-second Undo countdown runs and the card becomes a Sent to jordan@example.com receipt."
                      />
                      <Label data={C.labels.sendClip} />
                    </figure>
                  )}
                  {i === 3 && (
                    <figure>
                      <Pic
                        name="card-draft-sent-light-desktop"
                        w={1364}
                        h={462}
                        alt="MCPEmails card after sending a draft: Sent to jordan@example.com with the subject, the start of the message and a Show full message link."
                        mobile={{ name: 'card-draft-sent-light-mobile', w: 720, h: 548 }}
                      />
                      <Label data={C.labels.draftSent} />
                    </figure>
                  )}
                  {i === 4 && (
                    <>
                      <figure>
                        <Pic
                          name="card-approval-light-desktop"
                          w={1364}
                          h={484}
                          alt="MCPEmails approval card: a reply to billing@supplier.example waiting for approval, with Reject and Approve in browser buttons and the note that no agent can approve a send."
                          mobile={{ name: 'card-approval-light-mobile', w: 720, h: 602 }}
                        />
                        <Label data={C.labels.approval} />
                      </figure>
                      <figure className={s.gapTop}>
                        <Pic
                          name="card-sent-light-desktop"
                          w={1364}
                          h={138}
                          alt="MCPEmails receipt card: Sent to billing@supplier.example, approved in the browser, sent over SMTP and copied to Sent."
                          mobile={{ name: 'card-sent-light-mobile', w: 720, h: 172 }}
                        />
                        <Label data={C.labels.cardSent} />
                      </figure>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Providers ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-providers" id="providers">
          <Head n={2} id="v10-providers" title={C.providers.title} cobalt={COBALT.providers === 'number'} />
          <div className={s.row}>
            <div className={s.col}>
              <p className={s.intro}>{C.providers.intro}</p>
              <dl className={s.ruled}>
                {C.providers.rows.map((r) => (
                  <div key={r.name} className={s.ruledRow}>
                    <dt>
                      <a href={r.href}>{r.name}</a>
                    </dt>
                    <dd>{r.how}</dd>
                  </div>
                ))}
                <div className={cx(s.ruledRow, COBALT.providers === 'content' ? s.cobaltRow : s.strongRow)}>
                  <dt>
                    <a href={C.providers.imap.href}>{C.providers.imap.name}</a>
                  </dt>
                  <dd>{C.providers.imap.how}</dd>
                </div>
              </dl>
              <ul className={s.linkList}>
                {C.providers.links.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div className={s.margin}>
              <figure>
                <picture className={s.pic}>
                  <source media="(max-width: 767px)" srcSet={`${CA}logo-wall-mono-mobile.svg`} width={358} height={620} />
                  <img
                    src={`${CA}logo-wall-mono.svg`}
                    width={960}
                    height={240}
                    loading="lazy"
                    decoding="async"
                    alt="Supported email providers: Gmail, Outlook / Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail, GMX, WEB.DE and any IMAP inbox."
                  />
                </picture>
                <Label data={C.labels.wall} />
              </figure>
              <figure className={s.gapTop}>
                <Pic
                  name="dashboard-connect-providers-light-desktop"
                  w={1280}
                  h={1800}
                  className={s.tall}
                  alt="MCPEmails Connect an inbox dialog with provider tiles for IMAP / SMTP, Gmail, iCloud Mail, Yahoo Mail, Zoho Mail, Yandex Mail, Fastmail and Outlook."
                />
                <Label data={C.labels.providersDialog} />
              </figure>
            </div>
          </div>
        </section>

        {/* ── How it works ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-how" id="how">
          <Head n={3} id="v10-how" title={C.how.title} />
          <div className={s.row}>
            <div className={s.col}>
              {C.how.intro.map((p) => (
                <p key={p} className={s.intro}>
                  {p}
                </p>
              ))}
            </div>
          </div>
          <div className={s.figs}>
            <DrawLine />
            {C.how.figs.map((f, i) => (
              <div key={f.n} className={cx(s.row, s.fig)}>
                <div className={s.col}>
                  <h3 className={s.h3}>
                    <span className={s.figNo}>{f.n}</span> {f.h}
                  </h3>
                  {f.p.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                  {i === 1 && (
                    <div className={s.endpoint}>
                      <span className={s.codeLabel}>MCP endpoint</span>
                      <code>{C.MCP_URL}</code>
                    </div>
                  )}
                  {i === 2 && (
                    <figure className={s.wide}>
                      <picture className={s.pic}>
                        <source media="(max-width: 767px)" srcSet={`${CA}diagram-flow-mobile.svg`} width={358} height={252} />
                        <img
                          src={`${CA}diagram-flow.svg`}
                          width={960}
                          height={432}
                          loading="lazy"
                          decoding="async"
                          alt="How it works: your chat app asks MCPEmails over MCP, MCPEmails fetches your inbox live, and you review each draft in the chat and click Send."
                        />
                      </picture>
                      <Label data={C.labels.flow} />
                    </figure>
                  )}
                  {f.links && (
                    <p className={s.small}>
                      {f.links.map((l, j) => (
                        <span key={l.href}>
                          {j > 0 && ' · '}
                          <a href={l.href}>{l.label}</a>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                <div className={s.margin}>
                  {i === 0 && (
                    <figure>
                      <Pic
                        name="dashboard-connect-imap-light-desktop"
                        w={1280}
                        h={1800}
                        className={s.tall}
                        alt="MCPEmails Connect IMAP / SMTP form with email address, IMAP and SMTP host and port, and password fields."
                      />
                      <Label data={C.labels.imapForm} />
                    </figure>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Security ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-security" id="security">
          <Head n={4} id="v10-security" title={C.security.title} cobalt={COBALT.security === 'number'} />
          <div className={s.row}>
            <div className={s.col}>
              <p className={s.intro}>{C.security.intro}</p>
              <p className={cx(s.place, COBALT.security === 'content' && s.cobalt)}>
                <span className={s.placeText}>{C.security.location}</span>
                <a href={C.security.locationLink.href}>{C.security.locationLink.label}</a>
              </p>
              {C.security.blocks.map((b) => (
                <div key={b.h} className={s.block}>
                  <h3 className={s.h3}>{b.h}</h3>
                  <p>{b.p}</p>
                </div>
              ))}
              <ul className={s.linkList}>
                {C.security.links.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
            <div className={s.margin}>
              <figure className={s.sticky}>
                <img
                  className={s.svgFig}
                  src={`${CA}diagram-stored.svg`}
                  width={960}
                  height={400}
                  loading="lazy"
                  decoding="async"
                  alt="MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored."
                />
                <Label data={C.labels.stored} />
              </figure>
            </div>
          </div>
        </section>

        {/* ── Use cases by mailbox ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-uses" id="features">
          <Head n={5} id="v10-uses" title={C.uses.title} cobalt={COBALT.uses === 'number'} />
          <div className={s.row}>
            <div className={s.col}>
              <p className={s.intro}>{C.uses.intro}</p>
            </div>
          </div>
          {C.uses.items.map((u, i) => (
            <div key={u.address} className={cx(s.row, s.use)}>
              <div className={s.col}>
                <h3 className={s.h3}>
                  <span className={cx(s.addrTag, i === 0 && COBALT.uses === 'content' && s.cobalt)}>{u.address}</span> {u.h}
                </h3>
                <p>{u.p}</p>
              </div>
              <div className={s.margin}>
                <p className={s.note}>
                  <span className={s.noteLabel}>Asked of it</span>
                  <span className={s.noteQuote}>“{u.prompt}”</span>
                </p>
              </div>
            </div>
          ))}
          <div className={s.row}>
            <div className={s.col}>
              <h3 className={s.h3}>{C.uses.compare.h}</h3>
              <p>{C.uses.compare.p}</p>
            </div>
          </div>
          <figure className={s.compareFig}>
            <Compare
              start={DIVIDER_START}
              beforeLabel={C.uses.compare.before}
              afterLabel={C.uses.compare.after}
              rangeLabel={C.uses.compare.range}
              before={
                <Pic
                  name="dashboard-inboxes-light-desktop"
                  w={2880}
                  h={1800}
                  alt="Before: the MCPEmails Inboxes page with two connected IMAP inboxes and nothing waiting."
                  mobile={{ name: 'dashboard-inboxes-light-mobile', w: 780, h: 1688 }}
                />
              }
              after={
                <Pic
                  name="dashboard-approvals-light-desktop"
                  w={2880}
                  h={1800}
                  alt="After: the MCPEmails Approvals page with two emails prepared by an AI assistant, each with Reject and Review & approve buttons."
                  mobile={{ name: 'dashboard-approvals-light-mobile', w: 780, h: 1688 }}
                />
              }
            />
            <Label data={C.labels.compare} />
          </figure>
          <div className={s.row}>
            <div className={s.col}>
              <ul className={s.linkList}>
                {C.uses.links.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── Reviews ── */}
        {review && (
          <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-reviews" id="reviews">
            <Head n={6} id="v10-reviews" title={C.reviews.title} cobalt={COBALT.reviews === 'number'} />
            <div className={s.row}>
              <div className={s.col}>
                <p className={s.intro}>{C.reviews.intro}</p>
                <figure className={s.review}>
                  <blockquote className={s.quote} cite={review.sourceUrl}>
                    <p>{review.quote}</p>
                  </blockquote>
                  <figcaption className={s.cite}>
                    {review.author}, {review.role},{' '}
                    <a href={review.url} rel="noopener">
                      {review.company}
                    </a>
                  </figcaption>
                </figure>
              </div>
              <div className={s.margin}>
                <div className={cx(s.rating, COBALT.reviews === 'content' && s.cobalt)}>
                  <span className={s.ratingNum}>{review.rating}/5</span>
                  <span>{C.reviews.stars}</span>
                </div>
                <p className={cx(s.label, s.labelStandalone)}>
                  <span className={s.labelTitle}>{C.labels.review.title}</span>
                  <span className={s.labelMedium}>{C.labels.review.medium}</span>
                  <span className={s.labelDate}>
                    {C.labels.leftWord} <time dateTime={review.date}>{C.museumDate(review.date)}</time> ·{' '}
                    <a href={review.sourceUrl} rel="noopener">
                      {C.reviews.readOn}
                    </a>
                  </span>
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ── Pricing ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-pricing" id="pricing">
          <Head n={7} id="v10-pricing" title={C.pricing.title} cobalt={COBALT.pricing === 'number'} />
          <div className={s.row}>
            <div className={s.col}>
              <p className={s.intro}>{C.pricing.intro}</p>
            </div>
          </div>
          <div className={s.plans}>
            {tiers.map((t) => (
              <div key={t.id} className={cx(s.plan, t.accent && s.planAccent)}>
                <h3 className={s.planName}>
                  {t.name}
                  {t.accent && <span className={s.planFlag}>{C.pricing.popular}</span>}
                </h3>
                <p className={s.planPrice}>
                  <span className={s.planAmount}>
                    <Money usd={t.usd} eur={t.eur} eurEnabled={eurEnabled} />
                  </span>
                  <span className={s.planPer}>{t.per}</span>
                </p>
                {t.cents > 0 && (
                  <p className={s.planVat}>
                    <Money usd="" eur={C.pricing.inclVat} eurEnabled={eurEnabled} />
                  </p>
                )}
                {t.minimum && <p className={s.planMin}>{t.minimum}</p>}
                <p className={s.planDesc}>{t.desc}</p>
                <ul className={s.planList}>
                  {t.features.map((f) => (
                    <li key={f.usd}>
                      <Money usd={f.usd} eur={f.eur} eurEnabled={eurEnabled} />
                    </li>
                  ))}
                </ul>
                <div className={s.planFoot}>
                  <a
                    href={t.href}
                    className={cx(s.btn, t.accent && COBALT.pricing === 'content' ? s.btnPrimary : s.btnLine, s.planBtn)}
                  >
                    {t.cta}
                  </a>
                  <p className={s.reassure}>{t.cents > 0 ? checkoutReassurance(locale) : C.pricing.freeNote}</p>
                </div>
              </div>
            ))}
          </div>
          <div className={s.row}>
            <div className={s.col}>
              <p className={s.small}>
                {C.pricing.footnote.before} <a href="/pricing">{C.pricing.footnote.compare}</a> ·{' '}
                <a href="mailto:hello@mcpemails.com">{C.pricing.footnote.contact}</a> ·{' '}
                <a href="/for/business">{C.pricing.footnote.business}</a>
              </p>
            </div>
          </div>
        </section>

        {/* ── FAQ: every question and answer visible ── */}
        <section className={cx(s.section, s.lazySection)} aria-labelledby="v10-faq" id="faq">
          <Head n={8} id="v10-faq" title={C.faq.title} cobalt={COBALT.faq === 'number'} />
          <div className={s.row}>
            <div className={s.col}>
              <p className={s.intro}>{C.faq.intro}</p>
              <div className={s.faq}>
                {faqItems.map((item) => (
                  <div key={item.q} className={s.faqItem}>
                    <h3 className={s.faqQ}>{item.q}</h3>
                    <p>{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className={s.margin}>
              <p className={cx(s.note, s.sticky)}>
                <span className={s.noteLabel}>{C.faq.note.label}</span>
                <span>
                  {C.faq.note.before} <a href="mailto:support@mcpemails.com">support@mcpemails.com</a>{' '}
                  {C.faq.note.middle} <a href="/help">{C.faq.note.help}</a>.
                </span>
              </p>
            </div>
          </div>
        </section>

        {/* ── Closing ── */}
        <section className={cx(s.section, s.closing, s.lazySection)} aria-labelledby="v10-close">
          <div className={s.row}>
            <div className={s.col}>
              <h2 id="v10-close" className={s.closingTitle}>
                {C.closing.title}
              </h2>
              <p className={s.intro}>{C.closing.p}</p>
              <div className={s.ctas}>
                <a href="/signup" className={cx(s.btn, s.btnPrimary)}>
                  {C.closing.primary}
                </a>
                <a href="/docs/clients" className={cx(s.btn, s.btnLine)}>
                  {C.closing.secondary}
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerBrand}>
            <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" loading="lazy" />
            <p>{C.footer.tagline}</p>
            <dl className={s.contact}>
              {C.footer.contact.map((c) => (
                <div key={c.href}>
                  <dt>{c.label}</dt>
                  <dd>
                    <a href={c.href} className={s.mono}>
                      {c.value}
                    </a>
                  </dd>
                </div>
              ))}
              <div>
                <dt>{C.footer.endpointLabel}</dt>
                <dd className={s.mono}>{C.MCP_URL}</dd>
              </div>
            </dl>
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
