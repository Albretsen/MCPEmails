import type { ReactNode } from 'react';

/**
 * Production stand-in for the Homepage Lab picker. next.config.js aliases
 * `home-lab-entry` to this file on every build that is not staging, so the
 * lab is never compiled into production. It renders the page unchanged.
 */
export async function renderHomeLab({ current }: { current: ReactNode; id?: string }): Promise<ReactNode> {
  return current;
}
