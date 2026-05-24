# MCP Inspector

> In-depth guide to using the MCP Inspector for testing and debugging Model Context Protocol servers

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is an interactive developer tool for testing and debugging MCP servers.

## Getting Started

### Installation and basic usage

The Inspector runs directly through `npx` without requiring installation:

```bash
npx @modelcontextprotocol/inspector <command>
npx @modelcontextprotocol/inspector <command> <arg1> <arg2>
```

### Inspecting servers from npm or PyPI

```bash
# npm package
npx -y @modelcontextprotocol/inspector npx <package-name> <args>
# For example:
npx -y @modelcontextprotocol/inspector npx @modelcontextprotocol/server-filesystem /Users/username/Desktop

# PyPI package
npx @modelcontextprotocol/inspector uvx <package-name> <args>
# For example:
npx @modelcontextprotocol/inspector uvx mcp-server-git --repository ~/code/mcp/servers.git
```

### Inspecting locally developed servers

```bash
# TypeScript
npx @modelcontextprotocol/inspector node path/to/server/index.js args...

# Python
npx @modelcontextprotocol/inspector \
  uv \
  --directory path/to/server \
  run \
  package-name \
  args...
```

Always read any attached README for the most accurate instructions.

## Feature Overview

The Inspector provides several features for interacting with your MCP server:

### Server connection pane

* Allows selecting the transport for connecting to the server
* For local servers, supports customizing the command-line arguments and environment

### Resources tab

* Lists all available resources
* Shows resource metadata (MIME types, descriptions)
* Allows resource content inspection
* Supports subscription testing

### Prompts tab

* Displays available prompt templates
* Shows prompt arguments and descriptions
* Enables prompt testing with custom arguments
* Previews generated messages

### Tools tab

* Lists available tools
* Shows tool schemas and descriptions
* Enables tool testing with custom inputs
* Displays tool execution results

### Notifications pane

* Presents all logs recorded from the server
* Shows notifications received from the server

## Best Practices

### Development workflow

1. **Start Development**
   * Launch Inspector with your server
   * Verify basic connectivity
   * Check capability negotiation

2. **Iterative testing**
   * Make server changes
   * Rebuild the server
   * Reconnect the Inspector
   * Test affected features
   * Monitor messages

3. **Test edge cases**
   * Invalid inputs
   * Missing prompt arguments
   * Concurrent operations
   * Verify error handling and error responses

## Next Steps

* [Inspector Repository](https://github.com/modelcontextprotocol/inspector)
* [Debugging Guide](./debugging.md)
* [Build an MCP server](./build-server.md)

---

*Source: https://modelcontextprotocol.io/docs/tools/inspector*
