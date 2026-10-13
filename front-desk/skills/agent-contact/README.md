# agent-contact — outbound visitor skill for the front desk

Talk to another agent's public MCP endpoint. Discover it, read its public
material, and — with your user's explicit approval per call — leave a
contact request or propose a meeting.

Self-contained: `mcpq.py` is vendored in this directory (stdlib only, no
installs). Nothing here holds any credentials.

## Commands

### Discover an endpoint

```bash
# explicit URL (primary discovery convention)
python3 contact.py discover https://mcp.dust.run/mcp

# domain fallback: GET https://<domain>/.well-known/agent-mcp
python3 contact.py discover somedomain.example
```

Runs `initialize` + `tools/list` and prints each tool's name with its full
description **verbatim**, plus owner/agent when the well-known document
provides them.

### Ask (read tools — always permitted)

```bash
python3 contact.py ask https://mcp.dust.run/mcp get_profile '{}'
python3 contact.py ask https://mcp.dust.run/mcp list_repos '{}'
python3 contact.py ask https://mcp.dust.run/mcp ask_repo \
  '{"repo": "some-repo", "question": "What does the cache layer do?"}'
```

`ask` accepts only `get_profile`, `list_repos`, `ask_repo`, `tools/list`.
Anything else is refused with an error pointing at the `send` flow:

```bash
python3 contact.py ask https://x/mcp contact-owner '{}'
# error: 'contact-owner' is not a read tool. Refusing. ... For contact/message
# tools use the `send` flow, which requires explicit approval.
```

### Send (write tools — approval-gated)

```bash
python3 contact.py send https://owner.example/mcp contact-owner \
  '{"name": "...", "email": "...", "message": "..."}'

python3 contact.py send https://owner.example/mcp propose_meeting \
  '{"name": "...", "email": "...", "phone": "...",
    "purpose": "...", "source": "friday/1.0"}'
```

(Tip: `contact-owner` and `contact_owner` spellings are both accepted.)

## The approval model

`send` does three things, in order, and transmits only if all pass:

1. **Private-data scan.** The payload is scanned for secret-looking patterns
   (e.g. `api_key: <value>`, tokens, passwords, bearer strings, long
   hex/base64 blobs). On a hit the skill **refuses with a warning** and
   nothing is sent. The only override is re-running with
   `--i-take-responsibility` — which the user, not the agent, must choose.
2. **Surface the exact payload.** The skill prints the full JSON payload
   (pretty), its canonical form, and `sha256(canonical payload)`. The hash
   is the approval handle: it is bound to the exact bytes of the payload.
3. **Explicit confirmation, never pre-filled.**
   - Interactive (TTY stdin): `Type SEND to transmit this exact payload`
     — the user must type it themselves.
   - Non-interactive: `--confirm <sha256>` must match the printed hash.
     Workflow: run once with `--print-hash` to review and get the hash,
     show it to the user, get their yes, then re-run with `--confirm`.
     Anything else (mismatched hash, no TTY, no `--confirm`) refuses with
     exit code 2 and nothing is sent.

```bash
# non-interactive review pass — prints payload + hash, sends nothing
python3 contact.py send https://owner.example/mcp propose_meeting \
  '{"name":"...","email":"..."}' --print-hash

# approved transmission — hash must match the reviewed payload exactly
python3 contact.py send https://owner.example/mcp propose_meeting \
  '{"name":"...","email":"..."}' --confirm 9f2c...
```

One approval = one payload = one call. If any byte changes, the old hash
dies and the payload must be reviewed and approved again.

## For other Muse users

This directory is the outbound half of a general agent-to-agent contact
plugin; the inbound half (the personal endpoint) is a separate component
(see `~/workspace/friday/front-desk/SPEC.md`, sections 3-8). Drop the
directory anywhere, call `contact.py` with python3 — no dependencies beyond
the standard library. Tool spellings the skill recognizes: read =
`get_profile`, `list_repos`, `ask_repo`, `tools/list`; write =
`contact-owner`/`contact_owner`, `propose_meeting`. If the endpoint you
visit uses different tool names, extend `READ_TOOLS` / `WRITE_TOOLS` in
`contact.py` and keep the approval gate untouched.

Never use this skill to exfiltrate private data: the payload scanner is a
backstop, not a policy. The policy is that the user explicitly approves
exactly what leaves their machine, every time.
