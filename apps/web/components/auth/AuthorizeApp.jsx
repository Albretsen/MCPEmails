'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MIcon } from '../MarketingPrimitives';
import { Icon, Btn, ProviderLogo } from '../Primitives';
import { trackProductEvent, scopeProfile } from '@/lib/analytics.mjs';

// ─── Theme toggle ─────────────────────────────────────────────────────────────

function ThemeBtn() {
  const t = useTranslations('auth');
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
    <button className="theme-toggle" onClick={() => setDark((d) => !d)} title={t('shared.toggleTheme')} aria-label={t('shared.toggleTheme')}>
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

// ─── Access presets ─────────────────────────────────────────────────────────
//
// Connect-time presets let a user quickly pick how much access to grant without
// reasoning about every individual scope. Selecting a preset pre-fills the
// per-scope toggles; manually editing a toggle flips the active mode to
// "custom" (handled in AuthorizeApp). Each preset is intersected with the
// scopes the client actually offered (offeredScopes) — a preset only ever
// selects scopes within that set.

const PRESETS = [
  { id: 'readOnly', icon: 'eye',      scopes: ['read:email', 'search:email'] },
  { id: 'standard', icon: 'zap',      scopes: ['read:email', 'search:email', 'send:email', 'manage:drafts', 'manage:contacts'], recommended: true },
  { id: 'full',     icon: 'shield',   scopes: ['read:email', 'search:email', 'send:email', 'manage:folders', 'delete:email', 'manage:drafts', 'manage:contacts', 'schedule:email', 'manage:automations'] },
];

// ─── Preset cards (radiogroup) ───────────────────────────────────────────────

function PresetCards({ presets, mode, onSelect }) {
  const t = useTranslations('auth');

  // Keyboard: arrow keys move selection between enabled (offered) presets,
  // matching native radiogroup semantics.
  const selectableIds = presets.filter((p) => p.available).map((p) => p.id).concat('custom');

  const handleKeyDown = (e, currentId) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = selectableIds.indexOf(currentId);
    if (idx === -1) return;
    const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
    const next = selectableIds[(idx + dir + selectableIds.length) % selectableIds.length];
    onSelect(next);
  };

  return (
    <div className="az-presets" role="radiogroup" aria-label={t('authorize.accessLevelLabel')}>
      {presets.map((p) => {
        const selected = mode === p.id;
        const disabled = !p.available;
        return (
          <div
            key={p.id}
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : (selected || (mode === 'custom' && p.id === presets.find((x) => x.available)?.id) ? 0 : -1)}
            className={'az-preset' + (selected ? ' is-selected' : '') + (disabled ? ' is-disabled' : '')}
            title={disabled ? t('authorize.presetNotOffered') : undefined}
            onClick={() => { if (!disabled) onSelect(p.id); }}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect(p.id); }
              else handleKeyDown(e, p.id);
            }}
          >
            <div className="az-preset-ico"><Icon name={p.icon} size={16} /></div>
            <div className="az-preset-main">
              <div className="az-preset-title-row">
                <span className="az-preset-title">{t(`authorize.preset.${p.id}.title`)}</span>
                {p.recommended && (
                  <span className="az-preset-badge">{t('authorize.recommended')}</span>
                )}
              </div>
              <div className="az-preset-desc">{t(`authorize.preset.${p.id}.desc`)}</div>
            </div>
            <span className="az-preset-radio" aria-hidden="true" />
          </div>
        );
      })}

      {/* Custom card */}
      <div
        role="radio"
        aria-checked={mode === 'custom'}
        tabIndex={mode === 'custom' ? 0 : -1}
        className={'az-preset' + (mode === 'custom' ? ' is-selected' : '')}
        onClick={() => onSelect('custom')}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onSelect('custom'); }
          else handleKeyDown(e, 'custom');
        }}
      >
        <div className="az-preset-ico"><Icon name="settings" size={16} /></div>
        <div className="az-preset-main">
          <div className="az-preset-title-row">
            <span className="az-preset-title">{t('authorize.preset.custom.title')}</span>
          </div>
          <div className="az-preset-desc">{t('authorize.preset.custom.desc')}</div>
        </div>
        <span className="az-preset-radio" aria-hidden="true" />
      </div>
    </div>
  );
}

// ─── Permission row ───────────────────────────────────────────────────────────

