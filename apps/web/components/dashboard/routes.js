/**
 * Single source of truth for the dashboard's section ↔ URL mapping.
 *
 * The dashboard is a client SPA that renders one section at a time from React
 * state, but each section is also a real, deep-linkable URL under /dashboard.
 * This module is shared by:
 *   - the catch-all route (app/dashboard/[[...section]]/page.js) to resolve the
 *     initial section from the request path,
 *   - App.jsx to keep the URL in sync with the active section, and
 *   - Sidebar.jsx to render the nav items as real <a href> links.
 *
 * Keep the segment name identical to the route id so the mapping stays 1:1.
 */
export const DASHBOARD_SECTIONS = [
  'overview',
  'inboxes',
  'keys',
  'members',
  'usage',
  'workflows',
  'approvals',
  'settings',
  'security',
];

/** Map a route id to its URL path. Overview is the bare /dashboard. */
export function sectionToPath(section) {
  return section === 'overview' ? '/dashboard' : `/dashboard/${section}`;
}

/**
 * Map a URL path segment to a valid route id.
 * Returns 'overview' for an empty segment (the /dashboard index), or null when
 * the segment is not a known section (the caller should 404).
 */
export function pathSegmentToSection(segment) {
  if (!segment) return 'overview';
  return DASHBOARD_SECTIONS.includes(segment) ? segment : null;
}
