/**
 * Homepage Lab v02, "The Postal Manual" (staging only, English only).
 *
 * The page is a manual's table of contents: every contents line is a native
 * <details> that opens into its chapter in place, so all copy is in the
 * server HTML with JavaScript off. The provider picker in the hero is radio
 * inputs read by CSS (:has), so chapter 02's route follows the visitor's
 * inbox without a script. Copy: copy.mjs. Seeded choices: rng.mjs.
 */
import s from './Home.module.css';
import {
  MCP_URL, nav, hero, providers, contents, ch1, ch2, ch3, ch4, ch5, ch6, appA, appB, footer,
} from './copy.mjs';
import { choices, pageFor } from './rng.mjs';
import { REVIEWS } from '../../marketing/reviews.mjs';
import { PLANS, planDisplayName } from '@/lib/stripe/plans';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { CheckoutReassurance } from '../../CheckoutReassurance';
import Manual from './Manual';
import { Price, Money, VatNote } from './Currency';

const A = '/home-lab/assets/a/';
const C = '/home-lab/assets/c/';
const ROOT_ID = 'v02-manual';
/** The lead paragraph (the LCP) paints in this face; preloaded as a real <link>. */
const LEAD_FONT = new URL('./fonts/atkinson-400.woff2', import.meta.url).pathname;
const HERO_MOBILE = { name: 'dashboard-overview-light-mobile', W: 780, H: 1688, x: 0, y: 150, w: 780, h: 920 };
const HERO_CROP = { name: 'dashboard-overview-light-desktop', W: 2880, H: 1800, x: 1876, y: 905, w: 960, h: 790 };
const HERO_INSET = { name: 'dashboard-overview-light-desktop', W: 2880, H: 1800, x: 548, y: 356, w: 556, h: 252 };
const HERO_ENDPOINT = { name: 'dashboard-overview-light-desktop', W: 2880, H: 1800, x: 1648, y: 24, w: 590, h: 82 };

/* ---------- small renderers ---------- */

const TOKEN = /(==[^=]+==|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/** Light markup from copy.mjs: ==marker==, `mono`, [link](href). */
function Rich({ text }) {
  const parts = text.split(TOKEN);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('==') && part.endsWith('==')) {
      return <mark key={i} className={s.marker}>{part.slice(2, -2)}</mark>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className={s.mono}>{part.slice(1, -1)}</code>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]}>{link[1]}</a>;
    return part;
  });
}

/** `mobile` = { name, w, h }: the phone-width shot under 768 px. */
function Pic({ name, w, h, alt, lazy = true, className, mobile }) {
  return (
    <picture>
      {mobile && (
        <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}${mobile.name}.avif`} width={mobile.w} height={mobile.h} />
      )}
      {mobile && (
        <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}${mobile.name}.webp`} width={mobile.w} height={mobile.h} />
      )}
      <source type="image/avif" srcSet={`${A}${name}.avif`} />
      <img
        className={className}
        src={`${A}${name}.webp`}
        width={w}
        height={h}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        decoding="async"
      />
    </picture>
  );
}

/**
 * A rectangle of a real screenshot. The image keeps its own pixels; the frame
 * clips it, so a 2x shot shown at one image pixel per CSS pixel is a 200%
 * detail. Everything is percentages, so it scales down on a phone.
 */
function Crop({ crop, alt, lazy = true, priority = false, className, children }) {
  const { name, W, H, x, y, w, h } = crop;
  const style = { aspectRatio: `${w} / ${h}` };
  const imgStyle = {
    width: `${(W / w) * 100}%`,
    left: `${(-x / w) * 100}%`,
    top: `${(-y / h) * 100}%`,
  };
  return (
    <div className={`${s.crop} ${className || ''}`} style={style}>
      <picture>
        <source type="image/avif" srcSet={`${A}${name}.avif`} />
        <img
          src={`${A}${name}.webp`}
          width={W}
          height={H}
          alt={alt}
          style={imgStyle}
          loading={lazy ? 'lazy' : undefined}
          decoding={priority ? 'sync' : 'async'}
          fetchPriority={priority ? 'high' : undefined}
        />
      </picture>
      {children}
    </div>
  );
}

