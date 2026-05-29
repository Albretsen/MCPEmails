'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * InviteAcceptUI: client component for the /invite/[token] accept page.
 *
 * Handles three states:
 *  - Not logged in: show sign-in / sign-up links.
 *  - Logged in: Accept button that calls POST /api/workspaces/invite/[token]/accept.
 *  - After accept: redirect to /dashboard?joined=1.
 */

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function InviteAcceptUI({
  token,
  workspaceName,
  inviterName,
  role,
  expiresAt,
  isLoggedIn,
  userEmail,
  inviteEmail,
}) {
  const router = useRouter();
  const t = useTranslations('auth');
  const [accepting, setAccepting] = useState(false);
  const [error, setError]         = useState(null);

  const ROLE_LABELS = {
    admin:  t('invite.roleAdmin'),
    member: t('invite.roleMember'),
    viewer: t('invite.roleViewer'),
  };
  const roleLabel = ROLE_LABELS[role] ?? role;
  const emailMismatch = isLoggedIn && userEmail && inviteEmail &&
    userEmail.toLowerCase() !== inviteEmail.toLowerCase();

  async function handleAccept() {
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/invite/${token}/accept`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? t('invite.errorAccept'));
        return;
      }
      router.push('/dashboard?joined=1');
    } catch {
      setError(t('invite.errorNetwork'));
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-page, #f9fafb)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 16px',
      fontFamily: 'var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
    }}>
      {/* Logo */}
      <div style={{ marginBottom: 32 }}>
        <img src="/logo-wordmark.svg" alt="MCP Emails" style={{ height: 28, opacity: 0.9 }} />
      </div>

      {/* Card */}
      <div style={{
        background: 'var(--bg-card, #ffffff)',
        border: '1px solid var(--border-1, #e2e8f0)',
        borderRadius: 16,
        padding: '36px 40px 32px',
        maxWidth: 440,
        width: '100%',
        boxShadow: '0 1px 4px rgba(0,0,0,.06)',
      }}>
        {/* Workspace icon */}
        <div style={{
          width: 48, height: 48,
          borderRadius: 12,
          background: 'var(--brand-soft, #eef1fd)',
          border: '1px solid rgba(37,71,229,.14)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
          fontSize: 22,
        }}>
          ✉
        </div>

        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg-1, #0f172a)', letterSpacing: '-0.3px', marginBottom: 8 }}>
          {t('invite.heading')}
        </div>

        <div style={{ fontSize: 14, color: 'var(--fg-2, #475569)', lineHeight: 1.6, marginBottom: 28 }}>
          {t.rich('invite.body', {
            inviter: inviterName,
            workspace: workspaceName,
            role: roleLabel,
            strong: (c) => <strong style={{ color: 'var(--fg-1, #0f172a)' }}>{c}</strong>,
            role_tag: (c) => (
              <span style={{
                display: 'inline-block',
                padding: '1px 8px',
                borderRadius: 20,
                background: 'var(--brand-soft, #eef1fd)',
                color: 'var(--brand, #2547e5)',
                fontSize: 12,
                fontWeight: 600,
              }}>
                {c}
              </span>
            ),
          })}
        </div>

        {/* Email mismatch warning */}
        {emailMismatch && (
          <div style={{
            background: 'var(--amber-50, #fffbeb)',
            border: '1px solid var(--amber-200, #fde68a)',
            borderRadius: 10,
            padding: '12px 16px',
            fontSize: 13,
            color: 'var(--amber-800, #92400e)',
            marginBottom: 20,
            lineHeight: 1.5,
          }}>
            {t.rich('invite.emailMismatch', {
              inviteEmail: maskEmail(inviteEmail),
              userEmail,
              strong: (c) => <strong>{c}</strong>,
            })}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div style={{
            background: 'var(--red-50, #fef2f2)',
            border: '1px solid var(--red-200, #fecaca)',
            borderRadius: 10,
            padding: '12px 16px',
            fontSize: 13,
            color: 'var(--red-700, #b91c1c)',
            marginBottom: 20,
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* CTA area */}
        {isLoggedIn ? (
          <button
            onClick={handleAccept}
            disabled={accepting || emailMismatch}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%',
              padding: '11px 20px',
              background: (accepting || emailMismatch) ? 'var(--bg-subtle, #e2e8f0)' : 'var(--brand, #2547e5)',
              color: (accepting || emailMismatch) ? 'var(--fg-3, #94a3b8)' : '#fff',
              border: 'none',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              cursor: (accepting || emailMismatch) ? 'not-allowed' : 'pointer',
              transition: 'background 120ms',
              fontFamily: 'inherit',
            }}
          >
            {accepting ? t('invite.joining') : t('invite.acceptInvitation')}
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <a
              href={`/signup?redirect=/invite/${token}`}
              style={{
                display: 'block', textAlign: 'center',
                padding: '11px 20px',
                background: 'var(--brand, #2547e5)',
                color: '#fff',
                borderRadius: 10,
                fontSize: 14, fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {t('invite.createAccount')}
            </a>
            <a
              href={`/login?redirect=/invite/${token}`}
              style={{
                display: 'block', textAlign: 'center',
                padding: '11px 20px',
                background: 'var(--bg-card, #fff)',
                color: 'var(--fg-1, #0f172a)',
                border: '1px solid var(--border-1, #e2e8f0)',
                borderRadius: 10,
                fontSize: 14, fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {t('invite.signInToAccept')}
            </a>
          </div>
        )}

        {/* Expiry notice */}
        {expiresAt && (
          <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: 'var(--fg-3, #94a3b8)' }}>
            {t('invite.expires', {
              date: new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
            })}
          </div>
        )}
      </div>
    </div>
  );
}
