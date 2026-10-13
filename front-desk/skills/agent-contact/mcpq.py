#!/usr/bin/env python3
# Vendored from ~/workspace/skills/mcp-client/mcpq.py, verified 2026-10-13.
# This copy makes the agent-contact skill self-contained for other Muse
# users: the skill needs only this file (stdlib only, no installs).
# Upstream changes to ~/workspace/skills/mcp-client/mcpq.py are NOT
# automatically reflected here; re-vendor deliberately if the upstream
# transport behavior changes.
"""Minimal MCP client over Streamable HTTP (JSON-RPC by hand).

Lets Friday talk to other people's personal MCP servers (e.g. me-mcp
instances) even though this runtime has no MCP-client install path.

Usage:
    mcpq.py <url> tools                       # list tools
    mcpq.py <url> call <tool> '{"arg":"val"}' # call a tool
    mcpq.py <url> resources                   # list resources
    mcpq.py <url> read <uri>                  # read a resource

Security notes:
- Only connects to URLs Charles or his contacts explicitly name.
- Never sends Charles's private data to a third-party server.
- 'call' on contact-style tools (anything that sends a message on his
  behalf) requires his explicit per-message yes. Reading is fine.
"""
import json, sys, time, urllib.request

def rpc(url, method, params=None, req_id=1, session=None, retries=3):
    body = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method,
                       "params": params or {}}).encode()
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream",
               "User-Agent": "Friday/1.0 (agent-to-agent)"}
    if session:
        headers["mcp-session-id"] = session
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as r:
                session = r.headers.get("mcp-session-id", session)
                try:
                    raw = r.read().decode()
                except Exception as e:  # SSE streams often close abruptly; take what arrived
                    raw = getattr(e, "partial", b"").decode(errors="replace")
            break
        except Exception as e:
            last = e
            time.sleep(2 ** attempt)
    else:
        raise last
    # SSE or plain JSON?
    payload = None
    for line in raw.splitlines():
        if line.startswith("data:"):
            try:
                payload = json.loads(line[5:].strip()); break
            except json.JSONDecodeError:
                continue
    if payload is None:
        payload = json.loads(raw)
    return payload, session

def notify(url, method, session):
    body = json.dumps({"jsonrpc": "2.0", "method": method}).encode()
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    if session:
        headers["mcp-session-id"] = session
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass  # notifications get no meaningful response

def connect(url):
    res, session = rpc(url, "initialize", {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "friday", "version": "1.0"}})
    if "error" in res:
        sys.exit(f"initialize failed: {res['error']}")
    notify(url, "notifications/initialized", session)
    return session

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    url, cmd = sys.argv[1], sys.argv[2]
    session = connect(url)
    if cmd == "tools":
        res, _ = rpc(url, "tools/list", session=session)
        for t in res["result"]["tools"]:
            print(f"- {t['name']}: {t.get('description','')[:100]}")
    elif cmd == "call":
        name, args = sys.argv[3], json.loads(sys.argv[4] if len(sys.argv) > 4 else "{}")
        res, _ = rpc(url, "tools/call",
                     {"name": name, "arguments": args}, session=session)
        out = res["result"]["content"]
        print(json.dumps(out, indent=1)[:4000])
    elif cmd == "resources":
        res, _ = rpc(url, "resources/list", session=session)
        for r in res["result"].get("resources", []):
            print(f"- {r['uri']}: {r.get('name','')}")
    elif cmd == "read":
        res, _ = rpc(url, "resources/read",
                     {"uri": sys.argv[3]}, session=session)
        print(json.dumps(res["result"]["contents"], indent=1)[:4000])
    else:
        sys.exit(f"unknown command: {cmd}")

if __name__ == "__main__":
    main()
