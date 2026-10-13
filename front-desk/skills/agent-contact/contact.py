#!/usr/bin/env python3
"""agent-contact: the outbound ("visitor") half of the front-desk
agent-to-agent contact system.

Commands:
  contact.py discover <url-or-domain>
      Resolve the agent's MCP endpoint (explicit URL, or
      https://<domain>/.well-known/agent-mcp fallback), run initialize +
      tools/list, and print the endpoint's tools with their descriptions
      verbatim.

  contact.py ask <url> <tool> '<json-args>'
      Call a READ tool only: get_profile, list_repos, ask_repo, tools/list.
      Anything else is refused; use `send` for write tools.

  contact.py send <url> <contact-owner|propose_meeting> '<json-args>' [flags]
      Approval-gated write path. Prints the EXACT payload, scans it for
      private data, and transmits only after explicit confirmation:
        * interactive: prompts "Type SEND to transmit this exact payload"
        * non-interactive: --confirm <sha256-of-canonical-payload>
          (get the hash first with --print-hash, then re-run with it)
        * private-data scan can be overridden only with --i-take-responsibility

Stdlib only. Only network calls are to the user-supplied endpoint URL and
the well-known fallback on the user-supplied domain.

Exit codes: 0 success; 1 network/RPC/unexpected failure;
2 usage error or gate refusal (wrong tool, no confirmation, private data).
"""
import hashlib
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcpq  # vendored, same directory

READ_TOOLS = {"get_profile", "list_repos", "ask_repo", "tools/list"}
WRITE_TOOLS = {"contact_owner": "contact_owner", "contact-owner": "contact_owner",
               "propose_meeting": "propose_meeting"}

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def err(msg, code=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)

def canonical_payload(tool, args):
    """Canonical JSON used for hashing and for the --confirm check."""
    return json.dumps({"tool": tool, "arguments": args},
                      sort_keys=True, separators=(",", ":")).encode("utf-8")

# Private-data scan: secret-looking key/value pairs, and long hex/base64
# blobs (likely pasted credentials). Scans the whole JSON text so no field
# slips through by name.
_SECRET_KV = re.compile(
    r"""["']?(api[_-]?key|token|secret|password|passwd|bearer|credential)["']?"""
    r"""\s*[:=]\s*["']?\S{8,}""", re.IGNORECASE)
_BLOB = re.compile(r"\b(?:[0-9a-fA-F]{33,}|[A-Za-z0-9+/]{33,}={0,2})\b")

def scan_private_data(payload_text):
    hits = []
    for m in _SECRET_KV.finditer(payload_text):
        hits.append(f"secret-looking assignment: '{m.group(0)[:40]}...'")
    for m in _BLOB.finditer(payload_text):
        s = m.group(0)
        # Skip long runs that are clearly prose or URLs, not credentials.
        if "://" in s or s.startswith(("http", "www.")):
            continue
        hits.append(f"long hex/base64 blob (len {len(s)}): '{s[:24]}...'")
    return hits

def call_tool(url, tool, args):
    """Connect and call a tool; return the tool-call result payload."""
    try:
        session = mcpq.connect(url)
    except SystemExit as e:  # mcpq.connect exits on initialize failure
        err(str(e), code=1)
    try:
        res, _ = mcpq.rpc(url, "tools/call",
                           {"name": tool, "arguments": args}, session=session)
    except Exception as e:
        err(f"tools/call failed: {e}", code=1)
    if isinstance(res, dict) and "error" in res:
        err(f"endpoint returned error: {res['error']}", code=1)
    try:
        content = res["result"]["content"]
    except (KeyError, TypeError):
        err(f"unexpected tools/call response: {res!r}", code=1)
    return content

# --------------------------------------------------------------------------
# discover
# --------------------------------------------------------------------------

