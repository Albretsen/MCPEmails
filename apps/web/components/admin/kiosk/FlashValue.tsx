'use client';

/**
 * A number that flashes when a refresh changes it.
 *
 * The board re-renders in place every five minutes, so a new signup or payment
 * otherwise lands as a silently different digit that nobody walking past would
 * notice. This keeps the previous text across `router.refresh()` (the client
 * component survives a soft refresh at the same tree position) and, when the
 * text changes, plays one short tint: green when the number went the good way,
 * red when it went the bad way, amber when it changed but cannot be compared
 * (a label, a "—" turning into a figure).
 *
 * The first render never flashes, so a view switch or a hard reload is quiet.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flashDirection, flashTone } from './flash-math';

export function FlashValue({
  text,
  goodDirection,
  className,
  children,
}: {
  /** The text compared between renders. */
  text: string;
  /** Which way is good news. Defaults to up. */
  goodDirection?: 'up' | 'down';
  className?: string;
  children?: ReactNode;
}) {
  const previous = useRef(text);
  // Bumped per change: the new key remounts the span, so the same tone twice in
  // a row still replays the animation. The class stays after it ends, harmlessly.
  const [flash, setFlash] = useState<{ tone: string; n: number } | null>(null);

  useEffect(() => {
    const direction = flashDirection(previous.current, text);
    previous.current = text;
    if (!direction) return;
    setFlash((current) => ({ tone: flashTone(direction, goodDirection), n: (current?.n ?? 0) + 1 }));
  }, [text, goodDirection]);

  return (
    <span
      key={flash?.n ?? 0}
      className={`${className ?? ''}${flash ? ` kiosk-flash is-flash-${flash.tone}` : ''}`}
    >
      {children ?? text}
    </span>
  );
}
