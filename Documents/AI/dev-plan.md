# AI Development Plan

## Overview

This document outlines the standards, processes, and guidelines that all AI agents must follow when developing MCPEmails. The goal is to create a high-quality, performant, maintainable codebase through coordinated agent development using a scheduled task-picker system.

---

## 1. Development Loop Architecture

### 1.1 Scheduled Agent System

- **Frequency**: Every 5 minutes
- **Function**: Wake up, read the task checklist, pick the next available task
- **State**: The agent is stateless between runs; all context comes from the checklist and task metadata
- **Checklist Location**: `CHECKLIST.md` (to be created in project root)
- **Task Format**: Each task includes:
  - Task ID (e.g., `TASK-001`)
  - Title
  - Description
  - Acceptance criteria
  - Estimated effort
  - Current status (`pending`, `in-progress`, `blocked`, `completed`)
  - Owner (AI agent name or empty)
  - Dependencies (other task IDs that must be completed first)
  - Labels (e.g., `frontend`, `backend`, `testing`, `docs`)

### 1.2 Agent Responsibilities

Each agent run should:
1. Read `CHECKLIST.md` and identify next eligible task
2. Mark task as `in-progress` with agent name and timestamp
3. Fetch full task context from linked documents
4. Execute the task following this plan's standards
5. Create atomic, well-formatted git commits
6. Update task status to `completed` with summary
7. Document blockers if task cannot complete

### 1.3 Task Selection Logic

- Pick first `pending` task with no `blockedBy` dependencies
- Skip tasks that are already `in-progress` (other agent working on it)
- Prioritize by: criticality > dependencies > effort
- If blocked, mark blocker clearly and move to next task

---

## 2. Code Quality Standards

### 2.1 General Principles

- **One responsibility per function/component**: Small, focused, testable units
- **No commented-out code**: Delete it; git history has it
- **No TODO/FIXME comments**: Convert to issues in the checklist
- **Meaningful variable names**: `user` not `u`, `emailCount` not `ec`
- **Type safety**: Use TypeScript; avoid `any` type
- **No magic strings**: Use named constants
- **Consistent formatting**: 2-space indentation, semicolons required

### 2.2 React/Frontend Standards

- **Use function components**: No class components
- **Hooks over hoc**: Use React hooks for state and effects
- **Minimize re-renders**: Use `React.memo`, `useCallback`, `useMemo` when profiler shows benefit
- **Props validation**: PropTypes or TypeScript interfaces for all components
- **Custom hooks**: Extract logic into custom hooks (e.g., `useEmailList`, `useAuth`)
- **No inline styles**: Use CSS modules or design system classes
- **Accessibility first**: Semantic HTML, ARIA labels, keyboard navigation
- **Error boundaries**: Wrap feature areas in error boundaries

### 2.3 Backend/API Standards

- **Type-safe database queries**: Use Supabase JavaScript client with types
- **Prepared statements**: Always use parameterized queries (built-in with Supabase SDK)
- **Error handling**: Structured error messages; never expose stack traces to client
- **Input validation**: Validate all user input at API boundary
- **Rate limiting ready**: Design API routes to be rate-limit-friendly
- **Logging**: Use structured logging with correlation IDs for tracing

### 2.4 Performance Standards

- **Lighthouse target**: 90+ on all metrics
- **Perceived performance**: Optimistic updates, loading states, skeletons
- **Bundle size**: Monitor and report on changes > 5KB
- **Database queries**: Index frequently filtered columns; explain plans for slow queries
- **Caching strategy**: Cache headers for static assets; SWR for API responses
- **No N+1 queries**: Use joins/relations instead of looping and fetching

---

## 3. Design System Compliance

### 3.1 Design System Location

- **Source**: `/apps/web/styles/` contains all design tokens
- **Reference**: `designs/` folder (to be created) contains Figma export or design specs
- **Typography**: All text must use established font sizes, weights, and line heights
- **Colors**: Use CSS variables (e.g., `var(--cobalt-500)`) from theme
- **Spacing**: Use 4px base unit (4px, 8px, 12px, 16px, 24px, 32px, etc.)
- **Components**: Reuse Primitives from `components/Primitives.jsx`

### 3.2 Responsive Design

