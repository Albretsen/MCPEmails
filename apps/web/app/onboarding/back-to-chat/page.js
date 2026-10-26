import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { normalizeChipClient } from '@/lib/onboarding/clients.mjs';
import { ChatReturnPanel } from '../../../components/onboarding/ChatReturnPanel';

export const dynamic = 'force-dynamic';

/**
 * /onboarding/back-to-chat?client=claude: "Connected. Go back to Claude and
 * ask again", with a copyable first prompt. Where the dashboard sends someone
 * who connected a mailbox from a chat connect link (`from=chat`, see
 * src/lib/onboarding/chat-connect-link.ts); /onboarding shows the same panel
 * in place. Any signed-in user, any onboarding arm: it only says what to do
 * next. `client` is a chip id or ignored.
 */
export default async function BackToChatPage({ searchParams }) {
  const params = (await searchParams) ?? {};
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent('/dashboard')}`);
  const client = normalizeChipClient(typeof params.client === 'string' ? params.client : null);
  return (
    <div className="onb-root">
      <header className="onb-header">
        <a className="onb-brand" href="/dashboard">MCPEmails</a>
      </header>
      <main className="onb-main">
        <ChatReturnPanel client={client} dashboardHref="/dashboard" />
      </main>
    </div>
  );
}
