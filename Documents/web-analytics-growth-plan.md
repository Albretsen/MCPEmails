# Early-growth web analytics plan

## Objective

Measure whether growth is constrained by discovery, signup, inbox connection, MCP-client connection, or first useful tool call. Use Vercel Web Analytics and custom events only; do not collect email content, message metadata, inbox addresses, API keys, OAuth tokens, prompt text, or any persistent cross-site identifier.

## Decisions this must answer

1. Which landing pages and referrers create activated users, not just visits?
2. Where does the activation funnel drop: signup, inbox connection, client setup, or first MCP call?
3. Which provider and MCP client are most successful, expressed only as aggregate event properties?
4. Did a release or campaign improve 7-day activation and retention?

## Instrumentation

Keep the existing `@vercel/analytics` page views plus `signup_completed` and `api_key_revealed`. Add the following client-safe, low-cardinality events:

| Event | When | Properties |
| --- | --- | --- |
| `signup_started` | User submits the signup form | `method` (`password` or OAuth provider) |
| `signup_completed` | Account creation succeeds | `method` |
| `inbox_connect_started` | User chooses a provider in Connect Inbox | `provider` (`gmail`, `imap`, `fastmail`, etc.) |
| `inbox_connected` | OAuth/app-password setup succeeds | `provider`, `connection_method` (`oauth` or `app_password`) |
| `mcp_connection_started` | User opens/copies the MCP endpoint or begins OAuth client connect | `client` when known; otherwise `unknown` |
| `mcp_connection_authorized` | OAuth authorization completes | `client`, `scope_profile` (`read_only`, `read_send`, `custom`) |
| `api_key_revealed` | Existing event; retain only for non-OAuth setup | `scope_profile` |
| `first_mcp_tool_call` | First successful MCP call for a workspace | `tool_name`, `provider`, `client` if captured server-side without joining identities into analytics |
| `activation_completed` | First successful email read/search/list after a connected inbox and client | `activation_path` (`oauth` or `api_key`) |

Do **not** send workspace IDs, user IDs, email addresses, raw URLs containing API keys, inbox IDs, message IDs, tool arguments, email subjects/bodies, attachments, or error payloads to Vercel Analytics.

## Implementation design

1. Create a small `analytics.js` wrapper with an allowlisted event name/property schema and a development-only assertion that rejects sensitive-looking keys/values.
2. Emit browser events only from explicit UI success points. OAuth and server-side connection success should redirect with a short-lived, non-identifying status code that the dashboard consumes once and converts to the event.
3. For `first_mcp_tool_call`, record a minimal first-use marker in the application database or activity log, then surface one aggregate client event after the next authenticated dashboard load. Do not call browser analytics from the MCP edge function and do not export request data.
4. Preserve the current no-email-storage guarantee: analytics is product-funnel telemetry, not email telemetry.
5. Add a weekly dashboard review: visits by landing page/referrer, signup conversion, inbox-connect conversion, activation conversion, and first-tool-call conversion.

## Copy and policy changes

Before enabling the new events, update all five locale variants of:

- Homepage privacy claim: replace any blanket statement such as “no analytics or third-party tracking” with “We use privacy-preserving product analytics to understand site and setup performance. We never collect email content, addresses, API keys, or MCP request data.”
- Privacy policy: add a "Product analytics" section naming Vercel Analytics, the categories above, purpose, retention/provider link, and opt-out/cookie position if applicable.
- Cookie/consent notice: only add one if the final Vercel configuration uses cookies or any non-essential identifier. If it remains cookieless, state that no consent banner is required under the selected policy but document the decision.
- Docs/security FAQ: add a short answer distinguishing website/product analytics from mailbox data and MCP traffic.

## Acceptance criteria

- Vercel Web Analytics is enabled in the production project.
- Events appear in production with only the documented properties.
- Automated tests cover the allowlist and reject representative sensitive fields.
- A manual QA run confirms signup → inbox connection → first read and confirms no sensitive values reach analytics requests.
- Privacy/FAQ copy is localized in English, Norwegian, Spanish, French, and Chinese before release.

## Implementation-agent prompt

> Implement `Documents/web-analytics-growth-plan.md` in the MCPEmails web app. Use `@vercel/analytics` only; do not add another analytics vendor. First inspect the existing analytics calls and privacy copy. Build an allowlisted analytics wrapper, instrument the documented early-growth funnel events, and ensure no user ID, workspace ID, email address, inbox ID, API key, token, MCP request, prompt, or mailbox content is sent. Add tests for the wrapper and update the privacy, homepage/FAQ, and security/documentation copy in all five locales. Do not enable Vercel Analytics in the dashboard or change any external settings. Run the production build and report the event schema, changed files, test evidence, and any point that still requires an owner decision.
