# Architecture Checklist

Each item below represents one architecture document to write. Check it off when the document exists and is complete.

---

## Backend (Supabase)

- [x] **Database Schema** — Tables, relationships, indexes, and naming conventions
- [ ] **Row-Level Security (RLS)** — Multi-tenant data isolation policies per table
- [ ] **Authentication & Session Management** — Supabase Auth setup, JWT handling, session lifecycle, protected routes
- [ ] **API Key Management** — Key generation, hashing, storage, scopes, rotation, and revocation
- [ ] **Edge Functions Architecture** — Which logic lives in Edge Functions, request/response shape, cold start mitigations
- [ ] **Real-time & Webhooks** — Supabase Realtime subscriptions, email event push, client reconnection strategy

## MCP Layer

- [ ] **MCP Server Architecture** — JSON-RPC 2.0 transport, lifecycle, capability negotiation, tool registration
- [ ] **MCP Tool Design** — How MCPEmails tools are structured, input/output schemas, error surface
- [ ] **MCP Authentication Flow** — How API keys map to MCP sessions, scope enforcement per tool call

## Email Integration

- [ ] **Email Provider OAuth Flows** — Gmail, Outlook, Fastmail OAuth 2.0 flows, token storage, refresh lifecycle
- [ ] **IMAP/SMTP Connection Management** — Connection pooling, keep-alive, provider-specific quirks
- [ ] **Email Parsing Pipeline** — MIME parsing, sanitization, attachment handling, content extraction

## Frontend (Next.js)

- [ ] **App Architecture** — App Router structure, route groups, layout hierarchy, shared state
- [ ] **Data Fetching Strategy** — Server Components vs. client fetching, caching, revalidation, optimistic updates
- [ ] **Design System & Component Library** — CSS variable tokens, primitive components, responsive breakpoints

## Cross-Cutting

- [ ] **Rate Limiting & Quotas** — Per-key and per-user limits, quota enforcement at the Edge Function level
- [ ] **Error Handling & Recovery** — Global error boundaries, retry logic, user-facing error messages
- [ ] **Security Architecture** — Token encryption at rest, audit logging, threat model, OWASP mitigations
- [ ] **Performance Optimizations** — Caching layers (in-memory, Supabase, CDN), batching, code splitting
- [ ] **Deployment Architecture** — Vercel + Supabase environment setup, CI/CD pipeline, secrets management
- [ ] **Monitoring & Observability** — Structured logging, metrics, alerting thresholds, error tracking (Sentry)

---

**Total**: 21 documents

**Convention**: Create each document at `Documents/Architecture/<kebab-case-name>.md`.
