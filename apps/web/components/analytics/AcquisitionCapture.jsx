'use client';

import { useEffect } from 'react';
import {
  acquisitionFromLocation,
  sanitizedAcquisition,
} from '@/lib/acquisition-context.mjs';

// Store only coarse, allowlisted acquisition categories in session storage.
// Raw URLs, UTM values, search terms, and identifiers never leave the browser.
export function readAcquisitionContext() {
  try {
    const raw = window.sessionStorage.getItem('mcpe-acquisition');
    const value = raw ? JSON.parse(raw) : null;
    if (value) return sanitizedAcquisition(value);
  } catch {}
  return sanitizedAcquisition({});
}

export default function AcquisitionCapture() {
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('mcpe-acquisition')) return;
      const url = new URL(window.location.href);
      const referrer = document.referrer ? new URL(document.referrer) : null;
      window.sessionStorage.setItem(
        'mcpe-acquisition',
        JSON.stringify(acquisitionFromLocation(url, referrer)),
      );
    } catch {}
  }, []);
  return null;
}
