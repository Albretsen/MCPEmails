/** Pure rules for FlashValue: which way a refreshed number moved, and what colour that is. */

export type FlashDirection = 'up' | 'down' | 'changed';

/** Pulls a comparable number out of formatted text: "$1,234/mo" -> 1234. */
export function parseDisplayNumber(text: string): number | null {
  const match = text.replace(/[,\s ]/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function flashDirection(previous: string, next: string): FlashDirection | null {
  if (previous === next) return null;
  const a = parseDisplayNumber(previous);
  const b = parseDisplayNumber(next);
  if (a === null || b === null || a === b) return 'changed';
  return b > a ? 'up' : 'down';
}

export function flashTone(direction: FlashDirection, goodDirection: 'up' | 'down' = 'up'): 'good' | 'bad' | 'warn' {
  if (direction === 'changed') return 'warn';
  return direction === goodDirection ? 'good' : 'bad';
}
