'use client';

import { useEffect, useRef } from 'react';

/* Open dialogs, oldest first. Only the top one answers Escape, so a confirmation
   opened from a form closes the confirmation and leaves the form as it was. */
const open = [];

/**
 * Calls `onEscape` when Escape is pressed while this dialog is the top one. Listens
 * on the document, since focus usually stays on the button that opened the dialog.
 * Pass the same guarded close the scrim uses, so Escape can not interrupt a save.
 */
export function useEscapeKey(onEscape) {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    const entry = {};
    open.push(entry);
    const onKey = (event) => {
      if (event.key === 'Escape' && open[open.length - 1] === entry) latest.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      open.splice(open.indexOf(entry), 1);
    };
  }, []);
}
