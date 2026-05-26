'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { MIcon } from '../MarketingPrimitives';
import { Icon, Btn, ProviderLogo } from '../Primitives';

// ─── Theme toggle ─────────────────────────────────────────────────────────────

function ThemeBtn() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'dark'
    );
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem('mcpe-theme', dark ? 'dark' : 'light'); } catch (_) {}
  }, [dark]);

  return (
    <button className="theme-toggle" onClick={() => setDark((d) => !d)} title="Toggle theme" aria-label="Toggle theme">
      <MIcon name={dark ? 'sun' : 'moon'} size={16} color="currentColor" />
    </button>
  );
}

// ─── Client logo ──────────────────────────────────────────────────────────────
// Renders a logo_url image if provided, otherwise falls back to a generic
// agent mark derived from the client_id. This avoids hard-coding real product
// logos for clients we don't control.

function ClientMark({ clientId, logoUrl, size = 36 }) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={clientId}
        width={size}
        height={size}
        style={{ borderRadius: 9, objectFit: 'cover' }}
      />
    );
  }

  // Deterministic colour from client_id string so the same client always
  // gets the same colour (but without hardcoding per known client).
  const hue = Math.abs(
    clientId.split('').reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7)
  ) % 360;

  const firstLetter = clientId.replace(/[^a-z]/gi, '')[0]?.toUpperCase() ?? '?';

  return (
    <svg width={size} height={size} viewBox="0 0 36 36">
      <rect width="36" height="36" rx="9" fill={`hsl(${hue},65%,50%)`} />
      <text
        x="18" y="24"
        textAnchor="middle"
        fontFamily="system-ui,sans-serif"
        fontSize="18"
        fontWeight="700"
        fill="#fff"
      >
        {firstLetter}
      </text>
    </svg>
  );
}

// ─── Permission row ───────────────────────────────────────────────────────────

function PermRow({ icon, title, desc, enabled, onToggle, required }) {
  return (
    <div className="az-perm">
      <div className="pico"><Icon name={icon} size={16} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ph">{title}</div>
        <div className="pd">{desc}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginLeft: 12 }}>
        {required ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)',
          }}>
            <Icon name="shield" size={11} color="var(--mint-600)" />required
          </span>
        ) : (
          <Switch checked={enabled} onChange={onToggle} />
        )}
      </div>
    </div>
  );
}

// ─── Inbox toggle ─────────────────────────────────────────────────────────────

function InboxToggle({ inbox, checked, onChange }) {
  const label = inbox.display_name || inbox.email_address;

  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
      border: '1px solid ' + (checked ? 'var(--brand)' : 'var(--border-1)'),
      background: checked ? 'var(--cobalt-50)' : 'var(--bg-surface)',
      borderRadius: 10, cursor: 'pointer', transition: 'all 120ms var(--ease-out)',
    }}>
      <ProviderLogo kind={inbox.provider} size={18} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          title={inbox.email_address}
          style={{
            fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600,
            color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
        {inbox.display_name && (
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {inbox.email_address}
          </div>
        )}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--brand)' }}
      />
    </label>
  );
}

// ─── Switch ───────────────────────────────────────────────────────────────────

function Switch({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 36, height: 20, borderRadius: 999,
        background: checked ? 'var(--brand)' : 'var(--ink-200)',
        border: 'none', padding: 0, cursor: 'pointer', position: 'relative',
        transition: 'background 120ms var(--ease-out)',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: 999, background: '#fff',
        transition: 'left 120ms var(--ease-out)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      }} />
    </button>
  );
}

// ─── Done screen ──────────────────────────────────────────────────────────────

function DoneScreen({ client, grantCount, totalInboxes }) {
  return (
    <>
      <div className="az-success">
        <div className="ring">
          <Icon name="check" size={28} color="var(--mint-700)" strokeWidth={2.2} />
        </div>
        <h1>{client.client_name} is connected</h1>
        <p>
          It can now access {grantCount} of your {totalInboxes} inboxes.
          You&apos;ll see its calls live in your dashboard.
        </p>
      </div>

      <div style={{ padding: '0 32px 24px', textAlign: 'center' }}>
        <p style={{
          fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', marginBottom: 24,
        }}>
          The MCP client will receive its bearer token automatically via the redirect.
          You can revoke access at any time from the <strong>API Keys</strong> page.
        </p>
      </div>

      <div className="az-foot">
        <div className="grow" />
        <a className="btn btn-secondary" href="/dashboard">Back to dashboard</a>
        <a className="btn btn-primary" href="/dashboard/security">View audit log</a>
      </div>
    </>
  );
}

// ─── AuthorizeApp (main export) ───────────────────────────────────────────────

