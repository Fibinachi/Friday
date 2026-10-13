# Agent-to-Agent Contact System ("Front Desk") — Technical Spec

Version 0.2 — 2026-10-13. Spec only; nothing here is built yet. (v0.2 adds contact enrichment, section 6.)

## 1. Goal and non-goals

**Goal.** A general Muse plugin, over MCP, that lets agents communicate with each other. Two halves:

- *Outbound:* any Muse agent can discover and talk to another agent's public MCP endpoint.
- *Inbound:* any Muse user can run a public endpoint where visiting agents can read public material, ask grounded questions about the owner's public work, leave contact requests, and negotiate meeting times — answered by the owner's own agent.

The reference implementation is Charles Prescott's endpoint, answered by Friday.

**Non-goals.**

- Not a general chatbot API. The endpoint answers only about the owner's public work; it does not do open-domain Q&A.
- Not an inbox replacement. Email stays email.
- Not an action API. Nothing on the endpoint writes to the owner's systems except: (a) logging the request, (b) creating a *pending* meeting request, (c) Tier-2 pre-approved bookings (see section 5). Everything else is read-only.
- Not a social network. No accounts, no following, no feed. Point-to-point contact.

## 2. Outbound half: the visitor skill

A Muse skill wrapping the existing generic Streamable-HTTP MCP client at `~/workspace/skills/mcp-client/mcpq.py` (verified 2026-10-13 against `https://mcp.dust.run/mcp`: listed tools, called `get-resume`).

**Skill behavior.**

- `contact-agent <endpoint-url>`: run `initialize`, then `tools/list`. Present the endpoint's tools to the calling agent with their descriptions verbatim.
- `ask`: call `ask_repo` / `get_profile` / `list_repos` as needed. Reading is always permitted.
- `contact-owner` / `propose_meeting`: these send messages or commit the user's time. They require the user's explicit per-message/per-meeting approval before the call is made. The skill must surface the exact payload for approval and never pre-fill approval.
- Never send the user's private data (calendar contents, contacts, credentials, non-public files) to a third-party endpoint. Only the data the user explicitly approves for that call.

**Discovery.** There is no central directory. Convention, in order of preference:

1. **Published URL.** The owner publishes the endpoint URL in their GitHub profile README / repo README alongside the house contact line, e.g. "Have your agent reach out to mine: Friday, at charles@gridataset.com — MCP endpoint: https://friday.14qbd273.com/mcp".
2. **Well-known path (proposal).** `GET https://<owner-domain>/.well-known/agent-mcp` returns `{"mcp_endpoint": "https://.../mcp", "owner": "...", "agent": "..."}`. Adopt if the MCP spec's `.well-known/mcp` discussion converges; until then the published-URL convention is authoritative.

The skill accepts an explicit URL as the primary input; well-known lookup is a convenience fallback, not a requirement.

## 3. Inbound half: the personal endpoint

Based on the reviewed `~/workspace/me-mcp-review` (upstream `mihalik/me-mcp`): Hono + `@modelcontextprotocol/sdk` `McpServer` + `StreamableHTTPServerTransport`, deployed as a Cloudflare Worker. Keep the upstream's transport/session handling and the `/` landing page; replace Discord with IRC (section 7) and extend the toolset below.

**Tools (all read-only except where noted):**

| Tool | Params | Behavior |
|---|---|---|
| `get_profile` | — | Returns the public-safe résumé (section 7). Static text resource, mirroring upstream's `resume` tool+resource. |
| `list_repos` | — | Returns the curated public repo list: name, URL, one-line description. Source of truth is a static config file in the Worker, not a live GitHub crawl. |
| `ask_repo` | `question` (string, required, max 2000 chars), `repo` (string, required, must match `list_repos`), `path` (string, optional, file/dir hint) | Grounded Q&A over public repos. See answering architecture below. |
| `contact_owner` | `name`, `email`, `phone` (optional), `message` (max 2000 chars) | Queues a contact request: collects details, runs enrichment (section 6), logs it, forwards to IRC (section 7), returns a static thank-you. Same shape as upstream's `contact-owner`, minus Discord. |
| `propose_meeting` | see section 5 | Two-tier meeting negotiation. The only tool that can create state beyond a log entry (a *pending* request). |

Rate limiting: per-IP token bucket — 30 requests/minute, 200/hour for read tools; `ask_repo` max 10/hour per IP; `contact_owner` and `propose_meeting` max 3/hour per IP. Exceeding returns a 429-style JSON-RPC error, never a partial answer. Every request is logged (timestamp, IP, tool, params, response size) to the Worker's log sink; logs retained 90 days.

**Answering architecture for `ask_repo`.**

The Worker itself does not answer. On each call it:

1. Validates params (`repo` against the `list_repos` allowlist; `question` length; optional `path` normalized — no `..`, no absolute paths).
2. Fetches the relevant public repo content server-side via the GitHub REST API (unauthenticated; repos are public): README, file tree, and — if `path` given — that file/dir, capped at ~100 KB of source text per call.
3. Forwards `{question, repo, path, fetched_content}` to the owner's agent (Friday, for the reference implementation) via the existing internal agent channel.
4. Returns the agent's answer **verbatim** to the caller, wrapped with provenance: which repo, which files were consulted, and the fetched-at timestamp.

