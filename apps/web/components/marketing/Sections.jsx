'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  const tc = useTranslations('compare');
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuId = 'mobile-nav-menu';

  // Close on Escape key
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const closeMenu = useCallback(() => setMobileOpen(false), []);

  return (
    <header className="nav">
      <div className="container nav-row">
        <Link className="brand" href="/" onClick={closeMenu}><img src="/logo-wordmark.svg" alt="mcpemails" /></Link>
        <nav className="nav-links" aria-label="Primary navigation">
          <Link href="/#features">{t('nav.features')}</Link>
          <Link href="/#how">{t('nav.how')}</Link>
          <Link href="/#pricing">{t('nav.pricing')}</Link>
          <Link href="/native-connectors-vs-mcp">{tc('links.compare')}</Link>
          <Link href="/docs">{t('nav.docs')}</Link>
          <Link href="/blog">{t('nav.blog')}</Link>
        </nav>
        <div className="nav-grow" />
        <div className="nav-cta">
          <a className="btn btn-ghost" onClick={onSignIn} href="/login">{t('nav.signIn')}</a>
          <a className="btn btn-primary" onClick={onGetStarted} href="/signup">{t('nav.getStarted')}</a>
        </div>

        {/* Hamburger button — visible only on mobile (≤767px via CSS) */}
        <button
          className="nav-hamburger"
          aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileOpen}
          aria-controls={menuId}
          onClick={() => setMobileOpen(o => !o)}
        >
          {/* Three-line / X icon drawn with CSS */}
          <span className={'nav-hamburger-icon' + (mobileOpen ? ' open' : '')} aria-hidden="true">
            <span /><span /><span />
          </span>
        </button>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="nav-mobile-menu" id={menuId} role="dialog" aria-label="Navigation menu">
          <nav aria-label="Mobile navigation">
            <Link href="/#features" onClick={closeMenu}>{t('nav.features')}</Link>
            <Link href="/#how" onClick={closeMenu}>{t('nav.how')}</Link>
            <Link href="/#pricing" onClick={closeMenu}>{t('nav.pricing')}</Link>
            <Link href="/native-connectors-vs-mcp" onClick={closeMenu}>{tc('links.compare')}</Link>
            <Link href="/docs" onClick={closeMenu}>{t('nav.docs')}</Link>
            <Link href="/blog" onClick={closeMenu}>{t('nav.blog')}</Link>
          </nav>
          <div className="nav-mobile-cta">
            <a className="btn btn-ghost" href="/login" onClick={() => { onSignIn?.(); closeMenu(); }}>{t('nav.signIn')}</a>
            <a className="btn btn-primary" href="/signup" onClick={() => { onGetStarted?.(); closeMenu(); }}>{t('nav.getStarted')}</a>
          </div>
        </div>
      )}
    </header>
  );
}

/* ============== HERO ============== */

