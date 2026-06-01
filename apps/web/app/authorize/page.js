import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { issueCsrfToken } from '@/lib/oauth/csrf';
import { storeStateNonce } from '@/lib/oauth/state';
import { isValidRedirectUri } from '@/lib/oauth/redirect-uri';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { AuthorizeApp } from '../../components/auth/AuthorizeApp';
import '../../styles/marketing.css';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Authorize · MCP Emails',
  description: 'Authorize an agent to access your inboxes',
};

const VALID_SCOPES = new Set([
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
]);

const SCOPE_META = {
  'read:email':      { icon: 'inbox',  title: 'Read your inbox',           desc: 'list_inboxes, list_inbox, read_email, search_emails.', required: false },
  'search:email':    { icon: 'search', title: 'Search your emails',        desc: 'search_emails across your messages.', required: false },
  'send:email':      { icon: 'mail',   title: 'Send email on your behalf',  desc: 'send_email, reply_to_email, forward_email.', required: false },
  'manage:folders':  { icon: 'menu',   title: 'Manage folders & labels',    desc: 'create/rename/delete folders, move and copy messages.', required: false },
  'delete:email':    { icon: 'trash',  title: 'Delete emails',              desc: 'delete and bulk-delete messages.', required: false },
  'manage:drafts':   { icon: 'copy',   title: 'Manage drafts',              desc: 'create, update, list and delete drafts.', required: false },
  'manage:contacts': { icon: 'users',  title: 'Manage contacts',            desc: 'list and look up address-book contacts.', required: false },
  'schedule:email':  { icon: 'bell',   title: 'Schedule emails',            desc: 'schedule sends and manage scheduled messages.', required: false },
};

