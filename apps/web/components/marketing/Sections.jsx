'use client';

import React, { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { MBtn, MIcon } from '../MarketingPrimitives';
import { CLIENT_LOGOS, MCP_CLIENT_BRANDS } from '../dashboard/clientLogos';

// Rich-text tag handlers shared across sections (inline code + bold).
const RICH = {
  code: (chunks) => <code className="t-code-inline">{chunks}</code>,
  b: (chunks) => <strong>{chunks}</strong>,
};

export function Nav({ onSignIn, onGetStarted }) {
  const t = useTranslations('home');
  return (
    <header className="nav">
      <div className="container nav-row">
        <Link className="brand" href="/"><img src="/logo-wordmark.svg" alt="mcpemails" /></Link>
        <nav className="nav-links">
          <a href="#features">{t('nav.features')}</a>
          <a href="#how">{t('nav.how')}</a>
          <a href="#pricing">{t('nav.pricing')}</a>
          <Link href="/docs">{t('nav.docs')}</Link>
        </nav>
        <div className="nav-grow" />
        <div className="nav-cta">
          <a className="btn btn-ghost" onClick={onSignIn} href="/login">{t('nav.signIn')}</a>
          <a className="btn btn-primary" onClick={onGetStarted} href="/signup">{t('nav.getStarted')}</a>
        </div>
      </div>
    </header>
  );
}

/* ============== HERO ============== */

export function HeroTextBlock({ onGetStarted }) {
  const t = useTranslations('home');
  return (
    <div>
      <h1 className="h1" style={{ marginTop: 0 }}>
        {t('hero.titleLine1')}<br/>{t('hero.titleLine2')} <span className="accent">{t('hero.titleAccent')}</span>
      </h1>
      <p className="lead">{t('hero.lead')}</p>
      <div className="hero-cta">
        <MBtn variant="primary" size="lg" icon="arrow" href="/signup" onClick={onGetStarted}>{t('hero.ctaPrimary')}</MBtn>
        <MBtn variant="secondary" size="lg" href="/docs">{t('hero.ctaSecondary')}</MBtn>
      </div>
      <div className="hero-meta">
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> {t('hero.metaUnlimited')}</span>
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> {t('hero.metaNoCard')}</span>
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> {t('hero.metaNeverStored')}</span>
      </div>
    </div>
  );
}

/* Variant A: Endpoint + client-tabbed code snippet (developer mockup, untranslated) */
export function HeroEndpointCard() {
  const [client, setClient] = useState("oauth");
  const [copied, setCopied] = useState(false);
  const url = "https://www.mcpemails.com/api/mcp";
  const copyUrl = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const snippets = {
    oauth: `# OAuth-capable clients (claude.ai, Claude Desktop, Cursor…)
# Paste the URL, click Connect, authorize. No API key needed.

https://www.mcpemails.com/api/mcp`,
    claude: `{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "auth": { "type": "bearer", "token": "mcpe_live_••••" }
    }
  }
}`,
    cursor: `{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://www.mcpemails.com/api/mcp",
        "bearer": "mcpe_live_••••"
      }
    }
  }
}`,
    n8n: `# n8n MCP node
URL:    https://www.mcpemails.com/api/mcp
Auth:   Bearer
Token:  mcpe_live_••••`,
  };
  const paths = {
    oauth:  "claude.ai · Claude Desktop · Cursor · OAuth",
    claude: "~/.claude/mcp.json (API key fallback)",
    cursor: "~/.cursor/config.json",
    n8n:    "n8n · MCP credentials",
  };

  return (
    <div className="hero-card endpoint-card">
      <div className="endpoint-label">
        <span>Your MCP endpoint</span>
        <span className="endpoint-pill"><span className="d"/>3 inboxes connected</span>
      </div>
      <div className="endpoint-url">
        <span className="scheme">https://</span><span className="host">www.mcpemails.com</span><span className="path-seg">/api/mcp</span>
        <button className="copy-btn" onClick={copyUrl} aria-label="Copy URL">
          {copied
            ? <><MIcon name="check" size={13} color="var(--mint-700)"/> Copied</>
            : <><MIcon name="mail" size={13} color="var(--fg-2)"/> Copy</>}
        </button>
      </div>
      <div className="endpoint-divider"><span>Paste it into any MCP client</span></div>
      <div className="client-tabs">
        {[
          { k: "oauth",  l: "OAuth" },
          { k: "claude", l: "API key (Desktop)" },
          { k: "cursor", l: "Cursor" },
          { k: "n8n",    l: "n8n" },
        ].map(c => (
          <button key={c.k}
                  className={"client-tab" + (client === c.k ? " active" : "")}
                  onClick={() => setClient(c.k)}>{c.l}</button>
        ))}
      </div>
      <div className="code-bar">
        <div className="dots"><span/><span/><span/></div>
        <span className="path">{paths[client]}</span>
        <span className="pill"><span className="d"/>Live</span>
      </div>
      <pre className="code">{snippets[client]}</pre>
    </div>
  );
}

/* Variant B: Agent -> mcpemails -> Provider pipe diagram (canonical, default hero) */
export function HeroPipeDiagram() {
  const t = useTranslations('home');
  return (
    <div className="pipe-diagram">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--mint-500)", boxShadow: "0 0 0 2px rgba(31,203,139,0.2)" }}/>
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 500, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{t('hero.pipe.flow')}</span>
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-4)" }}>t+0ms → t+312ms</span>
      </div>

      <div className="pipe-row" style={{ marginTop: 6 }}>
        <div className="pipe-node">
          <MIcon name="cpu" size={22} color="var(--fg-2)"/>
          <div className="h">{t('hero.pipe.agent')}</div>
          <div className="s">{t('hero.pipe.agentSub')}</div>
        </div>
        <div className="pipe-arrow-wrap">
          <span className="pipe-tag">MCP</span>
          <div className="pipe-arrow"/>
        </div>
        <div className="pipe-node brand">
          <MIcon name="server" size={22} color="#fff"/>
          <div className="h">mcpemails</div>
          <div className="s">{t('hero.pipe.serverSub')}</div>
        </div>
        <div className="pipe-arrow-wrap">
          <span className="pipe-tag">JMAP</span>
          <div className="pipe-arrow"/>
        </div>
        <div className="pipe-node">
          <MIcon name="mail" size={22} color="var(--fg-2)"/>
          <div className="h">{t('hero.pipe.provider')}</div>
          <div className="s">{t('hero.pipe.providerSub')}</div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="code-bar" style={{ paddingTop: 0, paddingBottom: 8, marginBottom: 10, borderBottom: "1px solid var(--border-1)" }}>
          <div className="dots"><span/><span/><span/></div>
          <span className="path">live · t+12ms</span>
          <span className="pill"><span className="d"/>list_inboxes()</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg-2)" }}>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> {t('hero.pipe.logCalls')} <span style={{ color: "var(--mint-700)" }}>list_inboxes</span>()</div>
          <div><span style={{ color: "var(--fg-3)" }}>·</span> {t('hero.pipe.logReturns')}</div>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> {t('hero.pipe.logCalls')} <span style={{ color: "var(--mint-700)" }}>list_inbox</span>(inbox_id=<span style={{ color: "var(--amber-700)" }}>"3f7a…"</span>)</div>
          <div><span style={{ color: "var(--fg-3)" }}>·</span> {t('hero.pipe.logFetches')}</div>
          <div><span style={{ color: "var(--mint-700)" }}>←</span> {t('hero.pipe.logResult')} · <span style={{ color: "var(--fg-3)" }}>{t('hero.pipe.logNothing')}</span></div>
        </div>
      </div>

      <div className="pipe-legend">
        <span className="li"><span className="swatch"/> {t('hero.pipe.legendPipe')}</span>
        <span className="li"><span className="swatch mint"/> {t('hero.pipe.legendLive')}</span>
        <span className="li"><span className="swatch gray"/> {t('hero.pipe.legendData')}</span>
      </div>
    </div>
  );
}

