# Server Concepts: Tools, Resources, and Prompts

This document covers the three core primitives that MCP servers can expose to clients.

---

## Tools

The Model Context Protocol (MCP) allows servers to expose tools that can be invoked by language models. Tools enable models to interact with external systems, such as querying databases, calling APIs, or performing computations. Each tool is uniquely identified by a name and includes metadata describing its schema.

### User Interaction Model

Tools in MCP are designed to be **model-controlled**, meaning that the language model can discover and invoke tools automatically based on its contextual understanding and the user's prompts.

> **Security**: There SHOULD always be a human in the loop with the ability to deny tool invocations. Applications SHOULD provide UI that makes clear which tools are being exposed to the AI model, insert clear visual indicators when tools are invoked, and present confirmation prompts to the user for operations.

### Capabilities

Servers that support tools MUST declare the `tools` capability:

```json
{
  "capabilities": {
    "tools": {
      "listChanged": true
    }
  }
}
```

`listChanged` indicates whether the server will emit notifications when the list of available tools changes.

### Protocol Messages

#### Listing Tools

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {
    "cursor": "optional-cursor-value"
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "get_weather",
        "title": "Weather Information Provider",
        "description": "Get current weather information for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name or zip code"
            }
          },
          "required": ["location"]
        }
      }
    ],
    "nextCursor": "next-page-cursor"
  }
}
```

#### Calling Tools

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": {
      "location": "New York"
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Current weather in New York:\nTemperature: 72°F\nConditions: Partly cloudy"
      }
    ],
    "isError": false
  }
}
```

#### List Changed Notification

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed"
}
```

### Tool Data Types

A tool definition includes:

* `name`: Unique identifier for the tool
* `title`: Optional human-readable name for display purposes
* `description`: Human-readable description of functionality
* `inputSchema`: JSON Schema defining expected parameters
* `outputSchema`: Optional JSON Schema defining expected output structure
* `annotations`: Optional properties describing tool behavior

### Tool Result Content Types

#### Text Content
```json
{ "type": "text", "text": "Tool result text" }
```

#### Image Content
```json
{ "type": "image", "data": "base64-encoded-data", "mimeType": "image/png" }
```

#### Audio Content
```json
{ "type": "audio", "data": "base64-encoded-audio-data", "mimeType": "audio/wav" }
```

#### Resource Links
```json
{
  "type": "resource_link",
  "uri": "file:///project/src/main.rs",
  "name": "main.rs",
  "description": "Primary application entry point",
  "mimeType": "text/x-rust"
}
```

#### Embedded Resources
```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///project/src/main.rs",
    "mimeType": "text/x-rust",
    "text": "fn main() {\n    println!(\"Hello world!\");\n}"
  }
}
```

#### Structured Content

Structured content is returned as a JSON object in the `structuredContent` field. Tools may also provide an `outputSchema` for validation. For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block.

### Error Handling

Tools use two error reporting mechanisms:

1. **Protocol Errors**: Standard JSON-RPC errors for unknown tools, invalid arguments, server errors
2. **Tool Execution Errors**: Reported in tool results with `isError: true`

```json
// Protocol error
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32602,
    "message": "Unknown tool: invalid_tool_name"
  }
}

// Execution error
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{ "type": "text", "text": "Failed to fetch weather data: API rate limit exceeded" }],
    "isError": true
  }
}
```

---

## Resources

The Model Context Protocol (MCP) provides a standardized way for servers to expose resources to clients. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Each resource is uniquely identified by a URI.

### User Interaction Model

Resources in MCP are designed to be **application-driven**, with host applications determining how to incorporate context based on their needs.

### Capabilities

```json
{
  "capabilities": {
    "resources": {
      "subscribe": true,
      "listChanged": true
    }
  }
}
```

* `subscribe`: whether the client can subscribe to be notified of changes to individual resources
* `listChanged`: whether the server will emit notifications when the list of available resources changes

### Protocol Messages

#### Listing Resources

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/list",
  "params": { "cursor": "optional-cursor-value" }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resources": [
      {
        "uri": "file:///project/src/main.rs",
        "name": "main.rs",
        "title": "Rust Software Application Main File",
        "description": "Primary application entry point",
        "mimeType": "text/x-rust"
      }
    ],
    "nextCursor": "next-page-cursor"
  }
}
```

