/**
 * Homepage Lab v05, "setup sheet" (staging only, English only).
 *
 * A sticky split: the H1 and Start free stay pinned in the left five columns
 * while the right seven scroll through the setup in order (the card, connect,
 * paste the URL, ask, approve, sent). After the split the page continues as a
 * Q and A on storage, teams, the maker, reviews, pricing and the FAQ.
 * Server component; the clip and the currency switch are small client islands.
 */
import styles from './Home.module.css';
import {
  ENDPOINT, nav, hero, steps, security, team, maker, reviews as reviewCopy, pricing as P, faq, closing, footer, providers,
} from './copy.mjs';
import { SEED, stepNumber } from './seed.mjs';
import Clip from './Clip';
import { CurrencyRoot, Money, EurOnly } from './Currency';
import { REVIEWS } from '../../marketing/reviews.mjs';
import { PLANS, planDisplayName } from '@/lib/stripe/plans';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';

const SANS_URL = new URL('./fonts/public-sans-latin.woff2', import.meta.url);
const A = '/home-lab/assets/a/';
const C = '/home-lab/assets/c/';
const CLIP = `${A}card-draft-send-light`;

/* ---------- small helpers ---------- */

const fig = (text, n) => text.replace('{n}', n);
const lcFirst = (s) => (typeof s === 'string' && s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Light markup from the messages file: <b>, <strong>, <code>, <em>; other tags are dropped. */
function rich(text) {
  const strip = (s) => s.replace(/<[^>]+>/g, '');
  const out = [];
  const re = /<(b|strong|code|em|i)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let key = 0;
  let m;
  while ((m = re.exec(text))) {
    out.push(strip(text.slice(last, m.index)));
    const inner = strip(m[2]);
    if (m[1] === 'code') out.push(<code key={key++}>{inner}</code>);
    else if (m[1] === 'em' || m[1] === 'i') out.push(<em key={key++}>{inner}</em>);
    else out.push(<strong key={key++}>{inner}</strong>);
    last = re.lastIndex;
  }
  out.push(strip(text.slice(last)));
  return out;
}

/** Text that carries a dollar amount: USD on the server, EUR for an EU visitor. */
function Amounts({ text, render = (t) => t }) {
  if (!/\$/.test(text)) return render(text);
  return <Money usd={render(text)} eur={render(euroizeAmounts(text, 'en'))} />;
}

function Label({ children, lit = true }) {
  return (
    <p className={styles.label}>
      <span className={lit ? styles.dot : styles.dotOff} aria-hidden="true" />
      {children}
    </p>
  );
}

/**
 * A real screenshot in a hardware frame. AVIF + WebP, optional phone-width
 * source, lazy below the fold, width and height always set.
 */
function Shot({ name, w, h, alt, mobile = null, caption, crop = null, eager = false }) {
  return (
    <figure className={styles.figure}>
      <div className={styles.frame} style={crop ? { aspectRatio: crop } : undefined}>
        <picture>
          {mobile && (
            <source
              media="(max-width: 767px)"
              type="image/avif"
              srcSet={`${A}${mobile.name}.avif`}
              width={mobile.w}
              height={mobile.h}
            />
          )}
          {mobile && (
            <source
              media="(max-width: 767px)"
              type="image/webp"
              srcSet={`${A}${mobile.name}.webp`}
              width={mobile.w}
              height={mobile.h}
            />
          )}
          <source type="image/avif" srcSet={`${A}${name}.avif`} />
          <img
            className={crop ? styles.cropImg : styles.img}
            src={`${A}${name}.webp`}
            width={w}
            height={h}
            alt={alt}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
          />
        </picture>
      </div>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}

function LinkRow({ links }) {
  return (
    <ul className={styles.linkRow}>
      {links.map(([href, text]) => (
        <li key={href}>
          <a href={href}>{text}</a>
        </li>
      ))}
    </ul>
  );
}

/* ---------- pricing data ---------- */

function priceTiers(stripePrices, businessSeat) {
  const locale = 'en';
  const tiers = [
    { msgKey: 'free', priceKey: 'free', href: '/signup', accent: false },
    { msgKey: 'personal', priceKey: 'personal', href: withReadingLang(pricingUpgradeHref('personal', false, false, locale), locale), accent: false },
    { msgKey: 'solo', priceKey: 'solo', href: withReadingLang(pricingUpgradeHref('solo', false, false, locale), locale), accent: true },
    { msgKey: 'business', priceKey: 'pro', href: withReadingLang(pricingUpgradeHref('pro', false, false, locale), locale), accent: false },
  ];
  return tiers.map((tier) => {
    const live = stripePrices?.[tier.priceKey]?.monthlyCents;
    const cents = live != null && live > 0 ? live : PLANS[tier.priceKey].monthlyPriceCents;
    const eurCents = eurCentsFor(stripePrices?.[tier.priceKey]?.eurMonthlyCents, cents) ?? cents;
    const seat = tier.msgKey === 'business' ? businessSeat?.card ?? null : null;
    const copy = P.tiers[tier.msgKey];
    return {
      ...tier,
      name: planDisplayName(tier.priceKey),
      usd: formatUsdCopy(cents, locale),
      eur: formatMoneyCents(eurCents, 'eur', locale),
      paid: cents > 0,
      per: tier.priceKey === 'free' ? P.perForever : seat ? seat.per : P.perMonth,
      desc: seat ? lcFirst(seat.desc) : copy.desc,
      minimum: seat ? lcFirst(seat.minimum) : null,
      features: seat ? seat.features.map(lcFirst) : copy.features,
      cta: copy.cta,
    };
  });
}

/* ---------- page ---------- */

/**
 * @param {{
 *   stripePrices?: unknown,
 *   eurEnabled?: boolean,
 *   businessSeat?: unknown,
 *   faqItems?: { q: string, a: string }[],
 *   locale?: string,
 * }} props
 */
export default function Home({ stripePrices: rawPrices = null, eurEnabled = false, businessSeat: rawSeat = null, faqItems = [] }) {
  const stripePrices = /** @type {import('@/lib/stripe/getPrices').StripePricesMap | null} */ (rawPrices);
  const businessSeat = /** @type {import('@/lib/billing/business-seat-copy').BusinessSeatPageCopy | null} */ (rawSeat);
  const n = (i) => stepNumber(i);
  const tiers = priceTiers(stripePrices, businessSeat);
  const review = REVIEWS[0] ?? null;
  const stepIndex = [
    ['step-card', steps.clip.tag],
    ['step-connect', steps.connect.tag],
    ['step-paste', steps.paste.tag],
    ['step-ask', steps.ask.tag],
    ['step-approve', steps.approve.tag],
    ['step-sent', steps.sent.tag],
  ];
  const accent = (i) => (SEED.accentStep === i ? ` ${styles.accent}` : '');

  const vars = {
    '--panel': SEED.panel,
    '--rhythm': `${SEED.rhythm}px`,
    '--frame-r': `${SEED.frameRadius}px`,
  };

  return (
    <CurrencyRoot eurEnabled={eurEnabled}>
      <div className={styles.page} style={vars}>
        <link rel="preload" href={String(SANS_URL)} as="font" type="font/woff2" crossOrigin="anonymous" />
        <header className={styles.header}>
          <a href="/" className={styles.logoLink}>
            <img className={styles.logo} src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" />
          </a>
          <nav aria-label={nav.label} className={styles.nav}>
            <a className={styles.navWide} href="#how">{nav.how}</a>
            <a href="#pricing">{nav.pricing}</a>
            <a href="/docs">{nav.docs}</a>
            <a className={styles.navWide} href="/blog">{nav.blog}</a>
            <a href="/login">{nav.signIn}</a>
            <a className={styles.navStart} href="/signup">{nav.start}</a>
          </nav>
        </header>

        <main>
          {/* ===== sticky split: headline pinned, setup scrolls ===== */}
          <div className={styles.split} id="how">
            <div className={styles.pinCol}>
              <div className={styles.pin}>
                <Label>{hero.label}</Label>
                <h1 className={styles.h1}>{hero.h1}</h1>
                <p className={styles.lead}>{hero.lead}</p>
                <div className={styles.ctaRow}>
                  <a className={styles.btnPrimary} href="/signup">{hero.start}</a>
                  <a className={styles.btnQuiet} href="/docs/clients">{hero.install}</a>
                </div>
                <dl className={styles.meta}>
                  {hero.meta.map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
                <nav aria-label={hero.indexLabel} className={styles.index}>
                  <p className={styles.indexHead}>{hero.indexLabel}</p>
                  <ol>
                    {stepIndex.map(([id, tag], i) => (
                      <li key={id}>
                        <a href={`#${id}`}>
                          <span className={styles.indexNum}>{n(i)}</span>
                          {tag}
                        </a>
                      </li>
                    ))}
                  </ol>
                </nav>
              </div>
            </div>

            <div className={styles.rail}>
              {/* 00 the card (hero clip) */}
              <section id="step-card" className={styles.step + accent(0)} aria-labelledby="h-card">
                <figure className={styles.figure}>
                  <div className={styles.frame}>
                    <Clip
                      desktop={{ base: `${CLIP}-desktop`, w: 1428, h: 840 }}
                      mobile={{ base: `${CLIP}-mobile`, w: 784, h: 720 }}
                      label={steps.clip.clipAlt}
                      pauseLabel={steps.clip.pause}
                      playLabel={steps.clip.play}
                    />
                  </div>
                  <figcaption className={styles.caption}>{fig(steps.clip.figure, n(0))}</figcaption>
                </figure>
                <Label>{`${n(0)} · ${steps.clip.tag}`}</Label>
                <h2 id="h-card" className={styles.h2}>{steps.clip.h}</h2>
                {steps.clip.p.map((p) => <p key={p} className={styles.p}>{p}</p>)}
              </section>

              {/* 01 connect (providers) */}
              <section id="step-connect" className={styles.step + accent(1)} aria-labelledby="h-connect">
                <Label>{`${n(1)} · ${steps.connect.tag}`}</Label>
                <h2 id="h-connect" className={styles.h2}>{steps.connect.h}</h2>
                {steps.connect.p.map((p) => <p key={p} className={styles.p}>{p}</p>)}
                <div className={styles.panel}>
                  <p className={styles.panelHead}>{steps.connect.hoverHint}</p>
                  <ul className={styles.providers}>
                    {providers.map((pv) => (
                      <li key={pv.name}>
                        <a href={pv.href} className={styles.provider}>
                          {pv.logo ? (
                            <img src={`${C}logo-${pv.logo}-mono.svg`} width={pv.w} height="32" alt="" className={styles.providerLogo} loading="lazy" decoding="async" />
                          ) : (
                            <span className={styles.providerTile} aria-hidden="true">{pv.mono}</span>
                          )}
                          <span className={styles.providerName}>{pv.name}</span>
                          <span className={styles.providerHow}>{pv.how}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <Shot
                  name="dashboard-connect-providers-light-desktop"
                  w={1280}
                  h={1800}
                  crop="1280 / 1240"
                  mobile={{ name: 'dashboard-connect-providers-light-mobile', w: 780, h: 1688 }}
                  alt="MCPEmails Connect an inbox dialog with provider tiles for IMAP / SMTP, Gmail, iCloud Mail, Yahoo Mail, Zoho Mail, Yandex Mail, Fastmail and Outlook, each with how it connects."
                  caption={fig(steps.connect.figure, n(1))}
                />
                <LinkRow links={steps.connect.links} />
              </section>

              {/* 02 paste the URL (clients) */}
              <section id="step-paste" className={styles.step + accent(2)} aria-labelledby="h-paste">
                <Label>{`${n(2)} · ${steps.paste.tag}`}</Label>
                <h2 id="h-paste" className={styles.h2}>{steps.paste.h}</h2>
                {steps.paste.p.map((p) => <p key={p} className={styles.p}>{p}</p>)}
                <div className={styles.endpoint}>
                  <span className={styles.endpointLabel}>{steps.paste.endpointLabel}</span>
                  <code>{ENDPOINT}</code>
                </div>
                <div className={styles.installTop}>
                  <a className={styles.btnPrimary} href="/signup">{hero.start}</a>
                  <span className={styles.installHint}>{steps.paste.startAbove}</span>
                </div>
                <div className={styles.install}>
                  {[
                    ['claude', steps.paste.claude, { name: 'card-draft-sent-light-mobile', w: 720, h: 548, alt: 'MCPEmails card after sending a draft: Sent to jordan@example.com with the subject and the start of the message.' }],
                    ['chatgpt', steps.paste.chatgpt, { name: 'card-approval-light-mobile', w: 720, h: 602, alt: 'MCPEmails approval card: a reply to billing@supplier.example waiting for approval, with Reject and Approve in browser.' }],
                  ].map(([key, col, shot]) => (
                    <div key={key} className={styles.installCol}>
                      <h3 className={styles.h3}>{col.h}</h3>
                      <ol className={styles.numbered}>
                        {col.steps.map((s) => <li key={s}>{s}</li>)}
                      </ol>
                      {col.note && <p className={styles.small}>{col.note}</p>}
                      <Shot
                        name={shot.name}
                        w={shot.w}
                        h={shot.h}
                        alt={shot.alt}
                        caption={fig(col.figure, n(2))}
                      />
                      <p className={styles.small}>
                        <a href={col.guide[0]}>{col.guide[1]}</a>
                      </p>
                    </div>
                  ))}
                </div>
                <p className={styles.p}>{steps.paste.after}</p>
                <Shot
                  name="dashboard-overview-light-desktop"
                  w={2880}
                  h={1800}
                  mobile={{ name: 'dashboard-overview-light-mobile', w: 780, h: 1688 }}
                  alt="MCPEmails dashboard overview with the MCP endpoint mcpemails.com/api/mcp at the top, inboxes connected, API keys, MCP calls and recent tool calls."
                  caption={fig(steps.paste.figure, n(2))}
                />
                <LinkRow links={steps.paste.links} />
              </section>

              {/* 03 ask */}
              <section id="step-ask" className={styles.step + accent(3)} aria-labelledby="h-ask">
                <Label>{`${n(3)} · ${steps.ask.tag}`}</Label>
                <h2 id="h-ask" className={styles.h2}>{steps.ask.h}</h2>
                {steps.ask.p.map((p) => <p key={p} className={styles.p}>{p}</p>)}
                <div className={styles.panel}>
                  <p className={styles.panelHead}>{steps.ask.promptsLabel}</p>
                  <ul className={styles.prompts}>
                    {steps.ask.prompts.map(([q, a]) => (
                      <li key={q}>
                        <span className={styles.prompt}>{q}</span>
                        <span className={styles.outcome}>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Shot
                  name="card-draft-light-desktop"
                  w={1364}
                  h={776}
                  mobile={{ name: 'card-draft-light-mobile', w: 720, h: 878 }}
                  alt="MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons."
                  caption={fig(steps.ask.figure, n(3))}
                />
                <LinkRow links={[steps.ask.toolsLink]} />
              </section>

              {/* 04 approve */}
              <section id="step-approve" className={styles.step + accent(4)} aria-labelledby="h-approve">
                <Label>{`${n(4)} · ${steps.approve.tag}`}</Label>
                <h2 id="h-approve" className={styles.h2}>{steps.approve.h}</h2>
                {steps.approve.p.map((p) => <p key={p} className={styles.p}>{p}</p>)}
                <Shot
                  name="dashboard-approve-modal-light-desktop"
                  w={2880}
                  h={1800}
                  mobile={{ name: 'dashboard-approve-modal-light-mobile', w: 780, h: 1688 }}
                  alt="MCPEmails Approve email send dialog showing the request, inbox, recipients, subject and time left, with Cancel and Approve buttons."
                  caption={fig(steps.approve.figure, n(4))}
                />
              </section>

              {/* 05 sent */}
              <section id="step-sent" className={styles.step + accent(5)} aria-labelledby="h-sent">
                <Label>{`${n(5)} · ${steps.sent.tag}`}</Label>
                <h2 id="h-sent" className={styles.h2}>{steps.sent.h}</h2>
                {steps.sent.p.map((p) => <p key={p} className={styles.p}>{p}</p>)}
                <Shot
                  name="card-sent-light-desktop"
                  w={1364}
                  h={138}
                  mobile={{ name: 'card-sent-light-mobile', w: 720, h: 172 }}
                  alt="MCPEmails receipt card: Sent to billing@supplier.example, approved in the browser, sent over SMTP and copied to Sent."
                  caption={fig(steps.sent.figure, n(5))}
                />
              </section>
            </div>
          </div>

          {/* ===== storage and security, diagrams in the margin ===== */}
          <section id="features" className={styles.band} aria-labelledby="h-storage">
            <div className={styles.bandHead}>
              <Label>{security.tag}</Label>
              <h2 id="h-storage" className={styles.h2Big}>{security.h}</h2>
              <p className={styles.p}>{security.intro}</p>
            </div>
            <div className={styles.qa}>
              {security.items.map((item) => (
                <div key={item.q} className={styles.qaRow}>
                  <div className={styles.qaText}>
                    <h3 className={styles.q}>{item.q}</h3>
                    <p className={styles.p}>{item.a}</p>
                  </div>
                  <aside className={styles.margin}>
                    <MarginNote kind={item.margin} />
                  </aside>
                </div>
              ))}
            </div>
            <LinkRow links={security.links} />
          </section>

          {/* ===== teams and Business per person ===== */}
          <section id="business" className={styles.band} aria-labelledby="h-team">
            <div className={styles.bandHead}>
              <Label>{team.tag}</Label>
              <h2 id="h-team" className={styles.h2Big}>{team.h}</h2>
              <p className={styles.p}>{team.intro}</p>
            </div>
            <div className={styles.qa}>
              {team.items.map((item) => (
                <div key={item.q} className={styles.qaRow}>
                  <div className={styles.qaText}>
                    <h3 className={styles.q}>{item.q}</h3>
                    <p className={styles.p}>{item.a}</p>
                  </div>
                  <aside className={styles.margin}>
                    {item.q === team.items[1].q && <BusinessSeatNote tier={tiers[3]} businessSeat={businessSeat} />}
                  </aside>
                </div>
              ))}
            </div>
            <LinkRow links={team.links} />
          </section>

          {/* ===== the maker ===== */}
          <section id="maker" className={styles.band} aria-labelledby="h-maker">
            <div className={styles.bandHead}>
              <Label>{maker.tag}</Label>
              <h2 id="h-maker" className={styles.h2Big}>{maker.h}</h2>
            </div>
            <div className={styles.qa}>
              {maker.items.map((item, i) => (
                <div key={item.q} className={styles.qaRow}>
                  <div className={styles.qaText}>
                    <h3 className={styles.q}>{item.q}</h3>
                    <p className={styles.p}>
                      {item.a}
                      {i === 3 && (
                        <>
                          {' '}
                          <a href="mailto:support@mcpemails.com">support@mcpemails.com</a>
                        </>
                      )}
                    </p>
                  </div>
                  <aside className={styles.margin}>
                    {i === 1 && (
                      <blockquote className={styles.pull}>
                        <p>“{maker.quote}”</p>
                        <footer>
                          <a href="/about">{maker.quoteSource}</a>
                        </footer>
                      </blockquote>
                    )}
                  </aside>
                </div>
              ))}
            </div>
            <LinkRow links={maker.links} />
          </section>

          {/* ===== reviews: real, named, linked; hidden when none ===== */}
          {review && (
            <section id="reviews" className={styles.band} aria-labelledby="h-reviews">
              <div className={styles.bandHead}>
                <Label>{reviewCopy.tag}</Label>
                <h2 id="h-reviews" className={styles.h2Big}>{reviewCopy.h}</h2>
                <p className={styles.p}>{reviewCopy.intro}</p>
              </div>
              <figure className={styles.review}>
                <blockquote className={styles.reviewQuote}>
                  <p>{review.quote}</p>
                </blockquote>
                <figcaption className={styles.reviewBy}>
                  <span className={styles.reviewName}>{review.author}</span>
                  <span>
                    {review.role}
                    {review.company && (
                      <>
                        {', '}
                        {review.url ? <a href={review.url}>{review.company}</a> : review.company}
                      </>
                    )}
                  </span>
                  <span className={styles.reviewMeta}>
                    <span className={styles.stars} role="img" aria-label={reviewCopy.rating.replace('{n}', String(review.rating))}>
                      {Array.from({ length: 5 }, (_, i) => (
                        <span key={i} className={i < review.rating ? styles.starOn : styles.starOff} aria-hidden="true" />
                      ))}
                    </span>
                    {review.sourceUrl && (
                      <a href={review.sourceUrl}>
                        {reviewCopy.publishedOn} Google
                      </a>
                    )}
                    {review.date && <time dateTime={review.date}>{formatDate(review.date)}</time>}
                  </span>
                </figcaption>
              </figure>
            </section>
          )}

          {/* ===== pricing ===== */}
          <section id="pricing" className={styles.band} aria-labelledby="h-pricing">
            <div className={styles.bandHead}>
              <Label>{P.tag}</Label>
              <h2 id="h-pricing" className={styles.h2Big}>{P.h}</h2>
              <p className={styles.p}>{P.intro}</p>
            </div>
            <div className={styles.prices}>
              {tiers.map((t) => (
                <div key={t.msgKey} className={styles.price + (t.accent ? ` ${styles.priceAccent}` : '')}>
                  <p className={styles.label}>
                    <span className={t.accent ? styles.dot : styles.dotOff} aria-hidden="true" />
                    {t.accent ? P.popular : t.msgKey === 'business' && !t.minimum ? P.marks.businessFlat : P.marks[t.msgKey]}
                  </p>
                  <h3 className={styles.priceName}>{t.name}</h3>
                  <p className={styles.amount}>
                    <Money usd={t.usd} eur={t.eur} />
                    <small>{t.per}</small>
                  </p>
                  {t.paid && (
                    <EurOnly>
                      <span className={styles.small}>{P.inclVat}</span>
                    </EurOnly>
                  )}
                  {t.minimum && (
                    <p className={styles.small}>
                      <Amounts text={t.minimum} />
                    </p>
                  )}
                  <p className={styles.priceDesc}>{t.desc}</p>
                  <ul className={styles.features}>
                    {t.features.map((f) => (
                      <li key={f}>
                        <Amounts text={f} />
                      </li>
                    ))}
                  </ul>
                  <a className={t.accent ? styles.btnPrimary : styles.btnSecondary} href={t.href}>
                    {t.cta}
                  </a>
                </div>
              ))}
            </div>
            <p className={styles.small}>
              {P.footnote} <a href={P.compare[0]}>{P.compare[1]}</a>. {P.contact}{' '}
              <a href="mailto:hello@mcpemails.com">hello@mcpemails.com</a>.
            </p>
          </section>

          {/* ===== FAQ: exactly faqItems, all visible ===== */}
          {faqItems.length > 0 && (
            <section id="faq" className={styles.band} aria-labelledby="h-faq">
              <div className={styles.bandHead}>
                <Label>{faq.tag}</Label>
                <h2 id="h-faq" className={styles.h2Big}>{faq.h}</h2>
                <p className={styles.p}>{faq.intro}</p>
              </div>
              <div className={styles.faq}>
                {faqItems.map((item) => (
                  <div key={item.q} className={styles.faqItem}>
                    <h3 className={styles.q}>{item.q}</h3>
                    <p className={styles.p}>
                      <Amounts text={item.a} render={rich} />
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ===== closing ===== */}
          <section className={styles.closing} aria-labelledby="h-closing">
            <h2 id="h-closing" className={styles.h2Big}>{closing.h}</h2>
            <p className={styles.p}>{closing.p}</p>
            <div className={styles.ctaRow}>
              <a className={styles.btnPrimary} href="/signup">{closing.start}</a>
              <a className={styles.btnQuiet} href="/connect">{closing.install}</a>
              <a className={styles.btnQuiet} href="/login">{closing.signIn}</a>
            </div>
          </section>
        </main>

        <footer className={styles.footer}>
          <div className={styles.footGrid}>
            <div className={styles.footBrand}>
              <img src="/logo-mark.svg" width="48" height="48" alt="MCPEmails" className={styles.footMark} loading="lazy" />
              <p>{footer.tagline}</p>
              <dl className={styles.footMeta}>
                <div>
                  <dt>{footer.endpoint}</dt>
                  <dd><code>{ENDPOINT}</code></dd>
                </div>
                <div>
                  <dt>{footer.contact}</dt>
                  <dd><a href="mailto:support@mcpemails.com">support@mcpemails.com</a></dd>
                </div>
                <div>
                  <dt>{footer.sales}</dt>
                  <dd><a href="mailto:hello@mcpemails.com">hello@mcpemails.com</a></dd>
                </div>
              </dl>
            </div>
            {footer.groups.map((g) => (
              <div key={g.h}>
                <p className={styles.footHead}>{g.h}</p>
                <ul className={styles.footList}>
                  {g.links.map(([href, text]) => (
                    <li key={href}><a href={href}>{text}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className={styles.langs} aria-label={footer.languagesLabel} role="group">
            {footer.languages.map(([href, tag, name]) => (
              <a key={href} href={href} hrefLang={tag} aria-current={tag === 'en' ? 'true' : undefined}>
                {name}
              </a>
            ))}
          </div>
          <p className={styles.legal}>
            <span>{footer.copyright}</span>
            <span>{footer.legal}</span>
          </p>
          <p className={styles.legal}>{footer.entity}</p>
        </footer>
      </div>
    </CurrencyRoot>
  );
}

function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).toLowerCase();
}

/** Small line diagrams and marks in the right margin, next to the answer they explain. */
function MarginNote({ kind }) {
  if (kind === 'stored') {
    return (
      <figure className={styles.marginFig}>
        <img
          src={`${C}diagram-stored.svg`}
          width="960"
          height="400"
          loading="lazy"
          decoding="async"
          alt="MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored."
        />
        <figcaption className={styles.caption}>fig. s1 · what is kept, and what is not</figcaption>
      </figure>
    );
  }
  if (kind === 'flow') {
    return (
      <figure className={`${styles.marginFig} ${styles.marginFigSmall}`}>
        <img
          src={`${C}diagram-flow-mobile.svg`}
          width="358"
          height="252"
          loading="lazy"
          decoding="async"
          alt="Your chat app asks MCPEmails, which fetches your inbox live; you review each draft in the chat before it sends from your address."
        />
        <figcaption className={styles.caption}>fig. s2 · one request, start to end</figcaption>
      </figure>
    );
  }
  const marks = {
    location: ['icon-data-location', 'data · Stockholm, EU'],
    encrypted: ['icon-encrypted-credentials', 'credentials · AES-256-GCM'],
    revoke: ['icon-revoke-access', 'access · revoke per client'],
  };
  const mark = marks[kind];
  if (!mark) return null;
  return (
    <p className={styles.mark}>
      <img src={`${C}${mark[0]}.svg`} width="24" height="24" alt="" loading="lazy" />
      <span>{mark[1]}</span>
    </p>
  );
}

/** Business per person, in the margin next to the team answer. */
function BusinessSeatNote({ tier, businessSeat }) {
  return (
    <div className={styles.seatNote}>
      <p className={styles.label}>
        <span className={styles.dot} aria-hidden="true" />
        {tier.name}
      </p>
      <p className={styles.seatAmount}>
        <Money usd={tier.usd} eur={tier.eur} />
        <small>{tier.per}</small>
      </p>
      {businessSeat ? (
        <p className={styles.small}>
          <Amounts text={tier.minimum} />
        </p>
      ) : (
        <p className={styles.small}>{tier.desc}</p>
      )}
      <a href="#pricing" className={styles.small}>every plan, side by side</a>
    </div>
  );
}
