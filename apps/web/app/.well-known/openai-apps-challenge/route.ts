/**
 * GET /.well-known/openai-apps-challenge
 *
 * Domain-control proof for the OpenAI plugin submission. OpenAI fetches this
 * while reviewing the MCPEmails listing and compares the body to the token it
 * issued for the draft, which is how it confirms we actually control the host
 * behind the MCP server URL.
 *
 * The response body must be the bare token and nothing else. OpenAI explicitly
 * rejects JSON, a list of tokens, or several tokens returned from one URL, so
 * do not "improve" this into a structured response. It is also matched on the
 * origin only: the challenge path is fixed and any path on the MCP hostname or
 * a parent hostname resolves here, so a second plugin on this same host would
 * collide with this token rather than get one of its own.
 *
 * The token is not a secret. It proves control of the domain to a party that
 * can already read the domain, and it grants nothing on its own.
 */
const TOKEN = 'KtGl1bFltZM89gP7JD5O1tcq46ctF28mYIKk75u7Xf8';

export function GET() {
  return new Response(TOKEN, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Short cache: a re-issued token has to be able to take effect quickly.
      'Cache-Control': 'max-age=300',
    },
  });
}
