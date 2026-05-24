# Connect to Local MCP Servers

> Learn how to extend Claude Desktop with local MCP servers to enable file system access and other powerful integrations

This guide demonstrates how to connect to local MCP servers using Claude Desktop as an example client.

## Prerequisites

* **Claude Desktop**: Download from https://claude.ai/download (macOS and Windows)
* **Node.js**: Verify with `node --version`. Download from https://nodejs.org/ (LTS recommended)

## Understanding MCP Servers

MCP servers are programs that run on your computer and provide specific capabilities to Claude Desktop through a standardized protocol. Each server exposes tools that Claude can use to perform actions, with your approval.

The Filesystem Server provides tools for:
* Reading file contents and directory structures
* Creating new files and directories
* Moving and renaming files
* Searching for files by name or content

All actions require your explicit approval before execution.

## Installing the Filesystem Server

### Step 1: Open Claude Desktop Settings

Click on the Claude menu in your system's menu bar (not the settings within the Claude window itself) and select "Settings..."

### Step 2: Access Developer Settings

In the Settings window, navigate to the "Developer" tab and click "Edit Config".

This opens/creates the configuration file at:
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Step 3: Configure the Filesystem Server

```json
// macOS
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/Desktop",
        "/Users/username/Downloads"
      ]
    }
  }
}
```

```json
// Windows
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\username\\Desktop",
        "C:\\Users\\username\\Downloads"
      ]
    }
  }
}
```

Replace `username` with your actual computer username. The paths in `args` specify which directories the server can access.

**Configuration breakdown:**
* `"filesystem"`: A friendly name for the server
* `"command": "npx"`: Uses Node.js's npx tool to run the server
* `"-y"`: Automatically confirms the installation
* `"@modelcontextprotocol/server-filesystem"`: The package name
* Remaining arguments: Directories the server is allowed to access

**Security**: Only grant access to directories you're comfortable with Claude reading and modifying.

### Step 4: Restart Claude Desktop

Completely quit Claude Desktop and restart it. Upon successful restart, you'll see an MCP server indicator in the bottom-right corner of the conversation input box.

## Adding Environment Variables

MCP servers launched over stdio inherit only a limited subset of environment variables. To provide custom variables:

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

## claude_desktop_config.json Reference

Always use absolute paths, not relative paths:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/data"
      ]
    }
  }
}
```

## Troubleshooting

### Server not showing up / hammer icon missing

1. Restart Claude Desktop completely
2. Check your `claude_desktop_config.json` file syntax
3. Make sure file paths are valid and absolute (not relative)
4. Check logs to see why the server is not connecting
5. Try manually running the server:

```bash
# macOS/Linux
npx -y @modelcontextprotocol/server-filesystem /Users/username/Desktop /Users/username/Downloads

# Windows
npx -y @modelcontextprotocol/server-filesystem C:\Users\username\Desktop C:\Users\username\Downloads
```

### Getting logs from Claude Desktop

Log files are written to:
* **macOS**: `~/Library/Logs/Claude`
* **Windows**: `%APPDATA%\Claude\logs`

```bash
# macOS/Linux — view recent logs and follow new ones
tail -n 20 -f ~/Library/Logs/Claude/mcp*.log

# Windows — view recent logs
type "%APPDATA%\Claude\logs\mcp*.log"
```

Log files:
* `mcp.log`: General logging about MCP connections and connection failures
* `mcp-server-SERVERNAME.log`: Error (stderr) logging from the named server

### Tool calls failing silently

1. Check Claude's logs for errors
2. Verify your server builds and runs without errors
3. Try restarting Claude Desktop

### ENOENT error and `${APPDATA}` in paths on Windows

Add the expanded value of `%APPDATA%` to your `env` key:

```json
{
  "brave-search": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": {
      "APPDATA": "C:\\Users\\user\\AppData\\Roaming\\",
      "BRAVE_API_KEY": "..."
    }
  }
}
```

## Common Initialization Problems

1. **Path Issues**: Incorrect server executable path, missing required files, permission problems — try using an absolute path for `command`
2. **Configuration Errors**: Invalid JSON syntax, missing required fields, type mismatches
3. **Environment Problems**: Missing environment variables, incorrect variable values, permission restrictions

## Next Steps

* Browse official and community MCP servers: https://github.com/modelcontextprotocol/servers
* Build your own server: `/docs/develop/build-server`
* Connect to remote servers: `/docs/develop/connect-remote-servers`
* Debug issues: `/docs/tools/debugging`

---

*Source: https://modelcontextprotocol.io/docs/develop/connect-local-servers*
