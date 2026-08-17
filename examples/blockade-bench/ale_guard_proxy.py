"""Focas OpenAI-compatible guard proxy for Agents' Last Exam.

The proxy keeps benchmark-owned agent loops unchanged and injects a compact
recovery instruction only after a denied, missing, or repeatedly failing tool
family. State is isolated per conversation; no task can inherit another task's
failure counters or fired directives.

Configuration (environment variables take precedence over positional args):
  FOCAS_PORT          listening port, default 8787
  FOCAS_UPSTREAM      upstream OpenAI-compatible base URL
  FOCAS_API_KEY       upstream key
  FOCAS_PROFILE       auto | full | lite | off, default auto
  FOCAS_DEBUG         1 to print steering decisions
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PORT = int(os.getenv("FOCAS_PORT", sys.argv[1] if len(sys.argv) > 1 else "8787"))
UPSTREAM = os.getenv(
    "FOCAS_UPSTREAM",
    sys.argv[2] if len(sys.argv) > 2 else "https://dashscope.aliyuncs.com/compatible-mode/v1",
).rstrip("/")
API_KEY = os.getenv("FOCAS_API_KEY", sys.argv[3] if len(sys.argv) > 3 else "")
REQUESTED_PROFILE = os.getenv("FOCAS_PROFILE", sys.argv[4] if len(sys.argv) > 4 else "auto").lower()
DEBUG = os.getenv("FOCAS_DEBUG", "0") == "1"

FAMILY_FAILURE_LIMIT = int(os.getenv("FOCAS_FAMILY_FAILURE_LIMIT", "3"))
REPEATED_FAILURE_LIMIT = int(os.getenv("FOCAS_REPEATED_FAILURE_LIMIT", "2"))
MAX_CONVERSATIONS = int(os.getenv("FOCAS_MAX_CONVERSATIONS", "2048"))
CONVERSATION_TTL_SECONDS = int(os.getenv("FOCAS_CONVERSATION_TTL", "21600"))

DENIAL = re.compile(
    r"permission denied|operation not permitted|forbidden|unauthori[sz]ed|securityexception|"
    r"\b(?:401|403)\b|not granted|requires? (?:admin|root|signature|permission)",
    re.I,
)
MISSING = re.compile(
    r"no such file|not found|does not exist|unknown (?:tool|command|route)|no route|not exported|"
    r"\b(?:404|enoent|command not found)\b",
    re.I,
)
ERROR = re.compile(r"\berror\b|\bfailed\b|exception|traceback|exit (?:code )?[1-9]", re.I)
READ_VERB = re.compile(r"^(?:api_)?(?:search|get|list|read|query|find|lookup|describe|show|check|inspect)", re.I)
WRITE_VERB = re.compile(
    r"^(?:fetch|call|send|create|update|patch|delete|remove|add|set|post|put|mutate|write|"
    r"execute|submit|run|book|cancel|modify|transfer|issue|apply|install|start|stop|restart)",
    re.I,
)
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PATHISH = re.compile(r"(?:[A-Za-z]:)?[/\\](?:[^\s:/\\]+[/\\])+[^\s:/\\]*")
HEXISH = re.compile(r"\b(?:0x)?[0-9a-f]{8,}\b", re.I)
NUMBER = re.compile(r"\b\d+\b")
BLOCKADE_MARKER = "[blockade:"

FULL_DIRECTIVES = {
    "carrier": (
        "[blockade:carrier_search] That route cannot perform the action. Do not retry it unchanged. "
        "Find the capability carrier that already can: another available tool, application, service, "
        "UI entrypoint, browser workflow, CLI, or authorized account. Trigger the cheapest carrier and verify once."
    ),
    "missing": (
        "[blockade:target_missing] The target or route is absent. Discover the declared tool, endpoint, "
        "entrypoint, or owning application from the available tool surface; do not guess another spelling."
    ),
    "reframe": (
        "[blockade:p5_reframe] This action family is repeating the same failure without progress. Stop this "
        "family, inspect the actual state and first unresolved error, then take one structurally different, "
        "verifiable route."
    ),
}
LITE_DIRECTIVES = {
    "carrier": (
        "[blockade:carrier_search] Stop retrying that route. Use another available tool, app, service, "
        "entrypoint, or account that already carries the capability, then verify once."
    ),
    "missing": (
        "[blockade:target_missing] That target is absent. Discover the real tool or entrypoint from the "
        "available surface instead of guessing."
    ),
    "reframe": (
        "[blockade:p5_reframe] The same approach is failing again. Stop it, inspect the real state/error, "
        "and take one structurally different route."
    ),
}


@dataclass
class FamilyState:
    failure_streak: int = 0
    repeated_streak: int = 0
    last_fingerprint: str | None = None


@dataclass
class ConversationState:
    families: dict[str, FamilyState] = field(default_factory=dict)
    fired: set[str] = field(default_factory=set)
    processed_call_ids: set[str] = field(default_factory=set)
    updated_at: float = field(default_factory=time.monotonic)

    def record_success(self, family: str, progress: bool) -> None:
        self.updated_at = time.monotonic()
        if progress:
            for state in self.families.values():
                state.failure_streak = 0
                state.repeated_streak = 0
                state.last_fingerprint = None
            self.fired = {key for key in self.fired if key.startswith("carrier:") or key.startswith("missing:")}
            return
        state = self.families.setdefault(family, FamilyState())
        state.failure_streak = 0
        state.repeated_streak = 0
        state.last_fingerprint = None

    def record_failure(self, family: str, fingerprint: str) -> FamilyState:
        self.updated_at = time.monotonic()
        state = self.families.setdefault(family, FamilyState())
        state.failure_streak += 1
        state.repeated_streak = state.repeated_streak + 1 if fingerprint == state.last_fingerprint else 1
        state.last_fingerprint = fingerprint
        return state


CONVERSATIONS: "OrderedDict[str, ConversationState]" = OrderedDict()


def profile_for(model: str) -> str:
    if REQUESTED_PROFILE in {"off", "full", "lite"}:
        return REQUESTED_PROFILE
    lowered = model.lower()
    if any(marker in lowered for marker in ("flash", "mini", "small", "air", "turbo")):
        return "lite"
    return "full"


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return json.dumps(content, ensure_ascii=False, sort_keys=True)


def conversation_key(data: dict[str, Any]) -> str:
    messages = data.get("messages") or []
    system = ""
    first_user = ""
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "system" and not system:
            system = message_text(message.get("content", ""))
        elif role == "user" and not first_user and BLOCKADE_MARKER not in message_text(message.get("content", "")):
            first_user = message_text(message.get("content", ""))
    seed = f"{data.get('model', '')}\0{system}\0{first_user}"
    return hashlib.sha256(seed.encode("utf-8", errors="replace")).hexdigest()


def state_for(key: str) -> ConversationState:
    now = time.monotonic()
    expired = [name for name, state in CONVERSATIONS.items() if now - state.updated_at > CONVERSATION_TTL_SECONDS]
    for name in expired:
        CONVERSATIONS.pop(name, None)
    state = CONVERSATIONS.pop(key, None) or ConversationState()
    CONVERSATIONS[key] = state
    while len(CONVERSATIONS) > MAX_CONVERSATIONS:
        CONVERSATIONS.popitem(last=False)
    return state


def tool_names(messages: list[dict[str, Any]]) -> dict[str, str]:
    names: dict[str, str] = {}
    for message in messages:
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict) or not call.get("id"):
                continue
            function = call.get("function") or {}
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                names[str(call["id"])] = function["name"]
    return names


def classify_family(tool: str) -> tuple[str, bool, bool]:
    lowered = tool.lower()
    if READ_VERB.match(lowered):
        return (f"read:{lowered.split('_', 1)[0]}", False, False)
    if any(token in lowered for token in ("write", "create", "update", "patch", "delete", "remove", "set", "apply", "send", "submit", "book", "cancel", "transfer")):
        return (f"write:{re.split(r'[_./:-]', lowered)[0]}", True, True)
    if WRITE_VERB.match(lowered):
        return (f"action:{re.split(r'[_./:-]', lowered)[0]}", True, True)
    return (f"tool:{re.split(r'[_./:-]', lowered)[0] or 'unknown'}", False, False)


def classify_result(content: str) -> str:
    parsed: Any = None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        pass
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if error:
            rendered = message_text(error)
            if DENIAL.search(rendered):
                return "denial"
            if MISSING.search(rendered):
                return "missing"
            return "error"
        if parsed.get("isError") is True or parsed.get("success") is False or parsed.get("ok") is False:
            rendered = message_text(parsed)
            if DENIAL.search(rendered):
                return "denial"
            if MISSING.search(rendered):
                return "missing"
            return "error"
    if DENIAL.search(content):
        return "denial"
    if MISSING.search(content):
        return "missing"
    if ERROR.search(content[:2000]):
        return "error"
    return "success"


def fingerprint(content: str) -> str:
    normalized = ANSI.sub("", content.lower())
    normalized = PATHISH.sub("<path>", normalized)
    normalized = HEXISH.sub("<id>", normalized)
    normalized = NUMBER.sub("<n>", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return hashlib.sha1(normalized[:4000].encode("utf-8", errors="replace")).hexdigest()


def already_injected(messages: list[dict[str, Any]], marker: str) -> bool:
    return any(marker in message_text(message.get("content", "")) for message in messages if isinstance(message, dict))


def steer(data: dict[str, Any]) -> str | None:
    messages = data.get("messages") or []
    if not isinstance(messages, list) or not messages:
        return None
    profile = profile_for(str(data.get("model", "")))
    if profile == "off":
        return None
    directives = LITE_DIRECTIVES if profile == "lite" else FULL_DIRECTIVES
    names = tool_names(messages)
    state = state_for(conversation_key(data))

    last_assistant = -1
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, dict) and message.get("role") == "assistant":
            last_assistant = index
            break

    for message in messages[last_assistant + 1 :]:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        call_id = str(message.get("tool_call_id", ""))
        if not call_id or call_id in state.processed_call_ids:
            continue
        state.processed_call_ids.add(call_id)
        if len(state.processed_call_ids) > 512:
            state.processed_call_ids.pop()
        tool = names.get(call_id, "")
        if not tool:
            continue
        family, actionable, progress_on_success = classify_family(tool)
        if not actionable:
            continue
        content = message_text(message.get("content", ""))
        form = classify_result(content)

        if form == "success":
            state.record_success(family, progress_on_success)
            continue

        outcome = state.record_failure(family, fingerprint(content))
        if form == "denial":
            key = f"carrier:{family}"
            if key not in state.fired and not already_injected(messages, "[blockade:carrier_search]"):
                state.fired.add(key)
                return directives["carrier"]
        if form == "missing":
            key = f"missing:{family}"
            if key not in state.fired and not already_injected(messages, "[blockade:target_missing]"):
                state.fired.add(key)
                return directives["missing"]
        if (outcome.repeated_streak >= REPEATED_FAILURE_LIMIT or outcome.failure_streak >= FAMILY_FAILURE_LIMIT):
            key = f"reframe:{family}"
            if key not in state.fired and not already_injected(messages, "[blockade:p5_reframe]"):
                state.fired.add(key)
                return directives["reframe"]
    return None


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        try:
            data = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            data = None

        if isinstance(data, dict):
            directive = steer(data)
            if directive:
                messages = list(data.get("messages") or [])
                messages.append({"role": "user", "content": directive})
                data["messages"] = messages
                body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                if DEBUG:
                    print(f"[focas] {data.get('model', '')}: {directive}", file=sys.stderr)

        self._forward(body)

    def do_GET(self) -> None:
        self._forward(None)

    def _forward(self, body: bytes | None) -> None:
        url = UPSTREAM + self.path
        request = urllib.request.Request(url, data=body, method=self.command)
        for key, value in self.headers.items():
            if key.lower() not in {"host", "content-length", "connection", "transfer-encoding", "authorization"}:
                request.add_header(key, value)
        if API_KEY:
            request.add_header("Authorization", f"Bearer {API_KEY}")
        if body is not None:
            request.add_header("Content-Length", str(len(body)))

        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                payload = response.read()
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as error:
            payload = error.read()
            self.send_response(error.code)
            for key, value in error.headers.items():
                if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:  # network boundary: return a complete OpenAI-style error
            payload = json.dumps({"error": {"message": str(error), "type": "focas_proxy_error"}}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        if DEBUG:
            super().log_message(format, *args)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), ProxyHandler)
    print(f"Focas ALE proxy on 0.0.0.0:{PORT} -> {UPSTREAM} profile={REQUESTED_PROFILE}")
    server.serve_forever()
