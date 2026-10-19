'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Btn, Icon } from '../Primitives';
import { useToast } from './Toast';

/**
 * SAML single sign-on settings, on the Security page.
 *
 * Shown only to an owner or admin, and only when GET /api/sso answers (the
 * route also checks the enterprise plan; any 401/403 renders nothing, so other
 * plans never see the section). Everything it shows and changes goes through
 * app/api/sso/**; the browser never holds the Supabase provider id or any
 * token.
 *
 * Order follows the setup: our values for Entra, Entra's metadata URL back to
 * us, domains proven by DNS, then test and require.
 */

const ROW_LABEL = {
  fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600,
  color: 'var(--fg-3)', marginBottom: 6, letterSpacing: '0.01em',
};
const STEP_TITLE = { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600, color: 'var(--fg-1)', margin: 0 };
const HINT = { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', margin: '4px 0 0' };
const ERROR_LINE = { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--red-700)', margin: '8px 0 0' };

function CopyRow({ label, value }) {
  const t = useTranslations('dashboard');
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <div>
      {label ? <div style={ROW_LABEL}>{label}</div> : null}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--bg-inverse)', borderRadius: 10, padding: '0 8px 0 14px', minHeight: 40,
      }}>
        <code style={{
          fontFamily: 'var(--font-mono)', fontSize: 12.5, color: '#E6EAFB',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {value}
        </code>
        <button
          type="button"
          data-sso-copy={value}
          onClick={copy}
          title={copied ? t('copy.copied') : t('copy.copy')}
          aria-label={copied ? t('copy.copied') : t('copy.copyAria')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={15} color={copied ? 'var(--mint-500)' : 'rgba(230,234,251,0.55)'} />
        </button>
      </div>
    </div>
  );
}

/** Calls an /api/sso route. Returns { ok, status, data }. */
async function callSso(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

const KNOWN_ERRORS = new Set([
  'invalid_metadata_url', 'metadata_rejected', 'management_not_configured', 'management_unavailable',
  'invalid_domain', 'consumer_domain', 'domain_exists', 'domain_limit', 'domain_taken',
  'dns_record_missing', 'dns_lookup_failed', 'rate_limited', 'no_provider',
  'enforce_needs_active', 'enforce_needs_verified_domain', 'enforce_needs_test_sign_in',
]);

const AUDIT_ACTIONS = new Set([
  'connection.created', 'connection.metadata_updated', 'connection.default_role_changed',
  'connection.enforced', 'connection.enforcement_removed', 'connection.disabled', 'connection.enabled',
  'domain.added', 'domain.removed', 'domain.verified',
]);

export function SsoSettingsSection({ userRole }) {
  const t = useTranslations('dashboard');
  const { toast } = useToast();
  const mayManage = userRole === 'owner' || userRole === 'admin';

  // undefined = loading, null = hidden (not allowed / not entitled)
  const [state, setState] = useState(undefined);
  const [loadErr, setLoadErr] = useState(false);
  const [metadataUrl, setMetadataUrl] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [busy, setBusy] = useState(null);
  const [inlineErr, setInlineErr] = useState({});

  const errorText = (data) => {
    const code = data?.error_code;
    return KNOWN_ERRORS.has(code) ? t(`sso.errors.${code}`) : t('sso.errors.generic');
  };

  const load = async () => {
    setLoadErr(false);
    try {
      const res = await callSso('/api/sso', 'GET');
      if (res.status === 401 || res.status === 403) { setState(null); return; }
      if (!res.ok) { setLoadErr(true); return; }
      setState(res.data);
    } catch {
      setLoadErr(true);
    }
  };

  // Loads once for an owner/admin; the fetch sets state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (mayManage) load(); }, [mayManage]);

  if (!mayManage || state === null) return null;

  const run = async (key, path, method, body, onOk) => {
    if (busy) return;
    setBusy(key);
    setInlineErr((prev) => ({ ...prev, [key]: null }));
    try {
      const res = await callSso(path, method, body);
      if (!res.ok) {
        setInlineErr((prev) => ({ ...prev, [key]: errorText(res.data) }));
        return;
      }
      onOk?.(res.data);
      await load();
    } catch {
      setInlineErr((prev) => ({ ...prev, [key]: t('security.networkError') }));
    } finally {
      setBusy(null);
    }
  };

  const header = (
    <div className="card-h">
      <div>
        <div className="title">{t('sso.title')}</div>
        <div className="sub">{t('sso.sub')}</div>
      </div>
      {state?.connection ? (
        <div style={{ marginLeft: 'auto' }}>
          {state.connection.enforced
            ? <Badge tone="brand">{t('sso.statusRequired')}</Badge>
            : state.connection.status === 'active'
              ? <Badge tone="live">{t('sso.statusActive')}</Badge>
              : state.connection.status === 'disabled'
                ? <Badge tone="neutral">{t('sso.statusDisabled')}</Badge>
                : <Badge tone="neutral">{t('sso.statusDraft')}</Badge>}
        </div>
      ) : null}
    </div>
  );

  if (state === undefined) {
    return (
      <div className="card" style={{ marginTop: 14 }}>
        {header}
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {loadErr ? (
            <>
              <span style={{ ...ERROR_LINE, margin: 0 }}>{t('sso.errors.load')}</span>
              <Btn variant="secondary" size="sm" onClick={load}>{t('security.retry')}</Btn>
            </>
          ) : (
            <span style={{ ...HINT, margin: 0 }}>{t('sso.loading')}</span>
          )}
        </div>
      </div>
    );
  }

  const { saml, connection, domains = [], testSignInSeen, events = [], managementConfigured } = state;
  const hasVerifiedDomain = domains.some((d) => d.verified);
  const canEnforce = connection?.status === 'active' && hasVerifiedDomain && testSignInSeen;

  return (
    <div className="card" style={{ marginTop: 14 }} data-sso-section="">
      {header}
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {!managementConfigured ? <p role="alert" style={ERROR_LINE}>{t('sso.notAvailable')}</p> : null}

        {/* 1. Our values, for the Entra Enterprise application */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <h4 style={STEP_TITLE}>{t('sso.step1Title')}</h4>
            <p style={HINT}>{t('sso.step1Hint')}</p>
          </div>
          {saml ? (
            <>
              <CopyRow label={t('sso.entityId')} value={saml.entityId} />
              <CopyRow label={t('sso.acsUrl')} value={saml.acsUrl} />
              <CopyRow label={t('sso.metadataUrl')} value={saml.metadataUrl} />
            </>
          ) : null}
        </section>

        {/* 2. Entra's federation metadata URL */}
        <section>
          <h4 style={STEP_TITLE}>{t('sso.step2Title')}</h4>
          <p style={HINT}>
            {connection?.hasProvider ? t('sso.step2Connected') : t('sso.step2Hint')}
          </p>
          <form
            style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              run('metadata', '/api/sso/connection', 'PUT', { metadataUrl }, () => {
                setMetadataUrl('');
                toast({ message: t('sso.metadataSaved'), variant: 'success' });
              });
            }}
          >
            <input
              className="input"
              type="url"
              name="sso-metadata-url"
              value={metadataUrl}
              onChange={(e) => setMetadataUrl(e.target.value)}
              placeholder="https://login.microsoftonline.com/.../federationmetadata.xml?appid=..."
              aria-label={t('sso.metadataInputLabel')}
              style={{ flex: '1 1 320px', minWidth: 0 }}
              disabled={!managementConfigured || busy === 'metadata'}
            />
            <Btn type="submit" variant="primary" size="md" busy={busy === 'metadata'} disabled={!managementConfigured || !metadataUrl.trim()}>
              {connection?.hasProvider ? t('sso.metadataUpdate') : t('sso.metadataSave')}
            </Btn>
          </form>
          {inlineErr.metadata ? <p role="alert" style={ERROR_LINE}>{inlineErr.metadata}</p> : null}
        </section>

        {/* 3. Domains, proven by a DNS TXT record */}
        <section>
          <h4 style={STEP_TITLE}>{t('sso.step3Title')}</h4>
          <p style={HINT}>{t('sso.step3Hint')}</p>
          <form
            style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              run('addDomain', '/api/sso/domains', 'POST', { domain: newDomain }, () => setNewDomain(''));
            }}
          >
            <input
              className="input"
              type="text"
              name="sso-domain"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="example.com"
              aria-label={t('sso.domainInputLabel')}
              style={{ flex: '1 1 220px', minWidth: 0 }}
              disabled={busy === 'addDomain'}
            />
            <Btn type="submit" variant="secondary" size="md" busy={busy === 'addDomain'} disabled={!newDomain.trim()}>
              {t('sso.domainAdd')}
            </Btn>
          </form>
          {inlineErr.addDomain ? <p role="alert" style={ERROR_LINE}>{inlineErr.addDomain}</p> : null}

          {domains.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {domains.map((d) => (
                <li key={d.id} data-sso-domain={d.domain} style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-1)' }}>{d.domain}</span>
                    {d.verified
                      ? <Badge tone="live">{t('sso.domainVerified')}</Badge>
                      : <Badge tone="amber">{t('sso.domainPending')}</Badge>}
                    <div style={{ flex: 1 }} />
                    {!d.verified ? (
                      <Btn
                        variant="secondary"
                        size="sm"
                        busy={busy === `verify:${d.id}`}
                        onClick={() => run(`verify:${d.id}`, `/api/sso/domains/${d.id}/verify`, 'POST', undefined, () =>
                          toast({ message: t('sso.domainVerifiedToast', { domain: d.domain }), variant: 'success' }))}
                      >
                        {t('sso.checkNow')}
                      </Btn>
                    ) : null}
                    <Btn
                      variant="ghost"
                      size="sm"
                      busy={busy === `remove:${d.id}`}
                      onClick={() => run(`remove:${d.id}`, `/api/sso/domains/${d.id}`, 'DELETE')}
                    >
                      {t('sso.domainRemove')}
                    </Btn>
                  </div>
                  {!d.verified ? (
                    <div style={{ marginTop: 10 }}>
                      <CopyRow label={t('sso.txtRecordLabel', { domain: d.domain })} value={d.txtRecord} />
                    </div>
                  ) : null}
                  {inlineErr[`verify:${d.id}`] ? <p role="alert" style={ERROR_LINE}>{inlineErr[`verify:${d.id}`]}</p> : null}
                  {inlineErr[`remove:${d.id}`] ? <p role="alert" style={ERROR_LINE}>{inlineErr[`remove:${d.id}`]}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* 4. Test, default role, require, turn off */}
        {connection?.hasProvider ? (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <h4 style={STEP_TITLE}>{t('sso.step4Title')}</h4>
              <p style={HINT}>{testSignInSeen ? t('sso.testSeen') : t('sso.testHint')}</p>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
              {t('sso.defaultRole')}
              <select
                className="input"
                name="sso-default-role"
                value={connection.defaultRole}
                disabled={!!busy}
                onChange={(e) => run('role', '/api/sso/connection', 'PATCH', { defaultRole: e.target.value })}
                style={{ height: 32, padding: '0 28px 0 8px', width: 'auto' }}
              >
                <option value="member">{t('sso.roleMember')}</option>
                <option value="viewer">{t('sso.roleViewer')}</option>
              </select>
            </label>
            {inlineErr.role ? <p role="alert" style={ERROR_LINE}>{inlineErr.role}</p> : null}

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
              <input
                type="checkbox"
                name="sso-enforced"
                checked={connection.enforced}
                disabled={!!busy || (!connection.enforced && !canEnforce)}
                onChange={(e) => run('enforce', '/api/sso/connection', 'PATCH', { enforced: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                {t('sso.enforceLabel')}
                <span style={{ display: 'block', color: 'var(--fg-3)' }}>
                  {connection.enforced || canEnforce ? t('sso.enforceHint') : t('sso.enforceLocked')}
                </span>
              </span>
            </label>
            {inlineErr.enforce ? <p role="alert" style={ERROR_LINE}>{inlineErr.enforce}</p> : null}

            <div>
              {connection.status === 'disabled' ? (
                <Btn variant="secondary" size="sm" busy={busy === 'enabled'} onClick={() => run('enabled', '/api/sso/connection', 'PATCH', { enabled: true })}>
                  {t('sso.enable')}
                </Btn>
              ) : (
                <Btn variant="danger" size="sm" busy={busy === 'enabled'} onClick={() => run('enabled', '/api/sso/connection', 'PATCH', { enabled: false })}>
                  {t('sso.disable')}
                </Btn>
              )}
              {inlineErr.enabled ? <p role="alert" style={ERROR_LINE}>{inlineErr.enabled}</p> : null}
            </div>
          </section>
        ) : null}

        {/* Audit trail of SSO changes */}
        {events.length > 0 ? (
          <section>
            <h4 style={STEP_TITLE}>{t('sso.historyTitle')}</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {events.filter((e) => AUDIT_ACTIONS.has(e.action)).map((e) => (
                <li key={e.id} style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                  {t(`sso.audit.${e.action.replace('.', '_')}`, { domain: String(e.details?.domain ?? '') })}
                  <span style={{ color: 'var(--fg-3)' }}>
                    {' · '}{e.actorEmail ?? t('sso.auditUnknownActor')}{' · '}{new Date(e.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default SsoSettingsSection;
