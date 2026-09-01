import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { InviteAcceptUI } from './InviteAcceptUI';
import '../../../styles/marketing.css';
import '../../../styles/theme.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  await params;
  // Don't expose workspace name in the title before the user has been verified.
  return {
    title: 'Accept invite · MCP Emails',
    // Prevent invite pages from being indexed.
    robots: { index: false, follow: false },
  };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function ErrorCard({ title = 'Invite not found', message }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#f9fafb',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 16px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ marginBottom: 32 }}>
        <img src="/logo-wordmark.svg" alt="MCP Emails" style={{ height: 28, opacity: 0.9 }} />
      </div>
      <div style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 16,
        padding: '36px 40px 32px',
        maxWidth: 440,
        width: '100%',
        textAlign: 'center',
        boxShadow: '0 1px 4px rgba(0,0,0,.06)',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: '#fee2e2',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px',
          fontSize: 22,
        }}>
          ✕
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>
          {title}
        </div>
        <div style={{ fontSize: 14, color: '#64748b', lineHeight: 1.6, marginBottom: 28 }}>
          {message ?? 'This invite link has expired or is no longer valid.'}
        </div>
        <a
          href="/"
          style={{
            display: 'inline-block',
            padding: '10px 24px',
            background: '#0f172a',
            color: '#fff',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Go to homepage
        </a>
      </div>
    </div>
  );
}

export default async function InvitePage({ params }) {
  const { token: rawToken } = await params;

  if (!rawToken || typeof rawToken !== 'string') {
    return <ErrorCard />;
  }

  const tokenHash = hashToken(rawToken);
  const service = createServiceRoleClient();

  // Look up the invite. Service role bypasses RLS so unauthenticated visitors can still resolve it.
  const { data: invite } = await service
    .from('workspace_invites')
    .select('workspace_id, invited_by, email, role, expires_at')
    .eq('token_hash', tokenHash)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!invite) {
    return (
      <ErrorCard
        title="Invite not found"
        message="This invite link has expired, already been accepted, or doesn't exist. Ask the workspace owner to send a new invite."
      />
    );
  }

  // Fetch workspace and inviter in parallel.
  const [{ data: workspace }, { data: inviter }] = await Promise.all([
    service.from('workspaces').select('display_name, slug').eq('id', invite.workspace_id).single(),
    service.from('users').select('display_name, email').eq('id', invite.invited_by).single(),
  ]);

  // Check if there's a logged-in session.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <InviteAcceptUI
      token={rawToken}
      workspaceName={workspace?.display_name ?? 'the workspace'}
      inviterName={inviter?.display_name || inviter?.email || 'A teammate'}
      role={invite.role}
      expiresAt={invite.expires_at}
      isLoggedIn={!!user}
      userEmail={user?.email ?? null}
      inviteEmail={invite.email}
    />
  );
}