function Chapter({ data, index, open = false, children, wide = false }) {
  return (
    <details className={s.chapter} data-chapter="" id={data.id} open={open || undefined}>
      <summary className={s.line}>
        <span className={s.num}>{data.num}</span>
        <span className={s.lineText}>
          <h2 className={s.lineTitle}>{data.title}</h2>
          <span className={s.dek}>{data.dek}</span>
        </span>
        <span className={s.leader} aria-hidden="true" />
        <span className={s.page}>p.&nbsp;{pageFor(index)}</span>
        <span className={s.toggle} aria-hidden="true" />
      </summary>
      <div className={`${s.body} ${wide ? s.bodyWide : ''}`}>{children}</div>
    </details>
  );
}

function Links({ items, className }) {
  return (
    <ul className={className || s.linkRow}>
      {items.map((l) => (
        <li key={l.href}><a href={l.href}>{l.label}</a></li>
      ))}
    </ul>
  );
}

/* ---------- sections ---------- */

function Header() {
  return (
    <header className={s.header}>
      <div className={s.headerInner}>
        <a href="/" className={s.logo} aria-label="MCPEmails home">
          <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" />
        </a>
        <nav className={s.nav} aria-label="Primary">
          <ul>
            {nav.map((n) => (
              <li key={n.href} className={n.href.startsWith('#') && n.href !== '#contents' ? s.navOptional : undefined}>
                <a href={n.href}>{n.label}</a>
              </li>
            ))}
            <li><a href="/login">Sign in</a></li>
          </ul>
          <a className={`${s.btn} ${s.btnPrimary} ${s.btnSmall}`} href="/signup">{hero.ctaPrimary}</a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  const def = choices.defaultProvider;
  return (
    <section className={s.hero} aria-labelledby="v02-h1">
      <div className={s.heroText}>
        <p className={s.kicker}>{hero.kicker}</p>
        <h1 id="v02-h1" className={s.h1}>
          <span className={s.h1Q}>{hero.h1Question}</span>
          <span className={s.h1A}>{hero.h1Answer}</span>
        </h1>
        <p className={s.lead}><Rich text={hero.lead} /></p>
        <div className={s.ctaRow}>
          <a className={`${s.btn} ${s.btnPrimary}`} href="/signup">{hero.ctaPrimary}</a>
          <a className={`${s.btn} ${s.btnSecondary}`} href="/docs/clients">{hero.ctaInstall}</a>
          <a className={s.textLink} href={`#${ch1.id}`}>{hero.draftLink} <span aria-hidden="true">↓</span></a>
        </div>
        <ul className={s.metaRow}>
          {hero.meta.map((m) => <li key={m}>{m}</li>)}
        </ul>
      </div>

      <figure className={s.heroFig}>
        <div className={s.heroMob}>
          <div className={s.heroFrame}>
            <Crop crop={HERO_MOBILE} alt={hero.figAltMobile} />
          </div>
        </div>
        <div className={s.heroStage}>
          <div className={s.heroFrame}>
            <Crop crop={HERO_CROP} alt={hero.figAlt} />
          </div>
          <div className={`${s.heroInset} ${s.heroInsetA}`}>
            <Crop crop={HERO_INSET} alt="Close-up of the dashboard card: Inboxes connected, 2, 2 active inboxes." />
          </div>
          <div className={`${s.heroInset} ${s.heroInsetB}`}>
            <Crop crop={HERO_ENDPOINT} alt="Close-up of the dashboard header: MCP endpoint mcpemails.com/api/mcp with a copy button." />
          </div>
        </div>
        <figcaption className={s.caption}>{hero.figCaption}</figcaption>
      </figure>

      <div className={s.heroBelow}>
        <fieldset className={s.picker} id="inbox-picker">
          <legend className={s.pickerLegend}>{hero.pickerLegend}</legend>
          <div className={s.stamps}>
            {providers.map((p) => (
              <div className={s.stampCell} key={p.id}>
                <input
                  className={s.radio}
                  type="radio"
                  name="v02-provider"
                  id={`v02-p-${p.id}`}
                  value={p.id}
                  defaultChecked={p.id === def}
                />
                <label className={s.stamp} htmlFor={`v02-p-${p.id}`}>
                  <span className={s.stampMark} aria-hidden="true">
                    {p.logo
                      ? <img src={`${C}${p.logo}`} width={p.logoW} height="32" alt="" loading="lazy" />
                      : <span className={s.stampLetters}>Y Z Я</span>}
                  </span>
                  <span className={s.stampName}>{p.name}</span>
                  <span className={s.stampVia}>{p.via}</span>
                </label>
              </div>
            ))}
          </div>
          <div className={s.provNotes} aria-live="polite">
            {providers.map((p) => (
              <p key={p.id} data-prov={p.id} className={`${s.prov} ${p.id === def ? s.provDefault : ''}`}>
                <span className={s.provTag}>{p.name}</span> {p.note}{' '}
                <a href="#how">Your route is in chapter 02.</a>
              </p>
            ))}
          </div>
        </fieldset>

      </div>
    </section>
  );
}

function ChapterAnswer({ index }) {
  return (
    <Chapter data={ch1} index={index} open={choices.openChapter === 'answer'}>
      <div className={s.split} data-r="">
        <div className={s.prose}>
          <p><Rich text={ch1.p1} /></p>
          <p><Rich text={ch1.p2} /></p>
        </div>
        <figure className={s.fig}>
          <div className={s.mount}>
            <Pic name="card-draft-light-desktop" w={1364} h={776} mobile={{ name: 'card-draft-light-mobile', w: 720, h: 878 }} alt="MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons." />
          </div>
          <figcaption className={s.caption}>{ch1.figMain}</figcaption>
        </figure>
      </div>
      <h3 className={s.h3} data-r="">{ch1.calloutsTitle}</h3>
      <ol className={s.callouts}>
        {ch1.callouts.map((c) => (
          <li key={c.n} className={s.callout} data-r="">
            <div className={s.calloutFig} style={{ maxWidth: `${c.crop.w}px` }}>
              <Crop crop={c.crop} alt={c.alt} className={s.calloutCrop} />
              <span className={s.calloutBadge} aria-hidden="true">{c.n}</span>
            </div>
            <div className={s.calloutText}>
              <span className={s.calloutNum} aria-hidden="true">{c.n}</span>
              <p><strong>{c.label}.</strong> {c.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <figure className={s.fig} data-r="">
        <div className={s.mount}>
          <Pic name="card-sent-light-desktop" w={1364} h={138} mobile={{ name: 'card-sent-light-mobile', w: 720, h: 172 }} alt={ch1.receiptAlt} />
        </div>
        <figcaption className={s.caption}>{ch1.receipt}</figcaption>
      </figure>
    </Chapter>
  );
}

function ChapterHow({ index }) {
  const def = choices.defaultProvider;
  return (
    <Chapter data={ch2} index={index} open={choices.openChapter === 'how'}>
      <div className={s.prose} data-r="">
        <p><Rich text={ch2.p1} /></p>
      </div>
      <figure className={s.fig} data-r="">
        <div className={s.mount}>
          <picture>
            <source media="(max-width: 640px)" srcSet={`${C}diagram-flow-mobile-animated.svg`} width={358} height={252} />
            <img src={`${C}diagram-flow-animated.svg`} width={960} height={432} alt="How it works: your chat app asks MCPEmails over MCP, MCPEmails fetches your inbox live, and you review each draft in the chat and click Send before it goes out from your own address." loading="lazy" decoding="async" />
          </picture>
        </div>
        <figcaption className={s.caption}>{ch2.figFlow}</figcaption>
      </figure>

      <h3 className={s.h3} data-r="">{ch2.routeTitle}</h3>
      <p className={s.routeFor} data-r="">
        {ch2.routeFor}{' '}
        {providers.map((p) => (
          <span key={p.id} data-prov={p.id} className={`${s.prov} ${s.provInline} ${p.id === def ? s.provDefault : ''}`}>
            <strong>{p.name}</strong> ({p.via}).
          </span>
        ))}{' '}
        <a href="#inbox-picker">Pick another inbox</a>
      </p>
      <ol className={s.steps}>
        <li className={s.step} data-r="">
          <span className={s.stepNum} aria-hidden="true">1</span>
          <div>
            <h4 className={s.h4}>{ch2.steps[0].h}</h4>
            {providers.map((p) => (
              <div key={p.id} data-prov={p.id} className={`${s.prov} ${p.id === def ? s.provDefault : ''}`}>
                <div className={s.routeSplit}>
                  <div>
                    <p><Rich text={p.route} /></p>
                    <p><a href={p.guide.href}>{p.guide.label}</a></p>
                  </div>
                  <div className={s.shotMount}>
                    <Pic name={p.shot.name} w={p.shot.w || 1280} h={p.shot.h || 1800} alt={p.shot.alt} className={s.shot} mobile={{ name: p.shot.name.replace('-desktop', '-mobile'), w: 780, h: 1688 }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </li>
        {ch2.steps.slice(1).map((st, i) => (
          <li className={s.step} key={st.h} data-r="">
            <span className={s.stepNum} aria-hidden="true">{i + 2}</span>
            <div>
              <h4 className={s.h4}>{st.h}</h4>
              <p><Rich text={st.p} /></p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className={s.h3} id="providers" data-r="">{ch2.officesTitle}</h3>
      <div className={s.prose} data-r="">
        <p>{ch2.offices}</p>
      </div>
      <figure className={s.fig} data-r="">
        <div className={s.mount}>
          <picture>
            <source media="(max-width: 640px)" srcSet={`${C}logo-wall-mono-mobile.svg`} width={358} height={620} />
            <img src={`${C}logo-wall-mono.svg`} width={960} height={240} alt={ch2.logoAlt} loading="lazy" decoding="async" />
          </picture>
        </div>
      </figure>
      <Links items={ch2.officeLinks} />

      <h3 className={s.h3} data-r="">{ch2.teamTitle}</h3>
      <div className={s.prose} data-r="">
        <p><Rich text={ch2.team} /></p>
        <p>
          <a href={ch2.teamLink.href}>{ch2.teamLink.label}</a>
          {' · '}
          <a href={ch2.foundersLink.href}>{ch2.foundersLink.label}</a>
        </p>
      </div>
    </Chapter>
  );
}

/** Plates are lettered in reading order, which the seeded rhythm decides. */
const PLATE_ORDER = choices.gridRhythm === 'b'
  ? ['modal', 'appr', 'inbx', 'sent', 'clip']
  : ['appr', 'modal', 'inbx', 'clip', 'sent'];

function Tile({ area, children, caption }) {
  const letter = 'ABCDE'[PLATE_ORDER.indexOf(area)];
  return (
    <figure className={s.tile} style={{ gridArea: area }} data-r="">
      <div className={s.tileMount}>{children}</div>
      <figcaption className={s.tileCap}>Plate {letter}. {caption}</figcaption>
    </figure>
  );
}

function ChapterCan({ index }) {
  const t = ch3.tiles;
  return (
    <Chapter data={ch3} index={index}>
      <div className={s.prose} data-r="">
        <p>{ch3.p1}</p>
      </div>
      <dl className={s.abilities} data-r="">
        {ch3.abilities.map((a) => (
          <div key={a.h} className={s.ability}>
            <dt>{a.h}</dt>
            <dd><Rich text={a.p} /></dd>
          </div>
        ))}
      </dl>

      <h3 className={s.h3} data-r="">{ch3.promptsTitle}</h3>
      <ul className={s.prompts} data-r="">
        {ch3.prompts.map((p) => <li key={p}>{p}</li>)}
      </ul>

      <h3 className={s.h3} data-r="">{ch3.gridTitle}</h3>
      <div className={`${s.grid} ${choices.gridRhythm === 'b' ? s.gridB : s.gridA}`}>
        <Tile area="appr" caption={t.approvals.cap}>
          <Crop crop={t.approvals.crop} alt={t.approvals.alt} />
        </Tile>
        <Tile area="modal" caption={t.modal.cap}>
          <Crop crop={t.modal.crop} alt={t.modal.alt} />
        </Tile>
        <Tile area="inbx" caption={t.inboxes.cap}>
          <Crop crop={t.inboxes.crop} alt={t.inboxes.alt} />
        </Tile>
        <Tile area="clip" caption={t.clip.cap}>
          <div className={s.clip} style={{ aspectRatio: `${t.clip.W} / ${t.clip.H}` }}>
            <Pic name={`${t.clip.name}-poster`} w={t.clip.W} h={t.clip.H} alt={t.clip.alt} />
            <video
              className={s.clipVideo}
              data-clip=""
              muted
              loop
              playsInline
              preload="none"
              width={t.clip.W}
              height={t.clip.H}
              aria-hidden="true"
              tabIndex={-1}
            >
              <source src={`${A}${t.clip.name}.webm`} type="video/webm" />
              <source src={`${A}${t.clip.name}.mp4`} type="video/mp4" />
            </video>
          </div>
        </Tile>
        <Tile area="sent" caption={t.sent.cap}>
          <Pic name={t.sent.name} w={t.sent.W} h={t.sent.H} alt={t.sent.alt} mobile={{ name: 'card-draft-sent-light-mobile', w: 720, h: 548 }} />
        </Tile>
      </div>

      <h3 className={s.h3} data-r="">{ch3.clientsTitle}</h3>
      <div className={s.prose} data-r="">
        <p>{ch3.clients}</p>
      </div>
      <Links items={ch3.devLinks} />
    </Chapter>
  );
}

function ChapterWont({ index }) {
  return (
    <Chapter data={ch4} index={index}>
      <div className={s.prose} data-r="">
        <p className={s.motto}>{ch4.p1}</p>
      </div>
      <ul className={s.rules}>
        {ch4.rules.map((r) => (
          <li key={r.h} className={s.rule} data-r="">
            <img src={`${C}${r.icon}`} width="24" height="24" alt="" className={s.ruleIcon} loading="lazy" />
            <div>
              <h3 className={s.ruleTitle}>{r.h}</h3>
              <p><Rich text={r.p} /></p>
            </div>
          </li>
        ))}
      </ul>
      <figure className={s.fig} data-r="">
        <div className={s.mount}>
          <img src={`${C}diagram-stored-animated.svg`} width={960} height={400} alt="MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored." loading="lazy" decoding="async" />
        </div>
        <figcaption className={s.caption}>{ch4.figStored}</figcaption>
      </figure>
      <Links items={ch4.links} />
    </Chapter>
  );
}

function ChapterPricing({ index, stripePrices, eurEnabled, businessSeat }) {
  const tiers = [
    { key: 'free', priceKey: 'free', per: ch5.perForever, href: '/signup' },
    { key: 'personal', priceKey: 'personal', per: ch5.perMonth, href: pricingUpgradeHref('personal', false, false, 'en') },
    { key: 'solo', priceKey: 'solo', per: ch5.perMonth, href: pricingUpgradeHref('solo', false, false, 'en'), accent: true },
    { key: 'business', priceKey: 'pro', per: ch5.perMonth, href: pricingUpgradeHref('pro', false, false, 'en') },
  ];
  return (
    <Chapter data={ch5} index={index}>
      <div className={s.prose} data-r="">
        <p>{ch5.p1}</p>
      </div>
      <ul className={s.plans}>
        {tiers.map((tier) => {
          const live = stripePrices?.[tier.priceKey];
          const usdCents = live?.monthlyCents != null && live.monthlyCents > 0
            ? live.monthlyCents
            : PLANS[tier.priceKey].monthlyPriceCents;
          const seat = tier.key === 'business' ? businessSeat?.card ?? null : null;
          const copy = ch5.tiers[tier.key];
          const features = seat ? seat.features : copy.features;
          return (
            <li key={tier.key} className={`${s.plan} ${tier.accent ? s.planAccent : ''}`} data-r="">
              {tier.accent && <span className={s.planBadge}>{ch5.popular}</span>}
              <h3 className={s.planName}>{planDisplayName(tier.priceKey)}</h3>
              <p className={s.planPrice}>
                <span className={s.planNum}>
                  <Price usdCents={usdCents} eurCents={live?.eurMonthlyCents} eurEnabled={eurEnabled} />
                </span>
                <span className={s.planPer}>{seat ? seat.per : tier.per}</span>
              </p>
              {usdCents > 0 && <VatNote eurEnabled={eurEnabled} label={ch5.inclVat} className={s.planNote} />}
              {seat && <p className={s.planNote} data-business-seat-minimum="">{seat.minimum}</p>}
              <p className={s.planDesc}>{seat ? seat.desc : copy.desc}</p>
              <ul className={s.planFeatures}>
                {features.map((f) => (
                  <li key={f}><Money text={f} eurEnabled={eurEnabled} /></li>
                ))}
              </ul>
              <div className={s.planCta}>
                <a className={`${s.btn} ${tier.accent ? s.btnPrimary : s.btnSecondary}`} href={tier.href}>{copy.cta}</a>
                {tier.key !== 'free' && <CheckoutReassurance locale="en" style={{ margin: '8px 0 0', fontFamily: 'inherit', fontSize: 12.5, color: '#4B5167' }} />}
              </div>
            </li>
          );
        })}
      </ul>
      <p className={s.footnote}><Rich text={ch5.footnote} /></p>
      <p className={s.footnote}><Rich text={ch5.businessLink} /></p>
    </Chapter>
  );
}

function ChapterStart({ index }) {
  return (
    <Chapter data={ch6} index={index}>
      <div className={s.startBand} data-r="">
        <div className={s.prose}>
          <p>{ch6.p1}</p>
        </div>
        <div className={s.endpoint}>
          <span className={s.endpointLabel}>{ch6.endpointLabel}</span>
          <code className={s.mono}>{MCP_URL}</code>
        </div>
        <div className={s.ctaRow}>
          <a className={`${s.btn} ${s.btnPrimary}`} href="/signup">{hero.ctaPrimary}</a>
          <a className={`${s.btn} ${s.btnSecondary}`} href="/connect">Pick your provider</a>
          <a className={s.textLink} href="/docs/clients">{hero.ctaInstall}</a>
        </div>
        <Links items={ch6.install} />
        <p className={s.small}>{ch6.signIn} <a href="/login">{ch6.signInLink}</a></p>
      </div>
    </Chapter>
  );
}

function AppendixReaders({ index }) {
  const review = REVIEWS[0];
  return (
    <Chapter data={appA} index={index}>
      <div className={s.readers}>
        {review && (
          <figure className={s.letter} data-r="">
            <p className={s.small}>{appA.reviewIntro}</p>
            <blockquote className={s.quote} cite={review.sourceUrl}>
              <p>{review.quote}</p>
            </blockquote>
            <figcaption className={s.letterSig}>
              <span className={s.stars} aria-label={`Rated ${review.rating} out of 5`}>{'★'.repeat(review.rating)}</span>
              <span><strong>{review.author}</strong>, {review.role}, <a href={review.url} rel="noopener">{review.company}</a></span>
              {review.sourceUrl && <a href={review.sourceUrl} rel="noopener">{appA.reviewSource}</a>}
            </figcaption>
          </figure>
        )}
        <div className={s.dirs} data-r="">
          <h3 className={s.h3Flush}>{appA.dirTitle}</h3>
          <p className={s.small}>{appA.dirIntro}</p>
          <ul className={s.dirList}>
            {appA.directories.map((d) => (
              <li key={d.href}>
                <a href={d.href} rel="noopener">{d.name} <span aria-hidden="true">↗</span></a>
                <span>{d.what}</span>
              </li>
            ))}
          </ul>
          <p className={s.small}><a href={appA.compare.href}>{appA.compare.label}</a></p>
        </div>
      </div>
    </Chapter>
  );
}

function AppendixFaq({ index, faqItems, eurEnabled }) {
  return (
    <Chapter data={appB} index={index} open>
      <div className={s.faq}>
        {faqItems.map((item) => (
          <div key={item.q} className={s.faqItem} data-r="">
            <h3 className={s.faqQ}>{item.q}</h3>
            <p className={s.faqA}><Money text={item.a} eurEnabled={eurEnabled} /></p>
          </div>
        ))}
      </div>
    </Chapter>
  );
}

function Footer() {
  return (
    <footer className={s.footer}>
      <div className={s.footerInner}>
        <div className={s.footBrand}>
          <img src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" className={s.footLogo} loading="lazy" />
          <p>{footer.tagline}</p>
          <p className={s.footContact}>
            <span>Support <a href={`mailto:${footer.contact}`}>{footer.contact}</a></span>
            <span>Sales <a href={`mailto:${footer.sales}`}>{footer.sales}</a></span>
            <span>MCP endpoint <code className={s.mono}>{MCP_URL}</code></span>
          </p>
          <ul className={s.langs} aria-label="Language">
            {footer.languages.map((l) => (
              <li key={l.code}>
                <a href={l.href} hrefLang={l.code} aria-current={l.code === 'en' ? 'true' : undefined}>{l.label}</a>
              </li>
            ))}
          </ul>
        </div>
        {footer.columns.map((col) => (
          <div key={col.h} className={s.footCol}>
            <p className={s.footHead}>{col.h}</p>
            <ul>
              {col.links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}
            </ul>
          </div>
        ))}
      </div>
      <div className={s.footLegal}>
        <span>{footer.copyright}</span>
        <span>{footer.legal}</span>
        <span>{footer.legalEntity}</span>
      </div>
    </footer>
  );
}

/* ---------- page ---------- */

/**
 * @param {{
 *   stripePrices?: any,
 *   eurEnabled?: boolean,
 *   businessSeat?: any,
 *   faqItems?: { q: string, a: string }[],
 *   locale?: string,
 * }} props  see components/home-lab/README.md (variant contract)
 */

export default function Home({ stripePrices, eurEnabled = false, businessSeat = null, faqItems = [] }) {
  const leaderClass = choices.leader === 'dots' ? s.leaderDots : s.leaderDashes;
  return (
    <div id={ROOT_ID} className={`${s.root} ${leaderClass}`}>
      <link rel="preload" href={LEAD_FONT} as="font" type="font/woff2" crossOrigin="anonymous" />
      <a className={s.skip} href="#v02-main">Skip to the contents</a>
      <Header />
      <main id="v02-main">
        <Hero />
        <section className={s.contents} id="contents" aria-labelledby="v02-contents-h">
          <div className={s.contentsHead}>
            <p className={s.contentsLabel} id="v02-contents-h">{contents.label}</p>
            <p className={s.contentsIntro}>{contents.intro}</p>
            <Manual
              rootId={ROOT_ID}
              openLabel={contents.openAll}
              closeLabel={contents.closeAll}
              className={s.controls}
              buttonClassName={s.controlBtn}
            />
          </div>
          <div className={s.toc}>
            <ChapterAnswer index={0} />
            <ChapterHow index={1} />
            <ChapterCan index={2} />
            <ChapterWont index={3} />
            <ChapterPricing index={4} stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} />
            <ChapterStart index={5} />
            <AppendixReaders index={6} />
            <AppendixFaq index={7} faqItems={faqItems} eurEnabled={eurEnabled} />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
