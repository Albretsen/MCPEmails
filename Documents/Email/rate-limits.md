# Email Provider Rate Limits

## Gmail API

### Rate Limits

| Metric | Limit | Window |
|--------|-------|--------|
| Requests | 500 | Per user per second |
| Quota | 5 billion | Per project per day |
| Concurrent connections | 100 | Per user |

### Batch Requests

Gmail API supports batch requests to reduce overhead:

```javascript
// Instead of 100 individual API calls
// Make 10 batch requests with 10 messages each
// Dramatically reduces quota usage
```

### Handling 429 (Rate Limit)

```javascript
async function callGmailAPI(method, params) {
  let retries = 0;
  const maxRetries = 5;
  
  while (retries < maxRetries) {
    try {
      return await gmail[method](params);
    } catch (error) {
      if (error.status === 429) {
        const backoffMs = Math.min(1000 * Math.pow(2, retries), 30000);
        await sleep(backoffMs);
        retries++;
      } else {
        throw error;
      }
    }
  }
  
  throw new Error('Gmail API rate limit: max retries exceeded');
}
```

### Best Practices

1. **Batch operations**: Fetch multiple messages in one batch request
2. **Cache results**: Don't refetch same data within 5 minutes
3. **Use push notifications**: Instead of polling for new emails
4. **Limit to needed fields**: Only select columns you need
5. **Monthly quota**: Check quota usage in Google Cloud Console

## Microsoft Graph (Outlook)

### Rate Limits

| Metric | Limit | Window |
|--------|-------|--------|
| Requests | 2,000 | Per user per 60 seconds |
| Throttling | 429 | Response returned |

### Throttling Headers

Microsoft includes these headers in responses:

```
Retry-After: 120  (seconds to wait before retrying)
X-RateLimit-Limit: 2000
X-RateLimit-Remaining: 1995
X-RateLimit-Reset: 2026-05-24T10:45:00Z
```

**Use these to implement smart backoff**:

```javascript
async function callMSGraph(endpoint) {
  try {
    const response = await fetch(endpoint);
    
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
      await sleep(retryAfter * 1000);
      return callMSGraph(endpoint); // Retry
    }
    
    return response.json();
  } catch (error) {
    throw error;
  }
}
```

### Best Practices

1. **Read Retry-After header**: Use actual server guidance, not guessing
2. **Batch requests**: Use `$batch` endpoint for multiple operations
3. **Filter and select**: Only fetch needed properties
4. **Limit requests**: Paginate results; don't fetch all at once
5. **Monitor remaining quota**: Use `X-RateLimit-Remaining` header

## Fastmail IMAP/SMTP

### IMAP Limits

| Metric | Limit |
|--------|-------|
| Concurrent connections | 20 per account |
| Requests per second | No strict limit |
| Max command size | 8 KB |

Fastmail is very permissive with IMAP; no hard rate limits.

### SMTP Limits

| Metric | Limit |
|--------|-------|
| Emails per day | 10,000 |
| Recipients per email | 100 |
| Concurrent connections | 20 |
| Max message size | 150 MB |

### Handling Connection Limits

```javascript
// If connection fails due to limit:
// 1. Wait 30 seconds
// 2. Try again
// 3. If still failing, disconnect unused connections

async function connectIMAPWithRetry(config, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await imap.connect(config);
    } catch (error) {
      if (error.message.includes('connection limit')) {
        const waitMs = 30000 * attempt;
        await sleep(waitMs);
      } else {
        throw error;
      }
    }
  }
}
```

### Best Practices

1. **Reuse connections**: Keep one persistent connection per account
2. **Use IMAP IDLE**: Instead of polling (better for real-time updates)
3. **Batch operations**: Download multiple messages at once
4. **Close idle connections**: After 30 minutes of inactivity
5. **Monitor quota**: Fastmail shows email count in IMAP

## Generic IMAP/SMTP Providers

