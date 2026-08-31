import React from 'react';

// Matches the only two tags provider copy is allowed to use.
const TAG = /<(code|b)>([\s\S]*?)<\/\1>/g;

/**
 * Renders the tiny inline subset (<code>, <b>) that provider copy uses.
 *
 * The copy is ours, checked into the repo, so this is not a sanitiser. It
 * exists so the strings stay free of dangerouslySetInnerHTML: an editorial
 * string should never be a route by which markup reaches the DOM, however
 * trusted today's version of it is.
 */
export default function RichText({ children }) {
  const text = typeof children === 'string' ? children : '';
  const out = [];
  let last = 0;
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      m[1] === 'code'
        ? <code className="t-code-inline" key={m.index}>{m[2]}</code>
        : <strong key={m.index}>{m[2]}</strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** The same subset, flattened to plain text, for JSON-LD and meta tags. */
export function stripTags(text) {
  return typeof text === 'string' ? text.replace(/<\/?(code|b)>/g, '') : '';
}
