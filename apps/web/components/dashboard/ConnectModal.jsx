'use client';

import { useState, useEffect } from 'react';
import { Icon, Badge, Btn, Avatar, ProviderLogo } from '../Primitives';
import { MIcon, MBtn } from '../MarketingPrimitives';

/* ConnectModal.jsx — multi-step inbox connect flow with realistic OAuth handoff. */



export function ConnectModal({ onClose, onConnect, initialProvider = "gmail" }) {
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState(initialProvider);
  const [label, setLabel] = useState(initialProvider === "gmail" ? "work-gmail" : initialProvider === "outlook" ? "ms365" : "fastmail-ops");
  const [imap, setImap] = useState({ host: "", port: "993", user: "", pass: "" });
  const [oauthPhase, setOauthPhase] = useState("consent"); // consent → granting → returning
  const [imapTest, setImapTest] = useState("idle"); // idle → testing → ok

  // Reset oauth phase when entering step 2
  useEffect(() => { if (step === 2) { setOauthPhase("consent"); setImapTest("idle"); } }, [step]);

  const next = () => setStep(s => s + 1);
  const back = () => setStep(s => Math.max(1, s - 1));

  const authorizeOAuth = () => {
    setOauthPhase("granting");
    setTimeout(() => {
      setOauthPhase("returning");
      setTimeout(() => setStep(3), 700);
    }, 900);
  };

  const testImap = () => {
    if (!imap.host || !imap.user || !imap.pass) return;
    setImapTest("testing");
    setTimeout(() => {
      setImapTest("ok");
      setTimeout(() => setStep(3), 600);
    }, 1100);
  };

  const providerEmail =
    provider === "gmail"  ? "jordan@stripe.com" :
    provider === "outlook"? "jr@reyesconsult.com" :
    imap.user || "you@your-domain.com";

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: step === 2 && provider !== "imap" ? 520 : 480 }}>
        <div className="modal-h">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div className="step-pip">
              <div className={"pip" + (step >= 1 ? " on" : "")}/>
              <div className={"pip" + (step >= 2 ? " on" : "")}/>
              <div className={"pip" + (step >= 3 ? " on" : "")}/>
              <span className="label">Step {step} of 3</span>
            </div>
            <div style={{ flex: 1 }}/>
            <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--fg-3)" }}>
              <Icon name="x" size={16}/>
            </button>
          </div>
          <h2>{step === 3 ? "Inbox connected" : "Connect an inbox"}</h2>
          <div className="sub">
            {step === 1 ? "Choose a provider. Your credentials never touch our servers in plaintext." : null}
            {step === 2 && provider === "gmail"   ? "Review the scopes mcpemails.com is requesting from Google." : null}
            {step === 2 && provider === "outlook" ? "Sign in with Microsoft to authorize mcpemails.com." : null}
            {step === 2 && provider === "imap"    ? "Use an app password from your provider. Never your main password." : null}
            {step === 3 ? "It's now available to your MCP clients." : null}
          </div>
        </div>

        <div className="modal-body">
          {step === 1 && (
            <>
              <div className="provider-grid">
                {[
                  { k: "gmail",   l: "Gmail",   s: "OAuth2 · recommended" },
                  { k: "outlook", l: "Outlook", s: "OAuth2 · Microsoft 365" },
                  { k: "imap",    l: "IMAP",    s: "Any provider · app password" },
                ].map(p => (
                  <div key={p.k}
                       className={"provider-chip" + (provider === p.k ? " sel" : "")}
                       onClick={() => setProvider(p.k)}>
                    <ProviderLogo kind={p.k} size={26} />
                    <div className="pn">{p.l}</div>
                    <div className="ps">{p.s}</div>
                  </div>
                ))}
              </div>
              <div className="field" style={{ marginTop: 4 }}>
                <label>Label</label>
                <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. work-gmail" />
                <span style={{ fontFamily:"var(--font-sans)", fontSize:12, color:"var(--fg-3)" }}>
                  How the inbox appears in MCP responses.
                </span>
              </div>
            </>
          )}

          {step === 2 && (provider === "gmail" || provider === "outlook") && (
            <OAuthConsentSim
              provider={provider}
              providerEmail={providerEmail}
              phase={oauthPhase}
              onApprove={authorizeOAuth}
            />
          )}

          {step === 2 && provider === "imap" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                <div className="field">
                  <label>IMAP host</label>
                  <input className="input mono" placeholder="imap.fastmail.com" value={imap.host} onChange={e => setImap({...imap, host: e.target.value})} />
                </div>
                <div className="field">
                  <label>Port</label>
                  <input className="input mono" value={imap.port} onChange={e => setImap({...imap, port: e.target.value})} />
                </div>
              </div>
              <div className="field">
                <label>Username</label>
                <input className="input mono" placeholder="you@your-domain.com" value={imap.user} onChange={e => setImap({...imap, user: e.target.value})} />
              </div>
              <div className="field">
                <label>App password</label>
                <input className="input mono" type="password" placeholder="••••••••" value={imap.pass} onChange={e => setImap({...imap, pass: e.target.value})} />
                <span style={{ fontFamily:"var(--font-sans)", fontSize:12, color:"var(--fg-3)" }}>
                  Generate from your provider's security settings. Never your account password.
                </span>
              </div>
              {imapTest === "testing" && (
                <div style={{ padding: "10px 12px", background: "var(--cobalt-50)", border: "1px solid rgba(37,71,229,0.18)", borderRadius: 8, display: "flex", gap: 10, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--cobalt-700)" }}>
                  <Icon name="refresh" size={14} color="var(--cobalt-600)" className="spin"/>
                  Testing {imap.host}:{imap.port}…
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap: 12, padding: "12px 0 4px" }}>
              <div style={{ width: 56, height: 56, borderRadius: 999, background: "var(--mint-50)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="check" size={28} color="var(--mint-700)" strokeWidth={2.2} />
              </div>
              <div style={{ fontFamily:"var(--font-sans)", fontSize:16, fontWeight:600 }}>{label} is live</div>
              <div style={{ fontFamily:"var(--font-mono)", fontSize:12, color:"var(--fg-3)" }}>
                {provider === "gmail" || provider === "outlook" ? providerEmail : imap.user} · {provider} · just now
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Badge tone="live" dot="live">Connected</Badge>
                <Badge tone="brand">{provider === "imap" ? "imap session pooled" : "oauth · refresh token stored"}</Badge>
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {step === 1 && (
            <>
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn variant="primary" onClick={next}>Continue</Btn>
            </>
          )}
          {step === 2 && (
            <>
              <Btn variant="ghost" onClick={back}>Back</Btn>
              {provider === "imap" && (
                <Btn variant="primary" icon={imapTest === "ok" ? "check" : "shield"} onClick={testImap}>
                  {imapTest === "testing" ? "Testing…" : imapTest === "ok" ? "Connected" : "Test & save"}
                </Btn>
              )}
              {/* Gmail/Outlook approval button lives inside OAuthConsentSim */}
            </>
          )}
          {step === 3 && (
            <Btn variant="primary" onClick={() => onConnect({
              label,
              provider,
              address: provider === "gmail" || provider === "outlook" ? providerEmail : imap.user,
            })}>Done</Btn>
          )}
        </div>
      </div>
      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* OAuth consent simulator — looks like Google's consent screen, lives inside our modal. */
function OAuthConsentSim({ provider, providerEmail, phase, onApprove }) {
  const isGoogle = provider === "gmail";
  const brandColor = isGoogle ? "#4285F4" : "#0078D4";
  const brandName  = isGoogle ? "Google" : "Microsoft";

  if (phase === "granting") {
    return (
      <div style={{ border: "1px solid var(--border-1)", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 12, minHeight: 280, justifyContent: "center" }}>
        <Icon name="refresh" size={28} color={brandColor} className="spin"/>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>Redirecting to {brandName}…</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-3)" }}>oauth2/v2/auth?client_id=mcpemails…</div>
      </div>
    );
  }
  if (phase === "returning") {
    return (
      <div style={{ border: "1px solid var(--border-1)", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 12, minHeight: 280, justifyContent: "center" }}>
        <Icon name="check" size={28} color="var(--mint-600)" strokeWidth={2.2}/>
        <div style={{ fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, color: "var(--fg-1)" }}>Token received</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-3)" }}>Encrypting & storing…</div>
      </div>
    );
  }

  // consent (default)
  return (
    <div style={{ border: "1px solid var(--border-1)", borderRadius: 12, overflow: "hidden", background: "var(--bg-surface)" }}>
      {/* Faux browser chrome */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border-1)", background: "var(--ink-25)" }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--ink-300)" }}/>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--ink-300)" }}/>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--ink-300)" }}/>
        <span style={{ marginLeft: 8, padding: "3px 10px", borderRadius: 6, background: "var(--bg-surface)", border: "1px solid var(--border-1)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="shield" size={11} color="var(--mint-600)"/>
          {isGoogle ? "accounts.google.com" : "login.microsoftonline.com"}
        </span>
      </div>

      <div style={{ padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          {isGoogle
            ? <MIcon name="google" size={18}/>
            : <svg width="18" height="18" viewBox="0 0 24 24"><rect x="2" y="2" width="9" height="9" fill="#F25022"/><rect x="13" y="2" width="9" height="9" fill="#7FBA00"/><rect x="2" y="13" width="9" height="9" fill="#00A4EF"/><rect x="13" y="13" width="9" height="9" fill="#FFB900"/></svg>}
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--fg-3)", letterSpacing: 0.04, textTransform: "uppercase", fontWeight: 500 }}>Sign in with {brandName}</span>
        </div>

        <div style={{ fontFamily: "var(--font-sans)", fontSize: 18, fontWeight: 600, color: "var(--fg-1)", marginBottom: 4 }}>
          mcpemails.com wants access to your account
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Avatar initials={providerEmail.slice(0,2).toUpperCase()}/>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--fg-2)" }}>{providerEmail}</div>
        </div>

        <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, color: "var(--fg-3)", marginBottom: 8, fontWeight: 500 }}>
          This will allow mcpemails.com to:
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          {[
            { ic: "inbox",  h: "Read your mail", d: isGoogle ? "gmail.readonly" : "Mail.Read" },
            { ic: "mail",   h: "Send mail on your behalf", d: isGoogle ? "gmail.send" : "Mail.Send" },
            { ic: "refresh",h: "Reply to mail in your threads", d: isGoogle ? "gmail.modify (reply only)" : "Mail.ReadWrite" },
          ].map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--cobalt-50)", color: "var(--cobalt-700)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", marginTop: 2 }}>
                <Icon name={p.ic} size={14}/>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-sans)", fontSize: 13.5, color: "var(--fg-1)", fontWeight: 500 }}>{p.h}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--fg-3)" }}>{p.d}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => {}} style={{ background: "transparent", border: "1px solid var(--border-1)", color: "var(--fg-2)", height: 36, padding: "0 16px", borderRadius: 8, fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={onApprove}
                  style={{ background: brandColor, color: "#fff", border: "none", height: 36, padding: "0 16px", borderRadius: 8, fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            Allow
          </button>
        </div>

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-1)", display: "flex", gap: 6, alignItems: "center", fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.55 }}>
          <Icon name="shield" size={12} color="var(--mint-600)"/>
          mcpemails.com stores only an encrypted refresh token. You can revoke at any time from {brandName} or our dashboard.
        </div>
      </div>
    </div>
  );
}
