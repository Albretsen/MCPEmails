'use client';

import React, { useState } from 'react';
import { MBtn, MIcon } from '../MarketingPrimitives';

export function Nav({ onSignIn, onGetStarted }) {
  return (
    <header className="nav">
      <div className="container nav-row">
        <a className="brand" href="/"><img src="/logo-wordmark.svg" alt="mcpemails" /></a>
        <nav className="nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="/docs">Docs</a>
        </nav>
        <div className="nav-grow" />
        <div className="nav-cta">
          <a className="btn btn-ghost" onClick={onSignIn} href="/login">Sign in</a>
          <a className="btn btn-primary" onClick={onGetStarted} href="/signup">Get started free</a>
        </div>
      </div>
    </header>
  );
}

/* ============== HERO ============== */

export function HeroTextBlock({ onGetStarted }) {
  return (
    <div>
      <h1 className="h1" style={{ marginTop: 0 }}>
        Give your AI<br/>agent an <span className="accent">inbox.</span>
      </h1>
      <p className="lead">
        Connect Gmail, Outlook, or any IMAP account once. Paste a single MCP endpoint URL into claude.ai, Claude Desktop, Cursor, or any MCP-compatible agent — OAuth or API key, your choice. Your agent can now read, search, and send mail live, with no email stored on our servers.
      </p>
      <div className="hero-cta">
        <MBtn variant="primary" size="lg" icon="arrow" href="/signup" onClick={onGetStarted}>Connect your inbox</MBtn>
        <MBtn variant="secondary" size="lg" href="/docs">Read the docs</MBtn>
      </div>
      <div className="hero-meta">
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> 100 free calls / month</span>
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> No card required</span>
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> Email never stored</span>
      </div>
    </div>
  );
}

