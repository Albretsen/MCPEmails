/**
 * The dashboard address that opens the existing inbox-cap upgrade panel for a
 * second inbox (onboarding Flow B, B1; App.jsx reads `connect=second_inbox`).
 * Its own tiny module so the /onboarding inbox step can use it without
 * loading the rest of flow-b.mjs.
 */
export const SECOND_INBOX_DASHBOARD_HREF = '/dashboard/inboxes?connect=second_inbox';
