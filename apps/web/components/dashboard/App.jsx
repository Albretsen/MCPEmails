'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTweaks, TweakSection, TweakRadio, TweakToggle, TweaksPanel } from '../tweaks-panel';
import { Icon, Btn } from '../Primitives';
import { Sidebar, Topbar } from './Sidebar';
import { OverviewPage, InboxesPage, KeysPage, UsagePage, SettingsPage, SecurityPage } from './Pages';
import { ConnectModal } from './ConnectModal';
import { ToastProvider, useToast } from './Toast';

/* App.jsx — dashboard root. Owns state, route, modals.
   New: firstrun param auto-opens connect modal.
   Tweaks: light/dark mode, density. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "density": "spacious"
}/*EDITMODE-END*/;

// SEED_INBOXES removed — inboxes are now fetched server-side and passed as props.

// SEED_KEYS removed — API keys are now fetched server-side and passed as props.

const SEED_ACTIVITY = [
  { tool: "list_inbox",     account: "work-gmail",   time: "just now", ok: true },
  { tool: "read_email",     account: "work-gmail",   time: "12s ago",  ok: true },
  { tool: "send_email",     account: "personal",     time: "1m ago",   ok: true },
  { tool: "search_emails",  account: "work-gmail",   time: "3m ago",   ok: true },
  { tool: "list_inbox",     account: "ops-fastmail", time: "8m ago",   ok: false },
  { tool: "reply_to_email", account: "personal",     time: "14m ago",  ok: true },
];

function readQuery(searchParams, key) {
  return searchParams?.get(key) || null;
}

/**
 * DashboardApp — exported dashboard root.
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
 * DashboardInner — holds all dashboard state and routing logic.
 * Calls useToast() for user-facing feedback on all mutating actions.
 */
