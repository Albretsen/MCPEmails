# Real-Time Updates and Webhooks

## Purpose

This document defines the complete real-time and webhook architecture for MCPEmails. It covers which UI elements receive live updates, how Supabase Realtime delivers those updates via WebSocket, how email providers push new-message notifications via webhooks, and how the system decouples fast webhook acknowledgement from slower message processing. Every section is implementable as written.

---

## 1. What Needs Real-Time Updates

Not every piece of data in MCPEmails benefits from a live subscription. WebSocket channels consume server resources and add client complexity; they are justified only where a stale value meaningfully degrades the user experience.

### Dashboard Overview

Two counters on the workspace dashboard must stay current without a page reload:

- **Live MCP call counter** — the total count (and per-minute rate) of `activity_log` `INSERT` events for the current workspace. An AI agent may issue dozens of tool calls per minute; watching the counter increment in real time confirms the integration is working.
- **Connected inbox count** — the number of `inboxes` rows where `status = 'active'` and `deleted_at IS NULL`. When an OAuth token expires or a reconnect completes, this count changes without any user action.

### Activity Feed

The activity feed lists recent `activity_log` rows in reverse chronological order. New rows must appear at the top of the feed as soon as an MCP tool call completes — typically within 200 ms of the insert. Users monitor this feed during agent debugging sessions.

### Inbox Status Badges

Each inbox in the sidebar displays a coloured status badge derived from `inboxes.status`:

| `status` value | Badge colour | User-visible label |
|---|---|---|
| `active` | Green | Connected |
| `pending` | Yellow | Connecting… |
| `error` | Red | Reconnect required |
| `revoked` | Grey | Disconnected |

When the token-refresh Edge Function sets `status = 'error'` on an expiring token, the badge must turn red immediately without requiring a page reload. The reverse is equally important: when the user completes the OAuth re-authorisation flow and status returns to `active`, the badge turns green on its own.

### API Key `last_used_at`

The API keys panel in the sidebar shows when each key was last used. Because MCP clients may call the server continuously in the background, the `last_used_at` timestamp updates on every tool invocation. A Realtime subscription to `api_keys` UPDATE events keeps the displayed timestamp current.

### What Is NOT Real-Time

Email content — message bodies, attachment data, thread history — is **not** pushed via Realtime. Email content is fetched on demand when an MCP tool call (`read_email`, `list_inbox`, `search_email`) executes. The volume of email data makes it unsuitable for WebSocket delivery, and the security implications of broadcasting message bodies over a shared channel are unacceptable. Only IDs and metadata flow over Realtime channels.

---

## 2. Supabase Realtime Architecture

### How Supabase Realtime Works

Supabase Realtime is a Phoenix-based WebSocket server that listens to PostgreSQL's logical replication stream. The data flow is:

```
PostgreSQL WAL (Write-Ahead Log)
        │
        │  logical replication slot
        ▼
Supabase Realtime Server (Phoenix/Elixir)
        │
        │  filters rows against RLS policies
        │  filters rows against channel subscription params
        ▼
WebSocket connection to browser client
        │
        ▼
React state update → re-render
```

When a row is inserted or updated in a table that has `REPLICA IDENTITY` configured, Postgres writes the change to the WAL. The Realtime server reads the WAL via a replication slot, evaluates each change against active channel subscriptions, applies Row-Level Security (RLS) to determine whether the subscribing user is authorised to see the change, and delivers matching events over the user's WebSocket connection.

### Prerequisite: `REPLICA IDENTITY FULL`

For RLS enforcement on Realtime channels to work, each subscribed table must have `REPLICA IDENTITY FULL` set. Without it, the WAL record contains only the new column values — not enough to evaluate RLS policies that depend on old values, and not enough for the Realtime server to apply row-level filtering on `UPDATE` events.

```sql
-- Run once per table that will have Realtime subscriptions.
-- Must be run by a superuser (Supabase dashboard SQL editor or migration file).
ALTER TABLE public.activity_log   REPLICA IDENTITY FULL;
ALTER TABLE public.inboxes        REPLICA IDENTITY FULL;
ALTER TABLE public.api_keys       REPLICA IDENTITY FULL;
```

Add these statements to the initial schema migration. They are idempotent and do not lock the table.

### RLS Enforcement on Realtime Channels

Supabase Realtime evaluates the subscribing user's JWT against each table's RLS `SELECT` policy before delivering a row change. This means a user who subscribes to `activity_log` changes can only receive rows where `workspace_id` is one of their workspaces — the same guarantee that applies to normal `SELECT` queries.

The `authenticated` role and RLS policies defined in `row-level-security.md` apply directly to Realtime without additional configuration. The Realtime server uses the JWT provided by the client when establishing the WebSocket connection.

### Channel Naming Convention

All Realtime channels are scoped to a workspace to prevent cross-tenant leakage at the subscription layer:

| Channel purpose | Channel name |
|---|---|
| Activity feed for workspace | `workspace:{workspace_id}:audit_log` |
| Inbox status changes | `workspace:{workspace_id}:inboxes` |
| API key updates | `workspace:{workspace_id}:api_keys` |

