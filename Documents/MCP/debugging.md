# Debugging MCP Integrations

> A comprehensive guide to debugging Model Context Protocol (MCP) integrations

Effective debugging is essential when developing MCP servers or integrating them with applications. This guide covers the debugging tools and approaches available in the MCP ecosystem.

## Debugging Tools Overview

MCP provides several tools for debugging at different levels:

1. **MCP Inspector**: Interactive, transport-agnostic testing UI. Connect to stdio or Streamable HTTP servers, invoke tools, prompts, and resources, and watch the notification stream. **This should be your first stop.**
2. **Server logging**: Structured logs to stderr (stdio transport) or via `notifications/message` (all transports).
3. **Client developer tools**: Most MCP clients expose logs and connection state.

## Implementing Logging

### Server-side logging

When building a server that uses the local stdio transport, all messages logged to stderr (standard error) will be captured by the host application automatically.

> **Warning**: Local MCP servers should not log messages to stdout (standard out), as this will interfere with protocol operation.

For servers using the Streamable HTTP transport, stderr is not captured by the client. Use log message notifications, your own server-side log aggregation, or standard HTTP tooling to inspect requests.

For all transports, you can provide logging to the client by sending a log message notification:

```python
# Python
@server.tool()
async def my_tool(ctx: Context) -> str:
    await ctx.session.send_log_message(
        level="info",
        data="Server started successfully",
    )
    return "done"
```

```typescript
// TypeScript
await server.sendLoggingMessage({
  level: "info",
  data: "Server started successfully",
});
```

MCP defines eight RFC 5424 severity levels (`debug` through `emergency`). Clients can adjust the minimum level at runtime via the `logging/setLevel` request.

**Important events to log:**
* Initialization steps
* Resource access
* Tool execution
* Error conditions
* Performance metrics

## Common Issues

### Working directory

When an MCP client launches a stdio server:
* The working directory may be undefined (like `/` on macOS)
* Always use absolute paths in your configuration and `.env` files

For example in `claude_desktop_config.json`, use:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/data"]
    }
  }
}
```

Not relative paths like `./data`.

### Environment variables

MCP servers launched over stdio inherit only a limited subset of environment variables. Override them via `env` key:

```json
{
  "mcpServers": {
    "myserver": {
      "command": "mcp-server-myapp",
      "env": {
        "MYAPP_API_KEY": "some_key"
      }
    }
  }
}
```

### Server initialization

Common initialization problems:

1. **Path Issues**: Incorrect server executable path, missing required files, permission problems — try using an absolute path for `command`
2. **Configuration Errors**: Invalid JSON syntax, missing required fields, type mismatches
3. **Environment Problems**: Missing environment variables, incorrect variable values, permission restrictions

### Connection problems

When servers fail to connect:

1. Check client logs
2. Verify server process is running
3. Test standalone with the MCP Inspector
4. Verify protocol compatibility
5. Check capability negotiation: error `-32602` is the standard JSON-RPC "Invalid params" code. One common cause is a server sending sampling or elicitation requests to a client that hasn't declared that capability. Inspect the `initialize` exchange to verify both sides declared what you expect.

## Debugging in Claude Desktop

### Checking server status

Click the "Add files, connectors, and more" plus icon in the chat input, then hover over the **Connectors** menu to see connected servers and available tools.

### Viewing logs

Log files are written to:
* **macOS**: `~/Library/Logs/Claude`
* **Windows**: `%APPDATA%\Claude\logs`

```bash
# macOS
tail -n 20 -F ~/Library/Logs/Claude/mcp*.log

# Windows
type "$env:AppData\Claude\logs\mcp*.log"
```

The logs capture:
* Server connection events
* Configuration issues
* Runtime errors
* Message exchanges

### Using Chrome DevTools

Access Chrome's developer tools inside Claude Desktop:

1. Create `developer_settings.json` with `allowDevTools: true`:

```bash
# macOS
echo '{"allowDevTools": true}' > ~/Library/Application\ Support/Claude/developer_settings.json

# Windows
'{"allowDevTools": true}' | Set-Content "$env:AppData\Claude\developer_settings.json"
```

2. Open DevTools: `Command-Option-I` (macOS) or `Ctrl+Alt+I` (Windows)

Use the Console panel to inspect client-side errors and the Network panel to inspect message payloads and connection timing.

## Debugging Workflow

### Development cycle

1. **Initial Development**
   * Use MCP Inspector for basic testing
   * Implement core functionality
   * Add logging points

2. **Integration Testing**
   * Test in your target MCP client
   * Monitor logs
   * Check error handling

### Testing changes

* **Configuration changes**: Restart the MCP client
* **Server code changes**: Restart the client (for Claude Desktop, fully quit and reopen; closing the window is not enough)
* **Quick iteration**: Use MCP Inspector during development

## Best Practices

### Logging strategy

1. **Structured Logging**: Use consistent formats, include context, add timestamps, track request IDs
2. **Error Handling**: Log stack traces, include error context, track error patterns, monitor recovery
3. **Performance Tracking**: Log operation timing, monitor resource usage, track message sizes, measure latency

### Security considerations when debugging

1. **Sensitive Data**: Sanitize logs, protect credentials, mask personal information
2. **Access Control**: Verify permissions, check authentication, monitor access patterns

## Getting Help

When encountering issues:

1. **First Steps**: Check server logs, test with Inspector, review configuration, verify environment
2. **Support Channels**:
   * GitHub issues: https://github.com/modelcontextprotocol/modelcontextprotocol/issues
   * GitHub discussions: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions
3. **Providing Information**: Log excerpts, configuration files, steps to reproduce, environment details

---

*Source: https://modelcontextprotocol.io/docs/tools/debugging*