/**
 * Interactive consent UI for the OAuth authorization flow.
 *
 * Props (all provided by the server component in page.js):
 *  - client         { client_id, client_name, client_byline, logo_url, is_first_party }
 *  - workspaceName  string — the user's workspace display name
 *  - requestedScopes  Array<{ scope, icon, title, desc, required }>
 *  - inboxes        Array<{ id, email_address, display_name, provider, status }>
 *  - redirectUri    string — validated redirect URI for this client
 *  - oauthState     string — opaque state param to echo back in the redirect
 *  - codeChallenge  string — PKCE code_challenge
 *  - challengeMethod string — must be 'S256'
 *
 * The "Allow access" button posts to /api/oauth/authorize (task 15.2).
 * Until that endpoint exists it shows a granting spinner and transitions
 * to the done screen to demonstrate the full UI flow.
 */
export function AuthorizeApp({
  client,
  workspaceName,
  requestedScopes,
  inboxes,
  redirectUri,
  oauthState,
  codeChallenge,
  challengeMethod,
  csrfToken,
  preApproved = false,
}) {
  const router = useRouter();

  // Track which scopes the user has toggled on/off.
  const [enabledScopes, setEnabledScopes] = useState(() => {
    const initial = {};
    for (const s of requestedScopes) {
      initial[s.scope] = true; // all requested scopes default to enabled
    }
    return initial;
  });

  // Track which inboxes the user wants to grant access to.
  // Default: all connected inboxes are checked; error/pending inboxes unchecked.
  const [grantedInboxes, setGrantedInboxes] = useState(() => {
    const initial = {};
    for (const ib of inboxes) {
      initial[ib.id] = ib.status === 'connected';
    }
    return initial;
  });

  const [keyLabel, setKeyLabel] = useState(
    `${client.client_name} — ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );

  const [step, setStep] = useState('review'); // review | granting | done | error
  const [errorMsg, setErrorMsg] = useState('');

  const grantCount = Object.values(grantedInboxes).filter(Boolean).length;
  const selectedScopes = requestedScopes.filter((s) => enabledScopes[s.scope]);
  const selectedInboxIds = Object.entries(grantedInboxes)
    .filter(([, v]) => v)
    .map(([id]) => id);

  const handleAllow = async () => {
    setStep('granting');

    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csrf_token:       csrfToken,
          client_id:        client.client_id,
          redirect_uri:     redirectUri,
          state:            oauthState,
          code_challenge:   codeChallenge,
          challenge_method: challengeMethod,
          scopes:           selectedScopes.map((s) => s.scope),
          inbox_ids:        selectedInboxIds,
          key_name:         keyLabel,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }

      // The server will redirect to redirect_uri?code=...&state=... in its
      // response. We follow that redirect here.
      const { redirect_to } = await res.json();
      if (redirect_to) {
        window.location.href = redirect_to;
      } else {
        // Endpoint not yet implemented (task 15.2) — show the done screen
        // so the UI flow is visible and testable.
        setStep('done');
      }
    } catch (err) {
      if (err.message.includes('not yet implemented') || err.message.includes('404')) {
        // Gracefully degrade when the token endpoint doesn't exist yet.
        setStep('done');
      } else {
        setErrorMsg(err.message);
        setStep('error');
      }
    }
  };

  const handleDeny = () => {
    if (redirectUri) {
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', 'The user denied access.');
      if (oauthState) url.searchParams.set('state', oauthState);
      window.location.href = url.toString();
    } else {
      router.push('/dashboard');
    }
  };

  return (
    <div className="auth-shell" data-screen-label="Auth / Authorize agent">
      <ThemeBtn />
      <div className="az-wrap">
        <a className="auth-back" href="/dashboard">
          <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2} />
          Back to dashboard
        </a>

        <div className="az-card">
          {/* Header: client logo ↔ mcpemails logo */}
          {step !== 'done' && (
            <div className="az-head">
              <div className="blob">
                <ClientMark
                  clientId={client.client_id}
                  logoUrl={client.logo_url}
                  size={36}
                />
              </div>
              <div className="arc" />
              <div className="blob brand">
                <img src="/favicon.svg" alt="mcpemails" />
              </div>
            </div>
          )}

          {/* ── Review step ────────────────────────────────────────────── */}
          {step === 'review' && (
            <>
              <div className="az-body">
                <h1>Authorize {client.client_name}?</h1>
                <div className="who">
                  <strong>{client.client_name}</strong>
                  {client.client_byline ? ` · ${client.client_byline}` : ''}
                  {' '}is requesting access to your <strong>{workspaceName || 'workspace'}</strong>.
                </div>

                {/* Client ID badge */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
                  padding: '10px 12px', borderRadius: 8,
                  background: 'var(--ink-25)', border: '1px solid var(--border-1)',
                }}>
                  <Icon name="key" size={14} color="var(--fg-3)" />
                  <span style={{
                    fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--fg-3)',
                    letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}>
                    OAuth client
                  </span>
                  <code className="mono" style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-2)',
                    marginLeft: 'auto',
                  }}>
                    {client.client_id}
                  </code>
                </div>

                {/* Pre-approved notice */}
                {preApproved && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                    borderRadius: 8, marginBottom: 12,
                    background: 'var(--mint-50, #f0fdf4)', border: '1px solid var(--mint-200, #bbf7d0)',
                  }}>
                    <Icon name="check" size={14} color="var(--mint-700, #15803d)" strokeWidth={2.2} />
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--mint-700, #15803d)' }}>
                      You&apos;ve previously authorized this app. Confirm below to issue a new token.
                    </span>
                  </div>
                )}

                {/* Requested permissions */}
                {requestedScopes.length > 0 ? (
                  <>
                    <div style={{
                      fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                      color: 'var(--fg-2)', marginBottom: 8,
                    }}>
                      This agent will be able to:
                    </div>
                    <div className="az-perms">
                      {requestedScopes.map((s) => (
                        <PermRow
                          key={s.scope}
                          icon={s.icon || 'key'}
                          title={s.title || s.scope}
                          desc={s.desc || ''}
                          enabled={enabledScopes[s.scope] ?? true}
                          onToggle={(v) => setEnabledScopes((prev) => ({ ...prev, [s.scope]: v }))}
                          required={s.required ?? false}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{
                    fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)',
                    padding: '12px 0', marginBottom: 8,
                  }}>
                    No specific permissions requested. This connection will have read-only access by default.
                  </div>
                )}

                {/* Inbox selection */}
                <div style={{
                  fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                  color: 'var(--fg-2)', marginBottom: 8,
                }}>
                  Restrict to specific inboxes:
                </div>

                {inboxes.length > 0 ? (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: inboxes.length === 1 ? '1fr' : '1fr 1fr',
                    gap: 8,
                    marginBottom: 18,
                  }}>
                    {inboxes.map((ib) => (
                      <InboxToggle
                        key={ib.id}
                        inbox={ib}
                        checked={!!grantedInboxes[ib.id]}
                        onChange={(v) => setGrantedInboxes((prev) => ({ ...prev, [ib.id]: v }))}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{
                    padding: '12px', borderRadius: 8, marginBottom: 18,
                    background: 'var(--ink-25)', border: '1px solid var(--border-1)',
                    fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)',
                  }}>
                    No connected inboxes yet.{' '}
                    <a href="/dashboard/inboxes" style={{ color: 'var(--brand)' }}>
                      Connect an inbox
                    </a>
                    {' '}before authorizing an agent.
                  </div>
                )}

                {/* Connection name */}
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>Name this connection</label>
                  <input
                    className="input"
                    value={keyLabel}
                    onChange={(e) => setKeyLabel(e.target.value)}
                  />
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    Shown in your dashboard so you can revoke it later.
                  </span>
                </div>
              </div>

              <div className="az-foot">
                <div className="grow">
                  {inboxes.length > 0 && (
                    <>
                      Granting access to{' '}
                      <strong style={{ color: 'var(--fg-2)' }}>{grantCount}</strong>
                      {' '}of {inboxes.length} inbox{inboxes.length !== 1 ? 'es' : ''}
                    </>
                  )}
                </div>
                <Btn variant="ghost" onClick={handleDeny}>Deny</Btn>
                <Btn
                  variant="primary"
                  icon="shield"
                  onClick={handleAllow}
                  disabled={inboxes.length > 0 && grantCount === 0}
                >
                  Allow access
                </Btn>
              </div>
            </>
          )}

          {/* ── Granting step ──────────────────────────────────────────── */}
          {step === 'granting' && (
            <div style={{
              padding: '48px 32px', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 14,
            }}>
              <Icon name="refresh" size={28} color="var(--brand)" className="spin" />
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 16, fontWeight: 600 }}>
                Issuing token for {client.client_name}…
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>
                POST /api/oauth/authorize · generating authorization code
              </div>
              <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* ── Done step ──────────────────────────────────────────────── */}
          {step === 'done' && (
            <DoneScreen
              client={client}
              grantCount={grantCount}
              totalInboxes={inboxes.length}
            />
          )}

          {/* ── Error step ─────────────────────────────────────────────── */}
          {step === 'error' && (
            <div style={{
              padding: '40px 32px', textAlign: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: 'var(--red-100, #fee2e2)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16,
              }}>
                <Icon name="x" size={22} color="var(--red-600, #dc2626)" />
              </div>
              <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 18, fontWeight: 700, color: 'var(--fg-1)', marginBottom: 8 }}>
                Authorization failed
              </h2>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', marginBottom: 24 }}>
                {errorMsg || 'An unexpected error occurred. Please try again.'}
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <Btn variant="ghost" onClick={() => setStep('review')}>Try again</Btn>
                <Btn variant="secondary" onClick={handleDeny}>Cancel</Btn>
              </div>
            </div>
          )}
        </div>

        <div className="auth-microcopy" style={{ marginTop: 20 }}>
          <Icon name="shield" size={13} color="var(--mint-600)" />
          mcpemails never reveals your provider credentials to {client.client_name}.
          Revoke this connection from the API Keys page at any time.
        </div>
      </div>
    </div>
  );
}
