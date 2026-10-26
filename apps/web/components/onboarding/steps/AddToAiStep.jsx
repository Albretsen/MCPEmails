'use client';

import { StepPlaceholder } from './StepPlaceholder';

/**
 * A6, add MCPEmails to the chosen AI app (install deep links from WP-D). WP-F fills this in.
 * Props: the panel contract in ./index.js.
 */
export function AddToAiStep({ step, clientLabel, goNext }) {
  return <StepPlaceholder step={step} clientLabel={clientLabel} onContinue={goNext} />;
}
