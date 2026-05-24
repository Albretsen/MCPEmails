# Client Concepts: Sampling, Elicitation, and Roots

This document covers the core primitives that MCP clients can expose to servers.

---

## Sampling

The Model Context Protocol (MCP) provides a standardized way for servers to request LLM sampling ("completions" or "generations") from language models via clients. This flow allows clients to maintain control over model access, selection, and permissions while enabling servers to leverage AI capabilities—with no server API keys necessary.

### User Interaction Model

Sampling in MCP allows servers to implement agentic behaviors, by enabling LLM calls to occur *nested* inside other MCP server features.

> **Security**: There SHOULD always be a human in the loop with the ability to deny sampling requests. Applications SHOULD provide UI to review sampling requests, allow users to view and edit prompts before sending, and present generated responses for review before delivery.

### Capabilities

Clients that support sampling MUST declare the `sampling` capability during initialization:

```json
{
  "capabilities": {
    "sampling": {}
  }
}
```

### Protocol Messages

#### Creating Messages

```json
// Request (server → client)
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      {
        "role": "user",
        "content": {
          "type": "text",
          "text": "What is the capital of France?"
        }
      }
    ],
    "modelPreferences": {
      "hints": [
        { "name": "claude-3-sonnet" }
      ],
      "intelligencePriority": 0.8,
      "speedPriority": 0.5
    },
    "systemPrompt": "You are a helpful assistant.",
    "maxTokens": 100
  }
}

// Response (client → server)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "role": "assistant",
    "content": {
      "type": "text",
      "text": "The capital of France is Paris."
    },
    "model": "claude-3-sonnet-20240307",
    "stopReason": "endTurn"
  }
}
```

### Message Flow

```
Server → Client: sampling/createMessage
Client → User: Present request for approval
User → Client: Review and approve/modify
Client → LLM: Forward approved request
LLM → Client: Return generation
Client → User: Present response for approval
User → Client: Review and approve/modify
Client → Server: Return approved response
```

### Content Types

Sampling messages can contain:

* **Text**: `{ "type": "text", "text": "..." }`
* **Image**: `{ "type": "image", "data": "base64...", "mimeType": "image/jpeg" }`
* **Audio**: `{ "type": "audio", "data": "base64...", "mimeType": "audio/wav" }`

### Model Preferences

Model selection uses a preference system combining abstract capability priorities with optional model hints:

#### Capability Priorities (0–1 normalized)

* `costPriority`: How important is minimizing costs? Higher values prefer cheaper models.
* `speedPriority`: How important is low latency? Higher values prefer faster models.
* `intelligencePriority`: How important are advanced capabilities? Higher values prefer more capable models.

#### Model Hints

* Hints are treated as substrings that can match model names flexibly
* Multiple hints are evaluated in order of preference
* Clients MAY map hints to equivalent models from different providers
* Hints are advisory—clients make final model selection

```json
{
  "hints": [
    { "name": "claude-3-sonnet" },
    { "name": "claude" }
  ],
  "costPriority": 0.3,
  "speedPriority": 0.8,
  "intelligencePriority": 0.5
}
```

---

## Elicitation

The Model Context Protocol (MCP) provides a standardized way for servers to request additional information from users through the client during interactions. This flow allows clients to maintain control over user interactions and data sharing while enabling servers to gather necessary information dynamically.

> **Note**: Elicitation is newly introduced and its design may evolve in future protocol versions.

### User Interaction Model

Elicitation in MCP allows servers to implement interactive workflows by enabling user input requests to occur *nested* inside other MCP server features.

> **Security**: Servers MUST NOT use elicitation to request sensitive information. Applications SHOULD provide UI that makes it clear which server is requesting information, allow users to review and modify their responses, and provide clear decline and cancel options.

### Capabilities

```json
{
  "capabilities": {
    "elicitation": {}
  }
}
```

### Protocol Messages

#### Simple Text Request

```json
// Request (server → client)
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "elicitation/create",
  "params": {
    "message": "Please provide your GitHub username",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" }
      },
      "required": ["name"]
    }
  }
}

// Response (client → server)
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "action": "accept",
    "content": {
      "name": "octocat"
    }
  }
}
```

#### Structured Data Request

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "elicitation/create",
  "params": {
    "message": "Please provide your contact information",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "description": "Your full name" },
        "email": { "type": "string", "format": "email" },
        "age": { "type": "number", "minimum": 18 }
      },
      "required": ["name", "email"]
    }
  }
}
```

### Response Actions

The three response actions are:

1. **Accept** (`action: "accept"`): User explicitly approved and submitted with data
   * The `content` field contains the submitted data matching the requested schema

2. **Decline** (`action: "decline"`): User explicitly declined the request
   * The `content` field is typically omitted

3. **Cancel** (`action: "cancel"`): User dismissed without making an explicit choice
   * The `content` field is typically omitted

Servers should handle each state appropriately:
* **Accept**: Process the submitted data
* **Decline**: Handle explicit decline (e.g., offer alternatives)
* **Cancel**: Handle dismissal (e.g., prompt again later)

### Supported Schema Types

The schema is restricted to flat objects with primitive types:

1. **String**: `{ "type": "string", "minLength": 3, "maxLength": 50, "format": "email" }`
   * Supported formats: `email`, `uri`, `date`, `date-time`

2. **Number**: `{ "type": "number", "minimum": 0, "maximum": 100 }`
   (or `"type": "integer"`)

3. **Boolean**: `{ "type": "boolean", "default": false }`

4. **Enum**: `{ "type": "string", "enum": ["opt1", "opt2"], "enumNames": ["Option 1", "Option 2"] }`

> Complex nested structures, arrays of objects, and other advanced JSON Schema features are intentionally not supported to simplify client implementation.

---

## Roots

The Model Context Protocol (MCP) provides a standardized way for clients to expose filesystem "roots" to servers. Roots define the boundaries of where servers can operate within the filesystem, allowing them to understand which directories and files they have access to.

### User Interaction Model

Roots in MCP are typically exposed through workspace or project configuration interfaces. For example, implementations could offer a workspace/project picker that allows users to select directories and files the server should have access to.

### Capabilities

```json
{
  "capabilities": {
    "roots": {
      "listChanged": true
    }
  }
}
```

`listChanged` indicates whether the client will emit notifications when the list of roots changes.

### Protocol Messages

#### Listing Roots

```json
// Request (server → client)
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "roots/list"
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "roots": [
      {
        "uri": "file:///home/user/projects/myproject",
        "name": "My Project"
      }
    ]
  }
}
```

#### Root List Changes

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/roots/list_changed"
}
```

### Root Data Types

A root definition includes:

* `uri`: Unique identifier for the root. This MUST be a `file://` URI in the current specification.
* `name`: Optional human-readable name for display purposes.

### Multiple Repositories Example

```json
[
  {
    "uri": "file:///home/user/repos/frontend",
    "name": "Frontend Repository"
  },
  {
    "uri": "file:///home/user/repos/backend",
    "name": "Backend Repository"
  }
]
```

### Security Considerations

Clients MUST:
* Only expose roots with appropriate permissions
* Validate all root URIs to prevent path traversal
* Implement proper access controls
* Monitor root accessibility

Servers SHOULD:
* Handle cases where roots become unavailable
* Respect root boundaries during operations
* Validate all paths against provided roots

---

*Sources:*
- *https://modelcontextprotocol.io/docs/concepts/sampling*
- *https://modelcontextprotocol.io/docs/concepts/elicitation*
- *https://modelcontextprotocol.io/docs/concepts/roots*
