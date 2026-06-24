'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useTweaks, TweakSection, TweakRadio, TweakToggle, TweaksPanel } from '../tweaks-panel';
import { Icon, Btn } from '../Primitives';
import { Sidebar, Topbar } from './Sidebar';
import { sectionToPath, pathSegmentToSection } from './routes';
import { OverviewPage, InboxesPage, KeysPage, UsagePage, SettingsPage, SecurityPage, MembersPage } from './Pages';
import { ConnectModal } from './ConnectModal';
import { CommandPalette } from './CommandPalette';
import { ToastProvider, useToast } from './Toast';

/* App.jsx: dashboard root. Owns state, route, modals.
   firstrun param auto-opens the connect modal.
   Tweaks: light/dark mode, density. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "density": "spacious"
}/*EDITMODE-END*/;

// SEED_INBOXES removed: inboxes are now fetched server-side and passed as props.

// SEED_KEYS removed: API keys are now fetched server-side and passed as props.

const SEED_ACTIVITY = [
  { tool: "email_read",     account: "work-gmail",   time: "just now", ok: true },
  { tool: "email_read",     account: "work-gmail",   time: "12s ago",  ok: true },
  { tool: "email_compose",  account: "personal",     time: "1m ago",   ok: true },
  { tool: "email_read",     account: "work-gmail",   time: "3m ago",   ok: true },
  { tool: "email_organize", account: "ops-fastmail", time: "8m ago",   ok: false },
  { tool: "email_compose",  account: "personal",     time: "14m ago",  ok: true },
];

function readQuery(searchParams, key) {
  return searchParams?.get(key) || null;
}

/**
 * DashboardApp: exported dashboard root.
 *
 * Wraps everything in <ToastProvider> so that any component in the tree
 * can call useToast() to show success/error/info/warning notifications.
 * DashboardInner contains the actual state and routing logic, separated
 * here so it can call useToast() after the provider has mounted.
 */
export function DashboardApp(props) {
  return (
    <ToastProvider>
      <DashboardInner {...props} />
    </ToastProvider>
  );
}

/**
 * DashboardInner: holds all dashboard state and routing logic.
 * Calls useToast() for user-facing feedback on all mutating actions.
 */