function PermRow({ icon, title, desc, enabled, onToggle, required, destructive }) {
  const t = useTranslations('auth');
  return (
    <div className={'az-perm' + (destructive ? ' is-destructive' : '')}>
      <div className={'pico' + (destructive ? ' destructive' : '')}><Icon name={icon} size={16} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ph">
          {title}
          {destructive && (
            <span className="az-perm-warn">
              <Icon name="trash" size={11} color="var(--red-700)" />{t('authorize.destructive')}
            </span>
          )}
        </div>
        <div className="pd">{desc}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginLeft: 12 }}>
        {required ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)',
          }}>
            <Icon name="shield" size={11} color="var(--mint-600)" />{t('authorize.required')}
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
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      style={{
        width: 44, height: 44, border: 'none', padding: 0, cursor: 'pointer',
        position: 'relative', background: 'transparent', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <span style={{
        width: 36, height: 20, borderRadius: 999,
        background: checked ? 'var(--brand)' : 'var(--ink-200)',
        position: 'relative', transition: 'background 120ms var(--ease-out)',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 18 : 2,
          width: 16, height: 16, borderRadius: 999, background: '#fff',
          transition: 'left 120ms var(--ease-out)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }} />
      </span>
    </button>
  );
}

// ─── Done screen ──────────────────────────────────────────────────────────────

function DoneScreen({ client, grantCount, totalInboxes, allInboxes }) {
  const t = useTranslations('auth');
  return (
    <>
      <div className="az-success">
        <div className="ring">
          <Icon name="check" size={28} color="var(--mint-700)" strokeWidth={2.2} />
        </div>
        <h1>{t('authorize.connectedTitle', { clientName: client.client_name })}</h1>
        <p>
          {allInboxes
            ? t('authorize.connectedBodyAll')
            : t('authorize.connectedBody', { grantCount, totalInboxes })}
        </p>
      </div>

      <div style={{ padding: '0 32px 24px', textAlign: 'center' }}>
        <p style={{
          fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', marginBottom: 24,
        }}>
          {t.rich('authorize.connectedNote', {
            strong: (c) => <strong>{c}</strong>,
          })}
        </p>
      </div>

      <div className="az-foot">
        <div className="grow" />
        <a className="btn btn-secondary" href="/dashboard">{t('authorize.backToDashboardBtn')}</a>
        <a className="btn btn-primary" href="/dashboard/security">{t('authorize.viewAuditLog')}</a>
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
 *  - workspaceName  string: the user's workspace display name
 *  - requestedScopes  Array<{ scope, icon, title, desc, required }>
 *  - inboxes        Array<{ id, email_address, display_name, provider, status }>
 *  - redirectUri    string: validated redirect URI for this client
 *  - oauthState     string: opaque state param to echo back in the redirect
 *  - codeChallenge  string: PKCE code_challenge
 *  - challengeMethod string: must be 'S256'
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
  const t = useTranslations('auth');

  // The set of scopes this client is allowed to offer (canonical order).
  const offeredScopeIds = requestedScopes.map((s) => s.scope);
  const offeredScopeSet = new Set(offeredScopeIds);

  // Build the preset list, intersected with what the client offers. A preset is
  // only "available" when ALL of its scopes are offered — partially-offered
  // presets are greyed out (with a tooltip) so the user is never surprised that
  // a named preset granted less than its label implies. `effectiveScopes` is the
  // exact set a preset selects (already === its scopes when available).
  const presets = PRESETS.map((p) => {
    const effectiveScopes = p.scopes.filter((s) => offeredScopeSet.has(s));
    return {
      ...p,
      effectiveScopes,
      available: effectiveScopes.length === p.scopes.length && effectiveScopes.length > 0,
    };
  });

  // Pick the initial mode: prefer "standard" if fully available, else the first
  // available preset, else "custom". This determines the default selection.
  const defaultPreset =
    presets.find((p) => p.id === 'standard' && p.available) ??
    presets.find((p) => p.available) ??
    null;

  const [mode, setMode] = useState(defaultPreset ? defaultPreset.id : 'custom');

  // Track which scopes the user has toggled on/off. Initialised from the default
  // preset's scopes (or all offered scopes when no preset is available).
  const [enabledScopes, setEnabledScopes] = useState(() => {
    const initial = {};
    const initialOn = defaultPreset ? new Set(defaultPreset.effectiveScopes) : offeredScopeSet;
    for (const s of requestedScopes) {
      initial[s.scope] = initialOn.has(s.scope);
    }
    return initial;
  });

  // Whether the granular per-scope toggles are revealed. The Custom mode always
  // reveals them; presets keep them collapsed behind a "Customize" affordance.
  const [showCustom, setShowCustom] = useState(mode === 'custom');

  // Selecting a preset (or "custom") from the radiogroup.
  const selectPreset = (id) => {
    setMode(id);
    if (id === 'custom') {
      setShowCustom(true);
      return; // keep the user's current toggles
    }
    const preset = presets.find((p) => p.id === id);
    if (!preset || !preset.available) return;
    const on = new Set(preset.effectiveScopes);
    setEnabledScopes(() => {
      const next = {};
      for (const s of requestedScopes) next[s.scope] = on.has(s.scope);
      return next;
    });
  };

  // Toggling an individual scope flips the active mode to "custom" without
  // losing the user's edits.
  const toggleScope = (scope, value) => {
    setEnabledScopes((prev) => ({ ...prev, [scope]: value }));
    setMode('custom');
    setShowCustom(true);
  };

  // Inbox access mode. "All inboxes" (default) grants access to every inbox in
  // the workspace, including ones connected later — it is stored as
  // inbox_ids = null. "Specific inboxes" restricts access to an explicit list.
  const [allInboxes, setAllInboxes] = useState(true);

  // Track which inboxes the user wants to grant access to (specific mode only).
  // Default: all connected inboxes are checked; error/pending inboxes unchecked.
  const [grantedInboxes, setGrantedInboxes] = useState(() => {
    const initial = {};
    for (const ib of inboxes) {
      initial[ib.id] = ib.status === 'connected';
    }
    return initial;
  });

  const [keyLabel, setKeyLabel] = useState(
    `${client.client_name} · ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );

  const [step, setStep] = useState('review'); // review | granting | done | error
  const [errorMsg, setErrorMsg] = useState('');

  const selectedScopes = requestedScopes.filter((s) => enabledScopes[s.scope]);
  const selectedInboxIds = Object.entries(grantedInboxes)
    .filter(([, v]) => v)
    .map(([id]) => id);
  // In "all inboxes" mode the effective grant count is the whole workspace.
  const grantCount = allInboxes ? inboxes.length : selectedInboxIds.length;

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
          // null = all inboxes (including future ones); array = explicit allowlist.
          all_inboxes:      allInboxes,
          inbox_ids:        allInboxes ? null : selectedInboxIds,
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
      trackProductEvent('mcp_connection_authorized', {
        client: ['claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast', 'warp', 'curl'].includes(client.client_id) ? client.client_id : 'unknown',
        scope_profile: scopeProfile(selectedScopes.map((scope) => scope.scope)),
      });
      if (redirect_to) {
        window.location.href = redirect_to;
      } else {
        // Endpoint not yet implemented (task 15.2): show the done screen
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
          {t('authorize.backToDashboard')}
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
                <h1>{t('authorize.title', { clientName: client.client_name })}</h1>
                <div className="who">
                  {t.rich('authorize.who', {
                    clientName: client.client_name,
                    byline: client.client_byline ? ` · ${client.client_byline}` : '',
                    workspace: workspaceName || t('authorize.workspaceFallback'),
                    strong: (c) => <strong>{c}</strong>,
                  })}
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
                    {t('authorize.oauthClient')}
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
                      {t('authorize.preApproved')}
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
                      {t('authorize.accessLevelLabel')}
                    </div>

                    {/* Preset cards (radiogroup) */}
                    <PresetCards presets={presets} mode={mode} onSelect={selectPreset} />

                    {/* Customize affordance + granular per-scope toggles */}
                    <button
                      type="button"
                      className="az-customize-toggle"
                      aria-expanded={showCustom}
                      onClick={() => setShowCustom((v) => !v)}
                    >
                      <Icon name="chevron" size={14} className={showCustom ? 'az-chev-open' : 'az-chev'} />
                      {showCustom ? t('authorize.hideCustomize') : t('authorize.customize')}
                    </button>

                    {showCustom && (
                      <div className="az-perms" style={{ marginTop: 8 }}>
                        {requestedScopes.map((s) => (
                          <PermRow
                            key={s.scope}
                            icon={s.icon || 'key'}
                            title={s.title || s.scope}
                            desc={s.desc || ''}
                            enabled={enabledScopes[s.scope] ?? false}
                            onToggle={(v) => toggleScope(s.scope, v)}
                            required={s.required ?? false}
                            destructive={s.destructive ?? false}
                          />
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{
                    fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)',
                    padding: '12px 0', marginBottom: 8,
                  }}>
                    {t('authorize.noScopes')}
                  </div>
                )}

                {/* Inbox selection */}
                <div style={{
                  fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                  color: 'var(--fg-2)', marginBottom: 8,
                }}>
                  {t('authorize.inboxesLabel')}
                </div>

                {/* Access mode: all inboxes vs a specific allowlist */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                    border: '1px solid ' + (allInboxes ? 'var(--brand)' : 'var(--border-1)'),
                    background: allInboxes ? 'var(--cobalt-50)' : 'var(--bg-surface)',
                    borderRadius: 10, cursor: 'pointer', transition: 'all 120ms var(--ease-out)',
                  }}>
                    <input
                      type="radio"
                      name="az-inbox-mode"
                      checked={allInboxes}
                      onChange={() => setAllInboxes(true)}
                      style={{ marginTop: 2, accentColor: 'var(--brand)', flexShrink: 0 }}
                    />
                    <div>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
                        {t('authorize.allInboxes')}
                      </div>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: 1 }}>
                        {t('authorize.allInboxesDesc')}
                      </div>
                    </div>
                  </label>

                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                    border: '1px solid ' + (!allInboxes ? 'var(--brand)' : 'var(--border-1)'),
                    background: !allInboxes ? 'var(--cobalt-50)' : 'var(--bg-surface)',
                    borderRadius: 10, cursor: 'pointer', transition: 'all 120ms var(--ease-out)',
                  }}>
                    <input
                      type="radio"
                      name="az-inbox-mode"
                      checked={!allInboxes}
                      onChange={() => setAllInboxes(false)}
                      style={{ marginTop: 2, accentColor: 'var(--brand)', flexShrink: 0 }}
                    />
                    <div>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
                        {t('authorize.specificInboxes')}
                      </div>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: 1 }}>
                        {t('authorize.specificInboxesDesc')}
                      </div>
                    </div>
                  </label>
                </div>

                {/* Inbox checklist (specific mode only) */}
                {!allInboxes && (
                  inboxes.length > 0 ? (
                    <div
                      className="az-inbox-grid"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: inboxes.length === 1 ? '1fr' : '1fr 1fr',
                        gap: 8,
                        marginBottom: 18,
                      }}
                    >
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
                      {t('authorize.noInboxesPrefix')}
                      <a href="/dashboard/inboxes" style={{ color: 'var(--brand)' }}>
                        {t('authorize.connectInbox')}
                      </a>
                      {t('authorize.noInboxesSuffix')}
                    </div>
                  )
                )}

                {/* Connection name */}
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>{t('authorize.nameConnection')}</label>
                  <input
                    className="input"
                    value={keyLabel}
                    onChange={(e) => setKeyLabel(e.target.value)}
                  />
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {t('authorize.nameConnectionHint')}
                  </span>
                </div>
              </div>

              <div className="az-foot">
                <div className="grow">
                  {allInboxes ? (
                    t.rich('authorize.grantingAll', {
                      strong: (c) => <strong style={{ color: 'var(--fg-2)' }}>{c}</strong>,
                    })
                  ) : inboxes.length > 0 ? (
                    t.rich('authorize.grantingAccessTo', {
                      count: grantCount,
                      total: inboxes.length,
                      strong: (c) => <strong style={{ color: 'var(--fg-2)' }}>{c}</strong>,
                    })
                  ) : null}
                </div>
                <Btn variant="ghost" onClick={handleDeny}>{t('authorize.deny')}</Btn>
                <Btn
                  variant="primary"
                  icon="shield"
                  onClick={handleAllow}
                  disabled={(!allInboxes && grantCount === 0) || selectedScopes.length === 0}
                >
                  {t('authorize.allowAccess')}
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
                {t('authorize.issuingToken', { clientName: client.client_name })}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>
                {t('authorize.issuingTokenSub')}
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
              allInboxes={allInboxes}
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
                {t('authorize.failedTitle')}
              </h2>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', marginBottom: 24 }}>
                {errorMsg || t('authorize.failedGeneric')}
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <Btn variant="ghost" onClick={() => setStep('review')}>{t('authorize.tryAgain')}</Btn>
                <Btn variant="secondary" onClick={handleDeny}>{t('authorize.cancel')}</Btn>
              </div>
            </div>
          )}
        </div>

        <div className="auth-microcopy" style={{ marginTop: 20 }}>
          <Icon name="shield" size={13} color="var(--mint-600)" />
          {t('authorize.microcopy', { clientName: client.client_name })}
        </div>
      </div>
    </div>
  );
}
