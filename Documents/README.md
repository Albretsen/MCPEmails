# MCPEmails Documentation

This directory contains all technical documentation for MCPEmails development, organized by topic.

## Directory Structure

### AI Development Guide

**Location**: `AI/`

- **[dev-plan.md](AI/dev-plan.md)** — The definitive guide for all AI agents developing MCPEmails
  - Development loop architecture
  - Code quality standards
  - Design system compliance
  - Performance optimization
  - Git commit guidelines
  - Backend architecture with Supabase
  - Testing strategy
  - Workflow and checklists

**Start here if you are**: An AI agent picking up a task from the checklist

### MCP Protocol Documentation

**Location**: `MCP/`

#### Official MCP Protocol Docs (downloaded from modelcontextprotocol.io)

- **[introduction.md](MCP/introduction.md)** — What is MCP? Ecosystem overview
- **[architecture.md](MCP/architecture.md)** — Full architecture: participants, layers, primitives, JSON-RPC examples
- **[server-concepts.md](MCP/server-concepts.md)** — Tools, Resources, Prompts — detailed spec with JSON examples
- **[client-concepts.md](MCP/client-concepts.md)** — Sampling, Elicitation, Roots — detailed spec with JSON examples
- **[versioning.md](MCP/versioning.md)** — Protocol version format (YYYY-MM-DD), negotiation
- **[build-server.md](MCP/build-server.md)** — Full tutorial: Python, TypeScript, Java weather server
- **[build-client.md](MCP/build-client.md)** — Full tutorial: Python, TypeScript, Java, Kotlin, C#, Ruby clients
- **[connect-local-servers.md](MCP/connect-local-servers.md)** — Filesystem server, claude_desktop_config.json reference, troubleshooting
- **[connect-remote-servers.md](MCP/connect-remote-servers.md)** — Custom Connectors, step-by-step guide
- **[debugging.md](MCP/debugging.md)** — MCP Inspector, logging, Claude Desktop DevTools
- **[inspector.md](MCP/inspector.md)** — MCP Inspector features and usage
- **[security-best-practices.md](MCP/security-best-practices.md)** — Confused deputy, token passthrough, SSRF, session hijacking, scope minimization

#### MCPEmails-Specific MCP Docs

- **[spec.md](MCP/spec.md)** — MCPEmails MCP protocol specification
  - Protocol basics (JSON-RPC 2.0 over stdio)
  - Key concepts (tools, scopes, rate limits)
  - Request/response format
  - Security considerations

- **[tools.md](MCP/tools.md)** — Reference for all MCPEmails MCP tools
  - `list_inbox()` — List emails in an inbox
  - `read_email()` — Read full email content
  - `send_email()` — Send an email
  - `reply_to_email()` — Reply to an email
  - `search_emails()` — Search emails by query
  - Scope system and rate limiting

- **[authentication.md](MCP/authentication.md)** — Auth, API keys, and security
  - Creating and using API keys
  - OAuth flows for Gmail, Outlook, Fastmail
  - Token refresh logic
  - Security best practices
  - Audit logging

- **[error-handling.md](MCP/error-handling.md)** — Error codes and recovery
  - Error response format
  - Specific error codes and causes
  - Retry strategies (exponential backoff)
  - Client-side error handling
  - Common error scenarios and solutions

**Start here if you are**: Implementing MCP tool calls, debugging authentication issues, or handling errors

### Email Provider Documentation

**Location**: `Email/`

- **[imap-smtp.md](Email/imap-smtp.md)** — IMAP/SMTP protocols for all providers
  - Gmail: IMAP/SMTP settings and Gmail API alternative
  - Outlook: IMAP/SMTP settings and Microsoft Graph alternative
  - Fastmail: IMAP/SMTP (excellent support)
  - Generic/self-hosted: Configuration guide
  - Common connection and parsing issues

- **[oauth-flows.md](Email/oauth-flows.md)** — OAuth authentication details
  - Gmail OAuth flow (scopes, token lifetime, refresh logic)
  - Outlook OAuth flow
  - Fastmail OAuth (with app password alternative)
  - Token storage and encryption
  - Error handling and recovery
  - Best practices

- **[email-parsing.md](Email/email-parsing.md)** — How to safely parse emails
  - Email structure and MIME format
  - Parsing headers, addresses, multipart messages
  - Decoding content (base64, quoted-printable)
  - Extracting text, HTML, and attachments
  - Security (HTML sanitization, phishing detection, malware scanning)
  - Common parsing issues and solutions

