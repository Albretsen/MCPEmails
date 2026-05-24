# Versioning

The Model Context Protocol uses string-based version identifiers following the format `YYYY-MM-DD`, to indicate the last date backwards incompatible changes were made.

> The protocol version will *not* be incremented when the protocol is updated, as long as the changes maintain backwards compatibility. This allows for incremental improvements while preserving interoperability.

## Revisions

Revisions may be marked as:

* **Draft**: in-progress specifications, not yet ready for consumption.
* **Current**: the current protocol version, which is ready for use and may continue to receive backwards compatible changes.
* **Final**: past, complete specifications that will not be changed.

The **current** protocol version is **2025-11-25**.

## Negotiation

Version negotiation happens during initialization. Clients and servers **MAY** support multiple protocol versions simultaneously, but they **MUST** agree on a single version to use for the session.

The protocol provides appropriate error handling if version negotiation fails, allowing clients to gracefully terminate connections when they cannot find a version compatible with the server.

### Example negotiation during initialization:

```json
// Client sends its supported version
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": { ... },
    "clientInfo": { ... }
  }
}

// Server responds with the agreed version
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { ... },
    "serverInfo": { ... }
  }
}
```

If the server cannot support the client's version, it should respond with an error and the connection should be terminated.

---

*Source: https://modelcontextprotocol.io/docs/learn/versioning*
