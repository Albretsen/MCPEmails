import { Fragment } from 'react';
import { Link } from '@/i18n/navigation';

/**
 * Rendering helpers for the developer pages (/developers and /docs/api), whose
 * copy lives in plain content modules next to each page.
 *
 * Inline markup in a copy string: `code`, **bold** and [label](/path), and
 * nothing else. A path starting with "/" goes through the locale-aware Link, so
 * a French reader stays on /fr/...; anything else is an external link.
 */
export function Inline({ text }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="t-code-inline">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      return href.startsWith('/')
        ? <Link key={i} href={href}>{label}</Link>
        : <a key={i} href={href} rel="noopener" target="_blank">{label}</a>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** A read-only code block in the docs page's style. No copy button: this is a server component. */
export function CodeBlock({ label, code }) {
  return (
    <div className="docs-code-wrap dev-code">
      <div className="docs-code-bar">
        <span className="docs-code-lang">{label}</span>
      </div>
      <pre className="docs-pre"><code>{code}</code></pre>
    </div>
  );
}
