# MCP Protocol Specification

## Overview

Model Context Protocol (MCP) is a standard protocol for AI agents to interact with external tools and services. This document describes the MCP protocol as implemented in MCPEmails.

## Protocol Basics

- **Transport**: JSON-RPC 2.0 over stdio
- **Format**: UTF-8 encoded newline-delimited JSON
- **Authentication**: Bearer tokens in Authorization header
- **Rate Limits**: Per API key, enforced by Supabase

## Key Concepts

### Tools

Tools are callable functions exposed by MCPEmails:
- `list_inbox(account)` — List emails in an inbox
- `read_email(account, message_id)` — Read full email
- `send_email(account, to, subject, body)` — Send an email
- `reply_to_email(account, message_id, body)` — Reply to an email
- `search_emails(account, query)` — Search emails

### Scopes

API keys can be limited to specific scopes:
- `read:email` — Can read emails
- `send:email` — Can send emails
- `reply:email` — Can reply to emails
- `list:email` — Can list emails

### Rate Limits

- 100 calls/minute per API key
- 1000 calls/hour per API key
- 10,000 calls/day per API key

## Request/Response Format

(Detailed protocol format to be documented)

## Error Handling

(Error codes and handling to be documented)

## Security Considerations

- API keys are sensitive; never log them
- All calls are logged to activity feed
- Tokens have expiration; refresh before use
- Validate scope before accepting request

---

**Note**: This is a placeholder. Full specification should be completed.
