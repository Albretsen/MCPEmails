import https from 'node:https';
import type { HostLookup } from '@/lib/email/host-guard';
import { validateWebhookUrl, type WebhookUrlCode } from './url.ts';

/**
 * One webhook POST from the web app (the dashboard's "Send test"). Real
 * deliveries go from the client-api edge function; this is the same contract:
 *
 *   - the URL is validated and its host resolved through the SSRF guard right
 *     before the request, and the APPROVED ADDRESS is dialled (the `lookup`
 *     hook below), with SNI and the certificate still checked against the name,
 *     exactly as lib/oauth/cimd.ts does;
 *   - one deadline of 10 seconds;
 *   - redirects are never followed: `https.request` does not, and a 3xx is
 *     reported as its status;
 *   - only the status is read; the body is discarded unread.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
const USER_AGENT = 'MCPEmails-Webhooks/1.0 (+https://mcpemails.com/docs)';

export type WebhookSendResult =
  | { kind: 'response'; status: number }
  | { kind: 'error'; code: WebhookUrlCode | 'timeout' | 'connect_failed' };

export interface PostWebhookOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  /** Tests: the resolver the guard uses. */
  lookup?: HostLookup;
  /** Tests: stands in for the pinned https request. */
  request?: (target: { host: string; port: number; path: string; hostHeader: string; address: string; family: 4 | 6 }, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<number>;
}

function pinnedRequest(
  target: { host: string; port: number; path: string; hostHeader: string; address: string; family: 4 | 6 },
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const req = https.request(
      {
        protocol: 'https:',
        hostname: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        servername: target.host,
        headers: {
          ...headers,
          Host: target.hostHeader,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          Connection: 'close',
        },
        lookup: (
          _hostname: string,
          opts: { all?: boolean },
          cb: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
        ) => {
          if (opts && opts.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve(status);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('webhook_deadline')), timeoutMs);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('webhook_timeout')));
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    req.end(payload);
  });
}

export async function postWebhook(options: PostWebhookOptions): Promise<WebhookSendResult> {
  const verdict = await validateWebhookUrl(options.url, { lookup: options.lookup });
  if (!verdict.ok) return { kind: 'error', code: verdict.code };
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const clean = Object.fromEntries(
    Object.entries(options.headers).map(([k, v]) => [k.replace(/[\r\n]/g, ''), v.replace(/[\r\n]/g, '')]),
  );
  try {
    const status = await (options.request ?? pinnedRequest)(
      { ...verdict.url, address: verdict.address, family: verdict.family },
      clean,
      options.body,
      timeoutMs,
    );
    return status >= 100 && status <= 599 ? { kind: 'response', status } : { kind: 'error', code: 'connect_failed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { kind: 'error', code: /deadline|timeout/.test(message) ? 'timeout' : 'connect_failed' };
  }
}
