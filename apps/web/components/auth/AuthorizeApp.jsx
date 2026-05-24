'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MIcon, MBtn } from '../MarketingPrimitives';
import { Icon, Badge, Btn, Avatar, ProviderLogo } from '../Primitives';

function readQuery(searchParams, key, fallback) {
  return searchParams?.get(key) || fallback;
}

function ThemeBtn() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(typeof document !== 'undefined' && document.documentElement.getAttribute("data-theme") === "dark");
  }, []);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("mcpe-theme", dark ? "dark" : "light"); } catch(e) {}
  }, [dark]);
  return (
    <button className="theme-toggle" onClick={() => setDark(d => !d)} title="Toggle theme">
      <MIcon name={dark ? "sun" : "moon"} size={16} color="currentColor"/>
    </button>
  );
}

const AGENTS = {
  claude:  { name: "Claude Desktop",  byline: "by Anthropic",  short: "Claude" },
  cursor:  { name: "Cursor",          byline: "by Anysphere",  short: "Cursor" },
  n8n:     { name: "n8n workflow",    byline: "self-hosted",   short: "n8n" },
};

function AgentMark({ kind, size = 32 }) {
  // Generic, abstract agent marks — distinguishable but not real product logos.
  if (kind === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36">
        <rect width="36" height="36" rx="9" fill="#D97757"/>
        <circle cx="13" cy="18" r="5" fill="none" stroke="#fff" strokeWidth="2.4"/>
        <circle cx="23" cy="18" r="5" fill="none" stroke="#fff" strokeWidth="2.4"/>
      </svg>
    );
  }
  if (kind === "cursor") {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36">
        <rect width="36" height="36" rx="9" fill="#0B1020"/>
        <path d="M11 9l16 9-7 1-2 7-7-17z" fill="#fff"/>
      </svg>
    );
  }
  if (kind === "n8n") {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36">
        <rect width="36" height="36" rx="9" fill="#EA4B71"/>
        <circle cx="11" cy="18" r="3.6" fill="#fff"/>
        <circle cx="25" cy="11" r="2.6" fill="#fff"/>
        <circle cx="25" cy="25" r="2.6" fill="#fff"/>
        <path d="M13 16.5l9.5-4.5M13 19.5l9.5 4.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    );
  }
  return null;
}

