# Architecture overview

This overview of the Model Context Protocol (MCP) discusses its scope and core concepts, and provides an example demonstrating each core concept.

Because MCP SDKs abstract away many concerns, most developers will likely find the **data layer protocol** section to be the most useful. It discusses how MCP servers can provide context to an AI application.

## Scope

The Model Context Protocol includes the following projects:

* **MCP Specification**: A specification of MCP that outlines the implementation requirements for clients and servers.
* **MCP SDKs**: SDKs for different programming languages that implement MCP.
* **MCP Development Tools**: Tools for developing MCP servers and clients, including the MCP Inspector.
* **MCP Reference Server Implementations**: Reference implementations of MCP servers.

> MCP focuses solely on the protocol for context exchange—it does not dictate how AI applications use LLMs or manage the provided context.

## Concepts of MCP

### Participants

MCP follows a client-server architecture where an MCP host — an AI application like Claude Code or Claude Desktop — establishes connections to one or more MCP servers. The MCP host accomplishes this by creating one MCP client for each MCP server. Each MCP client maintains a dedicated connection with its corresponding MCP server.

Local MCP servers that use the STDIO transport typically serve a single MCP client, whereas remote MCP servers that use the Streamable HTTP transport will typically serve many MCP clients.

The key participants in the MCP architecture are:

* **MCP Host**: The AI application that coordinates and manages one or multiple MCP clients
* **MCP Client**: A component that maintains a connection to an MCP server and obtains context from an MCP server for the MCP host to use
* **MCP Server**: A program that provides context to MCP clients

**For example**: Visual Studio Code acts as an MCP host. When Visual Studio Code establishes a connection to an MCP server, such as the Sentry MCP server, the Visual Studio Code runtime instantiates an MCP client object that maintains the connection to the Sentry MCP server.

```
MCP Host (AI Application)
├── MCP Client 1 ─── MCP Server A (Local, e.g. Filesystem)
├── MCP Client 2 ─── MCP Server B (Local, e.g. Database)
├── MCP Client 3 ─── MCP Server C (Remote, e.g. Sentry)
└── MCP Client 4 ─── MCP Server C (Remote, e.g. Sentry)
```

Note that **MCP server** refers to the program that serves context data, regardless of where it runs. MCP servers can execute locally or remotely.

### Layers

MCP consists of two layers:

* **Data layer**: Defines the JSON-RPC based protocol for client-server communication, including lifecycle management, and core primitives, such as tools, resources, prompts and notifications.
* **Transport layer**: Defines the communication mechanisms and channels that enable data exchange between clients and servers, including transport-specific connection establishment, message framing, and authorization.

Conceptually the data layer is the inner layer, while the transport layer is the outer layer.

#### Data layer

The data layer implements a JSON-RPC 2.0 based exchange protocol that defines the message structure and semantics. This layer includes:

* **Lifecycle management**: Handles connection initialization, capability negotiation, and connection termination between clients and servers
* **Server features**: Enables servers to provide core functionality including tools for AI actions, resources for context data, and prompts for interaction templates from and to the client
* **Client features**: Enables servers to ask the client to sample from the host LLM, elicit input from the user, and log messages to the client
* **Utility features**: Supports additional capabilities like notifications for real-time updates and progress tracking for long-running operations

#### Transport layer

The transport layer manages communication channels and authentication between clients and servers. MCP supports two transport mechanisms:

* **Stdio transport**: Uses standard input/output streams for direct process communication between local processes on the same machine, providing optimal performance with no network overhead.
* **Streamable HTTP transport**: Uses HTTP POST for client-to-server messages with optional Server-Sent Events for streaming capabilities. This transport enables remote server communication and supports standard HTTP authentication methods including bearer tokens, API keys, and custom headers. MCP recommends using OAuth to obtain authentication tokens.

### Data Layer Protocol

#### Lifecycle management

MCP is a stateful protocol that requires lifecycle management. The purpose of lifecycle management is to negotiate the capabilities that both client and server support.