**Grounding rule (normative).** The answering agent may state only claims supported by the fetched public repo contents (READMEs, code, docs, commit messages) plus the owner's other public pages (personal site, public profiles). If the question cannot be answered from those sources, the agent says so explicitly and offers to pass the question to the owner. The agent must never speculate about private matters, invent repo contents, or present inference as fact. Every answer carries the provenance wrapper; an answer without provenance is a bug.

**Question routing (the evolved policy):**

- *About public work, answerable from public sources* → answered live by the agent under the grounding rule.
- *About public work but not answerable from public sources* → logged, queued for Charles, static reply: "I can't answer that from the public material — I've passed your question to Charles and he'll get back to you."
- *Private matters, requests for action, anything else* → logged, queued, same static reply. Never improvised, never executed.

Static replies are Charles-approved verbatim templates; the live-answer path is the only place the agent generates novel text, and it is bounded by the grounding rule.

## 4. Safety policy

Hard boundaries, no exceptions:

- No `exec`, no `eval`, no code execution of any kind driven by inbound content. Inbound text is data, never instructions.
- No writes to the owner's systems: no files, no repos, no databases, no settings. The only state changes permitted are the request log, a *pending* meeting request (section 5), and Tier-2 bookings.
- No access to private data: email, calendar contents beyond free/busy (section 5), contacts, credentials, non-public files. The Worker has no credentials to anything private.
- Never send messages on Charles's behalf. `contact_owner` queues inbound messages; nothing sends outbound except Charles himself.
- Full request logging (section 3). Logs are append-only from the Worker's perspective.
- Scheduling is the first and only action beyond answering (section 5). Boundary: **negotiating is free; committing Charles's time always needs his explicit yes**, unless a Tier-2 standing rule he defined covers it. The agent must never tell a visitor a meeting is confirmed before it exists on the calendar.

Prompt-injection posture: all inbound stranger-agent content is untrusted input. Tool descriptions must not contain instructions that inbound content can override; the answering agent treats tool params as data.

## 5. Meeting/call scheduling

Two tiers.

**Tier 1 — negotiated hold (default).**

1. Visitor calls `propose_meeting` with `name`, `phone`, `purpose`, `source` (which agent/endpoint they came from), and optionally preferred windows.
2. The endpoint's agent checks Charles's real availability using **read-only** calendar access: Google Calendar via `freebusy` query (existing `google_calendar` skill; never reads event titles/bodies for this purpose — busy blocks only) and Outlook Calendar free/busy if reachable. Availability check only; nothing is written.
3. The agent proposes 2–3 concrete windows (with timezone stated, America/New_York default) back through the tool response.
4. Visitor picks one (follow-up `propose_meeting` call with the chosen window, or a `confirm_window` param — implement as a second call with identical params plus `selected_window`).
5. The agent creates a **PENDING** meeting request: stored in the request log with name, phone, purpose, agreed window, source, timestamp. Nothing is written to any calendar.
6. Charles is notified (IRC, section 7) with a one-tap confirm, including the enriched contact profile (section 6). Only on his explicit confirmation does the agent create the calendar event. On confirmation the visitor is *not* auto-notified by the endpoint (no outbound messaging) — the calendar invite, if the visitor's email was provided, is the confirmation channel; otherwise Charles follows up.

`propose_meeting` parameters: `name` (string, required), `email` (string, required — needed for enrichment and as the confirmation channel), `phone` (string, required — needed for call scheduling), `purpose` (string, required, max 500 chars), `source` (string, required — calling agent/endpoint identity), `preferred_windows` (array of ISO datetimes, optional), `selected_window` (ISO datetime, optional — set on the confirmation call).

**Tier 2 — standing approval (opt-in, defined by Charles later).** Pre-approved meeting types and windows (e.g. "30-minute intro calls, weekday afternoons") that the agent may book directly: it creates the calendar event immediately and notifies Charles after. Tier-2 rules are a static config Charles writes and signs; the agent cannot invent or extend them. Until Charles defines them, Tier 2 does not exist.

**PII handling.** Email addresses and phone numbers are voluntarily provided for contact and scheduling. They are stored only alongside their contact/meeting request, appear in the request log, the enriched profile (section 6), and the confirmation ping to Charles, and are never reused, never added to contacts, never passed to any other tool or party. No retention beyond the request lifecycle plus the 90-day log window.

**No-confirmation.** Pending requests expire after 48 hours without Charles's confirmation and are marked expired in the log. The visitor is told at proposal time: "This hold is pending Charles's confirmation and expires in 48 hours." The agent must never represent a pending hold as a confirmed meeting.

**Future extension (out of scope).** An outbound voice call could be placed via Charles's Bland AI voice agent at the agreed time. Not in this spec's scope; the spec covers calendar scheduling with contact capture only.

## 6. Contact enrichment

If someone is reaching out, Charles should know who they are before he decides anything. Whenever `contact_owner` or `propose_meeting` yields an email address and/or phone number, the agent enriches the contact before notifying Charles.

