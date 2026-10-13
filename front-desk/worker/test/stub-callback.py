#!/usr/bin/env python3
"""Stub owner-agent callback: records the payload, returns a canned answer."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

LAST = {}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        LAST["payload"] = json.loads(body)
        resp = json.dumps({"answer": "STUB ANSWER: Friday is the assistant augmentation portfolio."}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8790), H).serve_forever()