#### Primitives

MCP primitives define what clients and servers can offer each other.

MCP defines three core primitives that *servers* can expose:

* **Tools**: Executable functions that AI applications can invoke to perform actions (e.g., file operations, API calls, database queries)
* **Resources**: Data sources that provide contextual information to AI applications (e.g., file contents, database records, API responses)
* **Prompts**: Reusable templates that help structure interactions with language models (e.g., system prompts, few-shot examples)

Each primitive type has associated methods for discovery (`*/list`), retrieval (`*/get`), and in some cases, execution (`tools/call`).

MCP also defines primitives that *clients* can expose:

* **Sampling**: Allows servers to request language model completions from the client's AI application.
* **Elicitation**: Allows servers to request additional information from users.
* **Logging**: Enables servers to send log messages to clients for debugging and monitoring purposes.

Besides server and client primitives, the protocol offers cross-cutting utility primitives:

* **Tasks (Experimental)**: Durable execution wrappers that enable deferred result retrieval and status tracking for MCP requests.

#### Notifications

The protocol supports real-time notifications to enable dynamic updates between servers and clients. Notifications are sent as JSON-RPC 2.0 notification messages (without expecting a response).

## Example: Data Layer Walkthrough

### Step 1: Initialization (Lifecycle Management)

```json
// Initialize Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "elicitation": {}
    },
    "clientInfo": {
      "name": "example-client",
      "version": "1.0.0"
    }
  }
}

// Initialize Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": {
        "listChanged": true
      },
      "resources": {}
    },
    "serverInfo": {
      "name": "example-server",
      "version": "1.0.0"
    }
  }
}
```

After successful initialization, the client sends:
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

**Understanding the initialization exchange:**

1. **Protocol Version Negotiation**: The `protocolVersion` field ensures both client and server are using compatible protocol versions.
2. **Capability Discovery**: The `capabilities` object allows each party to declare what features they support.
3. **Identity Exchange**: The `clientInfo` and `serverInfo` objects provide identification and versioning information.

**Client Capabilities:**
* `"elicitation": {}` — The client can work with user interaction requests

**Server Capabilities:**
* `"tools": {"listChanged": true}` — The server supports tools AND can send `tools/list_changed` notifications
* `"resources": {}` — The server also supports the resources primitive

### Step 2: Tool Discovery (Primitives)

```json
// Tools List Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}

// Tools List Response
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "calculator_arithmetic",
        "title": "Calculator",
        "description": "Perform mathematical calculations",
        "inputSchema": {
          "type": "object",
          "properties": {
            "expression": {
              "type": "string",
              "description": "Mathematical expression to evaluate"
            }
          },
          "required": ["expression"]
        }
      },
      {
        "name": "weather_current",
        "title": "Weather Information",
        "description": "Get current weather information for any location worldwide",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name, address, or coordinates"
            },
            "units": {
              "type": "string",
              "enum": ["metric", "imperial", "kelvin"],
              "default": "metric"
            }
          },
          "required": ["location"]
        }
      }
    ]
  }
}
```

### Step 3: Tool Execution (Primitives)

```json
// Tool Call Request
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "weather_current",
    "arguments": {
      "location": "San Francisco",
      "units": "imperial"
    }
  }
}

// Tool Call Response
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Current weather in San Francisco: 68°F, partly cloudy with light winds from the west at 8 mph. Humidity: 65%"
      }
    ]
  }
}
```

### Step 4: Real-time Updates (Notifications)

```json
// Server notifies about tool list changes
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed"
}

// Client re-fetches updated tool list
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/list"
}
```

**Key features of MCP notifications:**
1. **No Response Required**: No `id` field — JSON-RPC 2.0 notification semantics.
2. **Capability-Based**: Only sent by servers that declared `"listChanged": true` during initialization.
3. **Event-Driven**: Server decides when to send notifications based on internal state changes.

---

*Source: https://modelcontextprotocol.io/docs/learn/architecture*