function DashboardInner({ initialRoute = 'overview', user, workspace: serverWorkspace, workspaces = [], activeWorkspaceId, canCreateWorkspace = false, mcpUrl, userRole, planLimits, stripePrices, overviewStats, activityFeed, inboxes: serverInboxes, apiKeys: serverApiKeys, usageData, auditLog, members: serverMembers, pendingInvites: serverPendingInvites }) {
  const searchParams = useSearchParams();
  const tr = useTranslations('dashboardChrome');
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const firstrun = readQuery(searchParams, "firstrun") === "1";
  const { toast } = useToast();

  // Initial section comes from the URL (resolved server-side by the catch-all
  // route); firstrun still forces the inboxes section for the connect flow.
  const [route, setRouteState] = useState(firstrun ? "inboxes" : initialRoute);
  // Mobile sidebar drawer state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Navigate to a section: update state, close the mobile drawer, and push the
  // matching URL so the section is deep-linkable and back/forward work. Browser
  // back/forward is handled by the popstate listener below (state-only, no push).
  const setRoute = (r) => {
    setRouteState(r);
    setSidebarOpen(false);
    try {
      const path = sectionToPath(r);
      if (window.location.pathname !== path) {
        window.history.pushState({ route: r }, '', path + window.location.search);
      }
    } catch { /* SSR / unsupported history: state still updates */ }
  };

  // Keep the active section in sync with browser back/forward navigation.
  useEffect(() => {
    const onPopState = () => {
      const segment = window.location.pathname.replace(/^\/dashboard\/?/, '').split('/')[0];
      const resolved = pathSegmentToSection(segment);
      setRouteState(resolved ?? 'overview');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  // Make workspace stateful so that a rename (PATCH /api/workspaces/[id])
  // is immediately reflected in the sidebar name + breadcrumb without a page reload.
  const [workspace, setWorkspace] = useState(serverWorkspace ?? null);

  // Initialise from server-fetched data; fallback to empty array so the
  // empty-state UI renders correctly on first run or when fetch fails.
  const [inboxes, setInboxes] = useState(serverInboxes ?? []);
  // Initialise from server-fetched API keys; empty array on first run or error.
  const [keys, setKeys] = useState(serverApiKeys ?? []);
  const [members, setMembers] = useState(serverMembers ?? []);
  const [pendingInvites, setPendingInvites] = useState(serverPendingInvites ?? []);
  const [showConnect, setShowConnect] = useState(false);
  // When set, the ConnectModal opens in reconnect mode for this existing inbox
  // (identity pre-filled and locked; only the password is re-entered).
  const [reconnectInbox, setReconnectInbox] = useState(null);
  const [showCommand, setShowCommand] = useState(false);

  // Global ⌘K / Ctrl+K opens the command palette from anywhere in the dashboard.
  // Escape also closes the mobile sidebar drawer when it is open.
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setShowCommand(v => !v);
        return;
      }
      if (e.key === 'Escape') {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.dark ? "dark" : "light");
    try { localStorage.setItem("mcpe-theme", t.dark ? "dark" : "light"); } catch(e) {}
  }, [t.dark]);

  // Read saved theme on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("mcpe-theme");
      if (saved === "dark" && !t.dark) setTweak("dark", true);
      if (saved === "light" && t.dark) setTweak("dark", false);
    } catch(e) {}
    // eslint-disable-next-line
  }, []);

  // Auto-open Connect modal on first run, with a brief welcome delay
  useEffect(() => {
    if (firstrun) {
      const id = setTimeout(() => setShowConnect(true), 400);
      return () => clearTimeout(id);
    }
  }, [firstrun]);

  // Handle ?connected=<provider> and ?error=<code> params injected by OAuth callbacks.
  useEffect(() => {
    const connectedParam = readQuery(searchParams, 'connected');
    const errorParam = readQuery(searchParams, 'error');

    if (connectedParam) {
      const label = connectedParam.charAt(0).toUpperCase() + connectedParam.slice(1);
      toast({ message: tr('app.connectedSuccess', { provider: label }), variant: 'success' });
      setRouteState('inboxes');
    } else if (errorParam === 'inbox_limit_reached') {
      const plan = workspace?.plan ?? 'free';
      const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
      toast({
        message: tr('app.inboxLimitReached', { plan: planLabel }),
        variant: 'warning',
      });
      setRouteState('inboxes');
    } else if (errorParam === 'token_exchange_failed') {
      toast({ message: tr('app.tokenExchangeFailed'), variant: 'error' });
      setRouteState('inboxes');
    } else if (errorParam === 'cancelled') {
      toast({ message: tr('app.connectionCancelled'), variant: 'info' });
      setRouteState('inboxes');
    } else if (errorParam) {
      toast({ message: tr('app.connectionFailed', { error: errorParam }), variant: 'error' });
      setRouteState('inboxes');
    }

    if (connectedParam || errorParam) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('connected');
        url.searchParams.delete('error');
        // Every branch above activates the inboxes section; reflect that in the
        // URL (OAuth callbacks land on the bare /dashboard) so a refresh stays.
        url.pathname = sectionToPath('inboxes');
        window.history.replaceState({}, '', url.toString());
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show success / cancelled toast when returning from Stripe Checkout.
  // Stripe appends ?checkout=success&plan=<planId> or ?checkout=cancelled to the URL.
  useEffect(() => {
    const checkoutParam = readQuery(searchParams, 'checkout');
    if (!checkoutParam) return;
    if (checkoutParam === 'success') {
      const planParam = readQuery(searchParams, 'plan');
      const planLabel = planParam ? planParam.charAt(0).toUpperCase() + planParam.slice(1) : tr('app.checkoutSuccessPlanFallback');
      toast({
        message: tr('app.checkoutSuccess', { plan: planLabel }),
        variant: 'success',
      });
    } else if (checkoutParam === 'cancelled') {
      toast({ message: tr('app.checkoutCancelled'), variant: 'info' });
    }
    // Clean up the query params from the URL without a reload.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      url.searchParams.delete('plan');
      window.history.replaceState({}, '', url.toString());
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show welcome toast when a user accepts an invite and lands on the dashboard.
  useEffect(() => {
    const joinedParam = readQuery(searchParams, 'joined');
    if (joinedParam === '1') {
      toast({ message: tr('app.joinedWorkspace'), variant: 'success' });
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('joined');
        window.history.replaceState({}, '', url.toString());
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Density
  useEffect(() => {
    document.documentElement.setAttribute("data-density", t.density);
  }, [t.density]);

  const counts = { inboxes: inboxes.length, keys: keys.length, members: members.length };

  /**
   * Disconnects an inbox by calling DELETE /api/inboxes/[id].
   *
   * The handler revokes the OAuth token with the provider, clears all
   * credential columns, and soft-deletes the row. This function returns a
   * Promise so the InboxesPage confirmation dialog can await it and stay open
   * on error, giving the user a chance to retry.
   *
   * On success: removes the inbox from local state and shows a success toast.
   * On failure: shows an error toast and re-throws so the dialog stays open.
   */
  const onRemoveInbox = async (id) => {
    try {
      const res = await fetch(`/api/inboxes/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        let message = tr('app.inboxDisconnectFailed');
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore JSON parse failure */ }
        toast({ message, variant: 'error' });
        throw new Error(message);
      }
      setInboxes(xs => xs.filter(x => x.id !== id));
      toast({ message: tr('app.inboxDisconnected'), variant: 'info' });
    } catch (err) {
      // Re-throw so the confirmation dialog knows to stay open.
      throw err;
    }
  };

  /**
   * Checks whether an inbox's stored credentials still work by calling
   * POST /api/inboxes/[id]/check. The server refreshes/validates OAuth tokens
   * (or performs an IMAP login for app-password inboxes) and returns the
   * resulting status. We update local state to reflect the new status unless
   * the check was inconclusive (transient network/provider error).
   */
  const onCheckInbox = async (inbox) => {
    let data = {};
    try {
      const res = await fetch(`/api/inboxes/${inbox.id}/check`, { method: 'POST' });
      try { data = await res.json(); } catch { /* ignore JSON parse failure */ }
      if (!res.ok) {
        toast({ message: data?.error || data?.message || tr('app.connectionCheckFailed'), variant: 'error' });
        return;
      }
    } catch {
      toast({ message: tr('app.connectionCheckFailedRetry'), variant: 'error' });
      return;
    }
    // Reflect the server-confirmed status locally, unless the check could not
    // reach the provider (transient), in which case we leave the row as-is.
    if (!data.transient && data.status) {
      setInboxes(xs => xs.map(x => (
        x.id === inbox.id ? { ...x, status: data.status, lastError: data.lastError ?? null } : x
      )));
    }
    toast({
      message: data.message || (data.ok ? tr('app.connectionHealthy') : tr('app.connectionCheckFailed')),
      variant: data.ok ? 'success' : 'error',
    });
  };

  /**
   * Saves a per-inbox signature via PATCH /api/inboxes/[id] (Phase 3). Returns
   * a Promise so the editor can show in-flight/error state and stay open on
   * failure. On success: merges the server-confirmed signature fields into local
   * state (so the modal reflects source = 'manual' and the saved values) and
   * shows a success toast. On failure: shows an error toast and re-throws.
   */
  const onSaveSignature = async (id, patch) => {
    let data = {};
    try {
      const res = await fetch(`/api/inboxes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      try { data = await res.json(); } catch { /* ignore JSON parse failure */ }
      if (!res.ok) {
        const message = typeof data?.error === 'string' ? data.error : tr('app.signatureSaveFailed');
        toast({ message, variant: 'error' });
        throw new Error(message);
      }
    } catch (err) {
      if (err instanceof Error && err.message) throw err;
      const message = tr('app.signatureSaveFailed');
      toast({ message, variant: 'error' });
      throw new Error(message);
    }
    const sig = data.signature ?? {};
    setInboxes(xs => xs.map(x => (
      x.id === id
        ? {
            ...x,
            signatureText: sig.signature_text ?? null,
            signatureHtml: sig.signature_html ?? null,
            signatureEnabled: sig.signature_enabled ?? true,
            signatureReplyMode: sig.signature_reply_mode ?? 'first_only',
            signatureSource: sig.signature_source ?? 'manual',
          }
        : x
    )));
    toast({ message: tr('app.signatureSaved'), variant: 'success' });
  };

  /**
   * Restarts the OAuth (or app-password) flow for an errored inbox.
   *
   * For OAuth inboxes: navigate to the provider's server-side initiation
   * route. The callback handler upserts the existing row so the inbox ID
   * and audit history are preserved.
   *
   * For Fastmail app-password inboxes (hasImap === true): navigate to the
   * standalone app-password form which submits to POST /api/inboxes/fastmail-app-password.
   */
  const onReconnectInbox = (inbox) => {
    const oauthRoutes = {
      gmail: '/auth/gmail',
      outlook: '/auth/outlook',
    };
    if (inbox.hasImap) {
      // Re-open the SAME connect form this inbox was created with, pre-filled and
      // identity-locked. Previously this navigated EVERY IMAP inbox to the
      // Fastmail app-password page regardless of its real provider/host, which
      // both showed the wrong form and left an empty login field for the browser
      // to autofill with another account's saved login (the wrong-mailbox bug).
      setReconnectInbox(inbox);
      setShowConnect(true);
    } else {
      window.location.href = oauthRoutes[inbox.provider] ?? '/auth/gmail';
    }
  };

  /**
   * Soft-deletes (revokes) an API key via PATCH /api/workspaces/api-keys/[id]/revoke.
   * Removes the key from local state immediately (optimistic) and shows a toast.
   * If the server call fails, the key is restored and an error toast is shown.
   */
  const onRevokeKey = async (id) => {
    // Optimistic: remove from list immediately.
    const previous = keys;
    setKeys(xs => xs.filter(x => x.id !== id));
    try {
      const res = await fetch(`/api/api-keys/${id}/revoke`, { method: 'PATCH' });
      if (!res.ok) {
        let message = tr('app.apiKeyRevokeFailed');
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore JSON parse failure */ }
        setKeys(previous);
        toast({ message, variant: 'error' });
        // Re-throw so the confirmation dialog knows to stay open.
        throw new Error(message);
      }
      toast({ message: tr('app.apiKeyRevoked'), variant: 'info' });
    } catch (err) {
      // Only restore + toast for network-level failures; API failures already
      // handled above (key already restored, toast already shown).
      if (err instanceof TypeError) {
        // TypeError = network failure (fetch itself threw)
        setKeys(previous);
        toast({ message: tr('app.apiKeyRevokeFailed'), variant: 'error' });
      }
      // Re-throw so the confirmation dialog knows to stay open.
      throw err;
    }
  };

  /**
   * Updates an existing key's scopes and inbox access via PATCH /api/api-keys/[id].
   *
   * Called by KeysPage > EditConnectionModal on save. `inboxIds` is null for
   * "all inboxes" or a non-empty array of inbox ids for an explicit allowlist.
   * On success the row is updated in local state so the change is reflected
   * immediately without a reload. Throws on API error so the modal can surface
   * an inline message.
   */
  const onUpdateKey = async (id, { scopes, inboxIds }) => {
    const res = await fetch(`/api/api-keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes, inboxIds }),
    });
    if (!res.ok) {
      let message = tr('app.apiKeyUpdateFailed');
      try {
        const data = await res.json();
        if (typeof data?.error === 'string') message = data.error;
      } catch { /* ignore JSON parse failure */ }
      throw new Error(message);
    }
    const updated = await res.json(); // { id, scopes, inboxIds, ... }
    setKeys(xs => xs.map(x => (x.id === id ? { ...x, scopes: updated.scopes, inboxIds: updated.inboxIds } : x)));
    toast({ message: tr('app.apiKeyUpdated'), variant: 'success' });
  };

  const onConnect = ({ label, provider, address }) => {
    // Optimistic update: the real row will appear on next page load via router.refresh().
    const next = { id: String(Date.now()), label, address: address || label, provider, status: "active", calls: 0 };
    // On a reconnect the row already exists — update it in place (clear the error,
    // mark active) instead of appending a duplicate. Match on the address.
    setInboxes(xs => {
      const idx = xs.findIndex(x => x.address && address && x.address.toLowerCase() === address.toLowerCase());
      if (idx !== -1) {
        const copy = xs.slice();
        copy[idx] = { ...copy[idx], status: "active", lastError: null };
        return copy;
      }
      return [...xs, next];
    });
    setReconnectInbox(null);
    setShowConnect(false);
    toast({ message: tr('app.inboxConnectedSuccess', { label }), variant: 'success' });
    if (firstrun) {
      // After first inbox, nudge them to keys
      setTimeout(() => setRoute("keys"), 1200);
    }
  };

  /**
   * Creates a new API key via POST /api/api-keys.
   *
   * Called by KeysPage > CreateKeyModal on submit. Returns the full response
   * object including rawKey (which is included in the response exactly once).
   * The KeysPage shows the rawKey in the KeyRevealModal and calls onKeyCreated
   * after the user acknowledges.
   *
   * Throws on API error so CreateKeyModal can surface an inline error message.
   */
  const onCreateKey = async (name, scopes) => {
    const res = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scopes, workspaceId: workspace.id }),
    });
    if (!res.ok) {
      let message = tr('app.apiKeyCreateFailed');
      try {
        const data = await res.json();
        if (typeof data?.error === 'string') message = data.error;
      } catch { /* ignore JSON parse failure */ }
      throw new Error(message);
    }
    return res.json(); // { id, name, keyPrefix, scopes, createdAt, lastUsedAt, expiresAt, rawKey }
  };

  /**
   * Called by KeysPage after the user acknowledges the key reveal modal.
   * Adds the new key row (without rawKey) to local state and shows a toast.
   */
  const onKeyCreated = (keyRow) => {
    setKeys(xs => [keyRow, ...xs]);
    toast({
      message: tr('app.apiKeyCreated'),
      variant: 'success',
    });
  };

  /** Send a workspace invite via POST /api/workspaces/invite. */
  const onInviteMember = async (email, role) => {
    const res = await fetch('/api/workspaces/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id, email, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? tr('app.inviteSendFailed'));
    // Optimistically add to pending invites list. Normalize to the same shape
    // the server loader returns ({ id, ... }); the POST response names the id
    // `inviteId`, and MembersPage / onCancelInvite key off `id`.
    setPendingInvites(xs => [{
      id:        data.inviteId,
      email:     data.email,
      role:      data.role,
      expiresAt: data.expiresAt,
      createdAt: data.createdAt,
    }, ...xs]);
    toast({ message: tr('app.inviteSent', { email }), variant: 'success' });
  };

  /** Cancel a pending invite via DELETE /api/workspaces/invite/[token]. */
  const onCancelInvite = async (inviteId) => {
    // We don't have the raw token client-side, so call a dedicated cancel-by-id endpoint.
    // Use the invite's id as the "token" placeholder; the route accepts workspaceId for auth.
    // For now, optimistically remove and call the token endpoint isn't available without the token.
    // Instead POST to a cancel-by-id route pattern, handled by deleting via invite id.
    const res = await fetch(`/api/workspaces/invite-cancel/${inviteId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast({ message: data.error ?? tr('app.inviteCancelFailed'), variant: 'error' });
      return;
    }
    setPendingInvites(xs => xs.filter(x => x.id !== inviteId));
    toast({ message: tr('app.inviteCancelled'), variant: 'info' });
  };

  /** Remove a member via DELETE /api/workspaces/members/[userId]. */
  const onRemoveMember = async (userId) => {
    const res = await fetch(
      `/api/workspaces/members/${userId}?workspaceId=${encodeURIComponent(workspace.id)}`,
      { method: 'DELETE' },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? tr('app.memberRemoveFailed'));
    setMembers(xs => xs.filter(x => x.userId !== userId));
    toast({ message: tr('app.memberRemoved'), variant: 'info' });
  };

  /** Change a member's role via PATCH /api/workspaces/members/[userId]. */
  const onChangeRole = async (userId, role) => {
    const res = await fetch(`/api/workspaces/members/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id, role }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? tr('app.roleUpdateFailed'));
    setMembers(xs => xs.map(x => x.userId === userId ? { ...x, role } : x));
    toast({ message: tr('app.roleUpdated'), variant: 'success' });
  };

  return (
    <div className="shell" data-screen-label={"Dashboard / " + route}>
      <Sidebar
        route={route}
        setRoute={setRoute}
        counts={counts}
        user={user}
        workspace={workspace}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        canCreateWorkspace={canCreateWorkspace}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main-col">
        <Topbar route={route} workspace={workspace} mcpUrl={mcpUrl} onMenuOpen={() => setSidebarOpen(true)} onOpenSearch={() => setShowCommand(true)} sidebarOpen={sidebarOpen} />

        {firstrun && inboxes.length === 0 && route === "inboxes" && !showConnect && (
          <FirstRunBanner onConnect={() => setShowConnect(true)} />
        )}

        {route === "overview" && <OverviewPage inboxes={inboxes} activity={activityFeed ?? SEED_ACTIVITY} stats={overviewStats} usageData={usageData} planLimits={planLimits} plan={workspace?.plan ?? 'free'} mcpUrl={mcpUrl} memberCount={members.length} onConnect={() => setShowConnect(true)} onGoToKeys={() => setRoute("keys")} onGoToMembers={() => setRoute("members")} />}
        {route === "inboxes"  && <InboxesPage  inboxes={inboxes} planLimits={planLimits} onConnect={() => setShowConnect(true)} onRemove={onRemoveInbox} onReconnect={onReconnectInbox} onCheck={onCheckInbox} onSaveSignature={onSaveSignature} />}
        {route === "keys"     && <KeysPage     keys={keys} inboxes={inboxes} mcpUrl={mcpUrl} onCreate={onCreateKey} onKeyCreated={onKeyCreated} onRevoke={onRevokeKey} onUpdate={onUpdateKey} />}
        {route === "members"  && <MembersPage  members={members} pendingInvites={pendingInvites} planLimits={planLimits} userRole={userRole} currentUserId={user?.id} onInvite={onInviteMember} onCancelInvite={onCancelInvite} onRemove={onRemoveMember} onChangeRole={onChangeRole} />}
        {route === "usage"    && <UsagePage usageData={usageData} planLimits={planLimits} onConnect={() => setShowConnect(true)} onGoToKeys={() => setRoute("keys")} />}
        {route === "settings" && <SettingsPage user={user} workspace={workspace} workspaces={workspaces} userRole={userRole} stripePrices={stripePrices} onWorkspaceUpdate={setWorkspace} />}
        {route === "security" && <SecurityPage auditLog={auditLog} />}
      </div>

      {showConnect && <ConnectModal reconnect={reconnectInbox} onClose={() => { setShowConnect(false); setReconnectInbox(null); }} onConnect={onConnect} atInboxLimit={reconnectInbox == null && planLimits != null && planLimits.maxInboxes != null && inboxes.length >= planLimits.maxInboxes} plan={workspace?.plan ?? 'free'} />}

      <CommandPalette
        open={showCommand}
        onClose={() => setShowCommand(false)}
        setRoute={setRoute}
        onConnect={() => setShowConnect(true)}
        inboxes={inboxes}
        members={members}
        keys={keys}
      />

      <TweaksPanel>
        <TweakSection label={tr('app.themeLabel')}/>
        <TweakToggle  label={tr('app.darkModeLabel')} value={t.dark} onChange={v => setTweak("dark", v)}/>
        <TweakSection label={tr('app.layoutLabel')}/>
        <TweakRadio   label={tr('app.densityLabel')} value={t.density}
                      options={[{value:"compact", label:tr('app.densityCompact')},{value:"spacious", label:tr('app.densitySpacious')}]}
                      onChange={v => setTweak("density", v)}/>
      </TweaksPanel>
    </div>
  );
}

function FirstRunBanner({ onConnect }) {
  const tr = useTranslations('dashboardChrome');
  return (
    <div style={{ padding: "16px 32px 0" }}>
      <div style={{
        background: "linear-gradient(180deg, var(--cobalt-50) 0%, transparent 100%)",
        border: "1px solid rgba(37,71,229,0.18)", borderRadius: 12, padding: "20px 24px",
        display: "flex", alignItems: "center", gap: 16,
      }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--brand)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="mail" size={20} color="#fff"/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>{tr('app.firstRunTitle')}</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--fg-2)", marginTop: 2 }}>
            {tr('app.firstRunBody')}
          </div>
        </div>
        <Btn variant="primary" icon="plus" onClick={onConnect}>{tr('app.firstRunCta')}</Btn>
      </div>
    </div>
  );
}
