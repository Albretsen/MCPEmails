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
          <a href="#docs">Docs</a>
          <a href="#security">Security</a>
        </nav>
        <div className="nav-grow" />
        <div className="nav-cta">
          <a className="btn btn-ghost" onClick={onSignIn} href="/signup?mode=signin">Sign in</a>
          <a className="btn btn-primary" onClick={onGetStarted} href="/signup">Get started</a>
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
        Connect your email accounts once. Paste a single URL into Claude, Cursor, or any MCP-compatible client. Your agent can now read, search, and send mail. You never share a password.
      </p>
      <div className="hero-cta">
        <MBtn variant="primary" size="lg" icon="arrow" href="/signup" onClick={onGetStarted}>Connect your inbox</MBtn>
        <MBtn variant="secondary" size="lg" href="#how">Read the docs</MBtn>
      </div>
      <div className="hero-meta">
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> 100 free calls / month</span>
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> No card required</span>
        <span className="item"><MIcon name="check" size={14} color="var(--mint-600)"/> EU-hosted</span>
      </div>
    </div>
  );
}

/* Variant A: Endpoint + client-tabbed code snippet */
export function HeroEndpointCard() {
  const [client, setClient] = useState("claude");
  const [copied, setCopied] = useState(false);
  const url = "https://mcpemails.com/mcp";
  const copyUrl = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const snippets = {
    claude: `{
  "mcpServers": {
    "mcpemails": {
      "url": "https://mcpemails.com/mcp",
      "auth": { "type": "bearer", "token": "mcpe_live_••••" }
    }
  }
}`,
    cursor: `{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://mcpemails.com/mcp",
        "bearer": "mcpe_live_••••"
      }
    }
  }
}`,
    n8n: `# n8n MCP node
URL:    https://mcpemails.com/mcp
Auth:   Bearer
Token:  mcpe_live_••••`,
  };
  const paths = {
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
        <span className="scheme">https://</span><span className="host">mcpemails.com</span><span className="path-seg">/mcp</span>
        <button className="copy-btn" onClick={copyUrl} aria-label="Copy URL">
          {copied
            ? <><MIcon name="check" size={13} color="var(--mint-700)"/> Copied</>
            : <><MIcon name="mail" size={13} color="var(--fg-2)"/> Copy</>}
        </button>
      </div>
      <div className="endpoint-divider"><span>Paste it into any MCP client</span></div>
      <div className="client-tabs">
        {[
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
          <div className="s">Claude · Cursor · n8n</div>
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
          <span className="pill"><span className="d"/>list_inbox()</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--fg-2)" }}>
          <div><span style={{ color: "var(--cobalt-700)" }}>→</span> agent calls <span style={{ color: "var(--mint-700)" }}>list_inbox</span>(account=<span style={{ color: "var(--amber-700)" }}>"work-gmail"</span>)</div>
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
    { ts: "14:02:18", arrow: "→", tool: "list_inbox",     args: "work-gmail · limit=20",       ok: "20 msgs",  ms: "182ms" },
    { ts: "14:02:21", arrow: "→", tool: "read_email",     args: "uid=4821",                    ok: "1.2kb",    ms: "97ms"  },
    { ts: "14:02:23", arrow: "→", tool: "search_emails",  args: "from:stripe after:2026-05",   ok: "3 hits",   ms: "238ms" },
    { ts: "14:02:25", arrow: "→", tool: "list_inbox",     args: "personal · unread=true",      ok: "4 msgs",   ms: "164ms" },
    { ts: "14:02:27", arrow: "→", tool: "reply_to_email", args: "uid=4821",                    ok: "queued",   ms: "311ms" },
    { ts: "14:02:30", arrow: "→", tool: "send_email",     args: "to=eng@team.io",              ok: "sent",     ms: "428ms" },
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
        <span className="label">Trusted by teams building with</span>
        <div className="trusted-logos">
          <span>Claude</span>
          <span>OpenAI</span>
          <span>Mistral</span>
          <span>n8n</span>
          <span>Cursor</span>
          <span>Zed</span>
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
      h: "Five tools cover the job.",
      p: <>The whole API surface fits in one line: <code className="t-code-inline">list_inbox</code>, <code className="t-code-inline">read_email</code>, <code className="t-code-inline">search_emails</code>, <code className="t-code-inline">send_email</code>, <code className="t-code-inline">reply_to_email</code>. Add the MCP URL to any agent. That's the integration.</>,
      tag: "Scope",
    },
    {
      n: "02",
      h: "We never store your email.",
      p: "Every call is a live IMAP or Gmail API fetch. No bodies, no attachments, no metadata cached. The only thing in our database is an encrypted refresh token per inbox.",
      tag: "Storage",
    },
    {
      n: "03",
      h: "Outbound goes through your provider.",
      p: <>Sending always uses your own SMTP or the Gmail API. Your deliverability stays in your control. We can't be the reason your domain ends up on a blocklist, because <em style={{ fontStyle: "normal", color: "var(--fg-1)", fontWeight: 500 }}>we never send mail from our own domain.</em></>,
      tag: "Sending",
    },
    {
      n: "04",
      h: "Gmail, Outlook, or any IMAP.",
      p: "OAuth2 where the provider supports it. App passwords for everything else. Connect as many inboxes as your plan allows and label them per use case (work-gmail, ops-fastmail, on-call-personal).",
      tag: "Providers",
    },
    {
      n: "05",
      h: "OAuth for agents, too.",
      p: "Agents authorize via standard OAuth2 with scoped permissions. You decide which inboxes each client can touch, and revoke any client in one click from the dashboard.",
      tag: "Access",
    },
    {
      n: "06",
      h: "EU-hosted by default.",
      p: "Workspaces created from the EU run in Frankfurt. US workspaces run in N. Virginia. Region is per-workspace and visible in Settings. Encrypted credentials never cross regions.",
      tag: "Region",
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
          <p className="sub">Three steps from sign-up to your agent talking to your inbox.</p>
        </div>

        <div className="how-steps">
          <div className="step">
            <span className="num">01</span>
            <h4>Connect your inbox</h4>
            <p>Click "Connect Gmail" in the dashboard and authorize the scopes you want. Or paste IMAP details for any other provider.</p>
          </div>
          <div className="step">
            <span className="num">02</span>
            <h4>Add the MCP URL to your agent</h4>
            <p>Drop the hosted MCP endpoint and a bearer token into Claude Desktop, n8n, Cursor, or your own client.</p>
          </div>
          <div className="step">
            <span className="num">03</span>
            <h4>Your agent works the inbox</h4>
            <p>The agent calls tools like <code className="t-code-inline">list_inbox()</code> and <code className="t-code-inline">send_email()</code>. We fetch live and disconnect.</p>
          </div>
        </div>

        <div className="tools">
          {[
            { n: "list_inbox",     d: "Most recent N emails, with sender, subject, snippet." },
            { n: "read_email",     d: "Full body of a specific email by UID." },
            { n: "search_emails",  d: "Search by keyword, sender, date, label." },
            { n: "send_email",     d: "Send from the connected account." },
            { n: "reply_to_email", d: "Reply in a specific email thread." },
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
          "It took me longer to log into Gmail than to wire up my agent. The fact that I never had to think about IMAP credentials is the entire point."
        </div>
        <div className="who"><strong>Maya Chen</strong> · staff engineer, building agent workflows at a Series C fintech</div>
      </div>
    </section>
  );
}

/* ============== PRICING ============== */
export function Pricing({ onGetStarted }) {
  const tiers = [
    { name: "Free",    price: "$0",  per: "/forever", accent: false, features: ["1 email account", "100 MCP calls / month", "Community support"], cta: "Start free" },
    { name: "Starter", price: "$9",  per: "/month",   accent: false, features: ["3 email accounts", "2,000 MCP calls / month", "Email support"], cta: "Start free trial" },
    { name: "Pro",     price: "$29", per: "/month",   accent: true,  features: ["10 email accounts", "20,000 MCP calls / month", "Priority support", "Usage analytics"], cta: "Start free trial" },
    { name: "Team",    price: "$79", per: "/month",   accent: false, features: ["Unlimited accounts", "100,000 MCP calls / month", "SSO, audit log", "Slack support"], cta: "Talk to sales" },
  ];
  return (
    <section className="section" id="pricing">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">Pricing</div>
          <h2>Pay for the calls your agent makes.</h2>
          <p className="sub">Simple usage-based pricing. Switch plans any time. EU and US billing in local currency.</p>
        </div>
        <div className="price-grid">
          {tiers.map(t => (
            <div className={"price" + (t.accent ? " featured" : "")} key={t.name}>
              <h4>{t.name}</h4>
              <div className="num">{t.price}<small> {t.per}</small></div>
              <ul>
                {t.features.map(f => (
                  <li key={f}><MIcon name="check" size={14} color="var(--mint-600)"/>{f}</li>
                ))}
              </ul>
              <a className={"btn " + (t.accent ? "btn-primary" : "btn-secondary")} href="/signup" onClick={onGetStarted}>{t.cta}</a>
            </div>
          ))}
        </div>
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
            <p>A hosted MCP server that gives AI agents access to your inbox, without ever storing your email.</p>
          </div>
          <div>
            <h5>Product</h5>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#docs">Docs</a>
            <a href="#changelog">Changelog</a>
          </div>
          <div>
            <h5>Resources</h5>
            <a href="#">MCP spec</a>
            <a href="#">Provider compat</a>
            <a href="#">Status</a>
            <a href="#">Community</a>
          </div>
          <div>
            <h5>Company</h5>
            <a href="#">About</a>
            <a href="#">Security</a>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Contact</a>
          </div>
        </div>
        <div className="legal">
          <span>© 2026 mcpemails. Made in Berlin & Lisbon.</span>
          <span>v0.4.2 · status: all systems normal</span>
        </div>
      </div>
    </footer>
  );
}
