'use client';

import { useEffect } from 'react';
import { sanitizedAcquisition } from '@/lib/acquisition-context.mjs';
import {
  captureAcquisition,
  readLegacyAcquisition,
  readStoredAcquisition,
} from './acquisition-storage.mjs';

// Store only coarse, allowlisted acquisition categories, now in local storage
// with a 30 day first-touch window (it used to be session storage, which filed
// every visitor who slept on it as `direct`). Raw URLs, UTM values, search
// terms, and identifiers never leave the browser.
export function readAcquisitionContext() {
  try {
    const stored = readStoredAcquisition(window.localStorage, Date.now());
    if (stored) return stored;
    // A visitor mid-session at deploy time may still only have the old session
    // record if they reached this form before the capture effect promoted it.
    const legacy = readLegacyAcquisition(window.sessionStorage);
    if (legacy) return legacy;
  } catch {}
  return sanitizedAcquisition({});
}

export default function AcquisitionCapture() {
  useEffect(() => {
    // Reading `window.localStorage` at all throws when site data is blocked,
    // so even the lookup is guarded before anything is handed to the helper.
    let local = null;
    let session = null;
    try {
      local = window.localStorage;
    } catch {}
    try {
      session = window.sessionStorage;
    } catch {}
    try {
      captureAcquisition({
        local,
        session,
        url: new URL(window.location.href),
        referrer: document.referrer ? new URL(document.referrer) : null,
        now: Date.now(),
      });
    } catch {}
  }, []);
  return null;
}
