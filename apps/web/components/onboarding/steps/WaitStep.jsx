'use client';

import { StepPlaceholder } from './StepPlaceholder';

/**
 * A8, the live wait ladder (setPolling(adaptiveCadence)) and timed help. WP-F fills this in.
 * Props: the panel contract in ./index.js.
 */
export function WaitStep({ step, clientLabel, goNext }) {
  return <StepPlaceholder step={step} clientLabel={clientLabel} onContinue={goNext} />;
}
