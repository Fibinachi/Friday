// Outbound notifications: Worker -> IRC relay webhook.
//
// Spec section 7: a small outbound-only IRC bot (proposed home:
// garage-linux, systemd-supervised, Libera Chat) exposes an HTTPS webhook
// relay on the tailnet. The Worker POSTs {type, summary, detail, at} to it
// and the bot posts the message into Charles's private channel. The bot is
// send-only for notifications plus existing receptionist duties; it never
// executes anything from inbound IRC text.
//
// Until the bot exists, notifications queue in the Worker log with
// status "queued" and Charles reviews them manually — the endpoint ships
// without losing messages.
//
// notify() NEVER throws: a failed delivery is logged and the request
// continues normally.

import { isUnset, type Env } from "./config";
import { appendLog, type LogEntry } from "./log";

export type NotifyType = "contact" | "meeting_pending" | "question_queued";

export interface NotifyInput {
  type: NotifyType;
  summary: string;
  /** Structured detail for Charles. May include the visitor's message —
   *  this goes only to Charles's channel, never to the public log. */
  detail: Record<string, unknown>;
}

export type NotifyStatus = "sent" | "queued" | "failed-queued";

function queuedLog(input: NotifyInput, status: Extract<NotifyStatus, "queued" | "failed-queued">): void {
  const entry: LogEntry = {
    at: new Date().toISOString(),
    ip: "internal",
    tool: "notify",
    // Bodies stay out of the log: record the type and payload size.
    params_summary: {
      type: input.type,
      summary: input.summary.slice(0, 200),
      detail_bytes: JSON.stringify(input.detail).length,
      status,
    },
    response_bytes: 0,
    rate_limited: false,
    notify_status: status,
  };
  appendLog(entry);
}

export async function notify(
  env: Env,
  input: NotifyInput
): Promise<NotifyStatus> {
  if (isUnset(env.NOTIFY_WEBHOOK_URL)) {
    queuedLog(input, "queued");
    return "queued";
  }
  const payload = {
    type: input.type,
    summary: input.summary,
    detail: input.detail,
    at: new Date().toISOString(),
  };
  try {
    const res = await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      queuedLog(input, "failed-queued");
      return "failed-queued";
    }
    return "sent";
  } catch (e) {
    console.error("notify failed:", e instanceof Error ? e.message : e);
    queuedLog(input, "failed-queued");
    return "failed-queued";
  }
}