/* Variant C: Live MCP terminal showing tool calls firing (developer mockup, untranslated) */
export function HeroMcpTerminal() {
  const fullLog = React.useMemo(() => [
    { ts: "14:02:16", arrow: "→", tool: "list_inboxes",   args: "",                            ok: "2 inboxes", ms: "84ms"  },
    { ts: "14:02:18", arrow: "→", tool: "list_inbox",     args: "inbox_id=3f7a · limit=20",    ok: "20 msgs",   ms: "182ms" },
    { ts: "14:02:21", arrow: "→", tool: "read_email",     args: "uid=4821",                    ok: "1.2kb",     ms: "97ms"  },
    { ts: "14:02:23", arrow: "→", tool: "search_emails",  args: "from:stripe after:2026-05",   ok: "3 hits",    ms: "238ms" },
    { ts: "14:02:25", arrow: "→", tool: "reply_to_email", args: "uid=4821",                    ok: "queued",    ms: "311ms" },
    { ts: "14:02:28", arrow: "→", tool: "send_email",     args: "to=eng@team.io",              ok: "sent",      ms: "428ms" },
  ], []);
  const [shown, setShown] = useState(2);
  React.useEffect(() => {
    if (shown >= fullLog.length) {
      const t = setTimeout(() => setShown(2), 2200);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown(s => s + 1), 1100);
    return () => clearTimeout(t);
  }, [shown, fullLog.length]);

  return (
    <div className="mcp-terminal">
      <div className="term-bar">
        <div className="dots"><span/><span/><span/></div>
        <span className="title">mcpemails · live tool log</span>
        <span className="pill"><span className="d"/>connected</span>
      </div>
      <div className="term-body">
        {fullLog.slice(0, shown).map((l, i) => (
          <div className="term-line" key={i} style={{ opacity: i === shown - 1 ? 0 : 1, animation: i === shown - 1 ? "fadein 360ms forwards" : "none" }}>
            <span className="ts">{l.ts}</span>
            <span className="arrow">{l.arrow}</span>
            <span className="tool">{l.tool}</span>
            <span className="meta">({l.args})</span>
            <span className="ok">✓ {l.ok} · {l.ms}</span>
          </div>
        ))}
        <div className="term-line">
          <span className="ts">{"14:02:" + String(33 + shown).padStart(2,"0")}</span>
          <span className="arrow">$</span>
          <span style={{ color: "rgba(255,255,255,0.6)" }}>awaiting next agent call</span>
          <span className="term-cursor"/>
        </div>
      </div>
      <style>{`@keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

export function Hero({ variant, onGetStarted }) {
  const right =
    variant === "endpoint" ? <HeroEndpointCard/> :
    variant === "terminal" ? <HeroMcpTerminal/> :
    <HeroPipeDiagram/>;
  return (
    <section className="hero">
      <div className="container hero-grid">
        <HeroTextBlock onGetStarted={onGetStarted}/>
        {right}
      </div>
    </section>
  );
}

/* ============== TRUSTED ============== */
function MarqueeItem({ name, logo, color }) {
  const g = CLIENT_LOGOS[logo];
  return (
    <span className="marquee-item">
      <span className="marquee-logo" style={{ background: color }}>
        {g && (
          <svg viewBox={g.viewBox} width="17" height="17" fill="#fff" aria-hidden="true">
            <path d={g.d} />
          </svg>
        )}
      </span>
      {name}
    </span>
  );
}

export function Trusted() {
  const t = useTranslations('home');
  // Repeat the list so a single segment always overflows even ultra-wide screens,
  // then duplicate that segment so the track loops seamlessly under translateX(-50%).
  const segment = [...MCP_CLIENT_BRANDS, ...MCP_CLIENT_BRANDS, ...MCP_CLIENT_BRANDS];
  const loop = [...segment, ...segment];
  return (
    <section className="trusted">
      <div className="container">
        <span className="trusted-label">{t('trusted.label')}</span>
      </div>
      <div className="marquee">
        <div className="marquee-track">
          {loop.map((c, i) => (
            <MarqueeItem key={i} name={c.name} logo={c.logo} color={c.color} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============== FEATURES ============== */
export function Features() {
  const t = useTranslations('home');
  const tags = ['Scope', 'Storage', 'Sending', 'Providers', 'Access', 'Security'];
  return (
    <section className="section principles" id="features">
      <div className="container">
        <div className="section-head principles-head">
          <div className="eye-label">{t('features.eyebrow')}</div>
          <h2>{t('features.titleLine1')}<br/>{t('features.titleLine2')}</h2>
          <p className="sub">{t('features.sub')}</p>
        </div>
        <ol className="principle-list">
          {tags.map((_, i) => (
            <li className="principle" key={i}>
              <div className="p-num">
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <span className="t">{t(`features.items.${i}.tag`)}</span>
              </div>
              <div className="p-body">
                <h3>{t(`features.items.${i}.h`)}</h3>
                <p>{t.rich(`features.items.${i}.p`, RICH)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ============== HOW IT WORKS ============== */
export function HowItWorks() {
  const t = useTranslations('home');
  const toolNames = ['list_inboxes', 'list_inbox', 'read_email', 'search_emails', 'send_email', 'reply_to_email'];
  return (
    <section className="section how" id="how">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">{t('howItWorks.eyebrow')}</div>
          <h2>{t('howItWorks.title')}</h2>
          <p className="sub">{t('howItWorks.sub')}</p>
        </div>

        <div className="how-steps">
          {[0, 1, 2].map((i) => (
            <div className="step" key={i}>
              <span className="num">{String(i + 1).padStart(2, '0')}</span>
              <h4>{t(`howItWorks.steps.${i}.h`)}</h4>
              <p>{t.rich(`howItWorks.steps.${i}.p`, RICH)}</p>
            </div>
          ))}
        </div>

        <div className="tools">
          {toolNames.map((name, i) => (
            <div className="tool" key={name}>
              <div className="name">{name}()</div>
              <div className="desc">{t(`howItWorks.tools.${i}`)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============== QUOTE ============== */
export function Quote() {
  const t = useTranslations('home');
  return (
    <section className="quote">
      <div className="container">
        <div className="text">&ldquo;{t('quote.text')}&rdquo;</div>
        <div className="who"><strong>Asgeir Albretsen</strong> · {t('quote.role')}</div>
      </div>
    </section>
  );
}

/* ============== PRICING ============== */
/**
 * @param {{ onGetStarted?: () => void, stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
export function Pricing({ onGetStarted, stripePrices }) {
  const t = useTranslations('home');
  // Static, non-translated attributes per tier. `msgKey` indexes the message
  // bundle; `priceKey` indexes the live Stripe prices map (Team is `pro` there).
  const tiers = [
    { msgKey: 'free', priceKey: 'free', price: '$0',  per: t('pricing.perForever'), accent: false, ctaHref: '/signup' },
    { msgKey: 'solo', priceKey: 'solo', price: '$12', per: t('pricing.perMonth'),   accent: false, ctaHref: '/signup' },
    { msgKey: 'team', priceKey: 'pro',  price: '$49', per: t('pricing.perMonth'),   accent: true,  ctaHref: '/signup' },
  ];
  return (
    <section className="section" id="pricing">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">{t('pricing.eyebrow')}</div>
          <h2>{t('pricing.title')}</h2>
          <p className="sub">{t('pricing.sub')}</p>
        </div>
        <div className="price-grid">
          {tiers.map((tier) => {
            const liveMonthlyCents = stripePrices?.[tier.priceKey]?.monthlyCents;
            const livePrice =
              liveMonthlyCents != null && liveMonthlyCents > 0
                ? `$${liveMonthlyCents / 100}`
                : tier.price;
            const features = t.raw(`pricing.tiers.${tier.msgKey}.features`);

            return (
              <div className={"price" + (tier.accent ? " featured" : "")} key={tier.msgKey}>
                <div>
                  <h4>{t(`pricing.tiers.${tier.msgKey}.name`)}</h4>
                  <div className="num">
                    {livePrice}
                    {tier.per && <small> {tier.per}</small>}
                  </div>
                  <p className="price-desc">{t(`pricing.tiers.${tier.msgKey}.desc`)}</p>
                </div>
                <ul>
                  {features.map((f) => (
                    <li key={f}><MIcon name="check" size={14} color="var(--mint-600)"/>{f}</li>
                  ))}
                </ul>
                <a
                  className={"btn " + (tier.accent ? "btn-primary" : "btn-secondary")}
                  href={tier.ctaHref}
                  onClick={tier.ctaHref === "/signup" ? onGetStarted : undefined}
                >
                  {t(`pricing.tiers.${tier.msgKey}.cta`)}
                </a>
              </div>
            );
          })}
        </div>
        <p className="pricing-footnote">
          {t.rich('pricing.footnote', {
            contact: (chunks) => <a href="mailto:sales@mcpemails.com">{chunks}</a>,
            comparison: (chunks) => <a href="/pricing">{chunks}</a>,
          })}
        </p>
      </div>
    </section>
  );
}

/* ============== LANGUAGE SWITCHER ============== */
/**
 * Minimal locale switcher. Only the home page is localized for now, so each
 * option links to the home page in that language. As more routes are
 * localized, swap these anchors for next-intl's locale-aware Link.
 */
function LanguageSwitcher() {
  const t = useTranslations('home');
  const locale = useLocale();
  const options = [
    { code: 'en', href: '/' },
    { code: 'nb', href: '/nb' },
    { code: 'es', href: '/es' },
    { code: 'fr', href: '/fr' },
    { code: 'zh', href: '/zh' },
  ];
  return (
    <div className="lang-switch" aria-label={t('languageSwitcher.label')}>
      <MIcon name="globe" size={13} color="var(--fg-3)" />
      {options.map((o) => (
        <a
          key={o.code}
          href={o.href}
          className={"lang-opt" + (locale === o.code ? " active" : "")}
          aria-current={locale === o.code ? 'true' : undefined}
        >
          {t(`languageSwitcher.${o.code}`)}
        </a>
      ))}
    </div>
  );
}

/* ============== FOOTER ============== */
export function Footer() {
  const t = useTranslations('home');
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="brand-cell">
            <img src="/logo-mark-dark.svg" alt="mcpemails" />
            <p>{t('footer.tagline')}</p>
            <LanguageSwitcher />
          </div>
          <div>
            <h5>{t('footer.productHeading')}</h5>
            <a href="#features">{t('footer.linkFeatures')}</a>
            <a href="#how">{t('footer.linkHow')}</a>
            <a href="#pricing">{t('footer.linkPricing')}</a>
            <Link href="/docs">{t('footer.linkDocs')}</Link>
          </div>
          <div>
            <h5>{t('footer.resourcesHeading')}</h5>
            <Link href="/docs#tools">{t('footer.linkToolReference')}</Link>
            <Link href="/docs#quickstart">{t('footer.linkQuickstart')}</Link>
            <Link href="/docs#oauth">{t('footer.linkOauth')}</Link>
            <Link href="/docs/providers">{t('footer.linkProviders')}</Link>
          </div>
          <div>
            <h5>{t('footer.companyHeading')}</h5>
            <Link href="/privacy">{t('footer.linkPrivacy')}</Link>
            <Link href="/terms">{t('footer.linkTerms')}</Link>
          </div>
        </div>
        <div className="legal">
          <span>{t('footer.copyright')}</span>
          <span>{t('footer.legal')}</span>
        </div>
      </div>
    </footer>
  );
}