def fetch_well_known(domain):
    url = f"https://{domain}/.well-known/agent-mcp"
    req = urllib.request.Request(url, headers={"Accept": "application/json",
                                               "User-Agent": "Friday/1.0 (agent-to-agent)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode()), url
    except Exception as e:
        err(f"well-known lookup failed for {domain}: {e}", code=1)

def cmd_discover(target):
    owner = agent = None
    if target.startswith(("http://", "https://")):
        endpoint = target
    else:
        domain = target.strip().rstrip("/")
        doc, wk_url = fetch_well_known(domain)
        if not isinstance(doc, dict) or "mcp_endpoint" not in doc:
            err(f"{wk_url} did not return {{\"mcp_endpoint\": ...}}; "
                f"pass the endpoint URL explicitly", code=1)
        endpoint = doc["mcp_endpoint"]
        owner, agent = doc.get("owner"), doc.get("agent")

    try:
        session = mcpq.connect(endpoint)
    except SystemExit as e:
        err(str(e), code=1)
    try:
        res, _ = mcpq.rpc(endpoint, "tools/list", session=session)
    except Exception as e:
        err(f"tools/list failed: {e}", code=1)
    if isinstance(res, dict) and "error" in res:
        err(f"endpoint returned error: {res['error']}", code=1)
    tools = res.get("result", {}).get("tools", []) if isinstance(res, dict) else []

    if owner or agent:
        print(f"owner: {owner or '(unknown)'}")
        print(f"agent: {agent or '(unknown)'}")
    print(f"endpoint: {endpoint}")
    print()
    if not tools:
        print("(endpoint exposed no tools)")
        return
    for t in tools:
        name = t.get("name", "(unnamed)")
        print(f"== {name} ==")
        print(t.get("description") or "(no description)")
        print()

# --------------------------------------------------------------------------
# ask (read tools only)
# --------------------------------------------------------------------------

def cmd_ask(url, tool, args_json):
    if tool not in READ_TOOLS:
        err(f"'{tool}' is not a read tool. Refusing. "
            f"Read tools: {sorted(READ_TOOLS)}. "
            f"For contact/message tools use the `send` flow, which requires "
            f"explicit approval.", code=2)
    try:
        args = json.loads(args_json)
    except json.JSONDecodeError as e:
        err(f"invalid JSON arguments: {e}", code=2)
    if tool == "tools/list":
        # tools/list takes no arguments; answer locally without a call.
        cmd_discover(url)
        return
    content = call_tool(url, tool, args)
    print(json.dumps(content, indent=2)[:8000])

# --------------------------------------------------------------------------
# send (approval-gated write path)
# --------------------------------------------------------------------------

def cmd_send(argv):
    # argv after "send": <url> <tool> <json-args> [--confirm HASH]
    #                     [--print-hash] [--i-take-responsibility]
    positional, flags = [], {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--confirm":
            i += 1
            if i >= len(argv):
                err("usage: --confirm <sha256-of-canonical-payload>", code=2)
            flags["confirm"] = argv[i]
        elif a in ("--print-hash", "--i-take-responsibility"):
            flags[a[2:].replace("-", "_")] = True
        elif a.startswith("--"):
            err(f"unknown flag: {a}", code=2)
        else:
            positional.append(a)
        i += 1
    if len(positional) != 3:
        err("usage: contact.py send <url> <contact-owner|propose_meeting> "
            "'<json-args>' [--confirm HASH] [--print-hash] "
            "[--i-take-responsibility]", code=2)
    url, tool_in, args_json = positional
    if tool_in not in WRITE_TOOLS:
        err(f"'{tool_in}' is not a sendable tool. send supports only: "
            f"contact-owner, propose_meeting.", code=2)
    tool = WRITE_TOOLS[tool_in]
    try:
        args = json.loads(args_json)
    except json.JSONDecodeError as e:
        err(f"invalid JSON arguments: {e}", code=2)
    if not isinstance(args, dict):
        err("arguments must be a JSON object", code=2)

    canon = canonical_payload(tool, args)
    digest = hashlib.sha256(canon).hexdigest()

    # 1) Private-data scan — runs BEFORE anything is printed or sent.
    hits = scan_private_data(canon.decode("utf-8", "replace"))
    if hits and not flags.get("i_take_responsibility"):
        print("REFUSED: payload looks like it contains private data:", file=sys.stderr)
        for h in hits[:10]:
            print(f"  - {h}", file=sys.stderr)
        print("\nNever send credentials, tokens, or other private data to a",
              file=sys.stderr)
        print("third-party endpoint. Re-run with --i-take-responsibility (and",
              file=sys.stderr)
        print("the correct --confirm hash) ONLY if you explicitly intend this.",
              file=sys.stderr)
        sys.exit(2)

    # 2) Surface the exact payload. This is the only approval basis.
    print("Exact payload to be sent (canonical hash below is the approval handle):")
    print(json.dumps({"tool": tool, "arguments": args}, indent=2, sort_keys=True))
    print(f"\nsha256(canonical payload): {digest}")
    print(f"canonical JSON: {canon.decode('utf-8')}")

    if flags.get("print_hash"):
        print("\n--print-hash: nothing sent. Re-run with --confirm " + digest)
        return

    # 3) Confirmation. Never pre-filled: one of these two, or nothing happens.
    if flags.get("confirm"):
        if flags["confirm"].lower() != digest:
            err("confirmation hash does not match the payload. Nothing sent. "
                "The payload may have changed; re-run --print-hash and "
                "approve the exact payload again.", code=2)
        print("confirmation hash matches. Transmitting.")
    elif sys.stdin.isatty():
        try:
            answer = input("\nType SEND to transmit this exact payload: ").strip()
        except EOFError:
            err("no confirmation. Nothing sent.", code=2)
        if answer != "SEND":
            err("no confirmation. Nothing sent.", code=2)
    else:
        err("non-interactive session: nothing sent. Re-run with "
            f"--confirm {digest} (after --print-hash review) to approve "
            "this exact payload.", code=2)

    content = call_tool(url, tool, args)
    print("sent. endpoint response:")
    print(json.dumps(content, indent=2)[:8000])

# --------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "discover":
        if len(sys.argv) != 3:
            err("usage: contact.py discover <url-or-domain>", code=2)
        cmd_discover(sys.argv[2])
    elif cmd == "ask":
        if len(sys.argv) != 5:
            err("usage: contact.py ask <url> <tool> '<json-args>'", code=2)
        cmd_ask(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "send":
        cmd_send(sys.argv[2:])
    else:
        err(f"unknown command: {cmd} (discover|ask|send)", code=2)

if __name__ == "__main__":
    main()