Note that in the code below, channel names are passed to `supabase.channel(name)`. The Supabase client uses these names for internal multiplexing; they also appear in browser DevTools WebSocket frames, so they must not contain sensitive data. `workspace_id` is a UUID and not a secret.

---

## 3. Client-Side Subscription Code

All subscription hooks follow the same three-part structure:

1. **Subscribe** on mount, storing the channel reference.
2. **Handle events** by updating local state.
3. **Unsubscribe** on unmount to release the channel and avoid memory leaks.

The hooks use `createClientComponentClient` from `@supabase/ssr` (the browser-safe client). They must only be used in Client Components (`'use client'`).

### `useAuditLogFeed`

Subscribes to `activity_log` `INSERT` events for the current workspace and maintains a capped, chronologically ordered array of the most recent entries.

```typescript
// apps/web/lib/hooks/useAuditLogFeed.ts
'use client';

import { useEffect, useRef, useState } from 'react';
import { createClientComponentClient } from '@supabase/ssr';
import type { RealtimeChannel, RealtimePostgresInsertPayload } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type ActivityLogRow = Database['public']['Tables']['activity_log']['Row'];

export interface AuditLogFeedState {
  entries: ActivityLogRow[];
  status: 'connecting' | 'connected' | 'error' | 'closed';
  error: string | null;
}

const MAX_FEED_ENTRIES = 100;

export function useAuditLogFeed(workspaceId: string): AuditLogFeedState {
  const supabase = createClientComponentClient<Database>();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [entries, setEntries] = useState<ActivityLogRow[]>([]);
  const [status, setStatus] = useState<AuditLogFeedState['status']>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;

    const channelName = `workspace:${workspaceId}:audit_log`;

    const channel = supabase
      .channel(channelName)
      .on<ActivityLogRow>(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'activity_log',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload: RealtimePostgresInsertPayload<ActivityLogRow>) => {
          setEntries((prev) => {
            // Prepend the new entry and cap the array length.
            const updated = [payload.new, ...prev];
            return updated.slice(0, MAX_FEED_ENTRIES);
          });
        }
      )
      .subscribe((channelStatus, err) => {
        switch (channelStatus) {
          case 'SUBSCRIBED':
            setStatus('connected');
            setError(null);
            // On reconnect: re-fetch the last N entries to fill the gap.
            // See Section 4 for the full reconnect strategy.
            syncRecentEntries(supabase, workspaceId, setEntries);
            break;

          case 'CHANNEL_ERROR':
            setStatus('error');
            setError(err?.message ?? 'Realtime channel error');
            break;

          case 'TIMED_OUT':
            setStatus('closed');
            setError('Realtime connection timed out. Attempting to reconnect…');
            break;

          case 'CLOSED':
            setStatus('closed');
            break;
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [workspaceId]); // Re-subscribe if workspaceId changes (workspace switcher).

  return { entries, status, error };
}

/**
 * Fetches the most recent activity_log rows from the database.
 * Called on initial connect and on every reconnect to fill any gap
 * that occurred while the WebSocket was down.
 */
async function syncRecentEntries(
  supabase: ReturnType<typeof createClientComponentClient<Database>>,
  workspaceId: string,
  setEntries: React.Dispatch<React.SetStateAction<ActivityLogRow[]>>
) {
  const { data, error } = await supabase
    .from('activity_log')
    .select(
      'id, workspace_id, api_key_id, inbox_id, tool_name, status, error_code, duration_ms, created_at'
    )
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(MAX_FEED_ENTRIES);

  if (error) {
    console.error('[useAuditLogFeed] syncRecentEntries failed', error);
    return;
  }

  if (data) {
    setEntries(data);
  }
}
```

**Usage in a Server Component page:** pass `workspaceId` down as a prop to a Client Component wrapper that calls `useAuditLogFeed`.

```typescript
// apps/web/app/(dashboard)/workspace/[workspaceId]/activity/ActivityFeedClient.tsx
'use client';

import { useAuditLogFeed } from '@/lib/hooks/useAuditLogFeed';
import { ConnectionStatusBanner } from '@/components/ConnectionStatusBanner';
import { ActivityEntry } from '@/components/ActivityEntry';

interface Props {
  workspaceId: string;
  initialEntries: ActivityLogRow[]; // SSR-prefetched; replaced once subscription connects
}

export function ActivityFeedClient({ workspaceId, initialEntries }: Props) {
  const { entries, status, error } = useAuditLogFeed(workspaceId);

  const displayEntries = status === 'connecting' ? initialEntries : entries;

  return (
    <div>
      {(status === 'closed' || status === 'error') && (
        <ConnectionStatusBanner message={error ?? 'Connection lost. Reconnecting…'} />
      )}
      <ul>
        {displayEntries.map((entry) => (
          <ActivityEntry key={entry.id} entry={entry} />
        ))}
      </ul>
    </div>
  );
}
```

### `useInboxStatus`

Subscribes to `UPDATE` events on a single inbox row and returns the current status. Used to drive the coloured status badge in the sidebar and the inbox detail page.

