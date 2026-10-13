// Local test runner: serves the Worker app via @hono/node-server with
// Node's proxy-aware fetch, so the GitHub API calls in ask_repo work
// from this sandbox (wrangler dev --local cannot do proxied HTTPS CONNECT
// here; production Workers fetch directly). Not used in production.
import { serve } from "@hono/node-server";
import app from "../src/index.js";

const env = {
  MCP_OWNER_NAME: process.env.MCP_OWNER_NAME || "Charles Prescott",
  MCP_AGENT_NAME: process.env.MCP_AGENT_NAME || "Friday",
  MCP_ENDPOINT_URL: process.env.MCP_ENDPOINT_URL || "",
  OWNER_AGENT_CALLBACK_URL: process.env.OWNER_AGENT_CALLBACK_URL || "",
  NOTIFY_WEBHOOK_URL: process.env.NOTIFY_WEBHOOK_URL || "",
};

const port = Number(process.env.PORT || 8788);
serve({ fetch: (req) => app.fetch(req, env), port });
console.log(`friday-front-desk local test server on http://127.0.0.1:${port}`);
