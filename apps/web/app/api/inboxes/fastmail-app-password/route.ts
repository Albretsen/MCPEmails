import { NextRequest, NextResponse } from 'next/server';
import * as tls from 'tls';
import { createClient } from '@/lib/supabase/server';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit } from '@/lib/plans/check-inbox-limit';

/**
 * POST /api/inboxes/fastmail-app-password
 *
 * Connects a Fastmail inbox using an app password (as an alternative to OAuth).
 * The handler:
 *
 *  1. Validates the authenticated user and resolves their workspace.
 *  2. Sanitises and validates the submitted email + app password fields.
 *  3. Opens a TLS socket to imap.fastmail.com:993 and attempts AUTH PLAIN.
 *     If authentication fails the request is rejected with a 422 and no data
 *     is persisted.
 *  4. AES-256-GCM encrypts the app password before any database write.
 *  5. Upserts the inbox row (conflict target: workspace_id + email_address)
 *     so reconnection reuses the same UUID, preserving activity_log references.
 *
 * Security:
 *  - The app password is never logged.
 *  - The plaintext app password is only held in memory for the duration of
 *    the IMAP validation call and the encryptToken call.
 *  - The encrypted value is stored in imap_password; oauth_* columns are NULL.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §4 (app-password section)
 *   Documents/Architecture/imap-smtp-connection-management.md §5 (Fastmail)
 */

const FASTMAIL_IMAP_HOST = 'imap.fastmail.com';
const FASTMAIL_IMAP_PORT = 993;

/** Hard connection + auth timeout in milliseconds. */
const IMAP_TIMEOUT_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValidateResult {
  ok: true;
}

interface ValidateError {
  ok: false;
  code:
    | 'AUTH_FAILED'
    | 'CONNECTION_REFUSED'
    | 'CONNECTION_TIMEOUT'
    | 'TLS_HANDSHAKE_FAILED'
    | 'IMAP_PROTOCOL_ERROR';
  message: string;
}

// ─── IMAP PLAIN validation ────────────────────────────────────────────────────

/**
 * Builds the base64-encoded PLAIN SASL token.
 *
 * Structure before encoding: \x00<username>\x00<password>
 * This is safe to transmit because the socket is TLS-encrypted.
 */
function buildPlainAuthToken(username: string, password: string): string {
  // \x00 is the NUL byte used as a field delimiter in SASL PLAIN.
  return Buffer.from(`\x00${username}\x00${password}`, 'utf8').toString('base64');
}

/**
 * Reads lines from a TLS socket until a line beginning with `tag` is seen.
 *
 * Returns the status ('OK', 'NO', or 'BAD') and all collected lines.
 * Rejects if no tagged response is seen within the timeout (controlled by
 * the outer timeout Promise in validateImapAppPassword).
 */
function readTaggedResponse(
  socket: tls.TLSSocket,
  tag: string
): Promise<{ status: 'OK' | 'NO' | 'BAD'; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines: string[] = [];

    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      let newline: number;

      while ((newline = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        lines.push(line);

        if (line.startsWith(`${tag} OK`)) {
          cleanup();
          resolve({ status: 'OK', lines });
          return;
        }
        if (line.startsWith(`${tag} NO`)) {
          cleanup();
          resolve({ status: 'NO', lines });
          return;
        }
        if (line.startsWith(`${tag} BAD`)) {
          cleanup();
          resolve({ status: 'BAD', lines });
          return;
        }
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * Reads the initial server greeting line from the IMAP socket.
 *
 * Resolves with the first complete line received. Rejects on socket error.
 */
function readGreeting(socket: tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\r\n');
      if (newline !== -1) {
        cleanup();
        resolve(buffer.slice(0, newline));
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * Validates a Fastmail app password by opening a real IMAP connection and
 * attempting AUTH PLAIN. Returns immediately on the first definitive answer
 * (auth success or failure) and always closes the socket.
 *
 * The entire operation is bounded by IMAP_TIMEOUT_MS. Any timeout, refused
 * connection, or TLS error is surfaced as a typed ValidateError.
 */
async function validateImapAppPassword(
  email: string,
  appPassword: string
): Promise<ValidateResult | ValidateError> {
  const timeout = new Promise<ValidateError>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          code: 'CONNECTION_TIMEOUT',
          message: 'IMAP connection timed out. Fastmail may be temporarily unreachable.',
        }),
      IMAP_TIMEOUT_MS
    )
  );

  const attempt = (async (): Promise<ValidateResult | ValidateError> => {
    let socket: tls.TLSSocket | null = null;

    try {
      // 1. Open TLS socket — implicit TLS on port 993 (no STARTTLS).
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect(
          { host: FASTMAIL_IMAP_HOST, port: FASTMAIL_IMAP_PORT, servername: FASTMAIL_IMAP_HOST },
          () => resolve(s)
        );
        s.once('error', reject);
      });

      // 2. Read and validate the server greeting.
      const greeting = await readGreeting(socket);
      if (!greeting.startsWith('* OK')) {
        return {
          ok: false,
          code: 'IMAP_PROTOCOL_ERROR',
          message: 'IMAP server returned an unexpected greeting.',
        };
      }

      // 3. Authenticate using SASL PLAIN.
      //    Token structure: \x00username\x00password (base64-encoded).
      const plainToken = buildPlainAuthToken(email, appPassword);
      socket.write(`A0001 AUTHENTICATE PLAIN ${plainToken}\r\n`);

      const authResult = await readTaggedResponse(socket, 'A0001');

      if (authResult.status !== 'OK') {
        return {
          ok: false,
          code: 'AUTH_FAILED',
          message:
            'Authentication failed. Check that the email address and app password are correct, ' +
            'and that the app password was generated with IMAP access enabled.',
        };
      }

      // 4. Auth succeeded — issue LOGOUT before closing.
      socket.write('A0002 LOGOUT\r\n');
      // We don't need to wait for the LOGOUT response; just close cleanly.
      return { ok: true };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;

      if (error.code === 'ECONNREFUSED') {
        return {
          ok: false,
          code: 'CONNECTION_REFUSED',
          message: 'Could not connect to the Fastmail IMAP server.',
        };
      }

      if (
        error.code === 'CERT_HAS_EXPIRED' ||
        error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        (error.message && error.message.toLowerCase().includes('tls'))
      ) {
        return {
          ok: false,
          code: 'TLS_HANDSHAKE_FAILED',
          message: 'Could not establish a secure TLS connection to the Fastmail IMAP server.',
        };
      }

      return {
        ok: false,
        code: 'IMAP_PROTOCOL_ERROR',
        message: 'An unexpected error occurred while connecting to Fastmail.',
      };
    } finally {
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
    }
  })();

  return Promise.race([attempt, timeout]);
}

