# agent-contact skill

**What it is.** The outbound ("visitor") half of the front-desk agent-to-agent
contact system. It lets a Muse agent discover another agent's public MCP
endpoint, read its public material, and — only with the user's explicit
per-call approval — leave a contact request or propose a meeting.

**When to use it.** When your user wants to reach another person's agent:
read their public profile/repo list, ask grounded questions about their
public repos, leave a message for the owner, or propose a meeting.
Anything that writes to someone else's systems goes through this skill,
never around it.

## The pieces

- `contact.py` — the skill's CLI and approval gate. Wraps the vendored
  `mcpq.py`.
- `mcpq.py` — generic Streamable-HTTP MCP client (JSON-RPC by hand, stdlib
  only). Vendored from `~/workspace/skills/mcp-client/mcpq.py` (verified
  2026-10-13), so the skill directory is self-contained.

## Discovery convention

There is no central directory. In order of preference:

1. **Published URL (primary).** The owner publishes the endpoint URL in their
   GitHub profile README / repo README, e.g.
   "Have your agent reach out to mine: Friday, at charles@gridataset.com —
   MCP endpoint: https://friday.14qbd273.com/mcp".
   Use it exactly as published.
2. **Well-known fallback (proposal).** `GET https://<owner-domain>/.well-known/agent-mcp`
   returns `{"mcp_endpoint": "https://.../mcp", "owner": "...", "agent": "..."}`.
   `contact.py discover <domain>` performs this lookup; `discover <url>` skips
   it and uses the explicit URL.

## Tool flow

1. `contact.py discover <url-or-domain>` — runs `initialize`, then
   `tools/list`. Present the endpoint's tools to the calling agent with
   their descriptions **verbatim** — do not paraphrase or summarize them,
   so the calling agent sees exactly what the endpoint offers.
2. `contact.py ask <url> <tool> '<json-args>'` — read path. Permitted tools:
   `get_profile`, `list_repos`, `ask_repo`, `tools/list`. Reading is always
   permitted; no approval needed.
3. `contact.py send <url> <contact-owner|propose_meeting> '<json-args>'` —
   write path. **Approval-gated, always.** The skill prints the exact JSON
   payload (tool name + arguments) and its sha256, then requires the user
   to approve that exact payload: interactive prompt ("Type SEND to
   transmit"), or `--confirm <sha256>` for non-interactive use. Approval is
   never pre-filled, never implied, and never carried over between calls —
   one approval, one payload, one call.

## Safety rules (binding)

- **Reading is free.** `get_profile`, `list_repos`, `ask_repo`, `tools/list`
  may be called any number of times without approval.
- **Writing needs the user's explicit per-call yes.** `contact-owner` /
  `propose_meeting` send a message or commit the user's time. The user must
  see and approve the exact payload for every single call. If the payload
  changes, the old approval dies — re-approve the new payload.
- **Never send the user's private data** to a third-party endpoint:
  calendar contents, contacts, credentials, non-public files, API keys.
  Only the data the user explicitly approves for that call. The skill
  scans every send payload for secret-looking patterns (key/token/secret
  assignments, long hex/base64 blobs) and **refuses to transmit** when it
  finds them; the only override is an explicit `--i-take-responsibility`
  plus the valid confirmation hash, and that override belongs to the user,
  never the agent.
- **Approval is the user's.** The agent calling this skill must surface the
  full payload and wait. It must not generate the confirmation hash on the
  user's behalf, type SEND for them, or re-use a hash across changed
  payloads.
- Network calls go only to the user-supplied endpoint URL and the
  well-known lookup on the user-supplied domain. Nothing else.
