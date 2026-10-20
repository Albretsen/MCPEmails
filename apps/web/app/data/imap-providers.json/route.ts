import { APP_URL } from '@/i18n/seo';
import { datasetJson } from '@/lib/connect/provider-dataset.mjs';

/**
 * GET /data/imap-providers.json
 *
 * The open IMAP/SMTP provider dataset documented at /docs/providers/data.
 * Built from providers.mjs on each request, so it follows the provider release
 * schedule and can never disagree with the page. CC BY 4.0, CORS-open so other
 * tools can fetch it directly.
 */
export function GET() {
  return new Response(`${JSON.stringify(datasetJson(APP_URL), null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
