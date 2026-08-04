# Synthetic monitoring: identity and secret contract

This document defines the production identity used by the synthetic monitor.
It is intentionally separate from customer and founder accounts. No secret
value belongs in this repository, the database, logs, or test fixtures.

## Monitor identity

Create one dedicated MCPEmails user and one connected mailbox for synthetic
monitoring.

| Item | Required value |
| --- | --- |
| MCPEmails account | A dedicated production account, used only by the monitor |
| Connected inbox | A dedicated mailbox, used only by the monitor |
| API key scopes | `read:email`, `send:email` only |
| Alert recipient | `hello@mcpemails.com` |
| MCP endpoint under test | `https://mcpemails.com/api/mcp` |
| Initial provider coverage | One representative provider; record which provider in the run result |

The monitor must never use a customer mailbox, an operator's personal mailbox,
or a broadly scoped API key. The connected inbox must be able to send to
`hello@mcpemails.com` and should be named clearly (for example,
`MCPEmails Production Monitor`).

## Production Edge Function secrets

Configure these as Supabase Edge Function secrets before enabling the future
`synthetic-monitor` function. Do not add them to `.env.example`; they are
production-only credentials.

| Secret | Purpose | Rules |
| --- | --- | --- |
| `SYNTHETIC_MCP_API_KEY` | Authenticates direct JSON-RPC calls to the public MCP API | Dedicated monitor key; scopes limited to read/send |
| `SYNTHETIC_MONITOR_TOKEN` | Authenticates the Cron-to-function request | Generate a unique high-entropy value; do not reuse any existing secret |
| `SYNTHETIC_ALERT_RECIPIENT` | Destination for incident and recovery emails | Set to `hello@mcpemails.com` |
| `SYNTHETIC_MCP_ENDPOINT` | Public endpoint being checked | Set to `https://mcpemails.com/api/mcp` |

The later Cron migration will also place its scheduler credentials and project
URL in Supabase Vault. Those are distinct from the Edge Function secrets above.

## Operational guarantees

- Every run will call the public branded endpoint, never the raw Edge Function
  URL, so it covers Vercel, the proxy, the MCP server, and the provider path.
- The monitor will persist only timestamps, step outcomes, durations,
  sanitized failure codes, and correlation IDs. It must not persist headers,
  API keys, email bodies, or raw provider responses.
- Routine health checks are read-only and never email canaries. Monitoring
  emails are sent through MCPEmails only for incident and recovery notices.
- API-key rotation is a two-step operation: create a replacement limited key,
  update `SYNTHETIC_MCP_API_KEY`, run a manual health check, then revoke the
  previous key.

## Owner handoff checklist

Before Part 2 (persistent monitor state), the service owner must provide:

- [ ] The dedicated monitor mailbox is connected in the production MCPEmails
      account and can send to `hello@mcpemails.com`.
- [ ] A new API key with only `read:email` and `send:email` has been created.
- [ ] The key has been saved in the production Supabase secret
      `SYNTHETIC_MCP_API_KEY`.

The implementation can proceed without the real key, but live end-to-end
verification and the production schedule must wait for these items.
