'use client';

import { useMemo, useState } from 'react';
import { prepareIndex, searchIndex } from '@/lib/support/search-filter.mjs';

const LIST_ID = 'help-search-results';
const optionId = (i) => `help-search-option-${i}`;

/** The active result looks like a hovered one (.help-result:hover in styles/help.css). */
const ACTIVE_STYLE = { background: 'var(--bg-sunken)' };

/**
 * Search box over the compact /help index (src/lib/support/search-index.mjs).
 * The index arrives as a prop; filtering happens in the browser.
 *
 * `onSelect(entry, event)` runs on a plain click of a result. When it returns
 * true it has handled the result (the help center opens an article in place),
 * so the default navigation is cancelled and the box is cleared.
 *
 * Accessibility: the input is a combobox that owns the results listbox. Up and
 * Down move the active result (announced through aria-activedescendant, while
 * focus stays in the box), Enter opens it, Escape clears the box. Each result
 * stays a real link, so Tab, middle-click and open-in-new-tab still work.
 */
export default function HelpSearch({ index, copy, onSelect }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const prepared = useMemo(() => prepareIndex(index), [index]);
  const results = useMemo(() => searchIndex(prepared, query), [prepared, query]);
  const active = query.trim().length > 0;
  const expanded = active && results.length > 0;
  const current = expanded && activeIndex < results.length ? activeIndex : -1;

  function onKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!expanded) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => {
        const from = i < results.length ? i : -1;
        if (from === -1) return step === 1 ? 0 : results.length - 1;
        return (from + step + results.length) % results.length;
      });
    } else if (e.key === 'Enter' && current >= 0) {
      e.preventDefault();
      document.getElementById(optionId(current))?.querySelector('a')?.click();
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
      setActiveIndex(-1);
    }
  }

  return (
    <div className="help-search" role="search">
      <label htmlFor="help-search-input" className="help-label">{copy.label}</label>
      <input
        id="help-search-input"
        className="help-input"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={LIST_ID}
        aria-expanded={expanded}
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        value={query}
        placeholder={copy.placeholder}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <ul id={LIST_ID} className="help-results" role="listbox" aria-label={copy.label}>
          {results.map((r, i) => (
            <li key={r.id} id={optionId(i)} role="option" aria-selected={i === current}>
              <a
                href={r.href}
                className="help-result"
                style={i === current ? ACTIVE_STYLE : undefined}
                onClick={(e) => {
                  if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  if (onSelect(r, e)) {
                    e.preventDefault();
                    setQuery('');
                    setActiveIndex(-1);
                  }
                }}
              >
                <span className="help-result-kind">{copy.kinds?.[r.kind] ?? r.kind}</span>
                <span className="help-result-title">{r.title}</span>
                {r.hint ? <span className="help-result-hint">{r.hint}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      )}
      {active && results.length === 0 && (
        <p className="help-empty" aria-live="polite">
          {copy.empty} <a href="#contact">{copy.emptyLink}</a>
        </p>
      )}
    </div>
  );
}
