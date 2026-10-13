// Append-only structured request log.
//
// In the Worker runtime every entry goes to console.log as a single JSON
// line (visible in Workers Logs). The 90-day retention is a Workers Logs /
// logpush setting, not code — configure it in the Cloudflare dashboard.
//
// PRIVACY: params_summary truncates ordinary values to 200 chars and NEVER
// logs full message bodies — it logs their lengths instead. The body rule
// applies recursively (MCP wraps tool args in an `arguments` object), so a
// nested message/question/purpose can never slip through.

const SUMMARY_TRUNCATE = 200;

// Params whose values are bodies that must never be fully logged:
// log {len: N} instead. Checked at every nesting level.
const BODY_KEYS = new Set([
  "message",
  "question",
  "purpose",
  "detail",
  "fetched_content",
  "preferred_windows",
  "selected_window",
  "files_consulted",
]);

export interface LogEntry {
  at: string;
  ip: string;
  tool: string;
  params_summary: Record<string, unknown>;
  response_bytes: number;
  rate_limited: boolean;
  notify_status: "sent" | "queued" | "failed-queued" | "n/a";
}

function summarizeValue(v: unknown, key?: string): unknown {
  if (key !== undefined && BODY_KEYS.has(key)) {
    const len =
      typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
    return { len };
  }
  if (typeof v === "string") {
    return v.length > SUMMARY_TRUNCATE ? v.slice(0, SUMMARY_TRUNCATE) + "…" : v;
  }
  if (typeof v === "number" || typeof v === "boolean" || v == null) {
    return v;
  }
  if (Array.isArray(v)) {
    return v.map((item) => summarizeValue(item));
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = summarizeValue(val, k);
    }
    return out;
  }
  return String(v);
}

export function summarizeParams(params: unknown): Record<string, unknown> {
  const out = summarizeValue(params);
  return out && typeof out === "object" && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}

export function appendLog(entry: LogEntry): void {
  try {
    console.log(JSON.stringify(entry));
  } catch {
    // Logging must never break a request.
  }
}
