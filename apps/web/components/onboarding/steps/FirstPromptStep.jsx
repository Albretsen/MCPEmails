'use client';

import { StepPlaceholder } from './StepPlaceholder';

/**
 * A8, the first prompt to paste or open in the AI app. WP-F fills this in.
 * Props: the panel contract in ./index.js.
 */
export function FirstPromptStep({ step, clientLabel, goNext }) {
  return <StepPlaceholder step={step} clientLabel={clientLabel} onContinue={goNext} />;
}