#### Reading Resources

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "resources/read",
  "params": { "uri": "file:///project/src/main.rs" }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "contents": [
      {
        "uri": "file:///project/src/main.rs",
        "mimeType": "text/x-rust",
        "text": "fn main() {\n    println!(\"Hello world!\");\n}"
      }
    ]
  }
}
```

#### Resource Templates

Resource templates allow servers to expose parameterized resources using URI templates:

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "resources/templates/list"
}

// Response
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "resourceTemplates": [
      {
        "uriTemplate": "file:///{path}",
        "name": "Project Files",
        "description": "Access files in the project directory",
        "mimeType": "application/octet-stream"
      }
    ]
  }
}
```

#### Subscriptions

```json
// Subscribe
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "resources/subscribe",
  "params": { "uri": "file:///project/src/main.rs" }
}

// Update notification
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": { "uri": "file:///project/src/main.rs" }
}
```

### Resource Annotations

Resources support optional annotations:

* **`audience`**: Array indicating intended audience(s) — `"user"` and/or `"assistant"`
* **`priority`**: Number 0.0–1.0 indicating importance (1 = most important)
* **`lastModified`**: ISO 8601 timestamp of last modification

```json
{
  "uri": "file:///project/README.md",
  "name": "README.md",
  "mimeType": "text/markdown",
  "annotations": {
    "audience": ["user"],
    "priority": 0.8,
    "lastModified": "2025-01-12T15:00:58Z"
  }
}
```

### Common URI Schemes

* **`https://`**: Web resources the client can fetch directly
* **`file://`**: Filesystem-like resources (don't need to map to actual filesystem)
* **`git://`**: Git version control integration
* Custom URI schemes following RFC3986

---

## Prompts

The Model Context Protocol (MCP) provides a standardized way for servers to expose prompt templates to clients. Prompts allow servers to provide structured messages and instructions for interacting with language models.

### User Interaction Model

Prompts are designed to be **user-controlled**, meaning they are exposed from servers to clients with the intention of the user being able to explicitly select them for use. Typically triggered through user-initiated commands in the UI, such as slash commands.

### Capabilities

```json
{
  "capabilities": {
    "prompts": {
      "listChanged": true
    }
  }
}
```

### Protocol Messages

#### Listing Prompts

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "prompts/list"
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "prompts": [
      {
        "name": "code_review",
        "title": "Request Code Review",
        "description": "Asks the LLM to analyze code quality and suggest improvements",
        "arguments": [
          {
            "name": "code",
            "description": "The code to review",
            "required": true
          }
        ]
      }
    ]
  }
}
```

#### Getting a Prompt

```json
// Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "prompts/get",
  "params": {
    "name": "code_review",
    "arguments": {
      "code": "def hello():\n    print('world')"
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "description": "Code review prompt",
    "messages": [
      {
        "role": "user",
        "content": {
          "type": "text",
          "text": "Please review this Python code:\ndef hello():\n    print('world')"
        }
      }
    ]
  }
}
```

### Prompt Content Types

* **Text**: `{ "type": "text", "text": "..." }`
* **Image**: `{ "type": "image", "data": "base64...", "mimeType": "image/png" }`
* **Audio**: `{ "type": "audio", "data": "base64...", "mimeType": "audio/wav" }`
* **Embedded Resources**: `{ "type": "resource", "resource": { "uri": "...", "mimeType": "...", "text": "..." } }`

---

*Sources:*
- *https://modelcontextprotocol.io/docs/concepts/tools*
- *https://modelcontextprotocol.io/docs/concepts/resources*
- *https://modelcontextprotocol.io/docs/concepts/prompts*
