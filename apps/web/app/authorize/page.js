import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { issueCsrfToken } from '@/lib/oauth/csrf';
import { storeStateNonce } from '@/lib/oauth/state';
import { isValidRedirectUri } from '@/lib/oauth/redirect-uri';
import { validateResourceIndicator } from '@/lib/oauth/resource';
import { looksLikeUrlClientId, redirectUriAllowed, resolveCimdClient } from '@/lib/oauth/cimd';
import { checkRateLimit } from '@/lib/rate-limit';
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
  'manage:automations',
]);

// The `desc` strings name the tools `tools/list` actually advertises, because a
// consent screen that names a tool the client never shows is unverifiable: the
// human is asked to trust a list they cannot check against their own client.
// Kept in sync with TOOL_REGISTRY in supabase/functions/mcp-server/index.ts.
// Scope assignments did not change when the read/write split shipped
// (2026-09-09), only the tool names the actions live under.
const SCOPE_META = {
  'read:email':      { icon: 'inbox',  title: 'Read your inbox',           desc: 'inbox_list, email_read (list/read/search), folder_list, signature_get.', required: false, destructive: false },
  'search:email':    { icon: 'search', title: 'Search your emails',        desc: 'email_read with action search (advanced search across your messages).', required: false, destructive: false },
  // email_organize's flag and archive actions are manage:folders, not
  // send:email. They were remapped in the 2026-07-28 scope bugfix and this
  // line still claimed them for two months afterwards. What send:email really
  // grants is mail leaving the mailbox, plus the From-line identity that
  // signature_set writes.
  'send:email':      { icon: 'mail',   title: 'Send email on your behalf',  desc: 'email_compose (send/reply/forward), draft (send), signature_set.', required: false, destructive: false },
  'manage:folders':  { icon: 'menu',   title: 'Manage folders & labels',    desc: 'folder (create/rename/delete), email_organize (move, copy, flag, archive), email_search_and_move.', required: false, destructive: false },
  'delete:email':    { icon: 'trash',  title: 'Delete emails',              desc: 'email_delete (delete and bulk-delete messages).', required: false, destructive: true },
  'manage:drafts':   { icon: 'copy',   title: 'Manage drafts',              desc: 'draft_list, draft (create/reply/update/delete). Sending a draft also needs send:email.', required: false, destructive: false },
  'manage:contacts': { icon: 'users',  title: 'Manage contacts',            desc: 'contact_search (find people via a live scan of your mail; nothing stored).', required: false, destructive: false },
  'schedule:email':  { icon: 'bell',   title: 'Schedule emails',            desc: 'schedule_list, schedule (create/cancel).', required: false, destructive: false },
  // Not marked destructive: an automation can never delete mail, and the two
  // actions that leave the mailbox (forward, draft_reply) are approval-gated or
  // produce a draft. It is still a standing, unattended capability rather than
  // a one-off call, which is what the description has to make plain.
  'manage:automations': { icon: 'zap', title: 'Run scheduled automations', desc: 'automation_read (list/get/runs/preview), automation (create/update/enable/disable/delete): rules that sort mail on a schedule with nobody watching. Never deletes; forwarding needs approval.', required: false, destructive: false },
};