```typescript
// apps/web/lib/hooks/useInboxStatus.ts
'use client';

import { useEffect, useRef, useState } from 'react';
import { createClientComponentClient } from '@supabase/ssr';
import type { RealtimeChannel, RealtimePostgresUpdatePayload } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type InboxRow = Database['public']['Tables']['inboxes']['Row'];
type InboxStatus = InboxRow['status'];

export interface InboxStatusState {
  status: InboxStatus | null;
  lastError: string | null;
  channelStatus: 'connecting' | 'connected' | 'error' | 'closed';
}

export function useInboxStatus(
  inboxId: string,
  workspaceId: string,
  initialStatus: InboxStatus
): InboxStatusState {
  const supabase = createClientComponentClient<Database>();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [status, setStatus] = useState<InboxStatus | null>(initialStatus);
  const [lastError, setLastError] = useState<string | null>(null);
  const [channelStatus, setChannelStatus] =
    useState<InboxStatusState['channelStatus']>('connecting');

  useEffect(() => {
    if (!inboxId || !workspaceId) return;

    // Use a per-inbox channel name. This is more granular than subscribing
    // to all inbox changes for a workspace — appropriate for single-inbox views.
    const channelName = `workspace:${workspaceId}:inbox:${inboxId}`;

    const channel = supabase
      .channel(channelName)
      .on<InboxRow>(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'inboxes',
          filter: `id=eq.${inboxId}`,
        },
        (payload: RealtimePostgresUpdatePayload<InboxRow>) => {
          // Only broadcast non-sensitive fields. The full payload arrives here
          // because REPLICA IDENTITY FULL is set, but we only use status
          // and last_error. Encrypted credential columns (oauth_access_token,
          // imap_password) are never sent over the wire; Supabase Realtime
          // applies RLS which restricts the columns delivered based on the
          // SELECT policy — but as an extra safeguard, only consume what is needed.
          setStatus(payload.new.status);
          setLastError(payload.new.last_error);
        }
      )
      .subscribe((s) => {
        switch (s) {
          case 'SUBSCRIBED':
            setChannelStatus('connected');
            break;
          case 'CHANNEL_ERROR':
            setChannelStatus('error');
            break;
          case 'TIMED_OUT':
            setChannelStatus('closed');
            break;
          case 'CLOSED':
            setChannelStatus('closed');
            break;
        }
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [inboxId, workspaceId]);

  return { status, lastError, channelStatus };
}
```

### `useApiKeyLastUsed`

Subscribes to `UPDATE` events on the `api_keys` table for the current workspace, tracking `last_used_at` changes.

```typescript
// apps/web/lib/hooks/useApiKeyLastUsed.ts
'use client';

import { useEffect, useRef, useState } from 'react';
import { createClientComponentClient } from '@supabase/ssr';
import type { RealtimeChannel, RealtimePostgresUpdatePayload } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type ApiKeyRow = Database['public']['Tables']['api_keys']['Row'];

// Map of api_key_id → last_used_at ISO string
type LastUsedMap = Record<string, string | null>;

export function useApiKeyLastUsed(
  workspaceId: string,
  initialMap: LastUsedMap
): LastUsedMap {
  const supabase = createClientComponentClient<Database>();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const [lastUsedMap, setLastUsedMap] = useState<LastUsedMap>(initialMap);

  useEffect(() => {
    if (!workspaceId) return;

    const channelName = `workspace:${workspaceId}:api_keys`;

    const channel = supabase
      .channel(channelName)
      .on<ApiKeyRow>(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'api_keys',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload: RealtimePostgresUpdatePayload<ApiKeyRow>) => {
          const { id, last_used_at } = payload.new;
          setLastUsedMap((prev) => ({
            ...prev,
            [id]: last_used_at,
          }));
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [workspaceId]);

  return lastUsedMap;
}
```

### Handling `CHANNEL_ERROR` and `TIMED_OUT`

Both states indicate a disrupted connection, but they have different recovery implications:

| State | Cause | Client action |
|---|---|---|
| `CHANNEL_ERROR` | Server rejected the subscription (auth failure, invalid filter, server error) | Show error banner; do not auto-retry without inspecting the error. If it is a transient server error, the Supabase client will attempt to re-subscribe automatically. |
| `TIMED_OUT` | The channel did not receive a confirmation from the server within the timeout window (default 10 s) | The Supabase client will close the channel and attempt to reconnect. Show "connection lost" indicator; re-fetch from DB on next `SUBSCRIBED` event. |
| `CLOSED` | The WebSocket was cleanly closed (e.g., user navigated away, explicit `removeChannel` call) | Normal teardown; no action required. |

The pattern used in `useAuditLogFeed` above — calling `syncRecentEntries` on every `SUBSCRIBED` transition — ensures correctness regardless of whether the `SUBSCRIBED` event is the initial connection or a post-reconnect one.

---

## 4. Client Reconnection Strategy

### Built-In Exponential Backoff

The Supabase JavaScript client (`@supabase/supabase-js` v2.x) implements automatic WebSocket reconnection with exponential backoff internally. When the underlying WebSocket disconnects, the client waits an increasing interval (starting at ~1 s, doubling up to a cap of ~30 s) before attempting to re-establish the connection. Application code does not need to implement retry loops.

The `RealtimeClient` configuration can be tuned via `createClient` options if the defaults are too aggressive for the production environment:

