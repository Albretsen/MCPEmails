'use client';

import { WaitPanel } from './WaitPanel';

/**
 * A8, the live wait after the handshake: the ladder, setPolling(adaptiveCadence)
 * and the timed help (WaitPanel). Moves to it_works on the first real call.
 * Props: the panel contract in ./index.js.
 */
export function WaitStep(props) {
  return <WaitPanel {...props} />;
}
