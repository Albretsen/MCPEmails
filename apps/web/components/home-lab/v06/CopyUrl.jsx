'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The copy button beside the connector URL. On click, "Copied" replaces the
 * label for two seconds (brief motion idea). The URL itself is plain server
 * text next to it, so it can be selected by hand with JavaScript off.
 */
export default function CopyUrl({ value, label = 'Copy', done = 'Copied', className, doneClassName }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      className={copied && doneClassName ? `${className} ${doneClassName}` : className}
      onClick={copy}
      aria-label={copied ? done : `${label} ${value}`}
    >
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}