```typescript
// apps/web/lib/supabase/client.ts
import { createBrowserClient } from '@supabase/ssr';

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      realtime: {
        params: {
          eventsPerSecond: 10,    // Rate-limit incoming events to prevent UI thrashing
        },
        timeout: 20_000,          // Increase timeout for flaky connections (default: 10_000 ms)
        heartbeatIntervalMs: 30_000,
      },
    }
  );
}
```

### Detecting a Missed Event Window

When the WebSocket was down — even for a few seconds — the client may have missed `INSERT` or `UPDATE` events. Supabase Realtime does not buffer missed events for offline clients. The correct recovery strategy is to re-query the database for the latest state on every reconnect.

The `onConnect` pattern used in all hooks above handles this: every time the channel transitions to `SUBSCRIBED`, a database query fills the local state with the current ground truth. This query is cheap (it is already behind a `workspace_id` index and limited to the last `N` rows).

For the activity feed this means re-fetching the last 100 `activity_log` rows. Any events that arrived during the outage will appear correctly ordered by `created_at` in the refreshed list.

```typescript
// Pattern: always call syncRecentEntries on SUBSCRIBED, not just on first connect.
// The Supabase client fires SUBSCRIBED both on initial subscription and on reconnect.
.subscribe((channelStatus) => {
  if (channelStatus === 'SUBSCRIBED') {
    // This runs on initial connect AND after every successful reconnect.
    syncRecentEntries(supabase, workspaceId, setEntries);
  }
});
```

### Showing a "Connection Lost" Indicator

Display a non-intrusive banner when the Realtime connection is interrupted. Do not show it on initial page load (status begins as `'connecting'`, which is normal).

```typescript
// apps/web/components/ConnectionStatusBanner.tsx
'use client';

interface Props {
  message: string;
}

export function ConnectionStatusBanner({ message }: Props) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-800"
    >
      <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
      {message}
    </div>
  );
}
```

```typescript
// Usage within a feed component:
const { status, error } = useAuditLogFeed(workspaceId);
const showBanner = status === 'closed' || status === 'error';

return (
  <>
    {showBanner && <ConnectionStatusBanner message={error ?? 'Reconnecting to live feed…'} />}
    {/* rest of feed UI */}
  </>
);
```

### Tab Visibility Optimisation

When the user switches browser tabs, the WebSocket connection may be throttled or suspended by the browser. On tab re-focus, trigger an immediate re-sync rather than waiting for the next heartbeat:

```typescript
// Add this inside the useEffect in any feed hook:
function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && channelRef.current) {
    // Re-fetch from DB to catch any events missed while the tab was hidden.
    syncRecentEntries(supabase, workspaceId, setEntries);
  }
}

document.addEventListener('visibilitychange', handleVisibilityChange);

return () => {
  supabase.removeChannel(channel);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  channelRef.current = null;
};
```

---

## 5. Email Event Push — Inbound Webhooks

Each supported email provider has a different mechanism for notifying MCPEmails that new messages have arrived.

### Gmail — Google Cloud Pub/Sub Push

Gmail's push notification system uses Google Cloud Pub/Sub. MCPEmails subscribes a Gmail account to a Pub/Sub topic; Google delivers new-message notifications to a webhook endpoint as HTTP POST requests.

**Setup flow:**

1. Create a Pub/Sub topic in the MCPEmails GCP project: `projects/mcpemails/topics/gmail-notifications`.
2. Grant the Gmail service account (`gmail-api-push@system.gserviceaccount.com`) `Publisher` permission on the topic.
3. Create a Pub/Sub push subscription pointing to `https://<supabase-project>.supabase.co/functions/v1/email-webhook`.
4. When a Gmail inbox is connected, call the Gmail `users.watch` API to register the inbox against the topic:

