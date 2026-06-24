/**
 * GET /.well-known/security.txt
 *
 * Vulnerability disclosure contact, per RFC 9116. Lets security researchers
 * find a responsible-disclosure path without guessing. The human-readable
 * policy (including safe harbour) lives at /security.
 *
 * `Expires` must be in the future; bump EXPIRES_ISO before it lapses.
 * No authentication required. Served as text/plain.
 */
const EXPIRES_ISO = '2027-06-24T00:00:00.000Z';

export function GET() {
  const body = [
    'Contact: mailto:security@mcpemails.com',
    `Expires: ${EXPIRES_ISO}`,
    'Preferred-Languages: en',
    'Canonical: https://mcpemails.com/.well-known/security.txt',
    'Policy: https://mcpemails.com/security',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'max-age=86400',
    },
  });
}