export function AuthorizeApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentKey = readQuery(searchParams, "agent", "claude");
  const agent = AGENTS[agentKey] || AGENTS.claude;
  const reqScopes = (readQuery(searchParams, "scope", "read:email,send:email,reply:email") || "").split(",");
  const keyName = readQuery(searchParams, "name", agentKey === "claude" ? "Claude Desktop (macbook)" : agent.name);

  // simulated state
  const [step, setStep] = useState("review"); // review → granting → done
  const [grantedInboxes, setGrantedInboxes] = useState({ "work-gmail": true, "personal": true, "ops-fastmail": false, "ms365-consult": false });
  const [scopes, setScopes] = useState({
    "read:email":   true,
    "send:email":   reqScopes.includes("send:email"),
    "reply:email":  reqScopes.includes("reply:email"),
    "search:email": true,
  });
  const [keyLabel, setKeyLabel] = useState(keyName);
  const [token, setToken] = useState("");

  const inboxes = [
    { id: "work-gmail",    addr: "jordan@stripe.com",      provider: "gmail" },
    { id: "personal",      addr: "jordan.reyes@gmail.com", provider: "gmail" },
    { id: "ops-fastmail",  addr: "ops@reyes.fm",           provider: "imap" },
    { id: "ms365-consult", addr: "jr@reyesconsult.com",    provider: "outlook" },
  ];

  const grantCount = Object.values(grantedInboxes).filter(Boolean).length;

  const allow = () => {
    setStep("granting");
    setTimeout(() => {
      const tk = "mcpe_live_" + Array.from({length: 32}, () => "abcdef0123456789"[Math.floor(Math.random()*16)]).join("");
      setToken(tk);
      setStep("done");
    }, 1100);
  };

  return (
    <div className="auth-shell" data-screen-label="Auth / Authorize agent">
      <ThemeBtn/>
      <div className="az-wrap">
        <a className="auth-back" href="/dashboard">
          <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2}/>
          Back to dashboard
        </a>

        <div className="az-card">
          {step !== "done" && (
            <div className="az-head">
              <div className="blob"><AgentMark kind={agentKey} size={36}/></div>
              <div className="arc"/>
              <div className="blob brand"><img src="/favicon.svg" alt="mcpemails"/></div>
            </div>
          )}

          {step === "review" && (
            <>
              <div className="az-body">
                <h1>Authorize {agent.name}?</h1>
                <div className="who"><strong>{agent.name}</strong> · {agent.byline} is requesting access to your <strong>jordan-personal</strong> workspace.</div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 12px", borderRadius: 8, background: "var(--ink-25)", border: "1px solid var(--border-1)" }}>
                  <Icon name="key" size={14} color="var(--fg-3)"/>
                  <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 500, whiteSpace: "nowrap" }}>OAuth client</span>
                  <code className="mono" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-2)", marginLeft: "auto" }}>cli_{agentKey}_v1</code>
                </div>

                <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, color: "var(--fg-2)", marginBottom: 8 }}>
                  This agent will be able to:
                </div>
                <div className="az-perms">
                  <PermRow
                    icon="inbox"
                    title="Read your inbox"
                    desc="list_inbox, read_email, search_emails. Limited to the inboxes you select below."
                    enabled={scopes["read:email"]}
                    onToggle={v => setScopes(s => ({...s, "read:email": v}))}
                    locked
                  />
                  <PermRow
                    icon="mail"
                    title="Send email on your behalf"
                    desc="send_email. Outbound goes through your provider's SMTP or Gmail API. Never our domain."
                    enabled={scopes["send:email"]}
                    onToggle={v => setScopes(s => ({...s, "send:email": v}))}
                  />
                  <PermRow
                    icon="refresh"
                    title="Reply in your threads"
                    desc="reply_to_email. Only inside existing threads, never new conversations."
                    enabled={scopes["reply:email"]}
                    onToggle={v => setScopes(s => ({...s, "reply:email": v}))}
                  />
                </div>

                <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, color: "var(--fg-2)", marginBottom: 8 }}>
                  Restrict to specific inboxes:
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
                  {inboxes.map(ib => (
                    <InboxToggle key={ib.id} ib={ib}
                                 checked={!!grantedInboxes[ib.id]}
                                 onChange={v => setGrantedInboxes(s => ({...s, [ib.id]: v}))}/>
                  ))}
                </div>

                <div className="field" style={{ marginBottom: 6 }}>
                  <label>Name this connection</label>
                  <input className="input" value={keyLabel} onChange={e => setKeyLabel(e.target.value)}/>
                  <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--fg-3)" }}>
                    Shown in your dashboard so you can revoke it later.
                  </span>
                </div>
              </div>

              <div className="az-foot">
                <div className="grow">
                  Granting access to <strong style={{ color: "var(--fg-2)" }}>{grantCount}</strong> of {inboxes.length} inboxes
                </div>
                <Btn variant="ghost" onClick={() => router.push("/dashboard")}>Deny</Btn>
                <Btn variant="primary" icon="shield" onClick={allow} disabled={grantCount === 0}>
                  Allow access
                </Btn>
              </div>
            </>
          )}

          {step === "granting" && (
            <div style={{ padding: "48px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <Icon name="refresh" size={28} color="var(--brand)" className="spin"/>
              <div style={{ fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600 }}>Issuing token for {agent.name}…</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>
                POST /oauth/token · grant_type=authorization_code
              </div>
              <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {step === "done" && (
            <DoneScreen agentKey={agentKey} agent={agent} token={token} grantCount={grantCount} inboxes={inboxes} grantedInboxes={grantedInboxes}/>
          )}
        </div>

        <div className="auth-microcopy" style={{ marginTop: 20 }}>
          <Icon name="shield" size={13} color="var(--mint-600)"/>
          mcpemails never reveals your provider passwords to {agent.name}. Revoke this connection from the API keys page at any time.
        </div>
      </div>
    </div>
  );
}

function PermRow({ icon, title, desc, enabled, onToggle, locked }) {
  return (
    <div className="az-perm">
      <div className="pico"><Icon name={icon} size={16}/></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ph">{title}</div>
        <div className="pd">{desc}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", marginLeft: 12 }}>
        {locked ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>
            <Icon name="shield" size={11} color="var(--mint-600)"/>required
          </span>
        ) : (
          <Switch checked={enabled} onChange={onToggle}/>
        )}
      </div>
    </div>
  );
}

function InboxToggle({ ib, checked, onChange }) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
      border: "1px solid " + (checked ? "var(--brand)" : "var(--border-1)"),
      background: checked ? "var(--cobalt-50)" : "var(--bg-surface)",
      borderRadius: 10, cursor: "pointer", transition: "all 120ms var(--ease-out)",
    }}>
      <ProviderLogo kind={ib.provider} size={18}/>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, color: "var(--fg-1)" }}>{ib.id}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ib.addr}</div>
      </div>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
             style={{ accentColor: "var(--brand)" }}/>
    </label>
  );
}

