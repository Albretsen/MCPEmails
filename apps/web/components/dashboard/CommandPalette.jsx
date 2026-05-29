'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '../Primitives';

/* CommandPalette.jsx — global ⌘K search/navigation popup.

   The dashboard uses client-side route state (setRoute), not URL routing, so
   selecting a result invokes a handler instead of navigating a URL. Items are
   built from static pages, quick actions, and the live inboxes/members/keys
   passed in as props, so everything in the app is searchable from one place. */

const PAGES = [
  { id: 'overview', label: 'Overview',  icon: 'activity', keywords: 'home dashboard stats activity' },
  { id: 'inboxes',  label: 'Inboxes',   icon: 'inbox',    keywords: 'mail email accounts connect' },
  { id: 'keys',     label: 'API keys',  icon: 'key',      keywords: 'tokens secrets credentials mcp' },
  { id: 'members',  label: 'Members',   icon: 'users',    keywords: 'team people users invite workspace' },
  { id: 'usage',    label: 'Usage',     icon: 'zap',      keywords: 'billing calls quota limits metrics' },
  { id: 'settings', label: 'Settings',  icon: 'settings', keywords: 'account profile password preferences' },
  { id: 'security', label: 'Security',  icon: 'shield',   keywords: 'audit log sessions devices' },
];

function matches(query, ...fields) {
  if (!query) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return query.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

/**
 * CommandPalette — fuzzy search/navigation popup.
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
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Build the flat, filtered, grouped result set.
  const groups = useMemo(() => {
    const q = query.trim();

    const pageItems = PAGES
      .filter(p => matches(q, p.label, p.keywords))
      .map(p => ({ key: `page:${p.id}`, label: p.label, icon: p.icon, sub: 'Page', run: () => setRoute(p.id) }));

    const actionItems = [
      { label: 'Connect inbox', icon: 'plus', keywords: 'add new mail account gmail outlook fastmail', run: () => onConnect?.() },
    ]
      .filter(a => matches(q, a.label, a.keywords))
      .map((a, i) => ({ key: `action:${i}`, label: a.label, icon: a.icon, sub: 'Action', run: a.run }));

    const inboxItems = inboxes
      .filter(ib => matches(q, ib.label, ib.address, ib.provider))
      .map(ib => ({ key: `inbox:${ib.id}`, label: ib.label || ib.address, icon: 'inbox', sub: ib.address || ib.provider || 'Inbox', run: () => setRoute('inboxes') }));

    const memberItems = members
      .filter(m => matches(q, m.displayName, m.email, m.role))
      .map(m => ({ key: `member:${m.userId}`, label: m.displayName || m.email, icon: 'users', sub: m.email || m.role || 'Member', run: () => setRoute('members') }));

    const keyItems = keys
      .filter(k => matches(q, k.name))
      .map(k => ({ key: `key:${k.id}`, label: k.name || 'API key', icon: 'key', sub: 'API key', run: () => setRoute('keys') }));

    return [
      { title: 'Pages', items: pageItems },
      { title: 'Actions', items: actionItems },
      { title: 'Inboxes', items: inboxItems },
      { title: 'Members', items: memberItems },
      { title: 'API keys', items: keyItems },
    ].filter(g => g.items.length > 0);
  }, [query, inboxes, members, keys, setRoute, onConnect]);

  // Flatten for keyboard navigation.
  const flat = useMemo(() => groups.flatMap(g => g.items), [groups]);

  // Reset query + selection and focus the input each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Clamp the active index whenever the result set shrinks.
  useEffect(() => {
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
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <Icon name="search" size={16} color="var(--fg-3)" />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search pages, inboxes, members…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search"
          />
          <span className="cmdk-esc">Esc</span>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {flat.length === 0 && (
            <div className="cmdk-empty">No results for “{query}”.</div>
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
          <span><span className="cmdk-kbd">↑</span><span className="cmdk-kbd">↓</span> navigate</span>
          <span><span className="cmdk-kbd">↵</span> select</span>
          <span><span className="cmdk-kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}