export default async function AuthorizePage({ searchParams }) {
  const params = await searchParams;

  const clientId        = params.client_id             ?? '';
  const redirectUri     = params.redirect_uri           ?? '';
  const rawScope        = params.scope                  ?? '';
  const state           = params.state                  ?? '';
  const codeChallenge   = params.code_challenge         ?? '';
  const challengeMethod = params.code_challenge_method  ?? '';
  const rawResource     = params.resource               ?? '';

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

  // ── 2b. RFC 8707 resource indicator ──────────────────────────────────────
  // Optional (older MCP clients omit it), but when present it must name the
  // one resource this server issues tokens for. The OAuth error is
  // `invalid_target`; rendered inline like every other request error here,
  // since we never redirect an error to a redirect_uri we have not validated.
  const resourceCheck = validateResourceIndicator(rawResource);
  if (!resourceCheck.ok) {
    return <ErrorPage title="Invalid resource (invalid_target)" message={resourceCheck.description} />;
  }
  const resource = resourceCheck.resource;

  // ── 3. Resolve the client ────────────────────────────────────────────────
  // There are two ways to be a client here, and the client_id itself says
  // which:
  //
  //   claude-desktop, dyn_…   a row in oauth_clients, put there by a seed
  //                           migration or by RFC 7591 dynamic registration.
  //   https://…               a Client ID Metadata Document: the URL
  //                           dereferences to the client's own OAuth metadata,
  //                           so there is no registration call and no row.
  //
  // Both produce the same client shape, so everything below this block, and
  // the consent component itself, is unaware of which one it is rendering. The
  // one place the difference must NOT be forgotten is the redirect_uri check
  // in section 4: a CIMD document is held to its own matching rule.
  //
  // For CIMD the client_name below is the HOST of the client_id URL, never the
  // document's self-asserted client_name. See lib/oauth/cimd.ts for why that
  // substitution is the security control and not a cosmetic choice.
  const supabase = await createClient();
  const isCimd = looksLikeUrlClientId(clientId);

  let oauthClient;

  if (isCimd) {
    // This is an unauthenticated GET and the URL is the requester's to choose,
    // so the outbound fetch is rate limited per IP on top of the in-process
    // document cache and the SSRF guard inside resolveCimdClient.
    const requestHeaders = await headers();
    const requestIp = requestHeaders.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
    if (await checkRateLimit(`oauth:cimd:${requestIp}`, 30, 600_000)) {
      return <ErrorPage title="Too many requests" message="Too many client metadata lookups from this address. Wait a few minutes and try again." />;
    }

    const resolved = await resolveCimdClient(clientId);
    if (!resolved.ok) {
      return <ErrorPage title="Client metadata could not be verified" message={resolved.message} />;
    }
    oauthClient = resolved.value;

    // A CIMD client has no row of its own, so the only way to stop one is an
    // oauth_clients row inserted by hand for exactly that URL with
    // deactivated_at set. Nothing else on such a row is read: the document
    // still supplies the redirect_uris and the host still supplies the name.
    const { data: blocked } = await supabase
      .from('oauth_clients')
      .select('deactivated_at')
      .eq('client_id', oauthClient.client_id)
      .not('deactivated_at', 'is', null)
      .maybeSingle();

    if (blocked) {
      return <ErrorPage title="Application deactivated" message="This application has been deactivated and can no longer request authorization." />;
    }
  } else {
    const { data: registered, error: clientError } = await supabase
      .from('oauth_clients')
      .select('client_id, client_name, client_byline, redirect_uris, scopes_allowed, logo_url, is_first_party, deactivated_at')
      .eq('client_id', clientId)
      .single();

    if (clientError || !registered) {
      return <ErrorPage title="Unknown application" message={`No registered application found for client_id "${clientId}".`} />;
    }

    if (registered.deactivated_at) {
      return <ErrorPage title="Application deactivated" message="This application has been deactivated and can no longer request authorization." />;
    }

    oauthClient = registered;
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

  if (isCimd) {
    // Same origin as the client_id URL, or a loopback URI compared with the
    // PORT IGNORED (RFC 8252 §7.3). A plain `includes` would be wrong in both
    // directions here: it would refuse every native client, which binds an
    // ephemeral port its document cannot name in advance, and it would not
    // enforce the same-origin rule the document's own entries are held to.
    if (!redirectUriAllowed(oauthClient.client_id, oauthClient.redirect_uris, resolvedRedirectUri)) {
      return <ErrorPage title="Invalid redirect_uri" message="The redirect_uri is not listed in the client ID metadata document, or is not on the same origin as the client_id." />;
    }
    // No isValidRedirectUri here on purpose. redirectUriAllowed has already
    // narrowed a CIMD redirect to loopback or to the client_id's own origin,
    // and that origin was resolved and checked against the SSRF range tables
    // before the document was fetched. Running the older guard as well would
    // wrongly refuse http://[::1]/…, which the connector docs name explicitly
    // as a native-client redirect.
  } else {
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
  }

  // ── 5. Resolve the selectable scope menu ──────────────────────────────────
  // Offer EVERY scope the client is permitted to use (its scopes_allowed, in our
  // canonical VALID_SCOPES order) so the user can choose what to grant — not just
  // whatever the client put in the `scope` param. Many MCP clients (especially
  // dynamically-registered ones) send no `scope` at all; without this they'd land
  // on a read-only default with nothing to select.
  const offeredScopes = [...VALID_SCOPES].filter((s) =>
    oauthClient.scopes_allowed.includes(s),
  );
  // Scopes the client explicitly asked for, narrowed to what it may hold. This
  // does NOT restrict what the user may select (the whole menu above stays
  // selectable); it decides which card the screen OPENS on, and it feeds the
  // "previously approved" hint below.
  //
  // Since 2026-09-09 the challenge in app/api/mcp/route.ts asks for
  // `read:email` alone rather than all nine scopes, so this is now a real
  // signal for the clients that send one: claude.ai's authorize request arrives
  // as `scope=read:email`, verified on the wire. The default-selection rule is
  // in lib/oauth/consent-presets.ts, which also explains why a request with no
  // `scope` param at all keeps the older, wider default.
  const clientRequestedScopes = rawScope
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((s) => offeredScopes.includes(s));

  // ── 6. Require authentication ─────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const qs = new URLSearchParams();
    ['client_id','redirect_uri','scope','state','code_challenge','code_challenge_method','resource'].forEach(k => {
      if (params[k]) qs.set(k, params[k]);
    });
    // Encode the whole return path as ONE value. Without this, the nested query
    // string (redirect_uri, scope, state, code_challenge…) leaks into /login's
    // own params and `redirect` truncates at the first `&`, so the user returns
    // to /authorize missing code_challenge etc. and the OAuth flow dies with a
    // "Missing code_challenge" error. This is the common path for a logged-out
    // user connecting a client (Cursor/VS Code/Glama) before they have a session.
    const returnTo = `/authorize?${qs.toString()}`;
    redirect(`/login?redirect=${encodeURIComponent(returnTo)}`);
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
  if (clientRequestedScopes.length > 0 && workspace) {
    const { data: consent } = await supabase
      .from('oauth_consents')
      .select('scopes')
      .eq('user_id', user.id)
      // oauthClient.client_id, not the raw param: a CIMD client_id is stored
      // in its normalised form, so a request that spells the same URL slightly
      // differently must still find the consent it already granted.
      .eq('client_id', oauthClient.client_id)
      .maybeSingle();

    preApproved = !!(consent && clientRequestedScopes.every((s) => consent.scopes.includes(s)));
  }

  // ── 10. Issue CSRF token for the consent form ─────────────────────────────
  const csrfToken = await issueCsrfToken(user.id);

  // ── 11. Render consent UI ─────────────────────────────────────────────────
  const scopesWithMeta = offeredScopes.map((scope) => ({
    scope,
    ...(SCOPE_META[scope] ?? { icon: 'key', title: scope, desc: '', required: false, destructive: false }),
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
      clientRequestedScopes={clientRequestedScopes}
      inboxes={inboxes}
      redirectUri={resolvedRedirectUri}
      oauthState={state}
      codeChallenge={codeChallenge}
      challengeMethod={challengeMethod || 'S256'}
      resource={resource}
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