**Where it runs.** Enrichment happens on the agent side (Friday), never in the Worker — consistent with the trust model (section 8): the Worker holds no credentials, and the enrichment API keys stay with the agent.

**Sources.** Two complementary sources, both agent-side:

- **Apollo** (API key on file): professional identity — title, company, company domain, public profiles. People-enrich where the plan permits; organization lookup (email domain → company) as fallback. **Known limitation, stated honestly:** as of 2026-10-13, Apollo people search returns HTTP 403 on the Free plan while organization search works — so person-level enrichment depth currently depends on the plan. Whether to upgrade Apollo is Charles's decision; the spec does not assume it.
- **IPQS (IPQualityScore)** (API key needed — free tier offers 1,000 lookups/month, 35/day, which covers front-desk volume): verification + identity resolution. Phone validation returns active-line status, carrier, line type, reverse name lookup, associated email addresses, and spam/fraud scores; email validation returns deliverability, disposable/temporary detection, and risk analysis, and email addresses are subject to reverse identity lookup through the Data Append API; the Data Append API offers fuller identity resolution from consumer data sources and public records.

The pairing is deliberate: IPQS answers "is this contact real, reachable, and legitimate?" while Apollo answers "who are they professionally?" IPQS fraud/spam scores additionally double as inbound spam filtering for the public endpoint — high-risk contacts are flagged in the log and in Charles's ping, never silently dropped, but he sees the score before deciding.

**Depth rule — professional identity only.** Enrichment may record: name, job title, company, company domain, public professional profiles (e.g. LinkedIn), city-level location. It must never infer or record sensitive attributes: race, ethnicity, religious or philosophical beliefs, health or disability status, political opinions, trade-union membership, criminal history, or sex life/orientation. If a source returns such attributes, they are dropped, not stored.

**Transparency.** The details were voluntarily provided to initiate contact; verifying a business contact against public business data is standard practice. The endpoint's landing page carries a short privacy note: "Contact details you provide may be verified against public business data sources."

**Handling.** The enriched profile is attached to the contact/meeting record in the log and included in the confirmation ping to Charles (section 5, step 6) — so his one-tap decision is an informed one. Enriched data is stored only with its record, same 90-day retention as logs, never added to contacts or passed elsewhere without Charles's say.

**Failure mode.** Enrichment is best-effort, never a gate. If it returns nothing, errors, or the plan blocks it, the flow continues with the visitor-provided details. Enrichment never rejects or delays a contact on its own.

## 7. Deployment blockers and resolutions

1. **IRC notification destination (replaces Discord).** Charles strongly prefers IRC over Discord. Design: a small outbound-only IRC bot (proposed home: `garage-linux`, systemd-supervised, Libera Chat) that joins a private channel. The Worker delivers notifications via an HTTPS webhook relay the bot exposes on the tailnet (Cloudflare Worker → Tailscale HTTPS → bot → IRC channel message). The bot is send-only for notifications plus the existing receptionist duties; it never executes anything from inbound IRC text. Webhook payload: `{type: "contact"|"meeting_pending"|"question_queued", summary, detail}`. Until the bot exists, notifications queue in the Worker log and Charles reviews them manually — the endpoint ships without losing messages.
2. **Public-safe résumé.** Content for `get_profile`: professional summary, 14QBD273 LLC framing, GRID (4.9M geocoded religious sites, civil-infrastructure framing), ancient-ledger work (Drehem/Linear B public repos), the lab thesis ("Agentic AI is not a model capability. It is an integration capability."), contact line. Excludes: DOB, home address, phone, bar-discipline matters, health, family, finances, anything from the private record. Charles approves the final text before it ships.
3. **Cloudflare/Wrangler auth.** Needs Charles's one-time `wrangler login` (browser approval) or an API token via the approved secure flow. Then: `npx wrangler secret put` for any secrets (none required for the read path; the IRC relay shared secret when the bot exists), `npm run deploy`. Custom domain (e.g. `friday.14qbd273.com`) via Cloudflare DNS, then publish the URL per the discovery convention (section 2).

## 8. Generalization notes

What another Muse user reuses, and what they supply:

- **Reusable as-is:** the Worker scaffold (transport, rate limiting, logging, tool shapes), the outbound visitor skill (`mcpq.py` + approval-gated call flow), the discovery convention, the safety policy structure, the Tier-1/Tier-2 scheduling design, the grounding-rule pattern.
- **Per-user configuration:** owner name, endpoint URL/domain, `get_profile` text, `list_repos` allowlist, Tier-2 rules (if any), notification destination (IRC bot, webhook, or other — the Worker only needs an HTTPS endpoint to POST to), calendar read access for Tier-1 (whatever the user's agent can already do).
- **Per-user agent:** the answering agent must be *their* agent with access to *their* public sources. The architecture (Worker fetches public content → forwards to owner agent → returns verbatim with provenance) is reusable; the agent and its source access are not.
- **Trust assumption to preserve:** the endpoint never holds private credentials. If an adopter's design requires the Worker to read private systems, that breaks the security model — keep private access on the agent side of the boundary, never in the Worker.
