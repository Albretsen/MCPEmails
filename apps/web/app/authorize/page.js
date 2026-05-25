import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AuthorizeApp } from '../../components/auth/AuthorizeApp';
import '../../styles/marketing.css';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Authorize · MCP Emails',
  description: 'Authorize an agent to access your inboxes',
};

/**
 * The set of scopes this server recognises. Anything outside this list is
 * silently dropped — unknown scopes are never presented to the user.
 */
const VALID_SCOPES = new Set([
  'read:email',
  'search:email',
  'send:email',
  'manage:drafts',
  'manage:folders',
]);

/**
 * Human-readable metadata for each valid scope, shown in the consent UI.
 */
const SCOPE_META = {
  'read:email': {
    icon: 'inbox',
    title: 'Read your inbox',
    desc: 'list_inbox, read_email, get_attachment. Scoped to the inboxes you select.',
    required: false,
  },
  'search:email': {
    icon: 'search',
    title: 'Search your emails',
    desc: 'search_email. Run queries across your messages and return matching snippets.',
    required: false,
  },
  'send:email': {
    icon: 'mail',
    title: 'Send email on your behalf',
    desc: 'send_email, reply_to_email, forward_email. Sent through your own provider — never via our domain.',
    required: false,
  },
  'manage:drafts': {
    icon: 'edit',
    title: 'Manage drafts',
    desc: 'create_draft, update_draft, delete_draft. Create and edit unsent messages.',
    required: false,
  },
  'manage:folders': {
    icon: 'folder',
    title: 'Manage folders',
    desc: 'create_folder, move_email, delete_email. Organise your mailbox structure.',
    required: false,
  },
};

/**
 * /authorize — OAuth 2.0 authorization page for MCP clients.
 *
 * Server Component responsibilities:
 *  1. Validate the required `client_id` query param against the
 *     `oauth_clients` table. Show an error page if not found.
 *  2. Validate `redirect_uri` against the client's registered URIs.
 *  3. Filter the requested `scope` param to only recognised, allowed scopes.
 *  4. Require the user to be authenticated. If not, redirect to /login
 *     with all original params preserved so they return after sign-in.
 *  5. Fetch the user's workspace and all active inboxes from Supabase.
 *  6. Pass fully validated, real data to AuthorizeApp (the interactive
 *     client component that renders the consent UI).
 *
 * The actual approve action (generating an auth code and redirecting to
 * redirect_uri) is implemented in the next task (15.2).
 */
export default async function AuthorizePage({ searchParams }) {
  const params = await searchParams;

  const clientId      = params.client_id       ?? '';
  const redirectUri   = params.redirect_uri     ?? '';
  const rawScope      = params.scope            ?? '';
  const state         = params.state            ?? '';
  const codeChallenge = params.code_challenge   ?? '';
  const challengeMethod = params.code_challenge_method ?? 'S256';

  // ── 1. Validate client_id is present ───────────────────────────────────
  if (!clientId) {
    return <ErrorPage title="Missing client_id" message="The authorization request did not include a client_id parameter." />;
  }

  // ── 2. Look up the client in the database ──────────────────────────────
  // oauth_clients has a public-read RLS policy so the anon key can read it.
  const supabase = await createClient();

  const { data: oauthClient, error: clientError } = await supabase
    .from('oauth_clients')
    .select('client_id, client_name, client_byline, redirect_uris, scopes_allowed, logo_url, is_first_party')
    .eq('client_id', clientId)
    .single();

  if (clientError || !oauthClient) {
    return (
      <ErrorPage
        title="Unknown application"
        message={`No registered application found for client_id "${clientId}". If you reached this page from an app, contact that app's developer.`}
      />
    );
  }

  // ── 3. Validate redirect_uri ───────────────────────────────────────────
  // Must be an exact string match against one of the registered URIs.
  // If redirect_uri is omitted and only one is registered, use it.
  let resolvedRedirectUri = redirectUri;
  if (!resolvedRedirectUri) {
    if (oauthClient.redirect_uris.length === 1) {
      resolvedRedirectUri = oauthClient.redirect_uris[0];
    } else {
      return (
        <ErrorPage
          title="Missing redirect_uri"
          message="The authorization request did not include a redirect_uri, and this client has more than one registered URI."
        />
      );
    }
  }

  if (!oauthClient.redirect_uris.includes(resolvedRedirectUri)) {
    // Do NOT redirect to the supplied URI — it may be malicious.
    return (
      <ErrorPage
        title="Invalid redirect_uri"
        message="The redirect_uri in this request does not match any URI registered for this application. This request has been blocked to protect your account."
      />
    );
  }

  // ── 4. Filter requested scopes ─────────────────────────────────────────
  // Split on space or comma (clients may use either), drop unrecognised
  // scopes and scopes the client is not permitted to request.
  const requestedScopes = rawScope
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((s) => VALID_SCOPES.has(s) && oauthClient.scopes_allowed.includes(s));

  // ── 5. Require authentication ──────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Preserve all original query params so the user lands back here after login.
    const loginUrl = new URL('/login', process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000');
    loginUrl.searchParams.set('redirect', buildAuthorizeUrl(params));
    redirect(loginUrl.pathname + '?' + loginUrl.searchParams.toString());
  }

  // ── 6. Fetch workspace and active inboxes ──────────────────────────────
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, display_name, slug')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

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

  // Annotate scopes with their display metadata before passing to the client.
  const scopesWithMeta = requestedScopes.map((scope) => ({
    scope,
    ...(SCOPE_META[scope] ?? {
      icon: 'key',
      title: scope,
      desc: '',
      required: false,
    }),
  }));

  return (
    <AuthorizeApp
      client={{
        client_id:     oauthClient.client_id,
        client_name:   oauthClient.client_name,
        client_byline: oauthClient.client_byline,
        logo_url:      oauthClient.logo_url,
        is_first_party: oauthClient.is_first_party,
      }}
      workspaceName={workspace?.display_name ?? ''}
      requestedScopes={scopesWithMeta}
      inboxes={inboxes}
      redirectUri={resolvedRedirectUri}
      oauthState={state}
      codeChallenge={codeChallenge}
      challengeMethod={challengeMethod}
    />
  );
}

/**
 * Reconstructs the /authorize URL with the original query params so the
 * login page can redirect back to it after a successful sign-in.
 */
function buildAuthorizeUrl(params) {
  const qs = new URLSearchParams();
  const knownKeys = ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'];
  for (const key of knownKeys) {
    if (params[key]) qs.set(key, params[key]);
  }
  return '/authorize?' + qs.toString();
}

/**
 * Inline error page rendered when the authorization request is structurally
 * invalid (unknown client, bad redirect_uri, etc.).
 *
 * We do NOT redirect to redirect_uri for these errors because the URI itself
 * may be the source of the attack (redirect URI manipulation).
 */
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
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontSize: 20, fontWeight: 700,
            color: 'var(--fg-1)', marginBottom: 10,
          }}>
            {title}
          </h1>
          <p style={{
            fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-3)',
            lineHeight: 1.6, marginBottom: 28, maxWidth: 380, margin: '0 auto 28px',
          }}>
            {message}
          </p>
          <a href="/dashboard" style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500,
            color: 'var(--brand)', textDecoration: 'none',
          }}>
            ← Return to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
