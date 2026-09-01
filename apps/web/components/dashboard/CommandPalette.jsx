'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '../Primitives';

/* CommandPalette.jsx: global ⌘K search/navigation popup.

   The dashboard uses client-side route state (setRoute), not URL routing, so
   selecting a result invokes a handler instead of navigating a URL. Items are
   built from static pages, quick actions, and the live inboxes/members/keys
   passed in as props, so everything in the app is searchable from one place. */

const PAGES = [
  { id: 'overview', labelKey: 'commandPalette.pageOverview', icon: 'activity', keywords: 'home dashboard stats activity' },
  { id: 'inboxes',  labelKey: 'commandPalette.pageInboxes',  icon: 'inbox',    keywords: 'mail email accounts connect' },
  { id: 'keys',     labelKey: 'commandPalette.pageKeys',     icon: 'key',      keywords: 'tokens secrets credentials mcp' },
  { id: 'members',  labelKey: 'commandPalette.pageMembers',  icon: 'users',    keywords: 'team people users invite workspace' },
  { id: 'usage',    labelKey: 'commandPalette.pageUsage',    icon: 'zap',      keywords: 'billing calls quota limits metrics' },
  { id: 'workflows', label: 'Workflows', icon: 'activity', keywords: 'prompts routines triage draft search cleanup scheduled email' },
  { id: 'approvals', labelKey: 'commandPalette.pageApprovals', icon: 'shield', keywords: 'approve reject review pending sends outgoing email' },
  { id: 'automations', labelKey: 'commandPalette.pageAutomations', icon: 'zap', keywords: 'automation rule triage schedule unattended filter move label forward recurring' },
  { id: 'settings', labelKey: 'commandPalette.pageSettings', icon: 'settings', keywords: 'account profile password preferences' },
  { id: 'security', labelKey: 'commandPalette.pageSecurity', icon: 'shield',   keywords: 'audit log sessions devices' },
];

function matches(query, ...fields) {
  if (!query) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

/**
 * CommandPalette: fuzzy search/navigation popup.
 *
 * @param open       whether the palette is visible
 * @param onClose    called to dismiss the palette
 * @param setRoute   navigate to a dashboard page id
 * @param onConnect  open the Connect-inbox modal
 * @param inboxes    live inbox rows ({ id, label, address, provider })
 * @param members    live member rows ({ userId, displayName, email, role })
 * @param keys       live API key rows ({ id, name })
 */
export function CommandPalette({ open, onClose, setRoute, onConnect, inboxes = [], members = [], keys = [] }) {
  const tr = useTranslations('dashboardChrome');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Build the flat, filtered, grouped result set.
  const groups = useMemo(() => {
    const q = query.trim();

    const pageItems = PAGES
      .map(p => ({ ...p, label: p.labelKey ? tr(p.labelKey) : p.label }))
      .filter(p => matches(q, p.label, p.keywords))
      .map(p => ({ key: `page:${p.id}`, label: p.label, icon: p.icon, sub: tr('commandPalette.groupTitlePage'), run: () => setRoute(p.id) }));

    const actionItems = [
      { label: tr('commandPalette.actionConnectInbox'), icon: 'plus', keywords: 'add new mail account gmail outlook fastmail', run: () => onConnect?.() },
    ]
      .filter(a => matches(q, a.label, a.keywords))
      .map((a, i) => ({ key: `action:${i}`, label: a.label, icon: a.icon, sub: tr('commandPalette.groupTitleAction'), run: a.run }));

    const inboxItems = inboxes
      .filter(ib => matches(q, ib.label, ib.address, ib.provider))
      .map(ib => ({ key: `inbox:${ib.id}`, label: ib.label || ib.address, icon: 'inbox', sub: ib.address || ib.provider || tr('commandPalette.inboxFallback'), run: () => setRoute('inboxes') }));

    const memberItems = members
      .filter(m => matches(q, m.displayName, m.email, m.role))
      .map(m => ({ key: `member:${m.userId}`, label: m.displayName || m.email, icon: 'users', sub: m.email || m.role || tr('commandPalette.memberFallback'), run: () => setRoute('members') }));

    const keyItems = keys
      .filter(k => matches(q, k.name))
      .map(k => ({ key: `key:${k.id}`, label: k.name || tr('commandPalette.keyFallback'), icon: 'key', sub: tr('commandPalette.subApiKey'), run: () => setRoute('keys') }));

    return [
      { title: tr('commandPalette.groupPages'), items: pageItems },
      { title: tr('commandPalette.groupActions'), items: actionItems },
      { title: tr('commandPalette.groupInboxes'), items: inboxItems },
      { title: tr('commandPalette.groupMembers'), items: memberItems },
      { title: tr('commandPalette.groupApiKeys'), items: keyItems },
    ].filter(g => g.items.length > 0);
  }, [query, inboxes, members, keys, setRoute, onConnect, tr]);

  // Flatten for keyboard navigation.
  const flat = useMemo(() => groups.flatMap(g => g.items), [groups]);

  // Reset query + selection and focus the input each time the palette opens.
  useEffect(() => {
    if (open) {
      // Resets the palette each time it opens.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery('');
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Clamp the active index whenever the result set shrinks.
  useEffect(() => {
    // Clamps the highlighted row when the result set shrinks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(a => (flat.length === 0 ? 0 : Math.min(a, flat.length - 1)));
  }, [flat.length]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const select = (item) => {
    if (!item) return;
    item.run();
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, flat.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); select(flat[active]); return; }
  };

  let runningIndex = -1;

  return (
    <div className="cmdk-scrim" onMouseDown={onClose}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label={tr('commandPalette.ariaLabel')} onMouseDown={e => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <Icon name="search" size={16} color="var(--fg-3)" />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder={tr('commandPalette.searchPlaceholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={tr('commandPalette.ariaSearch')}
          />
          <span className="cmdk-esc">{tr('commandPalette.esc')}</span>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {flat.length === 0 && (
            <div className="cmdk-empty">{tr('commandPalette.noResults', { query })}</div>
          )}
          {groups.map(group => (
            <div className="cmdk-group" key={group.title}>
              <div className="cmdk-group-title">{group.title}</div>
              {group.items.map(item => {
                runningIndex += 1;
                const idx = runningIndex;
                const isActive = idx === active;
                return (
                  <div
                    key={item.key}
                    className={'cmdk-item' + (isActive ? ' active' : '')}
                    data-active={isActive ? 'true' : 'false'}
                    onMouseEnter={() => setActive(idx)}
                    onMouseDown={(e) => { e.preventDefault(); select(item); }}
                    role="button"
                    tabIndex={-1}
                  >
                    <Icon name={item.icon} size={15} color={isActive ? 'var(--brand)' : 'var(--fg-3)'} />
                    <span className="cmdk-item-label">{item.label}</span>
                    {item.sub ? <span className="cmdk-item-sub">{item.sub}</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="cmdk-foot">
          <span><span className="cmdk-kbd">↑</span><span className="cmdk-kbd">↓</span> {tr('commandPalette.footNavigate')}</span>
          <span><span className="cmdk-kbd">↵</span> {tr('commandPalette.footSelect')}</span>
          <span><span className="cmdk-kbd">esc</span> {tr('commandPalette.footClose')}</span>
        </div>
      </div>
    </div>
  );
}
