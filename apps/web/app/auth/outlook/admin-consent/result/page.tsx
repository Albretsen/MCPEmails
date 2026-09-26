import type { Metadata } from 'next';
import { AdminConsentResult } from '../../../../../components/dashboard/AdminConsentResult';
import { isAdminConsentResultStatus } from '@/lib/email-providers/outlook-admin-link';

export const metadata: Metadata = {
  title: 'Microsoft 365 approval · mcpemails',
  description: 'The result of approving MCP Emails for a Microsoft 365 organisation',
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ status?: string }>;
}

/**
 * /auth/outlook/admin-consent/result?status=<code>
 *
 * PUBLIC. Where a Microsoft 365 administrator lands after following a shared
 * admin-consent link (see app/auth/outlook/admin-consent/route.ts). They
 * usually have no MCP Emails account, so this is a small standalone page, not
 * the dashboard. `status` is one of ADMIN_CONSENT_RESULT_STATUSES; anything
 * else renders as a generic failure. Nothing from Microsoft is echoed.
 */
export default async function AdminConsentResultPage({ searchParams }: Props) {
  const params = await searchParams;
  const status = isAdminConsentResultStatus(params.status) ? params.status : 'failed';
  return <AdminConsentResult status={status} />;
}
