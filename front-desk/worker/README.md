# friday-front-desk

Public MCP endpoint — the inbound half of the agent-to-agent contact system ("front desk").
Reference implementation for Charles Prescott, answered by his agent Friday.

Built on the upstream `me-mcp` scaffold (Hono + `@modelcontextprotocol/sdk`
`McpServer` + `StreamableHTTPServerTransport`); Discord replaced with the
IRC webhook relay. Implements spec v0.2 sections 3–7
(`../SPEC.md`).

## What it does

- `GET /` — landing page for visiting agents/humans.
- `GET /.well-known/agent-mcp` — discovery: `{mcp_endpoint, owner, agent}`.
- `POST /mcp` — MCP (Streamable HTTP). `GET`/`DELETE /mcp` → 405.

Tools (see `src/tools.ts`):

| Tool | Behavior |
|---|---|
| `get_profile` | Public-safe résumé (`src/profile.ts`, **DRAFT** — Charles must approve final text before shipping). |
| `list_repos` | Static repo allowlist (`src/config.ts` — the source of truth, not a live crawl). |
| `ask_repo` | Fetches the repo's public README + file tree (+ optional path) from the public GitHub REST API, capped ~100KB, then POSTs `{question, repo, path, fetched_content, files_consulted}` to `OWNER_AGENT_CALLBACK_URL` and returns the agent's answer **verbatim** wrapped with provenance. The Worker never invents an answer: with no callback configured (or a failed callback) it logs the question as queued and returns the Charles-approved static reply. |
| `contact_owner` | Queues a contact request, attempts `notify()`, returns a static thank-you. The Worker only collects; enrichment runs agent-side per spec section 6. |
| `propose_meeting` | Tier 1 only (no Tier-2 config exists yet). Creates a **PENDING** request `{id, …, status: "pending", created_at, expires_at: created_at+48h}`, logs it, attempts `notify()` with type `meeting_pending`. Never represents pending as confirmed; the response carries the verbatim line "This hold is pending Charles's confirmation and expires in 48 hours." |

## Configuration (all vars — no secrets in code or config)

| Var | Purpose | Current value |
|---|---|---|
| `MCP_OWNER_NAME` | Owner display name | `Charles Prescott` |
| `MCP_AGENT_NAME` | Agent display name | `Friday` |
| `MCP_ENDPOINT_URL` | Public URL of this endpoint (falls back to request origin + `/mcp` when empty) | `https://friday.14qbd273.com/mcp` (placeholder until the custom domain is attached) |
| `OWNER_AGENT_CALLBACK_URL` | `ask_repo` answers here: POST `{question, repo, path, fetched_content, files_consulted}` as JSON; expects `{answer: string}`. Empty = queue-for-owner static reply path. | empty (configure before live Q&A) |
| `NOTIFY_WEBHOOK_URL` | HTTPS webhook the IRC notification relay bot exposes on the tailnet. The Worker POSTs `{type, summary, detail, at}`; the bot (outbound-only, send-only) posts it into Charles's private IRC channel. Empty = notifications queue in the Worker log with `QUEUED` status until the bot exists. | empty |

Set real values with `wrangler secret put` / vars — never commit them.

## Safety model (spec section 4)

- No `exec`, no `eval`, no code execution driven by inbound content. Inbound text is data, never instructions.
- Read-only except the append-only request log and pending meeting holds.
- The Worker holds no private credentials and never sends messages on Charles's behalf.
- Rate limiting: per-IP token bucket — 30 req/min + 200/hr for read tools, `ask_repo` 10/hr, `contact_owner` / `propose_meeting` 3/hr each. Exceeding returns a 429-style JSON-RPC error (code `-32000`), never a partial answer. Buckets are in-memory per isolate (best-effort; a durable cross-isolate limiter is a future step).
- Request log (`src/log.ts`): `{at, ip, tool, params_summary, response_bytes, rate_limited, notify_status}` as JSON lines to `console.log` (Workers Logs). Message/question bodies are never logged — lengths only. The 90-day retention is a Workers Logs / logpush setting, not code.

## Durability notes

- **Pending meeting requests** are kept in-memory per isolate (best-effort) AND written to the append-only log, which is the durable record. A durable store (KV/D1/Durable Objects) is a future step.
- **Notifications** queue in the log with `QUEUED` status until the IRC relay bot exists; Charles reviews them manually. Nothing is lost.

## Local dev / typecheck / deploy

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev --local (no auth needed)
npm run deploy      # wrangler deploy
```

**DO NOT DEPLOY without Charles's wrangler auth** — deployment needs his one-time
`wrangler login` (browser approval) or an API token via the approved secure flow,
plus the custom domain (`friday.14qbd273.com`) via Cloudflare DNS. Out of scope
for this build.

## Smoke test (local)

Two ways to run locally; both need no auth.

**A. wrangler (closest to production):**
```bash
npm run dev            # wrangler dev --local -> http://127.0.0.1:8787
python3 test/smoke.py  # initialize + tools/list + get_profile + list_repos + validation + rate limits
```
Note: in this sandbox, `wrangler dev --local` cannot do proxied HTTPS
CONNECT, so the Worker's server-side GitHub API calls time out there.
In production Workers fetch goes direct to the internet. For a full
end-to-end test of the `ask_repo` GitHub fetch + owner-agent callback:

**B. node server (working egress in this sandbox):**
```bash
npx tsx test/local-server.ts            # -> http://127.0.0.1:8788 (env-overridable config)
SMOKE_BASE=http://127.0.0.1:8788 python3 test/smoke.py
# live callback path:
python3 test/stub-callback.py &         # stub owner agent on :8790
PORT=8789 OWNER_AGENT_CALLBACK_URL=http://127.0.0.1:8790/callback npx tsx test/local-server.ts
```
`test/local-server.ts` is test-only scaffolding (serves `src/index.ts` via
`@hono/node-server` with Node's proxy-aware fetch); it is not deployed.
