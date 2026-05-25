/**
 * loading.js — Next.js Suspense fallback for the /dashboard route.
 *
 * Next.js automatically wraps each page segment's data-fetching in a
 * Suspense boundary. This file is the fallback UI shown while the server
 * is executing the async DB queries in page.js (fetchOverviewStats,
 * fetchInboxes, etc.).
 *
 * It renders the full dashboard shell with a shimmer sidebar and an
 * Overview page skeleton so the user sees a visually complete layout
 * with no layout shift when real data arrives.
 *
 * The CSS files are imported here because loading.js renders as a
 * standalone Server Component inside the route segment — layout.js CSS
 * imports are not automatically applied to the fallback.
 */

import { SkeletonDashboardShell } from '../../components/dashboard/Skeletons';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export default function DashboardLoading() {
  return <SkeletonDashboardShell />;
}
