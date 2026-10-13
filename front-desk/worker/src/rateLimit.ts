// Per-IP token-bucket rate limiting.
//
// Spec: 30 req/min + 200/hr for read tools (get_profile, list_repos,
// plus MCP meta calls like initialize/tools/list), ask_repo 10/hr,
// contact_owner and propose_meeting 3/hr each.
//
// Exceeding a limit yields a 429-style JSON-RPC error object
// (code -32000) — never a partial answer.
//
// NOTE: buckets are in-memory per isolate. On Cloudflare's production
// network an isolate serves a subset of traffic, so this is best-effort
// abuse protection, not a hard global guarantee. A durable, cross-isolate
// limiter (Durable Objects or Workers KV) is a future step if needed.

export type RateClass = "read" | "ask" | "contact" | "meeting";

interface Window {
  windowMs: number;
  max: number;
}

const LIMITS: Record<RateClass, Window[]> = {
  read: [
    { windowMs: 60_000, max: 30 },
    { windowMs: 3_600_000, max: 200 },
  ],
  ask: [{ windowMs: 3_600_000, max: 10 }],
  contact: [{ windowMs: 3_600_000, max: 3 }],
  meeting: [{ windowMs: 3_600_000, max: 3 }],
};

interface Bucket {
  count: number;
  resetAt: number;
}

// One store per rate class; keys are "<ip>|<windowMs>".
const stores: Record<RateClass, Map<string, Bucket>> = {
  read: new Map(),
  ask: new Map(),
  contact: new Map(),
  meeting: new Map(),
};

export interface RateCheck {
  allowed: boolean;
  /** ms until the tightest exhausted window resets; present when denied. */
  retryAfterMs?: number;
}

export function checkRateLimit(
  ip: string,
  cls: RateClass,
  now: number = Date.now()
): RateCheck {
  const store = stores[cls] as Map<string, Bucket>;
  // Check phase: deny if ANY window for this class is exhausted.
  let retryAfterMs = 0;
  for (const { windowMs, max } of LIMITS[cls]) {
    const key = `${ip}|${windowMs}`;
    let b = store.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      store.set(key, b);
    }
    if (b.count >= max) {
      retryAfterMs = Math.max(retryAfterMs, b.resetAt - now);
    }
  }
  if (retryAfterMs > 0) {
    return { allowed: false, retryAfterMs };
  }
  // Consume phase: increment every window for this class.
  for (const { windowMs } of LIMITS[cls]) {
    const b = store.get(`${ip}|${windowMs}`)!;
    b.count += 1;
  }
  return { allowed: true };
}

/** Extract the caller's IP per spec: CF-Connecting-IP, else x-forwarded-for[0], else "unknown". */
export function callerIp(headers: Headers): string {
  const cf = headers.get("CF-Connecting-IP");
  if (cf && cf.trim()) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff && xff.trim()) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/** The 429-style JSON-RPC error body returned when a limit is exceeded. */
export function rateLimitErrorBody(id: unknown, retryAfterMs: number): object {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32000,
      message: `Rate limit exceeded. Please slow down and retry in ${Math.ceil(
        retryAfterMs / 1000
      )} seconds.`,
      data: { retry_after_ms: retryAfterMs },
    },
  };
}
