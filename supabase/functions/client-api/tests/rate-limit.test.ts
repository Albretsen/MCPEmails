import { assertEquals } from "jsr:@std/assert@1";
import { RateLimiter } from "../rate-limit.ts";

const limits = {
  read: { capacity: 5, refillPerSec: 1 },
  write: { capacity: 2, refillPerSec: 0.5 },
  send: { capacity: 1, refillPerSec: 0.1 },
  assistant: { capacity: 1, refillPerSec: 0.1 },
};

Deno.test("token bucket: a burst up to capacity, then refused with a retry-after", () => {
  let now = 0;
  const limiter = new RateLimiter(limits, { limit: 1000, windowMs: 10_000 }, () => now);
  for (let i = 0; i < 5; i++) assertEquals(limiter.take("u1", "read").ok, true);
  const refused = limiter.take("u1", "read");
  assertEquals([refused.ok, refused.scope, refused.retryAfter], [false, "user", 1]);
  now += 2000;
  assertEquals(limiter.take("u1", "read").ok, true);
  assertEquals(limiter.take("u1", "read").ok, true);
  assertEquals(limiter.take("u1", "read").ok, false);
});

Deno.test("token bucket: users and classes do not share a bucket", () => {
  const limiter = new RateLimiter(limits, { limit: 1000, windowMs: 10_000 }, () => 0);
  assertEquals(limiter.take("u1", "send").ok, true);
  assertEquals(limiter.take("u1", "send").ok, false);
  assertEquals(limiter.take("u2", "send").ok, true, "another user is unaffected");
  assertEquals(limiter.take("u1", "read").ok, true, "another class is unaffected");
});

Deno.test("token bucket: a batch costs one token per call", () => {
  const limiter = new RateLimiter(limits, { limit: 1000, windowMs: 10_000 }, () => 0);
  assertEquals(limiter.take("u1", "read", 4).ok, true);
  assertEquals(limiter.take("u1", "read", 2).ok, false);
  assertEquals(limiter.take("u1", "read", 1).ok, true);
});

Deno.test("token bucket: the bucket never holds more than its capacity", () => {
  let now = 0;
  const limiter = new RateLimiter(limits, { limit: 1000, windowMs: 10_000 }, () => now);
  limiter.take("u1", "read");
  now += 3_600_000;
  for (let i = 0; i < 5; i++) assertEquals(limiter.take("u1", "read").ok, true);
  assertEquals(limiter.take("u1", "read").ok, false);
});

Deno.test("isolate ceiling: refuses across users once the window is full, and resets", () => {
  let now = 0;
  const limiter = new RateLimiter(limits, { limit: 3, windowMs: 10_000 }, () => now);
  assertEquals(limiter.take("u1", "read").ok, true);
  assertEquals(limiter.take("u2", "read").ok, true);
  assertEquals(limiter.take("u3", "read").ok, true);
  const refused = limiter.take("u4", "read");
  assertEquals([refused.ok, refused.scope], [false, "isolate"]);
  now += 10_000;
  assertEquals(limiter.take("u4", "read").ok, true);
});

Deno.test("a refused request does not consume the isolate ceiling", () => {
  const limiter = new RateLimiter(limits, { limit: 3, windowMs: 10_000 }, () => 0);
  assertEquals(limiter.take("u1", "send").ok, true);
  for (let i = 0; i < 10; i++) assertEquals(limiter.take("u1", "send").ok, false);
  assertEquals(limiter.take("u2", "read").ok, true);
  assertEquals(limiter.take("u3", "read").ok, true);
});

Deno.test("memory is bounded: old buckets are evicted", () => {
  const limiter = new RateLimiter(limits, { limit: 1_000_000, windowMs: 10_000 }, () => 0, 100);
  for (let i = 0; i < 1000; i++) limiter.take(`user-${i}`, "read");
  assertEquals(limiter.size <= 100, true);
});