function Switch({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      width: 36, height: 20, borderRadius: 999,
      background: checked ? "var(--brand)" : "var(--ink-200)",
      border: "none", padding: 0, cursor: "pointer", position: "relative",
      transition: "background 120ms var(--ease-out)",
    }}>
      <span style={{
        position: "absolute", top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: 999, background: "#fff",
        transition: "left 120ms var(--ease-out)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      }}/>
    </button>
  );
}

function DoneScreen({ agentKey, agent, token, grantCount, inboxes, grantedInboxes }) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState(agentKey);

  const snippet = (() => {
    if (tab === "claude") return `{
  "mcpServers": {
    "mcpemails": {
      "url": "https://mcpemails.com/mcp",
      "auth": { "type": "bearer", "token": "${token}" }
    }
  }
}`;
    if (tab === "cursor") return `{
  "mcp": {
    "servers": {
      "mcpemails": {
        "url": "https://mcpemails.com/mcp",
        "bearer": "${token}"
      }
    }
  }
}`;
    return `# n8n MCP credential
URL:    https://mcpemails.com/mcp
Auth:   Bearer
Token:  ${token}`;
  })();

  const path = tab === "claude" ? "~/.claude/mcp.json"
            : tab === "cursor" ? "~/.cursor/config.json"
            : "n8n · MCP credentials";

  const copy = () => {
    navigator.clipboard?.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div className="az-success">
        <div className="ring"><Icon name="check" size={28} color="var(--mint-700)" strokeWidth={2.2}/></div>
        <h1>{agent.name} is connected</h1>
        <p>It can now access {grantCount} of your inboxes. You'll see its calls live in your dashboard.</p>
      </div>

      <div style={{ padding: "0 32px 24px" }}>
        <div className="endpoint-label" style={{ marginBottom: 8 }}>
          <span>Paste this into {agent.short}</span>
          <span className="endpoint-pill"><span className="d"/>token issued</span>
        </div>

        <div className="client-tabs" style={{ marginBottom: 10 }}>
          {["claude", "cursor", "n8n"].map(k => (
            <button key={k}
                    className={"client-tab" + (tab === k ? " active" : "")}
                    onClick={() => setTab(k)}>
              {AGENTS[k].short}
            </button>
          ))}
        </div>

        <div className="code-bar">
          <div className="dots"><span/><span/><span/></div>
          <span className="path">{path}</span>
          <span className="pill"><span className="d"/>Live</span>
        </div>
        <pre className="code" style={{ background: "var(--bg-sunken)", padding: "14px 16px", borderRadius: 10, fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.65, color: "var(--fg-1)", whiteSpace: "pre", overflow: "auto", margin: 0 }}>
{snippet}
        </pre>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <button onClick={copy} style={{
            background: "var(--bg-surface)", border: "1px solid var(--border-1)", borderRadius: 8,
            padding: "8px 12px", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
            color: "var(--fg-1)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            {copied
              ? <><Icon name="check" size={13} color="var(--mint-700)"/> Copied token</>
              : <><Icon name="copy" size={13} color="var(--fg-2)"/> Copy bearer token</>}
          </button>
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--fg-3)" }}>
            This is the only time we'll show the full token.
          </span>
        </div>
      </div>

      <div className="az-foot">
        <div className="grow"/>
        <a className="btn btn-secondary" href="/dashboard">Back to dashboard</a>
        <a className="btn btn-primary" href="/dashboard?route=overview">View live calls</a>
      </div>
    </>
  );
}
