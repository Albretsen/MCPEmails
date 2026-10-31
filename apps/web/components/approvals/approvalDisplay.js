'use client';

import { useEffect, useState } from 'react';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The time left until a deadline, as a message key and count. Null when none or past. */
export function timeLeftParts(expiresAt, nowMs) {
  if (!expiresAt) return null;
  const left = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  if (left >= 2 * DAY) return { key: 'days', count: Math.floor(left / DAY) };
  if (left >= HOUR) return { key: 'hours', count: Math.floor(left / HOUR) };
  return { key: 'minutes', count: Math.max(1, Math.floor(left / MINUTE)) };
}

export function formatTimeLeft(t, expiresAt, nowMs) {
  const parts = timeLeftParts(expiresAt, nowMs);
  return parts ? t(`approvals.timeLeft.${parts.key}`, { count: parts.count }) : null;
}

/** Now, refreshed every 30 seconds, for counting down and for spotting a passed deadline. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A sentence for a delivery's reason, or null. */
export function deliveryReasonText(t, delivery) {
  if (!delivery?.reason) return null;
  const key = `approvals.delivery.reasons.${delivery.reason}`;
  return t.has(key) ? t(key) : t('approvals.delivery.reasons.generic');
}

/** Still moving, so the page should look again soon. */
export function deliveryInFlight(delivery) {
  return delivery?.state === 'sending';
}