- **[rate-limits.md](Email/rate-limits.md)** — Provider rate limits and optimization
  - Gmail API limits and batch requests
  - Microsoft Graph rate limiting
  - Fastmail IMAP/SMTP limits
  - MCPEmails global limits
  - Optimization strategies (batching, caching, queuing, backoff)
  - Monitoring and alerting

**Start here if you are**: Connecting a new email provider, debugging OAuth issues, parsing email content, or hitting rate limits

## Quick Navigation by Task

### "I need to implement a new email provider"

1. Read [Email/imap-smtp.md](Email/imap-smtp.md) for protocol details
2. Read [Email/oauth-flows.md](Email/oauth-flows.md) for authentication
3. Check [MCP/tools.md](MCP/tools.md) for which tools need updating
4. Follow code quality standards in [AI/dev-plan.md](AI/dev-plan.md#2-code-quality-standards)

### "I need to debug a rate limit issue"

1. Check [Email/rate-limits.md](Email/rate-limits.md) for provider limits
2. Check [MCP/error-handling.md](MCP/error-handling.md) for handling 429 errors
3. Implement exponential backoff from [Email/rate-limits.md](Email/rate-limits.md#optimization-strategies)

### "I need to parse an email"

1. Read [Email/email-parsing.md](Email/email-parsing.md) for structure and decoding
2. Use provided code examples for headers, addresses, multipart, and attachments
3. Follow security guidance for HTML sanitization

### "I'm starting a new task from the checklist"

1. Read [AI/dev-plan.md](AI/dev-plan.md#10-development-workflow) for workflow
2. Read relevant documentation based on task type (MCP, Email, Frontend, Backend, etc.)
3. Follow [Code Quality Standards](AI/dev-plan.md#2-code-quality-standards)
4. Follow [Git Commit Guidelines](AI/dev-plan.md#6-git-commit-guidelines)
5. Follow [Testing Strategy](AI/dev-plan.md#9-testing-strategy)

### "I need to understand how MCPEmails works"

1. Start with [MCP/spec.md](MCP/spec.md) for protocol overview
2. Read [MCP/tools.md](MCP/tools.md) for available tools
3. Read relevant email provider docs ([Email/](Email/))
4. Check [AI/dev-plan.md](AI/dev-plan.md#5-mcp--email-expertise) for architecture context

## Document Status

| Document | Status | Completeness |
|----------|--------|--------------|
| AI/dev-plan.md | ✅ Complete | 100% |
| MCP/introduction.md | ✅ Complete | 100% |
| MCP/architecture.md | ✅ Complete | 100% |
| MCP/server-concepts.md | ✅ Complete | 100% |
| MCP/client-concepts.md | ✅ Complete | 100% |
| MCP/versioning.md | ✅ Complete | 100% |
| MCP/build-server.md | ✅ Complete | 100% |
| MCP/build-client.md | ✅ Complete | 100% |
| MCP/connect-local-servers.md | ✅ Complete | 100% |
| MCP/connect-remote-servers.md | ✅ Complete | 100% |
| MCP/debugging.md | ✅ Complete | 100% |
| MCP/inspector.md | ✅ Complete | 100% |
| MCP/security-best-practices.md | ✅ Complete | 100% |
| MCP/spec.md | 🟡 Placeholder | 20% |
| MCP/tools.md | 🟡 Placeholder | 40% |
| MCP/authentication.md | 🟡 Placeholder | 60% |
| MCP/error-handling.md | ✅ Complete | 90% |
| Email/imap-smtp.md | 🟡 Placeholder | 70% |
| Email/oauth-flows.md | 🟡 Placeholder | 80% |
| Email/email-parsing.md | ✅ Complete | 95% |
| Email/rate-limits.md | ✅ Complete | 95% |

## Contributing to Documentation

When updating documentation:

1. **Clarity first**: Write for a developer new to the topic
2. **Examples**: Include working code examples
3. **Links**: Cross-reference related documents
4. **Keep updated**: Update when implementation changes
5. **Status badges**: Mark complete sections with ✅, placeholders with 🟡

## Version History

| Date | Changes |
|------|---------|
| 2026-05-24 | Initial documentation created; dev-plan and all guides published |

---

**Last Updated**: 2026-05-24  
**Next Review**: 2026-06-24