export default async function AuthorizePage({ searchParams }) {
  const params = await searchParams;

  const clientId        = params.client_id             ?? '';
  const redirectUri     = params.redirect_uri           ?? '';
  const rawScope        = params.scope                  ?? '';
  const state           = params.state                  ?? '';
  const codeChallenge   = params.code_challenge         ?? '';
  const challengeMethod = params.code_challenge_method  ?? '';

  // ── 1. Validate client_id is present ─────────────────────────────────────
  if (!clientId) {
    return <ErrorPage title="Missing client_id" message="The authorization request did not include a client_id parameter." />;
  }

  // ── 2. Reject non-S256 PKCE immediately ──────────────────────────────────
  if (!codeChallenge) {
    return <ErrorPage title="Missing code_challenge" message="PKCE is required. Include a code_challenge parameter." />;
  }
  if (challengeMethod && challengeMethod !== 'S256') {
    return <ErrorPage title="Unsupported PKCE method" message="Only code_challenge_method=S256 is supported. The plain method is rejected." />;
  }

  // ── 3. Look up client (including deactivated_at check) ───────────────────
  const supabase = await createClient();
  const { data: oauthClient, error: clientError } = await supabase
    .from('oauth_clients')
    .select('client_id, client_name, client_byline, redirect_uris, scopes_allowed, logo_url, is_first_party, deactivated_at')
    .eq('client_id', clientId)
    .single();

  if (clientError || !oauthClient) {
    return <ErrorPage title="Unknown application" message={`No registered application found for client_id "${clientId}".`} />;
  }

  if (oauthClient.deactivated_at) {
    return <ErrorPage title="Application deactivated" message="This application has been deactivated and can no longer request authorization." />;
  }

  // ── 4. Validate redirect_uri ──────────────────────────────────────────────
  let resolvedRedirectUri = redirectUri;
  if (!resolvedRedirectUri) {
    if (oauthClient.redirect_uris.length === 1) {
      resolvedRedirectUri = oauthClient.redirect_uris[0];
    } else {
      return <ErrorPage title="Missing redirect_uri" message="redirect_uri is required when the client has multiple registered URIs." />;
    }
  }

  if (!oauthClient.redirect_uris.includes(resolvedRedirectUri)) {
    return <ErrorPage title="Invalid redirect_uri" message="The redirect_uri does not match any URI registered for this application." />;
  }

  // SSRF guard: only for http/https URIs (custom schemes are safe)
  const looksLikeHttp = resolvedRedirectUri.startsWith('http://') || resolvedRedirectUri.startsWith('https://');
  if (looksLikeHttp) {
    const safe = await isValidRedirectUri(resolvedRedirectUri);
    if (!safe) {
      return <ErrorPage title="Invalid redirect_uri" message="The redirect_uri resolves to a disallowed host." />;
    }
  }

  // ── 5. Filter requested scopes ────────────────────────────────────────────
  const requestedScopes = rawScope
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((s) => VALID_SCOPES.has(s) && oauthClient.scopes_allowed.includes(s));

  // ── 6. Require authentication ─────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const qs = new URLSearchParams();
    ['client_id','redirect_uri','scope','state','code_challenge','code_challenge_method'].forEach(k => {
      if (params[k]) qs.set(k, params[k]);
    });
    redirect(`/login?redirect=/authorize?${qs.toString()}`);
  }

  // ── 7. Fetch the active workspace and its inboxes ─────────────────────────
  //    Match the workspace the consent POST will mint the key for.
  const activeWorkspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  const { data: workspace } = activeWorkspaceId
    ? await supabase
        .from('workspaces')
        .select('id, display_name, slug')
        .eq('id', activeWorkspaceId)
        .is('deleted_at', null)
        .maybeSingle()
    : { data: null };

  let inboxes = [];
  if (workspace) {
    const { data: inboxRows } = await supabase
      .from('inboxes')
      .select('id, email_address, display_name, provider, status')
      .eq('workspace_id', workspace.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    inboxes = inboxRows ?? [];
  }

  // ── 8. Store state nonce server-side ──────────────────────────────────────
  if (state) {
    await storeStateNonce(user.id, state);
  }

  // ── 9. Check if all requested scopes are already consented ──────────────
  // Never auto-redirect from a GET. Always render the consent UI so the user
  // has an explicit chance to review and confirm each authorization.
  let preApproved = false;
  if (requestedScopes.length > 0 && workspace) {
    const { data: consent } = await supabase
      .from('oauth_consents')
      .select('scopes')
      .eq('user_id', user.id)
      .eq('client_id', clientId)
      .maybeSingle();

    preApproved = !!(consent && requestedScopes.every((s) => consent.scopes.includes(s)));
  }

  // ── 10. Issue CSRF token for the consent form ─────────────────────────────
  const csrfToken = await issueCsrfToken(user.id);

  // ── 11. Render consent UI ─────────────────────────────────────────────────
  const scopesWithMeta = requestedScopes.map((scope) => ({
    scope,
    ...(SCOPE_META[scope] ?? { icon: 'key', title: scope, desc: '', required: false }),
  }));

  return (
    <AuthorizeApp
      client={{
        client_id:      oauthClient.client_id,
        client_name:    oauthClient.client_name,
        client_byline:  oauthClient.client_byline,
        logo_url:       oauthClient.logo_url,
        is_first_party: oauthClient.is_first_party,
      }}
      workspaceName={workspace?.display_name ?? ''}
      requestedScopes={scopesWithMeta}
      inboxes={inboxes}
      redirectUri={resolvedRedirectUri}
      oauthState={state}
      codeChallenge={codeChallenge}
      challengeMethod={challengeMethod || 'S256'}
      csrfToken={csrfToken}
      preApproved={preApproved}
    />
  );
}

function ErrorPage({ title, message }) {
  return (
    <div className="auth-shell">
      <div className="az-wrap">
        <div className="az-card" style={{ padding: '40px 32px', textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: 'var(--red-100, #fee2e2)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 20,
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                 stroke="var(--red-600, #dc2626)" strokeWidth="2.2"
                 strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 20, fontWeight: 700, color: 'var(--fg-1)', marginBottom: 10 }}>
            {title}
          </h1>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)', lineHeight: 1.6, marginBottom: 28, maxWidth: 380, margin: '0 auto 28px' }}>
            {message}
          </p>
          <a href="/dashboard" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500, color: 'var(--brand)', textDecoration: 'none' }}>
            ← Return to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
