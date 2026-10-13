#!/usr/bin/env python3
"""Smoke test for friday-front-desk: raw JSON-RPC over Streamable HTTP.

Exercises: initialize, tools/list, get_profile, list_repos, ask_repo
(queued path — no OWNER_AGENT_CALLBACK_URL configured), contact_owner
queued path, GET / and /.well-known/agent-mcp, GET/DELETE /mcp 405s,
and the contact_owner rate limit (3/hr).
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:8787")
passed = []
failed = []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" — {extra}" if extra else ""))


def post_mcp(payload, headers=None):
    req = urllib.request.Request(
        BASE + "/mcp",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream",
                 **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def parse_sse(text):
    """Stateless transport returns SSE (event:/data: lines) or plain JSON. Extract JSON payload."""
    text = text.strip()
    data_lines = [l[5:].strip() for l in text.splitlines() if l.startswith("data:")]
    if data_lines:
        return json.loads("\n".join(data_lines))
    return json.loads(text)



# 1. initialize
status, body = post_mcp({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2024-11-05",
               "capabilities": {},
               "clientInfo": {"name": "smoke", "version": "0.1"}},
})
check("initialize 200", status == 200, f"status={status}")
init = parse_sse(body)
check("initialize result has serverInfo", "result" in init and "serverInfo" in init.get("result", {}),
      str(init.get("result", {}).get("serverInfo", {}))[:80])

# 2. notifications/initialized (no id)
status, _ = post_mcp({"jsonrpc": "2.0", "method": "notifications/initialized"})
check("notifications/initialized accepted", status in (200, 202), f"status={status}")

# 3. tools/list
status, body = post_mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
tl = parse_sse(body)
tools = [t["name"] for t in tl.get("result", {}).get("tools", [])]
check("tools/list 200", status == 200)
check("5 tools registered",
      tools == ["get_profile", "list_repos", "ask_repo", "contact_owner", "propose_meeting"],
      str(tools))


def call_tool(name, args, req_id):
    status, body = post_mcp({
        "jsonrpc": "2.0", "id": req_id, "method": "tools/call",
        "params": {"name": name, "arguments": args}})
    return status, parse_sse(body)


# 4. get_profile
status, res = call_tool("get_profile", {}, 10)
text = res["result"]["content"][0]["text"]
check("get_profile 200", status == 200)
check("profile mentions 14QBD273", "14QBD273" in text)
check("profile mentions GRID", "GRID" in text)
check("profile has contact line", "charles@gridataset.com" in text)
check("profile has no DOB/address leak", "May 10" not in text and "Southwell" not in text)

# 5. list_repos
status, res = call_tool("list_repos", {}, 11)
text = res["result"]["content"][0]["text"]
check("list_repos has friday", "github.com/Fibinachi/friday" in text)
check("list_repos has linearb-ledger", "linearb-ledger" in text)

# 6. ask_repo with bad repo -> -32602 input validation error
status, res = call_tool("ask_repo", {"question": "hi", "repo": "nope"}, 12)
check("ask_repo rejects unknown repo", "-32602" in str(res), str(res)[:120])

# 7. ask_repo path traversal rejected
status, res = call_tool("ask_repo", {"question": "hi", "repo": "friday", "path": "../secret"}, 13)
check("ask_repo rejects '..' path", "-32602" in str(res), str(res)[:120])

# 8. ask_repo live fetch (queued path — callback unset) on the real friday repo
status, res = call_tool(
    "ask_repo",
    {"question": "What is the Friday augmentation stack?", "repo": "friday"},
    14)
text = res["result"]["content"][0]["text"]
check("ask_repo 200", status == 200)
check("ask_repo returns queued static reply",
      "I can't answer that from the public material" in text, text[:80])

# 9. ask_repo on missing repo (linearb-ledger 404s on GitHub today)
status, res = call_tool("ask_repo", {"question": "hi", "repo": "linearb-ledger"}, 15)
text = res["result"]["content"][0]["text"]
check("ask_repo handles missing repo gracefully", "404" in text, text[:100])

# 10. contact_owner validation: bad email -> -32602 (still consumes a rate token)
status, res = call_tool(
    "contact_owner",
    {"name": "X", "email": "not-an-email", "message": "hi"}, 16)
check("contact_owner rejects bad email", "-32602" in str(res), str(res)[:120])

# 11. contact_owner happy path (notify unset -> QUEUED, static thank-you)
status, res = call_tool(
    "contact_owner",
    {"name": "Test Agent", "email": "agent@example.com", "message": "Hello from smoke test."}, 17)
text = res["result"]["content"][0]["text"]
check("contact_owner 200 + thank-you", status == 200 and "Thank you, Test Agent" in text, text[:80])
check("contact_owner privacy note", "verified against public business data sources" in text)

# 12. contact_owner rate limit: 3/hr per IP, counted per request (the
# failed-validation call above consumed token #1). One more allowed, then 429.
s2, _ = call_tool("contact_owner",
                 {"name": "A", "email": "a@example.com", "message": "m"}, 18)
check("contact_owner #3 allowed", s2 == 200, f"status={s2}")
s3, err3 = call_tool("contact_owner",
                    {"name": "B", "email": "b@example.com", "message": "m"}, 19)
check("contact_owner #4 -> 429 JSON-RPC error", s3 == 429, f"status={s3}")
check("429 body code -32000 + rate-limit message",
      err3.get("error", {}).get("code") == -32000
      and "Rate limit exceeded" in err3.get("error", {}).get("message", ""),
      str(err3.get("error"))[:120])

# 13. GET / landing page
with urllib.request.urlopen(BASE + "/", timeout=10) as r:
    landing = r.read().decode()
check("GET / 200 + title", r.status == 200 and "agent front desk for Charles Prescott" in landing)
check("landing has privacy note", "verified against public business data sources" in landing)
check("landing has house contact line", "charles@gridataset.com" in landing)
check("landing has MCP endpoint link", "/mcp" in landing)

# 14. well-known
with urllib.request.urlopen(BASE + "/.well-known/agent-mcp", timeout=10) as r:
    wk = json.loads(r.read().decode())
check("well-known shape", wk.get("owner") == "Charles Prescott"
      and wk.get("agent") == "Friday" and wk.get("mcp_endpoint", "").endswith("/mcp"),
      str(wk))

# 15. GET/DELETE /mcp -> 405
for method in ("GET", "DELETE"):
    req = urllib.request.Request(BASE + "/mcp", method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            st = r.status
    except urllib.error.HTTPError as e:
        st = e.code
    check(f"{method} /mcp -> 405", st == 405, f"status={st}")

print(f"\n{len(passed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
