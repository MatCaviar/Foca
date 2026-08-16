"""Reframe guard proxy (Python) for ALE — runs inside WSL, accessible from Docker.

Same logic as the TypeScript proxy: intercepts OpenAI chat/completions,
analyzes trailing tool results, injects carrier_search / circuit-breaker
directives. Pure stdlib (no external deps) so it runs anywhere.

Usage: python3 guard_proxy.py [port] [upstream_base] [api_key] [profile]
  profile: full | lite
"""

import json
import re
import sys
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from collections import defaultdict

# --- Config ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
UPSTREAM = sys.argv[2] if len(sys.argv) > 2 else "https://dashscope.aliyuncs.com/compatible-mode/v1"
API_KEY = sys.argv[3] if len(sys.argv) > 3 else ""
PROFILE = sys.argv[4] if len(sys.argv) > 4 else "full"

FAMILY = "api-write"
LIMIT = 3
LONG_CONV = 40
WRITE_STREAK_P3 = 2

DIRECTIVES = {
    "full": {
        "carrier_search": "The current executor cannot perform this action. Do not retry it unchanged. Search for a CAPABILITY CARRIER — who can already do this: an installed tool, an existing script, a system service, git, a different entrypoint? Find the cheapest trigger and go through it. Search for the causal path to the target state.",
        "p5_reframe": "Multiple attempts in one family have failed — semantic circuit breaker tripped. Stop. Re-derive the goal, inspect actual state, choose a structurally different approach.",
    },
    "lite": {
        "carrier_search": "That failed. Find what already works — another tool, script, or route — and go through it.",
        "p5_reframe": "Repeated failures. Stop; inspect state and try a different approach.",
    },
}

# --- State ---
ledgers = defaultdict(lambda: {"fails": 0, "streak": 0, "p3": False, "fired": set()})
WRITE_VERBS = re.compile(r"^(fetch|call|send|create|update|patch|delete|remove|add|set|post|put|mutate|write|execute|submit|run|cancel|modify|transfer|apply)", re.I)


def classify_tool_result(content: str) -> str:
    try:
        d = json.loads(content)
        if isinstance(d, dict) and "error" in d:
            code = d["error"].get("code", 0) if isinstance(d["error"], dict) else 0
            if code in (401, 403):
                return "denial"
            if code == 404:
                return "missing"
            return "error"
    except (json.JSONDecodeError, AttributeError):
        pass
    if re.match(r"^error|\"error\"", content[:40], re.I):
        return "error"
    return "success"


def steer(messages: list, model: str) -> str | None:
    """Analyze trailing tool results and return a directive to inject."""
    # Find trailing tool messages after last assistant
    last_asst = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            last_asst = i
            break

    # Build call-id → tool-name map
    name_map = {}
    for msg in messages:
        for tc in (msg.get("tool_calls") or []):
            if isinstance(tc, dict) and tc.get("id"):
                fn = tc.get("function", {})
                if isinstance(fn, dict):
                    name_map[tc["id"]] = fn.get("name", "")

    conv_key = model  # simplified: per-model ledger
    led = ledgers[conv_key]
    text_directives = DIRECTIVES.get(PROFILE, DIRECTIVES["full"])

    for msg in messages[last_asst + 1:]:
        if msg.get("role") != "tool":
            continue
        tool = name_map.get(msg.get("tool_call_id", ""), "")
        if not WRITE_VERBS.match(tool):
            continue

        content = msg.get("content", "")
        if not isinstance(content, str):
            content = json.dumps(content)

        form = classify_tool_result(content)

        if form == "success":
            led["streak"] += 1
            if (PROFILE == "full" and not led["p3"] and led["streak"] >= WRITE_STREAK_P3
                    and "p3" not in led["fired"]):
                led["p3"] = True
                led["fired"].add("p3")
                return "[blockade:p3_unverified] Changes made without verification. Read back the result before claiming completion."
            continue

        led["streak"] = 0
        led["fails"] += 1

        if form == "denial" and "carrier" not in led["fired"]:
            led["fired"].add("carrier")
            return f"[blockade:carrier_search] {text_directives['carrier_search']}"

        if form == "missing" and "missing" not in led["fired"]:
            led["fired"].add("missing")
            return "[blockade:target_missing] Route not found. Search for the correct endpoint."

        if led["fails"] >= LIMIT and "p5" not in led["fired"]:
            led["fired"].add("p5")
            return f"[blockade:p5_reframe] {text_directives['p5_reframe']}"

    return None


class ProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        body_str = body.decode("utf-8")

        try:
            data = json.loads(body_str)
        except json.JSONDecodeError:
            data = {}

        messages = data.get("messages", [])
        model = data.get("model", "")

        directive = None
        if messages and len(messages) < 200:
            directive = steer(messages, model)

        if directive:
            messages.append({"role": "user", "content": directive})
            data["messages"] = messages
            body_str = json.dumps(data)
            body = body_str.encode("utf-8")
            print(f"[steer] {model} {directive[:60]}...", file=sys.stderr)

        # Forward to upstream
        url = UPSTREAM.rstrip("/") + self.path
        req = urllib.request.Request(url, data=body, method="POST")
        for k, v in self.headers.items():
            if k.lower() not in ("host", "content-length", "connection", "transfer-encoding"):
                req.add_header(k, v)
        if API_KEY:
            req.add_header("Authorization", f"Bearer {API_KEY}")
        req.add_header("Content-Length", str(len(body)))

        try:
            resp = urllib.request.urlopen(req, timeout=300)
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k.lower() not in ("connection", "transfer-encoding"):
                    self.send_header(k, v)
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_GET(self):
        url = UPSTREAM.rstrip("/") + self.path
        req = urllib.request.Request(url)
        if API_KEY:
            req.add_header("Authorization", f"Bearer {API_KEY}")
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            self.send_response(resp.status)
            self.end_headers()
            self.wfile.write(resp.read())
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(str(e).encode())

    def log_message(self, format, *args):
        pass  # suppress default logging


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Reframe guard proxy (py) on 0.0.0.0:{PORT} -> {UPSTREAM} profile={PROFILE}")
    server.serve_forever()
