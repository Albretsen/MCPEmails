# Installing MCP Emails (instructions for an AI assistant)

You are setting up the MCP Emails server for a user. Follow these steps exactly.

MCP Emails is a **hosted** server. There is nothing to clone, build or compile. The npm package `mcpemails` is a thin stdio bridge that forwards JSON-RPC to `https://mcpemails.com/api/mcp`, for clients that can only launch a local command.

## Step 1: get an API key from the user

The user must create the key themselves at <https://mcpemails.com/dashboard/keys>. It looks like `mcpe_` followed by 64 hexadecimal characters.

Ask them to paste it. Do not try to generate, guess or retrieve a key yourself, and do not write the key anywhere except the MCP settings file in step 2.

If the user has no account yet, tell them to sign up at <https://mcpemails.com> and connect an inbox (Gmail, Fastmail, iCloud, Yahoo, Zoho, Yandex, or any IMAP/SMTP mailbox) before creating the key.

Suggest they scope the key to what they actually want the agent to do. A key issued with read scopes only cannot send or delete mail regardless of what any agent asks for.

## Step 2: add the server to the MCP settings file

Add this entry to the `mcpServers` object, substituting the user's real key:

```json
{
  "mcpServers": {
    "mcpemails": {
      "command": "npx",
      "args": ["-y", "mcpemails"],
      "env": {
        "MCPEMAILS_API_KEY": "mcpe_REPLACE_WITH_THE_USERS_KEY"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Keep `autoApprove` empty. Email is a side-effectful, irreversible surface: `email_compose` sends real mail and `email_delete` removes real messages. Only add read-only tool names such as `inbox_list` or `email_read` if the user explicitly asks.

Requires Node 18 or newer. There is no other dependency and no build step.

## Step 3: verify

Restart or reload the MCP servers, then call the `inbox_list` tool. A successful response lists the user's connected inboxes with their `inbox_id` values. That confirms the key, the bridge and the network path all work.

If it fails:

- **"No API key"** means the client did not pass the environment variable. Confirm it is in the `env` block of the settings file, not just the shell.
- **"not in the expected format"** means the key is truncated. It must be exactly `mcpe_` plus 64 hex characters. Ask the user for the full key; keys are shown in full only once, at creation.
- **"Invalid or revoked API key"** means the key was deleted or expired. The user must create a new one.
- **`npx` not found** means Node is missing or the client did not inherit PATH. Use the absolute path from `which npx` as `command`.

## Alternative: skip the bridge

If the client supports remote MCP servers natively, do not install the npm package. Point the client at `https://mcpemails.com/api/mcp` directly with an `Authorization: Bearer mcpe_...` header, or let it run the OAuth flow.