Most self-hosted or generic providers have similar limits:

| Typical Limit | Value |
|---|---|
| Concurrent connections | 5-20 |
| Max message size | 25-50 MB |
| Rate limit | Varies widely |

**Always test with the specific provider** to understand their limits.

## MCPEmails Global Limits

On top of provider limits, MCPEmails enforces:

| Resource | Limit | Reason |
|----------|-------|--------|
| API key calls | 100/minute | Prevent abuse |
| API key calls | 1,000/hour | Fair usage |
| API key calls | 10,000/day | Prevent runaway scripts |
| Message size | 10 MB | Memory safety |
| Attachment count | 20 per email | Performance |
| Search results | 100 | Pagination |

### Handling MCPEmails Rate Limits

```javascript
// If MCPEmails returns 429:
// 1. Check Retry-After header
// 2. Wait and retry with exponential backoff
// 3. After 5 retries, fail gracefully to user

async function callMCPEmails(tool, params) {
  let retries = 0;
  
  while (retries < 5) {
    try {
      return await mcpemails.call(tool, params);
    } catch (error) {
      if (error.status === 429) {
        const delay = error.retryAfter || Math.pow(2, retries) * 1000;
        await sleep(delay);
        retries++;
      } else {
        throw error;
      }
    }
  }
  
  throw new Error('Rate limit exceeded; please try again later');
}
```

## Optimization Strategies

### 1. Batch API Calls

```javascript
// Bad: 100 separate API calls
for (const email of emails) {
  const details = await getEmailDetails(email.id);
}

// Good: Batch into 10 calls of 10 emails each
const batches = chunk(emails, 10);
const details = await Promise.all(
  batches.map(batch => batchGetEmailDetails(batch))
);
```

### 2. Cache Results

```javascript
const cache = new Map();

async function getEmailWithCache(id, options = {}) {
  const cacheKey = `${id}:${JSON.stringify(options)}`;
  
  if (!options.noCache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  
  const email = await getEmail(id, options);
  cache.set(cacheKey, email);
  
  // Auto-expire after 5 minutes
  setTimeout(() => cache.delete(cacheKey), 5 * 60 * 1000);
  
  return email;
}
```

### 3. Implement Queue with Backoff

```javascript
class RateLimitedQueue {
  constructor(rateLimit = 10, windowMs = 1000) {
    this.rateLimit = rateLimit;
    this.windowMs = windowMs;
    this.queue = [];
    this.inFlight = 0;
  }
  
  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }
  
  async process() {
    if (this.inFlight >= this.rateLimit || this.queue.length === 0) {
      return;
    }
    
    this.inFlight++;
    const { fn, resolve, reject } = this.queue.shift();
    
    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.inFlight--;
      
      // Stagger requests within window
      setTimeout(() => this.process(), this.windowMs / this.rateLimit);
    }
  }
}

// Usage
const queue = new RateLimitedQueue(10, 1000); // 10 requests per second
for (const email of emails) {
  queue.add(() => processEmail(email));
}
```

### 4. Implement Exponential Backoff

```javascript
async function withExponentialBackoff(fn, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 && attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        console.log(`Rate limited. Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
      } else {
        throw error;
      }
    }
  }
}
```

## Monitoring

### Log Rate Limit Hits

```javascript
function logRateLimitHit(provider, endpoint, retryAfter) {
  console.warn(`Rate limit hit [${provider}]`, {
    endpoint,
    retryAfter,
    timestamp: new Date().toISOString()
  });
  
  // Send to monitoring service (Sentry, DataDog, etc.)
  monitoring.captureException(new Error(`Rate limit: ${provider}`), {
    tags: { provider, endpoint }
  });
}
```

### Set Alerts

- Alert if rate limit hit > 3 times in an hour
- Alert if 429 responses > 1% of requests
- Alert if quota usage > 80% of daily limit

---

**Note**: This is a placeholder. Real production monitoring and alerting setup should be detailed.
