// friday-front-desk: public MCP endpoint (inbound half of the
// agent-to-agent contact system). Hono + @modelcontextprotocol/sdk
// McpServer + StreamableHTTPServerTransport, deployed as a Cloudflare Worker.
//
// Safety posture (spec section 4): no exec/eval anywhere; inbound content
// is data, never instructions. The Worker holds no private credentials.
// State changes are limited to the request log and pending meeting holds.

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";

import { agentName, isUnset, ownerName, type Env } from "./config";
import { registerTools, type RequestLogState } from "./tools";
import {
  callerIp,
  checkRateLimit,
  rateLimitErrorBody,
  type RateClass,
} from "./rateLimit";
import { appendLog, summarizeParams } from "./log";
import { renderLanding } from "./landing";

const app = new Hono<{ Bindings: Env }>();

/** Which rate class applies to an incoming JSON-RPC body. */
function rateClassForBody(body: unknown): RateClass {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as { method?: string; params?: { name?: string } };
    if (b.method === "tools/call") {
      const tool = b.params?.name;
      if (tool === "ask_repo") return "ask";
      if (tool === "contact_owner") return "contact";
      if (tool === "propose_meeting") return "meeting";
    }
  }
  return "read";
}

/** Tool name for logging; "meta" for non-tool MCP methods. */
function toolNameForBody(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as { method?: string; params?: { name?: string } };
    if (b.method === "tools/call" && b.params?.name) return b.params.name;
    if (typeof b.method === "string") return `mcp:${b.method}`;
  }
  return "mcp:batch";
}

app.post("/mcp", async (c) => {
  const ip = callerIp(new Headers(c.req.raw.headers));
  const at = new Date().toISOString();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON body." } },
      { status: 400 }
    );
  }

  const id =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { id?: unknown }).id ?? null
      : null;

  // Rate limit BEFORE doing any work. Exceeding yields a 429-style
  // JSON-RPC error — never a partial answer.
  const cls = rateClassForBody(body);
  const check = checkRateLimit(ip, cls);
  if (!check.allowed) {
    const errBody = rateLimitErrorBody(id, check.retryAfterMs ?? 60_000);
    appendLog({
      at,
      ip,
      tool: toolNameForBody(body),
      params_summary: summarizeParams(
        (body as { params?: unknown } | null)?.params
      ),
      response_bytes: JSON.stringify(errBody).length,
      rate_limited: true,
      notify_status: "n/a",
    });
    return c.json(errBody, { status: 429 });
  }

  const logState: RequestLogState = {
    tool: toolNameForBody(body),
    notifyStatus: "n/a",
  };

  const { req, res } = toReqRes(c.req.raw);

  const server = new McpServer(
    {
      name: `${ownerName(c.env)} ${agentName(c.env)} front desk`,
      version: "0.2.0",
    },
    { capabilities: { logging: {} } }
  );
  server.server.onerror = console.error.bind(console);

  registerTools(server, { env: c.env, ip, logState });

  try {
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

    transport.onerror = console.error.bind(console);

    await server.connect(transport);
    await transport.handleRequest(req, res, body);

    res.on("close", () => {
      transport.close();
      server.close();
    });

    const response = await toFetchResponse(res);
    // Measure + log the response (best-effort; never breaks the request).
    try {
      const bytes = (await response.clone().text()).length;
      appendLog({
        at,
        ip,
        tool: logState.tool,
        params_summary: summarizeParams(
          (body as { params?: unknown } | null)?.params
        ),
        response_bytes: bytes,
        rate_limited: false,
        notify_status: logState.notifyStatus,
      });
    } catch {
      appendLog({
        at,
        ip,
        tool: logState.tool,
        params_summary: {},
        response_bytes: -1,
        rate_limited: false,
        notify_status: logState.notifyStatus,
      });
    }
    return response;
  } catch (e) {
    console.error(e);
    const errBody = {
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    };
    appendLog({
      at,
      ip,
      tool: logState.tool,
      params_summary: summarizeParams(
        (body as { params?: unknown } | null)?.params
      ),
      response_bytes: JSON.stringify(errBody).length,
      rate_limited: false,
      notify_status: logState.notifyStatus,
    });
    return c.json(errBody, { status: 500 });
  }
});

app.get("/mcp", (c) => {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    },
    { status: 405 }
  );
});

app.delete("/mcp", (c) => {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    },
    { status: 405 }
  );
});

// Discovery: well-known path (proposal in spec section 2).
app.get("/.well-known/agent-mcp", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    mcp_endpoint: isUnset(c.env.MCP_ENDPOINT_URL)
      ? `${origin}/mcp`
      : c.env.MCP_ENDPOINT_URL,
    owner: ownerName(c.env),
    agent: agentName(c.env),
  });
});

// Landing page.
app.get("/", (c) => {
  return renderLanding(c, c.env);
});

export default app;