- **Mobile first**: Design for mobile, then enhance for tablet/desktop
- **Breakpoints**:
  - Mobile: 0–640px
  - Tablet: 641–1024px
  - Desktop: 1025px+
- **Touch targets**: Minimum 44px × 44px for interactive elements
- **Viewport meta tag**: Already set; don't override

### 3.3 Dark Mode Support

- **Class-based theming**: `data-theme="light"` and `data-theme="dark"` on `<html>`
- **CSS variables**: All colors use `var(--*)` with light/dark variants
- **User preference**: Respect `prefers-color-scheme` media query; allow override
- **Testing**: Test all UI in both light and dark modes

---

## 4. Performance & Optimization Tricks

### 4.1 Frontend Optimizations

**Preloading & Prefetching**
- Link preload for critical resources (fonts, hero images)
- DNS-prefetch for external APIs
- Prefetch links on hover or visibility (Intersection Observer)
- Use `<link rel="preload">` for fonts and critical CSS

**Optimistic Updates**
- Update UI before server responds (if safe to reverse)
- Example: Delete inbox → remove from list immediately → revert if 500 error
- Use optimistic cache in Supabase client or custom state

**Code Splitting**
- Lazy load dashboard pages (Overview, Inboxes, etc.) with `React.lazy` + `Suspense`
- No route should load >50KB of JS

**Image Optimization**
- Use `<picture>` for responsive images or WebP fallback
- Lazy load images below fold
- Compress images; target <100KB for hero, <30KB for thumbnails

**Caching Strategy**
- Service Worker for offline-first static assets (future task)
- HTTP cache headers: immutable for versioned assets, 1-hour for index.html
- SWR (stale-while-revalidate) for API responses

### 4.2 Backend Optimizations