export function HeroTextBlock({ onGetStarted }) {
  const t = useTranslations('home');
  return (
    <div>
      <h1 className="h1" style={{ marginTop: 0 }}>
        {t('hero.titleLine1')} <br/>{t('hero.titleLine2')} <span className="accent">{t('hero.titleAccent')}</span>
      </h1>
      <p className="lead">{t('hero.lead')}</p>
      <div className="hero-cta">
        <MBtn variant="primary" size="lg" icon="arrow" href="/signup" onClick={onGetStarted}>{t('hero.ctaPrimary')}</MBtn>
        <Link className="btn btn-secondary btn-lg" href="/docs">{t('hero.ctaSecondary')}</Link>
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
  const url = "https://mcpemails.com/api/mcp";
  const copyUrl = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const snippets = {
    oauth: `# OAuth-capable clients (claude.ai, Claude Desktop, Cursor…)
# Paste the URL, click Connect, authorize. No API key needed.

https://mcpemails.com/api/mcp`,
    claude: `{
  "mcpServers": {
    "mcpemails": {
      "url": "https://mcpemails.com/api/mcp",
      "auth": { "type": "bearer", "token": "mcpe_live_••••" }
    }
  }
}`,
    cursor: `{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://mcpemails.com/api/mcp",
        "bearer": "mcpe_live_••••"
      }
    }
  }
}`,
    n8n: `# n8n MCP node
URL:    https://mcpemails.com/api/mcp
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
        <span className="scheme">https://</span><span className="host">mcpemails.com</span><span className="path-seg">/api/mcp</span>
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
          <span className="pill"><span className="d"/>inbox_list()</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg-2)" }}>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> {t('hero.pipe.logCalls')} <span style={{ color: "var(--mint-700)" }}>inbox_list</span>()</div>
          <div><span style={{ color: "var(--fg-3)" }}>·</span> {t('hero.pipe.logReturns')}</div>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> {t('hero.pipe.logCalls')} <span style={{ color: "var(--mint-700)" }}>email_read</span>(action=<span style={{ color: "var(--amber-700)" }}>"list"</span> · inbox_id=<span style={{ color: "var(--amber-700)" }}>"3f7a…"</span>)</div>
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
    { ts: "14:02:16", arrow: "→", tool: "inbox_list",    args: "",                                ok: "2 inboxes", ms: "84ms"  },
    { ts: "14:02:18", arrow: "→", tool: "email_read",    args: "action=list · inbox_id=3f7a",     ok: "20 msgs",   ms: "182ms" },
    { ts: "14:02:21", arrow: "→", tool: "email_read",    args: "action=read · uid=4821",          ok: "1.2kb",     ms: "97ms"  },
    { ts: "14:02:23", arrow: "→", tool: "email_read",    args: "action=search · from:stripe",     ok: "3 hits",    ms: "238ms" },
    { ts: "14:02:25", arrow: "→", tool: "email_compose", args: "action=reply · uid=4821",         ok: "queued",    ms: "311ms" },
    { ts: "14:02:28", arrow: "→", tool: "email_compose", args: "action=send · to=eng@team.io",    ok: "sent",      ms: "428ms" },
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

/* ============== DASHBOARD PREVIEW ============== */
/**
 * A self-consistent, on-brand mockup of the dashboard so prospects can see the
 * product before signing up. Rendered in HTML/CSS (not a screenshot) so it
 * never drifts from the real naming — note "Team" plan and the real tool names
 * (email_read, email_compose, email_organize).
 */
export function DashboardPreview() {
  const t = useTranslations('home');

  const navItems = [
    { label: 'Overview', icon: 'cpu', active: true },
    { label: 'Inboxes', icon: 'inbox', count: 4 },
    { label: 'API keys', icon: 'lock', count: 3 },
    { label: 'Usage', icon: 'zap' },
  ];
  const stats = [
    { label: 'Inboxes connected', value: '4' },
    { label: 'MCP calls (30d)', value: '12,484' },
    { label: 'Avg. response', value: '214ms' },
    { label: 'Plan', value: 'Team' },
  ];
  const activity = [
    { tool: 'email_read', inbox: 'work-gmail', time: 'just now' },
    { tool: 'email_compose', inbox: 'work-gmail', time: '12s ago' },
    { tool: 'email_organize', inbox: 'ops-fastmail', time: '1m ago' },
    { tool: 'email_read', inbox: 'support-imap', time: '3m ago' },
  ];

  return (
    <section className="section" id="preview" style={{ paddingTop: 72, paddingBottom: 72 }}>
      <div className="container">
        <div className="section-head">
          <div className="eye-label">{t('preview.eyebrow')}</div>
          <h2>{t('preview.title')}</h2>
          <p className="sub">{t('preview.sub')}</p>
        </div>

        {/* Browser-chrome framed mockup */}
        <div style={{
          marginTop: 36,
          borderRadius: 14,
          border: '1px solid var(--border-1)',
          background: 'var(--bg-surface, #fff)',
          boxShadow: '0 24px 60px -24px rgba(15,23,42,0.28)',
          overflow: 'hidden',
        }}>
          {/* Top bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border-1)', background: 'var(--bg-page)' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {['#ff5f57', '#febc2e', '#28c840'].map(c => (
                <span key={c} style={{ width: 11, height: 11, borderRadius: 999, background: c, opacity: 0.9 }} />
              ))}
            </div>
            <div style={{
              flex: 1, maxWidth: 360, margin: '0 auto', textAlign: 'center',
              fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)',
              background: 'var(--bg-surface, #fff)', border: '1px solid var(--border-1)',
              borderRadius: 7, padding: '3px 10px',
            }}>
              app.mcpemails.com/dashboard
            </div>
            <div style={{ width: 60 }} />
          </div>

          {/* Body: sidebar + main */}
          <div style={{ display: 'flex', minHeight: 360 }}>
            {/* Sidebar */}
            <div className="dash-preview-aside" style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--border-1)', padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--bg-page)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 14px' }}>
                <MIcon name="mail" size={18} color="var(--cobalt-600)" />
                <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, color: 'var(--fg-1)' }}>mcpemails</span>
              </div>
              {navItems.map(it => (
                <div key={it.label} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
                  fontFamily: 'var(--font-sans)', fontSize: 13.5,
                  color: it.active ? 'var(--cobalt-700)' : 'var(--fg-2)',
                  background: it.active ? 'var(--brand-soft, rgba(37,99,235,0.08))' : 'transparent',
                  fontWeight: it.active ? 600 : 500,
                }}>
                  <MIcon name={it.icon} size={15} color={it.active ? 'var(--cobalt-600)' : 'var(--fg-3)'} />
                  <span style={{ flex: 1 }}>{it.label}</span>
                  {it.count != null && (
                    <span style={{ fontSize: 11, color: 'var(--fg-3)', background: 'var(--bg-sunken)', borderRadius: 999, padding: '1px 7px' }}>{it.count}</span>
                  )}
                </div>
              ))}
              <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 9, padding: '10px 8px 2px' }}>
                <span style={{ width: 28, height: 28, borderRadius: 999, background: 'var(--cobalt-600)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600 }}>J</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--fg-1)' }}>jordan</div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--fg-3)', textTransform: 'capitalize' }}>Team plan</div>
                </div>
              </div>
            </div>

            {/* Main */}
            <div style={{ flex: 1, padding: '22px 24px', minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 20, fontWeight: 700, color: 'var(--fg-1)' }}>Overview</div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', marginTop: 2, marginBottom: 18 }}>
                Real-time view of your connected inboxes and MCP traffic.
              </div>

              {/* Stat cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 18 }}>
                {stats.map(s => (
                  <div key={s.label} style={{ border: '1px solid var(--border-1)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-surface, #fff)' }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 6 }}>{s.label}</div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 22, fontWeight: 700, color: 'var(--fg-1)' }}>{s.value}</div>
                  </div>
                ))}
              </div>

              {/* Recent activity */}
              <div style={{ border: '1px solid var(--border-1)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface, #fff)' }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-1)', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
                  Recent activity
                </div>
                {activity.map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--mint-500)', flexShrink: 0 }} />
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--cobalt-700)' }}>{a.tool}()</code>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>· {a.inbox}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--fg-4, var(--fg-3))' }}>{a.time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============== HOW IT WORKS ============== */
export function HowItWorks() {
  const t = useTranslations('home');
  const toolNames = ['inbox_list', 'email_read', 'email_organize', 'email_compose', 'folder', 'draft', 'schedule', 'contact_search'];
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
            contact: (chunks) => <a href="mailto:hello@mcpemails.com">{chunks}</a>,
            comparison: (chunks) => <Link href="/pricing">{chunks}</Link>,
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

// Public MCP endpoint shown across the site (canonical apex host).
const FOOTER_MCP_URL = "https://mcpemails.com/api/mcp";
const FOOTER_CONTACT_EMAIL = "hello@mcpemails.com";

/* A single copyable contact row in the footer (email or MCP endpoint).
   Renders the value, an optional link (mailto), and a copy-to-clipboard button. */
function FooterCopy({ icon, label, value, href }) {
  const t = useTranslations('home');
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(value);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="footer-copy">
      <span className="footer-copy-label">{label}</span>
      <div className="footer-copy-field">
        <MIcon name={icon} size={13} color="var(--ink-400)" />
        {href
          ? <a className="footer-copy-value" href={href}>{value}</a>
          : <span className="footer-copy-value">{value}</span>}
        <button
          type="button"
          className="footer-copy-btn"
          onClick={copy}
          aria-label={copied ? t('footer.copied') : t('footer.copyAria', { label })}
        >
          <MIcon name={copied ? 'check' : 'copy'} size={13} color={copied ? 'var(--mint-500)' : 'currentColor'} />
          <span>{copied ? t('footer.copied') : t('footer.copy')}</span>
        </button>
      </div>
    </div>
  );
}

export function Footer() {
  const t = useTranslations('home');
  const tc = useTranslations('compare');
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="brand-cell">
            <img src="/logo-mark-dark.svg" alt="mcpemails" />
            <p>{t('footer.tagline')}</p>
            <div className="footer-contact">
              <FooterCopy icon="mail" label={t('footer.contactLabel')} value={FOOTER_CONTACT_EMAIL} href={`mailto:${FOOTER_CONTACT_EMAIL}`} />
              <FooterCopy icon="server" label={t('footer.mcpLabel')} value={FOOTER_MCP_URL} />
            </div>
            <LanguageSwitcher />
          </div>
          <div>
            <h5>{t('footer.productHeading')}</h5>
            <Link href="/#features">{t('footer.linkFeatures')}</Link>
            <Link href="/#how">{t('footer.linkHow')}</Link>
            <Link href="/#pricing">{t('footer.linkPricing')}</Link>
            <Link href="/docs">{t('footer.linkDocs')}</Link>
          </div>
          <div>
            <h5>{t('footer.resourcesHeading')}</h5>
            <Link href="/docs#tools">{t('footer.linkToolReference')}</Link>
            <Link href="/docs#quickstart">{t('footer.linkQuickstart')}</Link>
            <Link href="/docs#oauth">{t('footer.linkOauth')}</Link>
            <Link href="/docs/providers">{t('footer.linkProviders')}</Link>
            <Link href="/blog">Blog</Link>
          </div>
          <div>
            <h5>{tc('links.connectHeading')}</h5>
            <Link href="/connect/fastmail">{tc('links.connectFastmail')}</Link>
            <Link href="/connect/icloud">{tc('links.connectIcloud')}</Link>
            <Link href="/native-connectors-vs-mcp">{tc('links.vsNative')}</Link>
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
