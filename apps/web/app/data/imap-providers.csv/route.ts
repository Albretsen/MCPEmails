import { APP_URL } from '@/i18n/seo';
import { datasetCsv } from '@/lib/connect/provider-dataset.mjs';

/**
 * GET /data/imap-providers.csv
 *
 * The same rows as /data/imap-providers.json, one provider per line. List
 * fields (imapAuth, smtpAuth) are space-separated inside their cell.
 */
export function GET() {
  return new Response(datasetCsv(APP_URL), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'inline; filename="imap-providers.csv"',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
