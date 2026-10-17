'use client';

import { useMemo, useState } from 'react';
import { prepareIndex, searchIndex } from '@/lib/support/search-filter.mjs';

/**
 * Search box over the compact /help index (src/lib/support/search-index.mjs).
 * The index arrives as a prop; filtering happens in the browser.
 *
 * `onSelect(entry, event)` runs on a plain click of a result. When it returns
 * true it has handled the result (the help center opens an article in place),
 * so the default navigation is cancelled and the box is cleared.
 */
export default function HelpSearch({ index, copy, onSelect }) {
  const [query, setQuery] = useState('');
  const prepared = useMemo(() => prepareIndex(index), [index]);
  const results = useMemo(() => searchIndex(prepared, query), [prepared, query]);
  const active = query.trim().length > 0;

  return (
    <div className="help-search" role="search">
      <label htmlFor="help-search-input" className="help-label">{copy.label}</label>
      <input
        id="help-search-input"
        className="help-input"
        type="search"
        value={query}
        placeholder={copy.placeholder}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      {active && results.length > 0 && (
        <ul className="help-results" aria-live="polite">
          {results.map((r) => (
            <li key={r.id}>
              <a
                href={r.href}
                className="help-result"
                onClick={(e) => {
                  if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  if (onSelect(r, e)) {
                    e.preventDefault();
                    setQuery('');
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
