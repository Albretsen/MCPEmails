'use client';

import { createContext, useContext } from 'react';

/**
 * The visitor's AI assistant (src/lib/clients/preferred.mjs), read once on the
 * server by app/[locale]/layout.tsx and handed to every marketing client
 * component below it. Null when there is none, which renders the default order.
 */
const PreferredClientContext = createContext(null);

export function PreferredClientProvider({ value, children }) {
  return <PreferredClientContext.Provider value={value ?? null}>{children}</PreferredClientContext.Provider>;
}

export function usePreferredClient() {
  return useContext(PreferredClientContext);
}
