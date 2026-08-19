# mcpemails

Email for AI agents. Read, search, send, organize, draft and schedule email across your inboxes from any MCP client.

This package is a **stdio bridge**. [MCP Emails](https://mcpemails.com) is a hosted MCP server that speaks JSON-RPC over HTTPS, and many MCP clients can only launch a local command and talk over stdin/stdout. `mcpemails` sits between the two: it forwards every JSON-RPC message from your client to `https://mcpemails.com/api/mcp` and writes every response straight back. It adds nothing to the protocol.

Works with Gmail, Outlook, Fastmail, and any IMAP/SMTP mailbox you connect at [mcpemails.com](https://mcpemails.com).

## Quick start

1. Sign up at [mcpemails.com](https://mcpemails.com) and connect an inbox.
2. Create an API key at [mcpemails.com/dashboard/keys](https://mcpemails.com/dashboard/keys). It looks like `mcpe_` followed by 64 hex characters. Give it only the scopes you want the agent to have.
3. Drop one of the config blocks below into your client and restart it.

Nothing to install. `npx -y mcpemails` fetches the package on first run.

## Configuration

Every client below uses the same three things: the command `npx`, the args `["-y", "mcpemails"]`, and your key in the `MCPEMAILS_API_KEY` environment variable. Replace `mcpe_your_key_here` with your own key.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcpemails": {
      "command": "npx",
      "args": ["-y", "mcpemails"],
      "env": {
        "MCPEMAILS_API_KEY": "mcpe_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The email tools appear under the connectors icon.

### Cursor

Edit `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside one project:

```json
{
  "mcpServers": {
    "mcpemails": {
      "command": "npx",
      "args": ["-y", "mcpemails"],
      "env": {
        "MCPEMAILS_API_KEY": "mcpe_your_key_here"
      }
    }
  }
}
```

Then open Settings, MCP, and confirm the server shows a green status.

### Cline

Open the MCP Servers panel, choose Configure MCP Servers, and add this to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "mcpemails": {
      "command": "npx",
      "args": ["-y", "mcpemails"],
      "env": {
        "MCPEMAILS_API_KEY": "mcpe_your_key_here"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Leaving `autoApprove` empty means Cline asks before every call. Add read-only tool names such as `"inbox_list"` and `"email_read"` if you want those to run without a prompt; think twice before auto-approving `email_compose`, `email_delete` or `schedule`.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mcpemails": {
      "command": "npx",
      "args": ["-y", "mcpemails"],
      "env": {
        "MCPEMAILS_API_KEY": "mcpe_your_key_here"
      }
    }
  }
}
```

Then press Refresh in the Cascade MCP panel.

### Claude Code

```bash
claude mcp add mcpemails --env MCPEMAILS_API_KEY=mcpe_your_key_here -- npx -y mcpemails
```

### Any other stdio client

```bash
MCPEMAILS_API_KEY=mcpe_your_key_here npx -y mcpemails
```

The process reads newline-delimited JSON-RPC on stdin and writes newline-delimited JSON-RPC on stdout.

## Do you actually need this bridge?

If your client supports remote MCP servers natively, you do not. Point it straight at:

```
https://mcpemails.com/api/mcp
```

with an `Authorization: Bearer mcpe_...` header, or let it run the OAuth flow. Claude.ai and other remote-capable clients take that path. Use this package when your client can only spawn a local command.

## Tools

| Tool | Actions |
| --- | --- |
| `inbox_list` | list the inboxes the key can reach |
| `email_read` | `list`, `read`, `read_batch`, `search`, `attachment` |
| `email_organize` | `move`, `move_batch`, `copy`, `copy_batch`, `flag`, `archive`, `search_and_move` |
| `email_delete` | `delete`, `delete_batch`, `search_and_delete` |
| `email_compose` | `send`, `reply`, `forward` |
| `folder` | `list`, `create`, `rename`, `delete` |
| `draft` | `list`, `create`, `update`, `send` |
| `schedule` | `create`, `list`, `cancel` |
| `signature` | `get`, `set` |
| `contact_search` | search the address book |

Each tool is gated by the scopes on your API key, so a key issued with read scopes only cannot send or delete anything no matter what the agent asks for. Full reference at [mcpemails.com/docs](https://mcpemails.com/docs).

## Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--key <mcpe_...>` | `MCPEMAILS_API_KEY` | required |
| `--url <url>` | `MCPEMAILS_URL` | `https://mcpemails.com/api/mcp` |
| `--verbose` | | off |
| `--version`, `--help` | | |

Prefer the environment variable over `--key`. Command-line arguments are visible to any other process on the machine that can list processes.

`--url` exists for self-hosting. The MCP Emails server is source-available and can be run on your own infrastructure; see [the repository](https://github.com/Albretsen/MCPEmails) and [mcpemails.com/security](https://mcpemails.com/security).

## Where your key goes

- It is sent in the `Authorization` header, over HTTPS, to the configured endpoint and nowhere else.
- It is never written to disk, never printed to stdout, and never included in the diagnostics this process writes to stderr. `--verbose` logs method names and HTTP status codes only, never bodies or credentials.
- There is no telemetry, no analytics, and no network call to any host other than the endpoint you configure.

Revoke a key at any time from [the dashboard](https://mcpemails.com/dashboard/keys); revocation takes effect on the next request.

## Troubleshooting

**"No API key"** — the client did not pass `MCPEMAILS_API_KEY`. Some clients ignore a shell's exported environment and only read the `env` block in their config file, so put the key there.

**"The API key is not in the expected format"** — the key is `mcpe_` plus exactly 64 hex characters. A truncated paste, or the shortened prefix the dashboard displays for an existing key, will not authenticate. Keys are shown in full only once, at creation.

**"Invalid or revoked API key"** — the key was deleted or has expired. Create a new one.

**Server shows as failed, no other detail** — run it by hand to see the real error:

```bash
MCPEMAILS_API_KEY=mcpe_your_key_here npx -y mcpemails --verbose
```

then paste an initialize request and press Enter:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
```

**`npx` not found** — install Node 18 or newer. Some clients do not inherit your shell's PATH, in which case give `command` the absolute path to `npx` (`which npx`).

## Requirements

Node 18 or newer. No dependencies.

## License

AGPL-3.0-only. See [LICENSE](./LICENSE).
