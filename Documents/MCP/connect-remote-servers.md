# Connect to Remote MCP Servers

> Learn how to connect Claude to remote MCP servers and extend its capabilities with internet-hosted tools and data sources

Remote MCP servers extend AI applications' capabilities beyond your local environment, providing access to internet-hosted tools, services, and data sources.

Many clients now support remote MCP servers. This guide demonstrates how to connect using Claude as an example.

## Understanding Remote MCP Servers

Remote MCP servers function similarly to local MCP servers but are hosted on the internet rather than your local machine. They expose tools, prompts, and resources that Claude can use to perform tasks on your behalf.

**Key advantage**: Unlike local servers that require installation and configuration on each device, remote servers are available from any MCP client with an internet connection. Ideal for:
* Web-based AI applications
* Integrations that emphasize ease of use
* Services that require server-side processing or authentication

## What are Custom Connectors?

Custom Connectors serve as the bridge between Claude and remote MCP servers. They allow you to connect Claude directly to the tools and data sources that matter most to your workflows.

With Custom Connectors, you can:
* Connect Claude to existing remote MCP servers provided by third-party developers
* Build your own remote MCP servers to connect with any tool

## Connecting to a Remote MCP Server

### Step 1: Navigate to Connector Settings

Open Claude in your browser → Settings → "Connectors" section in the sidebar.

### Step 2: Add a Custom Connector

In the Connectors section, scroll to the bottom and click "Add custom connector". Enter the complete remote MCP server URL (must include `https://` and any necessary path components), then click "Add".

### Step 3: Complete Authentication

Most remote MCP servers require authentication. Common methods include OAuth, API keys, or username/password. Follow the prompts provided by the server.

### Step 4: Access Resources and Prompts

After successful connection, the remote server's resources and prompts become available in conversations. Click the paperclip icon in the message input area to access them.

### Step 5: Configure Tool Permissions

Navigate back to Connectors settings and click on your connected server to enable or disable specific tools, set usage limits, and configure other security parameters.

## Best Practices

**Security considerations**:
* Always verify the authenticity of remote MCP servers before connecting
* Only connect to servers from trusted sources
* Review the permissions requested during authentication
* Be cautious about granting access to sensitive data or systems

**Managing multiple connectors**:
* You can connect to multiple remote MCP servers simultaneously
* Organize connectors by purpose or project
* Regularly review and remove connectors you no longer use

## Building Your Own Remote MCP Server

See the Anthropic guide: https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers

Remote servers use the **Streamable HTTP transport**, which:
* Uses HTTP POST for client-to-server messages
* Supports Server-Sent Events (SSE) for streaming
* Supports standard HTTP authentication (bearer tokens, API keys, custom headers)
* MCP recommends using OAuth to obtain authentication tokens

## Next Steps

* Build your own remote server: https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers
* Browse available servers: https://github.com/modelcontextprotocol/servers
* Connect local servers: `/docs/develop/connect-local-servers`
* Understand the architecture: `/docs/learn/architecture`

---

*Source: https://modelcontextprotocol.io/docs/develop/connect-remote-servers*