```typescript
// Called from the OAuth callback Edge Function after storing tokens.
async function registerGmailWatch(accessToken: string, inboxId: string): Promise<void> {
  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/watch',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topicName: 'projects/mcpemails/topics/gmail-notifications',
        labelIds: ['INBOX'],
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail watch registration failed: ${error}`);
  }

  const { historyId, expiration } = await response.json();

  // Store historyId and expiration so we can renew the watch before it expires
  // (watches expire after 7 days — renew at day 6 via scheduled Edge Function).
  await supabase
    .from('inboxes')
    .update({
      gmail_history_id: historyId,
      gmail_watch_expires_at: new Date(parseInt(expiration)).toISOString(),
    })
    .eq('id', inboxId);
}
```

**Notification payload:** Google sends a base64-encoded Pub/Sub message. The MCPEmails webhook decodes it to extract `emailAddress` and `historyId`, then uses the Gmail History API to fetch the delta since the last known `historyId`.

### Outlook — Microsoft Graph Change Notifications

Microsoft Graph delivers change notifications via HTTP POST to a registered webhook endpoint. Subscriptions must be renewed every ≤4230 minutes (~3 days); a scheduled Edge Function handles renewal.

**Registering a subscription:**

```typescript
// Called after Outlook OAuth completes.
async function registerOutlookWebhook(
  accessToken: string,
  inboxId: string
): Promise<void> {
  const expirationDateTime = new Date(
    Date.now() + 3 * 24 * 60 * 60 * 1000 // 3 days from now
  ).toISOString();

  const response = await fetch(
    'https://graph.microsoft.com/v1.0/subscriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        changeType: 'created',
        notificationUrl: `${process.env.SUPABASE_URL}/functions/v1/email-webhook`,
        resource: 'me/mailFolders/inbox/messages',
        expirationDateTime,
        clientState: inboxId, // echoed back in notifications; used to identify the inbox
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Graph subscription registration failed: ${error}`);
  }

  const { id: subscriptionId } = await response.json();

  await supabase
    .from('inboxes')
    .update({
      graph_subscription_id: subscriptionId,
      graph_subscription_expires_at: expirationDateTime,
    })
    .eq('id', inboxId);
}
```

**Validation token handshake:** When Microsoft Graph first receives the subscription request, it sends a GET request to the `notificationUrl` with a `validationToken` query parameter. The webhook endpoint must echo the token back as `text/plain` within 10 seconds or the subscription is rejected. See Section 5's webhook handler below.

### Fastmail — IMAP IDLE Polling

Fastmail does not support webhook-based push notifications. The fallback is a cron Edge Function that polls each active Fastmail inbox via IMAP IDLE every 30 seconds. IMAP IDLE holds a connection open and blocks until the server sends a notification or the timeout (30 s) elapses — this is more efficient than repeated `NOOP` polling.

```typescript
// supabase/functions/fastmail-poller/index.ts
// Scheduled to run every 30 seconds via Supabase Edge Function cron.

import { createClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow'; // npm package for IMAP
import { decryptCredential } from '../_shared/crypto.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (_req) => {
  const { data: fastmailInboxes } = await supabase
    .from('inboxes')
    .select('id, workspace_id, imap_host, imap_port, imap_tls, imap_password, email_address')
    .eq('provider', 'fastmail')
    .eq('status', 'active')
    .is('deleted_at', null);

  if (!fastmailInboxes?.length) {
    return new Response('No active Fastmail inboxes', { status: 200 });
  }

  await Promise.allSettled(
    fastmailInboxes.map((inbox) => pollFastmailInbox(inbox))
  );

  return new Response('OK', { status: 200 });
});

async function pollFastmailInbox(inbox: FastmailInboxRow): Promise<void> {
  const password = await decryptCredential(inbox.imap_password);

  const client = new ImapFlow({
    host: inbox.imap_host,
    port: inbox.imap_port,
    secure: inbox.imap_tls,
    auth: { user: inbox.email_address, pass: password },
    logger: false,
  });

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');

    // Fetch UIDs of messages newer than the last known UID.
    const { data: lastEvent } = await supabase
      .from('inbox_events')
      .select('provider_message_id')
      .eq('inbox_id', inbox.id)
      .order('received_at', { ascending: false })
      .limit(1)
      .single();

    const sinceUid = lastEvent
      ? parseInt(lastEvent.provider_message_id) + 1
      : 1;

    const newMessages: string[] = [];
    for await (const msg of client.fetch(`${sinceUid}:*`, { uid: true })) {
      if (msg.uid >= sinceUid) {
        newMessages.push(String(msg.uid));
      }
    }

    if (newMessages.length > 0) {
      await supabase.from('inbox_events').insert(
        newMessages.map((uid) => ({
          inbox_id: inbox.id,
          provider: 'fastmail',
          provider_message_id: uid,
          received_at: new Date().toISOString(),
        }))
      );
    }
  } finally {
    await client.logout();
  }
}
```

---

## 6. Webhook Endpoint Implementation

### `supabase/functions/email-webhook/index.ts`

This single Edge Function handles all inbound webhook requests from Gmail (via Pub/Sub), Outlook (via Graph change notifications), and the subscription validation handshake for Outlook. It must acknowledge every valid request within 10 seconds and must return `200` even if downstream processing fails — failures are recorded and retried via the `inbox_events` staging table.

```typescript
// supabase/functions/email-webhook/index.ts
import { createClient } from '@supabase/supabase-js';
import { verifyGmailJWT, verifyOutlookClientState } from '../_shared/webhook-security.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ── Outlook subscription validation handshake ──────────────────────────────
  // Microsoft sends a GET with ?validationToken=<token> when first registering.
  // We must echo it back as text/plain within 10 s.
  const validationToken = url.searchParams.get('validationToken');
  if (req.method === 'GET' && validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const provider = url.searchParams.get('provider'); // 'gmail' | 'outlook'

  try {
    switch (provider) {
      case 'gmail':
        return await handleGmailNotification(req);
      case 'outlook':
        return await handleOutlookNotification(req);
      default:
        return new Response('Unknown provider', { status: 400 });
    }
  } catch (err) {
    // Never return a 5xx — the provider will retry aggressively and the queue
    // will grow. Log the error and return 200 so the provider considers it delivered.
    console.error(JSON.stringify({
      level: 'error',
      service: 'email-webhook',
      message: 'Unhandled webhook error',
      error: err instanceof Error ? err.message : String(err),
    }));
    return new Response('OK', { status: 200 });
  }
});

// ── Gmail handler ────────────────────────────────────────────────────────────

async function handleGmailNotification(req: Request): Promise<Response> {
  // Step 1: Verify the Pub/Sub push request is from Google.
  // Google signs the request with a JWT in the Authorization header.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const token = authHeader.slice(7);
  const isValid = await verifyGmailJWT(token, Deno.env.get('PUBSUB_AUDIENCE')!);
  if (!isValid) {
    return new Response('Invalid JWT', { status: 401 });
  }

  // Step 2: Decode the Pub/Sub message.
  const body = await req.json();
  const messageData = body?.message?.data;
  if (!messageData) {
    return new Response('Missing message.data', { status: 400 });
  }

  const decoded = JSON.parse(atob(messageData)) as {
    emailAddress: string;
    historyId: string;
  };

  // Step 3: Look up the inbox by email address.
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('id, workspace_id, gmail_history_id')
    .eq('email_address', decoded.emailAddress)
    .eq('provider', 'gmail')
    .eq('status', 'active')
    .is('deleted_at', null)
    .single();

  if (!inbox) {
    // Email address no longer associated with an active inbox. Acknowledge and ignore.
    return new Response('OK', { status: 200 });
  }

  // Step 4: Insert into inbox_events staging table for async processing.
  await supabase.from('inbox_events').insert({
    inbox_id: inbox.id,
    provider: 'gmail',
    provider_message_id: decoded.historyId,
    received_at: new Date().toISOString(),
  });

  // Step 5: Respond 200 immediately. Processing happens asynchronously.
  return new Response('OK', { status: 200 });
}

// ── Outlook handler ──────────────────────────────────────────────────────────

async function handleOutlookNotification(req: Request): Promise<Response> {
  const body = await req.json();
  const notifications = body?.value ?? [];

  for (const notification of notifications) {
    // Step 1: Verify the clientState matches the inboxId we stored on subscription.
    const inboxId: string | undefined = notification.clientState;
    if (!inboxId) continue;

    // Verify the inbox exists and is active.
    const { data: inbox } = await supabase
      .from('inboxes')
      .select('id, workspace_id')
      .eq('id', inboxId)
      .eq('provider', 'outlook')
      .eq('status', 'active')
      .is('deleted_at', null)
      .single();

    if (!inbox) continue;

    // Step 2: Insert the event for async processing.
    const messageId: string = notification.resourceData?.id ?? '';
    if (!messageId) continue;

    await supabase.from('inbox_events').insert({
      inbox_id: inbox.id,
      provider: 'outlook',
      provider_message_id: messageId,
      received_at: new Date().toISOString(),
    });
  }

  return new Response('OK', { status: 200 });
}
```

### Webhook Security Helpers

```typescript
// supabase/functions/_shared/webhook-security.ts

/**
 * Verifies a Google Pub/Sub JWT.
 * The token is signed by Google's service account and includes an `aud` claim
 * that must match the push endpoint URL registered for the subscription.
 */
export async function verifyGmailJWT(
  token: string,
  expectedAudience: string
): Promise<boolean> {
  try {
    // Fetch Google's public keys from their JWKS endpoint.
    const jwksResponse = await fetch(
      'https://www.googleapis.com/oauth2/v3/certs'
    );
    const jwks = await jwksResponse.json();

    // Decode the JWT header to find the key ID.
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64));
    const key = jwks.keys.find((k: { kid: string }) => k.kid === header.kid);
    if (!key) return false;

    // Import the public key and verify the signature.
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const [, payloadB64, signatureB64] = token.split('.');
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      signature,
      signedData
    );
    if (!valid) return false;

    // Verify the audience claim.
    const payload = JSON.parse(atob(payloadB64));
    return payload.aud === expectedAudience;
  } catch {
    return false;
  }
}
```

---

## 7. `inbox_events` Staging Table

### Purpose

The webhook endpoint must return `200` within 10 seconds (for Outlook) and within Google's acknowledgement deadline for Gmail (the Pub/Sub subscription's `ackDeadlineSeconds`, default 10 s). Full message processing — fetching the message body, parsing it, and updating the `activity_log` — can take several seconds per message. The staging table decouples the two concerns:

- **Webhook handler**: insert a minimal row into `inbox_events`, return `200`.
- **Processing worker**: read unprocessed events, do the slow work, mark as processed.

This architecture also provides at-least-once delivery semantics: if the processing worker crashes mid-batch, the events remain in `inbox_events` with `processed_at IS NULL` and will be retried on the next worker run.

### Schema

```sql
CREATE TABLE public.inbox_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id            uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  provider            text NOT NULL,           -- 'gmail' | 'outlook' | 'fastmail'
  provider_message_id text NOT NULL,           -- Gmail historyId, Graph messageId, or IMAP UID
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,             -- NULL = unprocessed
  error               text,                    -- set if processing failed; NULL on success
  retry_count         integer NOT NULL DEFAULT 0,
  UNIQUE (inbox_id, provider_message_id)       -- idempotent insert on duplicate delivery
);

-- Index for the processing worker's query pattern.
CREATE INDEX idx_inbox_events_unprocessed
  ON public.inbox_events (received_at ASC)
  WHERE processed_at IS NULL AND error IS NULL;

-- Partial index for retry logic.
CREATE INDEX idx_inbox_events_retry
  ON public.inbox_events (retry_count, received_at ASC)
  WHERE processed_at IS NULL AND error IS NOT NULL AND retry_count < 5;
```

The `UNIQUE (inbox_id, provider_message_id)` constraint makes the webhook handler idempotent: if Google re-delivers a Pub/Sub message (guaranteed-at-least-once semantics), the duplicate `INSERT` fails silently with a `409 Conflict` which the handler ignores.

### Processing Worker

```typescript
// supabase/functions/inbox-event-processor/index.ts
// Scheduled every 30 seconds via Supabase cron.

import { createClient } from '@supabase/supabase-js';
import { processGmailEvent } from '../_shared/providers/gmail.ts';
import { processOutlookEvent } from '../_shared/providers/outlook.ts';
import { processFastmailEvent } from '../_shared/providers/fastmail.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const BATCH_SIZE = 50;
const MAX_RETRIES = 5;

Deno.serve(async (_req) => {
  // Fetch a batch of unprocessed events, oldest first.
  const { data: events, error } = await supabase
    .from('inbox_events')
    .select(`
      id, inbox_id, provider, provider_message_id, retry_count,
      inboxes (
        id, workspace_id, provider, oauth_access_token, oauth_refresh_token,
        imap_host, imap_port, imap_tls, imap_password, email_address, gmail_history_id
      )
    `)
    .is('processed_at', null)
    .or('error.is.null,retry_count.lt.' + MAX_RETRIES)
    .order('received_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error || !events?.length) {
    return new Response('No events to process', { status: 200 });
  }

  const results = await Promise.allSettled(
    events.map((event) => processEvent(event))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(JSON.stringify({
    level: 'info',
    service: 'inbox-event-processor',
    message: `Processed batch`,
    succeeded,
    failed,
    total: events.length,
  }));

  return new Response(JSON.stringify({ succeeded, failed }), { status: 200 });
});

async function processEvent(event: InboxEventWithInbox): Promise<void> {
  try {
    switch (event.provider) {
      case 'gmail':
        await processGmailEvent(supabase, event);
        break;
      case 'outlook':
        await processOutlookEvent(supabase, event);
        break;
      case 'fastmail':
        await processFastmailEvent(supabase, event);
        break;
      default:
        throw new Error(`Unknown provider: ${event.provider}`);
    }

    // Mark as processed.
    await supabase
      .from('inbox_events')
      .update({ processed_at: new Date().toISOString(), error: null })
      .eq('id', event.id);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Record the error and increment retry count.
    await supabase
      .from('inbox_events')
      .update({
        error: errorMessage,
        retry_count: event.retry_count + 1,
      })
      .eq('id', event.id);

    // Re-throw so Promise.allSettled captures it as rejected.
    throw err;
  }
}
```

---

## 8. Postgres `NOTIFY` / `LISTEN` — Internal Mechanics

### How Supabase Realtime Uses `NOTIFY`

Under the hood, Supabase Realtime does not poll the database. It establishes a PostgreSQL replication connection and reads the WAL stream. However, for broadcast and presence features (not used in MCPEmails), and for understanding the event path, it is valuable to understand the `NOTIFY`/`LISTEN` mechanism that underpins the system.

When a row is inserted or updated in a replicated table, PostgreSQL writes the change to the WAL. The Realtime server, acting as a logical replication client, receives the change and internally calls a function equivalent to:

```sql
SELECT pg_notify(
  'realtime',
  json_build_object(
    'schema', 'public',
    'table',  'activity_log',
    'type',   'INSERT',
    'record', row_to_json(NEW)
  )::text
);
```

This is abstracted by the Supabase infrastructure — application code does not configure this directly. What application code does configure is which tables have `REPLICA IDENTITY FULL` and which RLS policies govern row visibility.

### Direct `pg_notify` for Application-Level Signals

There are cases where direct `NOTIFY`/`LISTEN` is appropriate: signalling between Edge Functions, triggering background jobs without an external queue, or sending a ping to a long-running process.

A trigger on `activity_log` that fires a direct notify is useful for internal processing pipelines that do not use WebSocket clients:

```sql
-- Trigger function: fires after every INSERT on activity_log.
CREATE OR REPLACE FUNCTION public.notify_audit_log_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'audit_log_insert',
    json_build_object(
      'id',           NEW.id,
      'workspace_id', NEW.workspace_id,
      'tool_name',    NEW.tool_name,
      'status',       NEW.status,
      'created_at',   NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_insert_notify
  AFTER INSERT ON public.activity_log
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_audit_log_insert();
```

A long-running process (e.g., a local development monitor) can listen on this channel:

```sql
LISTEN audit_log_insert;
-- Notifications arrive asynchronously via the connection's async message API.
```

**When to use `pg_notify` directly vs Supabase Realtime channels:**

| Scenario | Use |
|---|---|
| Delivering events to browser clients | Supabase Realtime channels (WebSocket, RLS-enforced) |
| Signalling between server-side processes | `pg_notify` / `LISTEN` directly |
| Triggering a queue consumer from a DB event | `pg_notify` trigger → consumer listens on connection |
| Fan-out to many browser clients with auth | Supabase Realtime (scales horizontally) |
| Low-latency internal ping (< 1 ms overhead) | `pg_notify` (no serialisation, no auth overhead) |

One important constraint: `pg_notify` payload is limited to 8000 bytes. Never include email body content or large JSONB blobs in a `NOTIFY` payload. Include only IDs and small metadata, then let the consumer fetch the full record if needed.

---

## 9. Security

### Never Broadcast Email Content

Email message bodies, subject lines, and sender/recipient addresses are never delivered over Realtime channels. The Supabase Realtime server does apply RLS before delivering rows, but defence in depth requires that the table structure itself does not expose sensitive content via INSERT/UPDATE events.

The `activity_log` table contains only operational metadata (`tool_name`, `status`, `duration_ms`, `api_key_id`, `inbox_id`) — never the content of the emails operated on. The `inboxes` table change events contain connection state metadata (`status`, `last_error`) but never the decrypted `oauth_access_token` or `imap_password` columns.

**Enforce at the RLS level:** The `SELECT` policy on `inboxes` should explicitly exclude encrypted columns from the Realtime-delivered payload by ensuring the subscribing role cannot `SELECT` those columns at all. Use column-level privileges:

```sql
-- Revoke select on encrypted columns from the authenticated role.
-- These columns are only read by service_role inside Edge Functions.
REVOKE SELECT ON COLUMN public.inboxes.oauth_access_token FROM authenticated;
REVOKE SELECT ON COLUMN public.inboxes.oauth_refresh_token FROM authenticated;
REVOKE SELECT ON COLUMN public.inboxes.imap_password       FROM authenticated;
```

With these column privileges revoked, even if a client subscribes to `inboxes` UPDATE events, the Realtime server will omit those columns from the delivered payload.

### Validate Workspace Membership Before Subscribing

The client must not simply pass any `workspaceId` to the hook — it must only subscribe to workspaces the authenticated user is a member of. Validate this server-side before rendering the client component:

```typescript
// In a Server Component or Route Handler, before passing workspaceId to a Client Component:
async function validateWorkspaceMembership(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .single();

  return !error && !!data;
}
```

If this check fails, do not render the subscription component. Return a `403` or redirect to the workspace list. The Supabase Realtime RLS policies are a second layer of protection, but the validation above ensures the browser never even initiates an unauthorised subscription.

### Webhook Endpoint Security

The webhook endpoint at `supabase/functions/email-webhook` must reject requests that cannot be verified:

- **Gmail (Pub/Sub):** Verify the JWT in the `Authorization` header using Google's public JWKS. Reject any request without a valid `Bearer` token. The audience (`aud`) claim must match the exact URL of the push endpoint, preventing tokens issued for other endpoints from being replayed.

- **Outlook (Graph):** Verify the `clientState` field in each notification matches the `inboxId` stored when the subscription was created. While not a cryptographic signature, it prevents arbitrary third parties from injecting fake notifications without knowing a valid inbox UUID. For production hardening, also validate the `odata.type` and restrict accepted IPs to Microsoft's published ranges.

- **Fastmail polling:** The poller is an internal Edge Function that does not accept external HTTP requests. No inbound webhook security is needed; the IMAP credentials are decrypted inside the trusted Edge Function environment.

**Rate-limit the webhook endpoint** to prevent denial-of-service via repeated POST floods:

```typescript
// In the webhook handler, before processing:
const RATE_LIMIT_RPM = 1000; // per source IP

// Supabase Edge Functions do not provide built-in rate limiting.
// Use a Redis counter (Upstash) or check against a rate_limits table.
// A simple implementation uses an in-memory Map with a 60-second window,
// but this does not persist across Edge Function cold starts.
// For production, integrate Upstash Redis rate limiting.
```

### Audit Trail for Webhook Events

Every `inbox_events` row that is successfully processed results in a row in `activity_log` with `tool_name = 'email_received'`. This ensures webhook-triggered events are traceable in the audit feed, even though they are not triggered by a user's MCP tool call.

---

## 10. Edge Function Cron Schedule

| Function | Schedule | Purpose |
|---|---|---|
| `fastmail-poller` | Every 30 s | Poll active Fastmail inboxes via IMAP |
| `inbox-event-processor` | Every 30 s | Process staged `inbox_events` |
| `gmail-watch-renewer` | Daily at 02:00 UTC | Renew Gmail `users.watch` subscriptions (expire after 7 days) |
| `outlook-subscription-renewer` | Daily at 02:30 UTC | Renew Graph change notification subscriptions (expire after ~3 days) |
| `activity-log-partition-creator` | Monthly on 25th at 00:00 UTC | Create next month's `activity_log` partition |

Configure these in Supabase using the `pg_cron` extension or the Supabase cron dashboard:

```sql
-- Example: schedule the inbox event processor every 30 seconds.
SELECT cron.schedule(
  'inbox-event-processor',
  '30 seconds',
  $$
    SELECT net.http_post(
      url     := current_setting('app.supabase_url') || '/functions/v1/inbox-event-processor',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      )
    );
  $$
);
```

---

## 11. Related Documents

- `database-schema.md` — Full table definitions including `activity_log`, `inboxes`, and `api_keys`
- `row-level-security.md` — RLS policies that govern Realtime channel row delivery
- `email-provider-oauth-flows.md` — OAuth flows for Gmail and Outlook, including token storage and refresh
- `imap-smtp-connection-management.md` — IMAP connection pooling and credential management for Fastmail
- `monitoring-and-observability.md` — Structured logging conventions used in Edge Functions
- `security-architecture.md` — Overall security model including credential encryption and key management