function DashboardInner({ user, workspace, planLimits, overviewStats, activityFeed, inboxes: serverInboxes, apiKeys: serverApiKeys, usageData, auditLog }) {
  const searchParams = useSearchParams();
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const firstrun = readQuery(searchParams, "firstrun") === "1";
  const { toast } = useToast();

  const [route, setRouteState] = useState(firstrun ? "inboxes" : "overview");
  // Mobile sidebar drawer state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Wrap setRoute so we also close the mobile drawer on navigation
  const setRoute = (r) => {
    setRouteState(r);
    setSidebarOpen(false);
  };
  // Initialise from server-fetched data; fallback to empty array so the
  // empty-state UI renders correctly on first run or when fetch fails.
  const [inboxes, setInboxes] = useState(serverInboxes ?? []);
  // Initialise from server-fetched API keys; empty array on first run or error.
  const [keys, setKeys] = useState(serverApiKeys ?? []);
  const [showConnect, setShowConnect] = useState(false);

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
      toast({ message: `${label} inbox connected successfully.`, variant: 'success' });
      setRouteState('inboxes');
    } else if (errorParam === 'inbox_limit_reached') {
      const plan = workspace?.plan ?? 'free';
      const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
      toast({
        message: `Your ${planLabel} plan inbox limit has been reached. Upgrade at mcpemails.com/pricing to connect more.`,
        variant: 'warning',
      });
      setRouteState('inboxes');
    } else if (errorParam === 'token_exchange_failed') {
      toast({ message: 'Could not connect inbox — token exchange with the provider failed. Please try again.', variant: 'error' });
      setRouteState('inboxes');
    } else if (errorParam === 'cancelled') {
      toast({ message: 'Inbox connection cancelled.', variant: 'info' });
      setRouteState('inboxes');
    } else if (errorParam) {
      toast({ message: `Inbox connection failed (${errorParam}). Please try again.`, variant: 'error' });
      setRouteState('inboxes');
    }

    if (connectedParam || errorParam) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('connected');
        url.searchParams.delete('error');
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
      const planLabel = planParam ? planParam.charAt(0).toUpperCase() + planParam.slice(1) : 'Pro';
      toast({
        message: `Welcome to ${planLabel}! Your subscription is being activated — this may take a moment.`,
        variant: 'success',
      });
    } else if (checkoutParam === 'cancelled') {
      toast({ message: 'Checkout cancelled. You can upgrade any time from Settings.', variant: 'info' });
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

  // Density
  useEffect(() => {
    document.documentElement.setAttribute("data-density", t.density);
  }, [t.density]);

  const counts = { inboxes: inboxes.length, keys: keys.length };

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
        let message = 'Failed to disconnect inbox.';
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore JSON parse failure */ }
        toast({ message, variant: 'error' });
        throw new Error(message);
      }
      setInboxes(xs => xs.filter(x => x.id !== id));
      toast({ message: 'Inbox disconnected.', variant: 'info' });
    } catch (err) {
      // Re-throw so the confirmation dialog knows to stay open.
      throw err;
    }
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
      fastmail: '/auth/fastmail',
    };
    if (inbox.hasImap) {
      window.location.href = '/auth/fastmail/app-password';
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
        let message = 'Failed to revoke API key.';
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore JSON parse failure */ }
        setKeys(previous);
        toast({ message, variant: 'error' });
        // Re-throw so the confirmation dialog knows to stay open.
        throw new Error(message);
      }
      toast({ message: 'API key revoked.', variant: 'info' });
    } catch (err) {
      // Only restore + toast for network-level failures; API failures already
      // handled above (key already restored, toast already shown).
      if (err instanceof TypeError) {
        // TypeError = network failure (fetch itself threw)
        setKeys(previous);
        toast({ message: 'Failed to revoke API key.', variant: 'error' });
      }
      // Re-throw so the confirmation dialog knows to stay open.
      throw err;
    }
  };

  const onConnect = ({ label, provider, address }) => {
    // Optimistic update — the real row will appear on next page load via router.refresh().
    const next = { id: String(Date.now()), label, address: address || (label + "@example.com"), provider, status: "active", calls: 0 };
    setInboxes(xs => [...xs, next]);
    setShowConnect(false);
    toast({ message: `${label} connected successfully.`, variant: 'success' });
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
      body: JSON.stringify({ name, scopes }),
    });
    if (!res.ok) {
      let message = 'Failed to create API key.';
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
      message: 'API key created. Copy it now — it won\'t be shown again.',
      variant: 'success',
    });
  };

  return (
    <div className="shell" data-screen-label={"Dashboard / " + route}>
      <Sidebar
        route={route}
        setRoute={setRoute}
        counts={counts}
        user={user}
        workspace={workspace}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main-col">
        <Topbar route={route} workspace={workspace} onMenuOpen={() => setSidebarOpen(true)} />

        {firstrun && inboxes.length === 0 && route === "inboxes" && !showConnect && (
          <FirstRunBanner onConnect={() => setShowConnect(true)} />
        )}

        {route === "overview" && <OverviewPage inboxes={inboxes} activity={activityFeed ?? SEED_ACTIVITY} stats={overviewStats} planLimits={planLimits} onConnect={() => setShowConnect(true)} onGoToKeys={() => setRoute("keys")} />}
        {route === "inboxes"  && <InboxesPage  inboxes={inboxes} planLimits={planLimits} onConnect={() => setShowConnect(true)} onRemove={onRemoveInbox} onReconnect={onReconnectInbox} />}
        {route === "keys"     && <KeysPage     keys={keys} onCreate={onCreateKey} onKeyCreated={onKeyCreated} onRevoke={onRevokeKey} />}
        {route === "usage"    && <UsagePage usageData={usageData} planLimits={planLimits} onConnect={() => setShowConnect(true)} onGoToKeys={() => setRoute("keys")} />}
        {route === "settings" && <SettingsPage user={user} workspace={workspace} />}
        {route === "security" && <SecurityPage auditLog={auditLog} />}
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} onConnect={onConnect} atInboxLimit={planLimits != null && planLimits.maxInboxes != null && inboxes.length >= planLimits.maxInboxes} plan={workspace?.plan ?? 'free'} />}

      <TweaksPanel>
        <TweakSection label="Theme"/>
        <TweakToggle  label="Dark mode" value={t.dark} onChange={v => setTweak("dark", v)}/>
        <TweakSection label="Layout"/>
        <TweakRadio   label="Density" value={t.density}
                      options={[{value:"compact", label:"Compact"},{value:"spacious", label:"Spacious"}]}
                      onChange={v => setTweak("density", v)}/>
      </TweaksPanel>
    </div>
  );
}

function FirstRunBanner({ onConnect }) {
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
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Welcome to mcpemails</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--fg-2)", marginTop: 2 }}>
            Connect your first inbox to get a working MCP endpoint in under a minute.
          </div>
        </div>
        <Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>
      </div>
    </div>
  );
}
