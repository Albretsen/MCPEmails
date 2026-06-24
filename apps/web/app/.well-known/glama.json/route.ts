/**
 * GET /.well-known/glama.json
 *
 * Glama connector ownership verification. Glama fetches this document from the
 * server's own domain to confirm that whoever publishes it controls the domain,
 * which lets the owner claim and edit the auto-generated MCP Emails connector
 * listing at https://glama.ai/mcp/connectors.
 *
 * The maintainer email MUST match the email on the Glama account doing the
 * claim. Glama auto-detects and verifies within a few minutes of publishing.
 *
 * No authentication required. Readable cross-origin.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function GET() {
  return Response.json(
    {
      $schema: 'https://glama.ai/mcp/schemas/connector.json',
      maintainers: [{ email: 'bjellanda@gmail.com' }],
    },
    {
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'max-age=3600',
      },
    }
  );
}