/* Variant A: Endpoint + client-tabbed code snippet */
export function HeroEndpointCard() {
  const [client, setClient] = useState("oauth");
  const [copied, setCopied] = useState(false);
  const url = "https://www.mcpemails.com/mcp";
  const copyUrl = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const snippets = {
    oauth: `# claude.ai — paste the URL, click Connect, authorize.
# No API key required — OAuth handles everything.

https://www.mcpemails.com/mcp`,
    claude: `{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/mcp",
      "auth": { "type": "bearer", "token": "mcpe_live_••••" }
    }
  }
}`,
    cursor: `{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://www.mcpemails.com/mcp",
        "bearer": "mcpe_live_••••"
      }
    }
  }
}`,
    n8n: `# n8n MCP node
URL:    https://www.mcpemails.com/mcp
Auth:   Bearer
Token:  mcpe_live_••••`,
  };
  const paths = {
    oauth:  "claude.ai → Customize → Connectors",
    claude: "~/.claude/mcp.json",
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
        <span className="scheme">https://</span><span className="host">www.mcpemails.com</span><span className="path-seg">/mcp</span>
        <button className="copy-btn" onClick={copyUrl} aria-label="Copy URL">
          {copied
            ? <><MIcon name="check" size={13} color="var(--mint-700)"/> Copied</>
            : <><MIcon name="mail" size={13} color="var(--fg-2)"/> Copy</>}
        </button>
      </div>
      <div className="endpoint-divider"><span>Paste it into any MCP client</span></div>
      <div className="client-tabs">
        {[
          { k: "oauth",  l: "claude.ai" },
          { k: "claude", l: "Claude Desktop" },
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

/* Variant B: Agent → mcpemails → Provider pipe diagram (canonical) */
export function HeroPipeDiagram() {
  return (
    <div className="pipe-diagram">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--mint-500)", boxShadow: "0 0 0 2px rgba(31,203,139,0.2)" }}/>
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 500, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>How a call flows</span>
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--fg-4)" }}>t+0ms → t+312ms</span>
      </div>

      <div className="pipe-row" style={{ marginTop: 6 }}>
        <div className="pipe-node">
          <MIcon name="cpu" size={22} color="var(--fg-2)"/>
          <div className="h">AI agent</div>
          <div className="s">claude.ai · Desktop · Cursor</div>
        </div>
        <div className="pipe-arrow-wrap">
          <span className="pipe-tag">MCP</span>
          <div className="pipe-arrow"/>
        </div>
        <div className="pipe-node brand">
          <MIcon name="server" size={22} color="#fff"/>
          <div className="h">mcpemails</div>
          <div className="s">/mcp endpoint</div>
        </div>
        <div className="pipe-arrow-wrap">
          <span className="pipe-tag">IMAP</span>
          <div className="pipe-arrow"/>
        </div>
        <div className="pipe-node">
          <MIcon name="mail" size={22} color="var(--fg-2)"/>
          <div className="h">Your provider</div>
          <div className="s">Gmail · IMAP</div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="code-bar" style={{ paddingTop: 0, paddingBottom: 8, marginBottom: 10, borderBottom: "1px solid var(--border-1)" }}>
          <div className="dots"><span/><span/><span/></div>
          <span className="path">live · t+12ms</span>
          <span className="pill"><span className="d"/>list_inboxes()</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg-2)" }}>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> agent calls <span style={{ color: "var(--mint-700)" }}>list_inboxes</span>()</div>
          <div><span style={{ color: "var(--fg-3)" }}>·</span> returns inbox IDs — no dashboard copy-paste</div>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> agent calls <span style={{ color: "var(--mint-700)" }}>list_inbox</span>(inbox_id=<span style={{ color: "var(--amber-700)" }}>"3f7a…"</span>)</div>
          <div><span style={{ color: "var(--fg-3)" }}>·</span> mcpemails fetches via Gmail API (token rotated)</div>
          <div><span style={{ color: "var(--mint-700)" }}>←</span> 20 messages returned · <span style={{ color: "var(--fg-3)" }}>nothing stored</span></div>
        </div>
      </div>

      <div className="pipe-legend">
        <span className="li"><span className="swatch"/> mcpemails (the pipe)</span>
        <span className="li"><span className="swatch mint"/> live request</span>
        <span className="li"><span className="swatch gray"/> your data, your provider</span>
      </div>
    </div>
  );
}

/* Variant C: Live MCP terminal showing tool calls firing */
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
export function Trusted() {
  return (
    <section className="trusted">
      <div className="container trusted-row">
        <span className="label">Works with every MCP-compatible agent and client</span>
        <div className="trusted-logos">
          <span>claude.ai</span>
          <span>Claude Desktop</span>
          <span>Cursor</span>
          <span>n8n</span>
          <span>Zed</span>
          <span>Windsurf</span>
          <span>Continue</span>
        </div>
      </div>
    </section>
  );
}

/* ============== FEATURES ============== */
export function Features() {
  const principles = [
    {
      n: "01",
      h: "Six tools. The whole surface area.",
      p: <>Every email task your agent needs fits in six calls: <code className="t-code-inline">list_inboxes</code>, <code className="t-code-inline">list_inbox</code>, <code className="t-code-inline">read_email</code>, <code className="t-code-inline">search_emails</code>, <code className="t-code-inline">send_email</code>, <code className="t-code-inline">reply_to_email</code>. Paste the MCP endpoint URL into claude.ai, Claude Desktop, Cursor, or any MCP-compatible agent. That's the entire integration.</>,
      tag: "Scope",
    },
    {
      n: "02",
      h: "Email is fetched live. Never stored.",
      p: "Every tool call hits your provider in real time — Gmail API, Microsoft Graph, or IMAP. Message bodies, subjects, and attachments are returned to the agent and immediately discarded. The only thing we persist is an encrypted OAuth token per inbox, so we can make the next call.",
      tag: "Storage",
    },
    {
      n: "03",
      h: "Sending goes through your provider.",
      p: <>When your agent calls <code className="t-code-inline">send_email</code> or <code className="t-code-inline">reply_to_email</code>, the message is dispatched via the Gmail API, Microsoft Graph, or your own SMTP server. Your domain reputation and deliverability stay entirely in your hands. We never relay mail from our own domain.</>,
      tag: "Sending",
    },
    {
      n: "04",
      h: "Gmail, Outlook, or any IMAP inbox.",
      p: "OAuth 2.0 for Gmail and Outlook. App passwords for Fastmail and any IMAP/SMTP provider. Connect multiple inboxes — label them by use case (work-gmail, ops-outlook, support-fastmail) and scope each API key to the inboxes you want that agent to reach.",
      tag: "Providers",
    },
    {
      n: "05",
      h: "OAuth 2.0 for agents. One click to revoke.",
      p: "claude.ai and other OAuth clients connect automatically — dynamic registration, authorization code + PKCE, no API key setup. For programmatic access, API keys are scoped, prefixed, and hashed. Either way, you can revoke any connection from the dashboard in one click.",
      tag: "Access",
    },
    {
      n: "06",
      h: "Credentials are encrypted at rest.",
      p: "OAuth tokens and app passwords are AES-256-GCM encrypted before being written to the database. Decryption happens only inside an isolated server function at call time. The encryption key is stored in a separate secrets vault, not alongside the data.",
      tag: "Security",
    },
  ];
  return (
    <section className="section principles" id="features">
      <div className="container">
        <div className="section-head principles-head">
          <div className="eye-label">Principles</div>
          <h2>Six things we believe<br/>about email and agents.</h2>
          <p className="sub">
            The decisions that shaped the product. If any of them stop being true, that's a bug worth filing.
          </p>
        </div>
        <ol className="principle-list">
          {principles.map(it => (
            <li className="principle" key={it.n}>
              <div className="p-num">
                <span className="n">{it.n}</span>
                <span className="t">{it.tag}</span>
              </div>
              <div className="p-body">
                <h3>{it.h}</h3>
                <p>{it.p}</p>
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
  return (
    <section className="section how" id="how">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">How it works</div>
          <h2>You're the user. We're the pipe.</h2>
          <p className="sub">Three steps from sign-up to your agent reading and sending mail.</p>
        </div>

        <div className="how-steps">
          <div className="step">
            <span className="num">01</span>
            <h4>Connect your inbox</h4>
            <p>Sign in and click <strong>Connect Inbox</strong>. Choose Gmail or Outlook and complete the OAuth flow — no passwords shared. For Fastmail or any IMAP provider, paste an app password instead.</p>
          </div>
          <div className="step">
            <span className="num">02</span>
            <h4>Connect your agent — API key or OAuth</h4>
            <p>For <strong>claude.ai</strong>: paste <code className="t-code-inline">https://www.mcpemails.com/mcp</code> in Connectors and authorize — no key needed. For <strong>Claude Desktop, Cursor, or n8n</strong>: generate a scoped API key in the dashboard and drop it in your config. One URL, all six tools.</p>
          </div>
          <div className="step">
            <span className="num">03</span>
            <h4>Your agent works the inbox</h4>
            <p>The agent calls tools like <code className="t-code-inline">search_emails()</code> or <code className="t-code-inline">reply_to_email()</code>. MCPEmails fetches live from your provider and returns the result. Nothing is cached between calls.</p>
          </div>
        </div>

        <div className="tools">
          {[
            { n: "list_inboxes",   d: "Discover all connected inboxes and their IDs. Call this first — no UUID copy-pasting from the dashboard." },
            { n: "list_inbox",     d: "List recent messages with sender, subject, date, and snippet — up to 100 per call." },
            { n: "read_email",     d: "Fetch a single message by ID. Returns parsed plain-text and sanitized HTML body, plus attachment metadata." },
            { n: "search_emails",  d: "Provider-native search: Gmail query syntax, IMAP SEARCH, or Microsoft Graph. Returns up to 100 matches." },
            { n: "send_email",     d: "Send a new message via the connected account. Dispatched through Gmail API, Graph, or SMTP — your domain, your deliverability." },
            { n: "reply_to_email", d: "Reply in-thread with correct Message-ID and References headers. Works across Gmail, Outlook, and IMAP." },
          ].map(t => (
            <div className="tool" key={t.n}>
              <div className="name">{t.n}()</div>
              <div className="desc">{t.d}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============== QUOTE ============== */
export function Quote() {
  return (
    <section className="quote">
      <div className="container">
        <div className="text">
          "It took me longer to log into Gmail than to wire up my agent. The fact that I never had to think about IMAP credentials — or whether my email is being stored somewhere — is the entire point."
        </div>
        <div className="who"><strong>Maya Chen</strong> · staff engineer, building agent workflows at a Series C fintech</div>
      </div>
    </section>
  );
}

/* ============== PRICING ============== */
export function Pricing({ onGetStarted }) {
  const tiers = [
    {
      name: "Free",
      price: "$0",
      per: "/forever",
      accent: false,
      desc: "For personal projects and tinkering with agents.",
      features: [
        "1 connected inbox",
        "100 MCP calls / month",
        "Gmail, Outlook, IMAP",
        "1 API key",
        "Community support",
      ],
      cta: "Start free",
      ctaHref: "/signup",
    },
    {
      name: "Pro",
      price: "$29",
      per: "/month",
      accent: true,
      desc: "For teams shipping agents that work the inbox every day.",
      features: [
        "10 connected inboxes",
        "20,000 MCP calls / month",
        "Gmail, Outlook, IMAP",
        "10 API keys",
        "Usage analytics dashboard",
        "Email support",
      ],
      cta: "Start free trial",
      ctaHref: "/signup",
    },
    {
      name: "Enterprise",
      price: "Custom",
      per: "",
      accent: false,
      desc: "For organisations that need unlimited scale and compliance guarantees.",
      features: [
        "Unlimited inboxes",
        "Custom MCP call volume",
        "Gmail, Outlook, IMAP",
        "Unlimited API keys",
        "Audit log + SSO",
        "Dedicated Slack support",
        "Custom SLA",
      ],
      cta: "Talk to sales",
      ctaHref: "mailto:sales@mcpemails.com",
    },
  ];
  return (
    <section className="section" id="pricing">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">Pricing</div>
          <h2>Pay for the calls your agent makes.</h2>
          <p className="sub">Simple, transparent pricing. Switch plans any time. EU and US billing in local currency.</p>
        </div>
        <div className="price-grid price-grid-3">
          {tiers.map(t => (
            <div className={"price" + (t.accent ? " featured" : "")} key={t.name}>
              <div>
                <h4>{t.name}</h4>
                <div className="num">
                  {t.price}
                  {t.per && <small> {t.per}</small>}
                </div>
                <p className="price-desc">{t.desc}</p>
              </div>
              <ul>
                {t.features.map(f => (
                  <li key={f}><MIcon name="check" size={14} color="var(--mint-600)"/>{f}</li>
                ))}
              </ul>
              <a
                className={"btn " + (t.accent ? "btn-primary" : "btn-secondary")}
                href={t.ctaHref}
                onClick={t.ctaHref === "/signup" ? onGetStarted : undefined}
              >
                {t.cta}
              </a>
            </div>
          ))}
        </div>
        <p className="pricing-footnote">
          All plans: email is fetched live and never stored. OAuth tokens encrypted at rest. <a href="/pricing">See full feature comparison →</a>
        </p>
      </div>
    </section>
  );
}

/* ============== FOOTER ============== */
export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="brand-cell">
            <img src="/logo-mark-dark.svg" alt="mcpemails" />
            <p>A hosted MCP server that gives AI agents read and send access to your inbox, without ever storing your email.</p>
          </div>
          <div>
            <h5>Product</h5>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="/docs">Docs</a>
          </div>
          <div>
            <h5>Resources</h5>
            <a href="/docs#tools">Tool reference</a>
            <a href="/docs#quickstart">Quickstart</a>
            <a href="/docs#oauth">OAuth connection</a>
          </div>
          <div>
            <h5>Company</h5>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </div>
        </div>
        <div className="legal">
          <span>© 2026 mcpemails.</span>
          <span>Email never stored · Credentials encrypted at rest</span>
        </div>
      </div>
    </footer>
  );
}