// ─── User-facing error messages ───────────────────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  AUTH_FAILED:
    'Incorrect email or app password. Make sure you are using a Fastmail ' +
    'app password (not your main Fastmail password).',
  CONNECTION_REFUSED:
    'Could not connect to the Fastmail IMAP server. Please try again.',
  CONNECTION_TIMEOUT:
    'The connection to Fastmail timed out. Please try again.',
  TLS_HANDSHAKE_FAILED:
    'Could not establish a secure connection to Fastmail. Please try again.',
  IMAP_PROTOCOL_ERROR:
    'An unexpected IMAP error occurred. Please try again.',
};

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify the user is authenticated.
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Resolve the user's workspace.
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // 3. Enforce plan inbox cap before doing any IMAP validation or DB writes.
  //    Return 402 (Payment Required) so the client can distinguish a plan
  //    limit from a credential error.
  const inboxLimit = await checkInboxLimit(supabase, member.workspace_id);
  if (inboxLimit.atLimit) {
    const capLabel = inboxLimit.maxInboxes === 1
      ? '1 inbox'
      : `${inboxLimit.maxInboxes} inboxes`;
    return NextResponse.json(
      {
        error: `Your ${inboxLimit.plan} plan allows ${capLabel}. ` +
          `Upgrade at mcpemails.com/pricing to connect more.`,
        error_code: 'inbox_limit_reached',
        plan: inboxLimit.plan,
        current_count: inboxLimit.currentCount,
        max_inboxes: inboxLimit.maxInboxes,
      },
      { status: 402 }
    );
  }

  // 5. Parse and validate the request body.
  let email: string;
  let appPassword: string;

  try {
    const body = (await request.json()) as { email?: unknown; appPassword?: unknown };
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    appPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 422 });
  }

  if (!appPassword || appPassword.length < 8) {
    return NextResponse.json({ error: 'App password is required.' }, { status: 422 });
  }

  // 6. Validate via IMAP before persisting anything.
  const validation = await validateImapAppPassword(email, appPassword);

  if (!validation.ok) {
    const userMessage = ERROR_MESSAGES[validation.code] ?? 'Connection failed. Please try again.';
    return NextResponse.json({ error: userMessage }, { status: 422 });
  }

  // 7. Encrypt the app password — never store plaintext.
  const encryptedPassword = encryptToken(appPassword);

  // 8. Upsert the inbox row.
  //    Conflict target: workspace_id + email_address (partial index WHERE deleted_at IS NULL).
  //    This ensures reconnection reuses the same UUID, keeping activity_log references intact.
  const { error: upsertError } = await supabase.from('inboxes').upsert(
    {
      workspace_id: member.workspace_id,
      provider: 'fastmail',
      email_address: email,
      imap_host: FASTMAIL_IMAP_HOST,
      imap_port: FASTMAIL_IMAP_PORT,
      imap_tls: true,
      smtp_host: 'smtp.fastmail.com',
      smtp_port: 465,
      smtp_tls: true,
      imap_password: encryptedPassword,
      // OAuth fields are NULL for app-password connections.
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      oauth_scope: null,
      status: 'active',
      last_error: null,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: 'workspace_id, email_address',
      ignoreDuplicates: false,
    }
  );

  if (upsertError) {
    console.error('[fastmail-app-password] Upsert failed:', upsertError.message);
    return NextResponse.json(
      { error: 'Failed to save inbox. Please try again.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
