'use client';

import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTweaks, TweakSection, TweakRadio, TweakToggle, TweaksPanel } from '../tweaks-panel';
import { Sidebar, Topbar } from './Sidebar';
import { Pages, OverviewPage, InboxesPage, KeysPage, UsagePage, SettingsPage, SecurityPage } from './Pages';
import { ConnectModal } from './ConnectModal';

/* App.jsx — dashboard root. Owns state, route, modals.
   New: firstrun param auto-opens connect modal.
   Tweaks: light/dark mode, density. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "density": "spacious"
}/*EDITMODE-END*/;

const SEED_INBOXES = [
  { id: 1, label: "work-gmail",       address: "jordan@stripe.com",      provider: "gmail",   status: "live",     calls: 5421 },
  { id: 2, label: "personal",         address: "jordan.reyes@gmail.com", provider: "gmail",   status: "live",     calls: 3208 },
  { id: 3, label: "ops-fastmail",     address: "ops@reyes.fm",           provider: "imap",    status: "expiring", calls: 2104 },
  { id: 4, label: "ms365-consult",    address: "jr@reyesconsult.com",    provider: "outlook", status: "error",    calls:  563 },
];

const SEED_KEYS = [
  { id: "k1", name: "Claude Desktop (macbook)", token: "mcpe_live_a3f8b2c9d1e7f4a6b8c2d4e6f1a3b5c7", scopes: ["read:email","send:email"], lastUsed: "2 min ago" },
  { id: "k2", name: "Personal agent (n8n)",     token: "mcpe_live_b7e3c1d5f9a2b4c6e8d0f2a4b6c8d0e2", scopes: ["read:email"],              lastUsed: "1 hour ago" },
  { id: "k3", name: "Test key (revoke me)",     token: "mcpe_live_c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f2", scopes: ["read:email","send:email","reply:email"], lastUsed: "yesterday" },
];

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

export function DashboardApp({ user, workspace, overviewStats }) {
  const searchParams = useSearchParams();
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const firstrun = readQuery(searchParams, "firstrun") === "1";

  const [route, setRoute] = useState(firstrun ? "inboxes" : "overview");
  const [inboxes, setInboxes] = useState(firstrun ? [] : SEED_INBOXES);
  const [keys, setKeys] = useState(firstrun ? [] : SEED_KEYS);
  const [showConnect, setShowConnect] = useState(false);
  const [toast, setToast] = useState(null);

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

  // Density
  useEffect(() => {
    document.documentElement.setAttribute("data-density", t.density);
  }, [t.density]);

  const counts = { inboxes: inboxes.length, keys: keys.length };

  const onRemoveInbox = (id) => {
    setInboxes(xs => xs.filter(x => x.id !== id));
    showToast("Inbox removed", "neutral");
  };
  const onRevokeKey   = (id) => {
    setKeys(xs => xs.filter(x => x.id !== id));
    showToast("API key revoked", "neutral");
  };
  const onConnect = ({ label, provider, address }) => {
    const next = { id: Date.now(), label, address: address || (label + "@example.com"), provider, status: "live", calls: 0 };
    setInboxes(xs => [...xs, next]);
    setShowConnect(false);
    showToast(`${label} connected`, "live");
    if (firstrun) {
      // After first inbox, nudge them to keys
      setTimeout(() => setRoute("keys"), 1200);
    }
  };
  const onCreateKey = () => {
    const next = {
      id: "k" + Date.now(),
      name: "Untitled key",
      token: "mcpe_live_" + Math.random().toString(36).slice(2, 34).padEnd(32, "x"),
      scopes: ["read:email"],
      lastUsed: "never",
    };
    setKeys(xs => [next, ...xs]);
    showToast("New API key created", "live");
  };

  const showToast = (msg, tone = "live") => {
    setToast({ msg, tone, id: Date.now() });
    setTimeout(() => setToast(t2 => (t2 && t2.msg === msg ? null : t2)), 3200);
  };

  return (
    <div className="shell" data-screen-label={"Dashboard / " + route}>
      <Sidebar route={route} setRoute={setRoute} counts={counts} user={user} workspace={workspace} />
      <div className="main-col">
        <Topbar route={route} workspace={workspace} />

        {firstrun && inboxes.length === 0 && route === "inboxes" && !showConnect && (
          <FirstRunBanner onConnect={() => setShowConnect(true)} />
        )}

        {route === "overview" && <OverviewPage inboxes={inboxes} activity={SEED_ACTIVITY} stats={overviewStats} onConnect={() => setShowConnect(true)} />}
        {route === "inboxes"  && <InboxesPage  inboxes={inboxes} onConnect={() => setShowConnect(true)} onRemove={onRemoveInbox} />}
        {route === "keys"     && <KeysPage     keys={keys} onCreate={onCreateKey} onRevoke={onRevokeKey} />}
        {route === "usage"    && <UsagePage />}
        {route === "settings" && <SettingsPage />}
        {route === "security" && <SecurityPage />}
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} onConnect={onConnect} />}
      {toast && <Toast msg={toast.msg} tone={toast.tone} />}

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

function Toast({ msg, tone }) {
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: "var(--ink-900)", color: "#fff", borderRadius: 999,
      padding: "10px 16px", display: "flex", alignItems: "center", gap: 10,
      boxShadow: "var(--shadow-3)", zIndex: 90,
      animation: "toast-in 260ms var(--ease-out)",
      fontFamily: "var(--font-sans)", fontSize: 13.5, fontWeight: 500,
    }}>
      <span className={"dot " + (tone === "live" ? "live" : "gray")} style={{ background: tone === "live" ? "var(--mint-500)" : "var(--ink-300)" }}/>
      {msg}
      <style>{`@keyframes toast-in { from { transform: translate(-50%, 12px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }`}</style>
    </div>
  );
}
