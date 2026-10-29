'use client';

import { WaitPanel } from './WaitPanel';

/**
 * A8, the first prompt to paste. Same screen as WaitStep (WaitPanel): the
 * prompt, the live ladder and the timed help; it moves to `wait` once the
 * handshake shows up.
 * Props: the panel contract in ./index.js.
 */
export function FirstPromptStep(props) {
  return <WaitPanel {...props} />;
}
