# Architecture Checklist

Each item below represents one architecture document to write. Check it off when the document exists and is complete.

---

## Backend (Supabase)

- [x] **Database Schema** — Tables, relationships, indexes, and naming conventions
- [x] **Row-Level Security (RLS)** — Multi-tenant data isolation policies per table
- [x] **Authentication & Session Management** — Supabase Auth setup, JWT handling, session lifecycle, protected routes
- [x] **API Key Management** — Key generation, hashing, storage, scopes, rotation, and revocation
- [x] **Edge Functions Architecture** — Which logic lives in Edge Functions, request/response shape, cold start mitigations
- [x] **Real-time & Webhooks** — Supabase Realtime subscriptions, email event push, client reconnection strategy

## MCP Layer

- [x] **MCP Server Architecture** — JSON-RPC 2.0 transport, lifecycle, capability negotiation, tool registration
- [x] **MCP Tool Design** — How MCPEmails tools are structured, input/output schemas, error surface
- [x] **MCP Authentication Flow** — How API keys map to MCP sessions, scope enforcement per tool call

## Email Integration

- [x] **Email Provider OAuth Flows** — Gmail, Outlook, Fastmail OAuth 2.0 flows, token storage, refresh lifecycle
- [x] **IMAP/SMTP Connection Management** — Connection pooling, keep-alive, provider-specific quirks
- [x] **Email Parsing Pipeline** — MIME parsing, sanitization, attachment handling, content extraction

## Frontend (Next.js)

- [x] **App Architecture** — App Router structure, route groups, layout hierarchy, shared state
- [x] **Data Fetching Strategy** — Server Components vs. client fetching, caching, revalidation, optimistic updates
- [x] **Design System & Component Library** — CSS variable tokens, primitive components, responsive breakpoints

## Cross-Cutting

- [x] **Rate Limiting & Quotas** — Per-key and per-user limits, quota enforcement at the Edge Function level
- [x] **Error Handling & Recovery** — Global error boundaries, retry logic, user-facing error messages
- [x] **Security Architecture** — Token encryption at rest, audit logging, threat model, OWASP mitigations
- [x] **Performance Optimizations** — Caching layers (in-memory, Supabase, CDN), batching, code splitting
- [x] **Deployment Architecture** — Vercel + Supabase environment setup, CI/CD pipeline, secrets management
- [x] **Monitoring & Observability** — Structured logging, metrics, alerting thresholds, error tracking (Sentry)

---

**Total**: 21 documents

**Convention**: Create each document at `Documents/Architecture/<kebab-case-name>.md`.