**Database**
- Create indexes on: `user_id`, `workspace_id`, `status`, `created_at`
- Batch operations when loading lists (use Supabase's `in()` filter)
- Limit columns in SELECT (don't fetch unused fields)
- Use real-time subscriptions sparingly (high cost)

**API Response**
- Paginate large lists (default 20, max 100 per page)
- Return only needed fields (no `select('*')` unless required)
- Gzip compression (Vercel/Next.js does this automatically)

**Background Jobs**
- Use Supabase Edge Functions for async work (cleanup, emails, etc.)
- Schedule with simple webhook polling (avoid cron until needed)

---

## 5. MCP & Email Expertise

### 5.1 Required Documents

Before starting any task, read these documents (located in `Documents/`):

**MCP Documentation** (`Documents/MCP/`)
- `spec.md` — MCP protocol specification and how mcpemails implements it
- `tools.md` — Available tools (list_inbox, read_email, send_email, reply_to_email, etc.)
- `authentication.md` — OAuth flows, token management, security
- `error-handling.md` — MCP error codes and how to handle them

**Email Documentation** (`Documents/Email/`)
- `imap-smtp.md` — IMAP and SMTP protocol details for all providers
- `oauth-flows.md` — Gmail, Outlook, Fastmail OAuth flows and token refresh
- `email-parsing.md` — How to safely parse email (encoding, attachments, etc.)
- `rate-limits.md` — Provider rate limits and backoff strategy

### 5.2 Key Concepts to Internalize

**MCP Protocol**
- Tools are JSON-RPC 2.0 requests over stdio
- Each tool call is logged to the activity feed
- Rate limits are per-API-key, not per-user
- Scopes restrict which tools a key can use

**Email Providers**
- Gmail: Uses Gmail API; OAuth tokens last 1 hour; refresh tokens last ~6 months
- Outlook: Uses Microsoft Graph; OAuth tokens last 1 hour; similar refresh logic
- Fastmail/IMAP: Uses IMAP/SMTP directly; credentials stored encrypted; no OAuth
- All have different rate limits; handle 429 responses with exponential backoff

**Security**
- API keys are bearer tokens; never log them
- OAuth tokens are sensitive; use secure storage
- Credentials are encrypted at rest (Supabase field encryption)
- All MCP traffic is user-initiated; no background fetching

---

## 6. Git Commit Guidelines

### 6.1 Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type** (required): `feat`, `fix`, `refactor`, `test`, `docs`, `perf`, `chore`
**Scope** (optional): Area affected (e.g., `dashboard`, `auth`, `api`)
**Subject**: Imperative, present tense ("add" not "added"), no period, max 50 chars

**Body** (required if complex): Explain the "why", not the "what"
- Wrap at 72 characters
- Leave blank line before footer
- Reference issue if applicable

**Footer** (optional): 
- Breaking changes: `BREAKING CHANGE: description`
- Issue close: `Closes #123`

### 6.2 Examples

```
feat(dashboard): add inbox connection status indicator

Show a green/yellow/red dot next to each inbox to indicate
connection health. Orange means token expiring soon, red means
auth failed.

Closes #TASK-042
```

```
fix(api): prevent N+1 query in inbox list endpoint

Use PostgreSQL JOIN instead of fetching inboxes then
looping to fetch provider status. Reduces response time
from 800ms to 120ms.
```

```
test(email-parser): add unit tests for edge cases

Cover: missing headers, malformed MIME, very large attachments,
non-UTF8 encoding.
```

### 6.3 Commit Best Practices

- **One logical change per commit**: Easy to revert if needed
- **Test before committing**: Don't commit broken code
- **Small commits**: Aim for <200 lines of changes per commit
- **Atomic commits**: Each commit should be deployable
- **No merge commits in feature branches**: Rebase onto main
- **Squash if necessary**: Before merging PR, squash into logical commits

---

## 7. Backend Architecture with Supabase

### 7.1 Core Concepts

**Tables** (PostgreSQL with RLS)
- `users` — User accounts and preferences
- `workspaces` — Tenant isolation (one per user initially)
- `inboxes` — Connected email accounts (Gmail, Outlook, Fastmail, IMAP)
- `api_keys` — OAuth and MCP API keys (encrypted)
- `activity_log` — All MCP tool calls for auditing
- `auth_logs` — Login/logout and security events

**Row-Level Security (RLS)**
- All tables filtered by `workspace_id` at database level
- Users can only see their own data (enforce in policy)
- Service role bypasses RLS for backups/admin tasks

**Real-time Subscriptions** (use sparingly; expensive)
- Activity feed updates in dashboard
- Only subscribe when user is actively viewing page
- Unsubscribe on unmount

### 7.2 Database Schema Design

- **UUID primary keys**: `id uuid default gen_random_uuid()`
- **Timestamps**: `created_at timestamp default now()`, `updated_at timestamp default now()`
- **Soft deletes** (if needed): `deleted_at timestamp null`
- **Indexes**: Add composite indexes for common filters (e.g., `(workspace_id, status)`)
- **Foreign keys**: Use `on delete cascade` or `on delete restrict` as appropriate

### 7.3 Supabase-Specific Features

**Auth**
- Use Supabase Auth for user management
- JWT tokens in cookie + localStorage (Supabase SDK handles)
- Magic link or OAuth sign-in (no passwords for MVP)

**Database Client**
```javascript
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(url, key);
const { data, error } = await supabase
  .from('inboxes')
  .select()
  .eq('workspace_id', workspaceId);
```

**Edge Functions**
- Deploy async work (email cleanup, token refresh, etc.)
- Triggered by webhooks or scheduled tasks
- Auto-scales; pay per execution

**Postgres Extensions**
- `pgvector` for future AI features
- `uuid-ossp` for UUID generation
- `pg_trgm` for text search

### 7.4 Performance at Scale

- **Connection pooling**: Supabase uses PgBouncer; handled automatically
- **Query optimization**: Use `explain` in dashboard to find slow queries
- **Materialized views**: For complex aggregations (activity stats, usage, etc.)
- **Partitioning**: Activity log will be partitioned by `created_at` when >50M rows

---

## 8. Supabase MCP Integration

### 8.1 What is Supabase MCP?

The Supabase MCP server exposes the Supabase API as MCP tools, allowing agents (and AI) to:
- Execute SQL queries (`execute_sql`)
- Apply migrations (`apply_migration`)
- Deploy Edge Functions (`deploy_edge_function`)
- List/manage tables, extensions, branches
- Get logs for debugging

### 8.2 Using Supabase MCP in Development

**When to use**:
- Run migrations to alter schema
- Deploy backend functions (Edge Functions)
- Execute one-off data fixes or backfills
- Query database for debugging

**Examples**:
```
// Apply a migration (from agent)
supabase_mcp.apply_migration("add_inbox_status_column", 
  "ALTER TABLE inboxes ADD COLUMN status TEXT DEFAULT 'pending';")

// Deploy an Edge Function
supabase_mcp.deploy_edge_function("send-email",
  { entrypoint: "index.ts", verify_jwt: true, ... })

// Execute a query
supabase_mcp.execute_sql("SELECT * FROM inboxes WHERE workspace_id = '...'")
```

### 8.3 Best Practices

- **Migrations over direct SQL**: Always use `apply_migration` for schema changes
- **Idempotent migrations**: `CREATE TABLE IF NOT EXISTS`, `DROP TABLE IF EXISTS`
- **Test migrations**: Apply to dev branch first
- **Edge Functions for backend logic**: Don't put business logic in API routes
- **Version your schema**: Keep migration names sequential and descriptive

---

## 9. Testing Strategy

### 9.1 Testing Pyramid

```
           /\
          /E2E\          < 5%   (critical user flows)
         /______\
        /  Unit  \      ~70%   (functions, hooks, API routes)
       /___________\
      /  Component \    ~25%   (UI rendering, interactions)
     /_______________\
```

### 9.2 Unit Testing

**Tools**: Vitest + @testing-library/react

**Coverage Target**: 80% line coverage minimum

**What to test**:
- Pure functions (formatters, parsers, validators)
- Custom React hooks (`useEmailList`, `useAuth`, etc.)
- Redux selectors and reducers (if using Redux)
- API route logic (endpoint handling, validation)
- Utilities (date manipulation, encryption, etc.)

**Example**:
```javascript
// useEmailList.test.ts
import { renderHook, act } from '@testing-library/react';
import { useEmailList } from './useEmailList';

test('fetches emails on mount', async () => {
  const { result } = renderHook(() => useEmailList('inbox-id'));
  expect(result.current.loading).toBe(true);
  
  await act(async () => {
    await new Promise(r => setTimeout(r, 100));
  });
  
  expect(result.current.emails).toHaveLength(3);
  expect(result.current.loading).toBe(false);
});
```

### 9.3 Component Testing

**Tools**: @testing-library/react + userEvent

**What to test**:
- Component renders with props
- User interactions (click, type, submit)
- State changes
- Error and loading states
- Accessibility (keyboard nav, ARIA labels)

**Example**:
```javascript
// EmailList.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailList } from './EmailList';

test('displays emails and allows delete', async () => {
  render(<EmailList emails={[...]} onDelete={mockFn} />);
  
  const email = screen.getByText('Test Email');
  expect(email).toBeInTheDocument();
  
  const deleteBtn = screen.getByRole('button', { name: /delete/i });
  await userEvent.click(deleteBtn);
  
  expect(mockFn).toHaveBeenCalledWith('email-id');
});
```

### 9.4 E2E Testing

**Tools**: Playwright or Cypress (choose one)

**Coverage**: Critical user flows only (5% of test suite)
- User sign up → connect inbox → view emails → send email
- Admin operations (create key, revoke access)
- Error recovery (network failure, expired token)

**Where to run**:
- CI/CD pipeline (GitHub Actions)
- Before production deployment
- Not on every commit (too slow)

**Example** (Playwright):
```javascript
// signup.spec.ts
import { test, expect } from '@playwright/test';

test('complete signup and connect inbox', async ({ page }) => {
  await page.goto('/signup');
  await page.fill('input[name=email]', 'user@example.com');
  await page.fill('input[name=password]', 'secure123');
  await page.fill('input[name=workspace]', 'my-workspace');
  
  await page.click('text=Create workspace');
  await page.waitForNavigation();
  
  expect(page.url()).toContain('/dashboard');
  await expect(page.locator('text=Overview')).toBeVisible();
});
```

### 9.5 Testing Checklist

Before marking a task as complete:
- [ ] Unit tests written for all functions/hooks
- [ ] Component tests for all new UI components
- [ ] E2E test added if user-facing feature
- [ ] Test coverage ≥ 80% for new code
- [ ] All tests passing locally (`npm test`)
- [ ] No console errors or warnings in tests
- [ ] Accessibility tests pass (`axe` or similar)

---

## 10. Development Workflow

### 10.1 Starting a Task

1. **Claim task**: Mark task as `in-progress` in CHECKLIST.md
2. **Read context**: Study linked docs and acceptance criteria
3. **Create branch**: `git checkout -b task/TASK-XXX-short-name`
4. **Write test first**: TDD approach for complex logic
5. **Implement feature**: Follow code quality standards
6. **Manual testing**: Test in browser; verify against acceptance criteria

### 10.2 During Development

**Run tests continuously**:
```bash
npm test -- --watch
```

**Check code quality**:
```bash
npm run lint
npm run type-check
```

**Test in browser**:
```bash
npm run dev
# Navigate to feature and test manually
```

**Monitor performance**:
- Open DevTools Performance tab
- Look for long tasks, excessive re-renders
- Use React DevTools Profiler

### 10.3 Submitting Work

1. **Commit frequently**: Small, logical commits (see git guidelines)
2. **Rebase on main**: `git rebase origin/main`
3. **Test one more time**: `npm test && npm run dev`
4. **Create PR**: Link to task, describe changes
5. **Code review**: Address feedback
6. **Merge**: Squash into single commit or keep atomic commits
7. **Update CHECKLIST**: Mark task as `completed`

### 10.4 Handling Blockers

If a task is blocked:
1. **Document clearly**: Why it's blocked, what's needed to unblock
2. **Identify dependency**: Link to blocking task
3. **Mark as blocked**: Set status to `blocked` with blocker note
4. **Notify team**: If blocking another agent
5. **Move on**: Pick next unblocked task

---

## 11. Continuous Improvement

### 11.1 Metrics to Track

- **Code quality**: Lint warnings, type errors, test coverage trend
- **Performance**: Lighthouse scores, Core Web Vitals, build size
- **Developer experience**: Time to set up, time to run tests, time to deploy
- **User impact**: Error rates, feature usage, performance metrics from users

### 11.2 Regular Reviews

- **Weekly**: Team sync on blockers and progress
- **Bi-weekly**: Code quality metrics review
- **Monthly**: Architecture review; refactor if needed
- **Quarterly**: User feedback review; reprioritize features

### 11.3 Debt Management

- **Technical debt issues**: Create `debt/` issues for refactoring
- **Prioritize**: High-impact debt (performance, security) gets highest priority
- **Allocate time**: Reserve 20% of sprint for debt
- **Document**: Link debt issues to decisions that caused them

---

## 12. Quick Reference

### Common Commands

```bash
# Development
npm run dev              # Start dev server
npm test                # Run tests
npm run lint            # Lint and format
npm run type-check      # TypeScript check

# Building
npm run build           # Production build
npm run build:analyze   # Bundle size analysis

# Database
npm run db:push         # Push schema changes (Prisma)
npm run db:studio       # Open Supabase Studio

# Deployment
npm run deploy          # Deploy to Vercel
```

### File Structure

```
/
  apps/web/
    app/                # Next.js app directory
    components/         # Reusable components
    styles/             # CSS and design tokens
    utils/              # Helper functions
  Documents/
    AI/                 # This plan
    MCP/                # MCP protocol docs
    Email/              # Email provider docs
  CHECKLIST.md          # Task list for agents
```

### Key Contacts & Resources

- **Design System**: Figma link (TBD)
- **Supabase Dashboard**: https://app.supabase.com/
- **GitHub**: Repository for issues and discussions
- **Performance**: Vercel Analytics dashboard

---

## Appendix: Standards Checklist

Use this checklist for every task:

- [ ] Code follows style guide (linting passes)
- [ ] All functions/components have tests
- [ ] Test coverage ≥ 80%
- [ ] No console errors or warnings
- [ ] Accessibility tested (keyboard, ARIA)
- [ ] Responsive design verified (mobile, tablet, desktop)
- [ ] Dark mode tested
- [ ] Performance verified (Lighthouse ≥ 90)
- [ ] Git commit messages follow format
- [ ] Task updated to `completed` in CHECKLIST.md
- [ ] All acceptance criteria met

---

**Version**: 1.0  
**Last Updated**: 2026-05-24  
**Next Review**: 2026-06-24
