"""DeepSeek Harness agent backend for the official tau2-bench orchestrator.

One child Node process per simulation runs the harness agent loop
(`examples/blockade-bench/tau2-bridge.ts`); this agent translates the tau2
half-duplex protocol onto it. Tool calls are handed to the orchestrator for
execution (it stays the single writer of environment state), and the real
results are fed back into the harness tool pipeline, where the blockade guard
observes them.

Usage accounting: every bridge emission carries the cumulative harness-side
token count; the agent appends one JSONL record per simulation to the usage
file named by `usage_file` in llm_args.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import uuid
from typing import Optional

from tau2.agent.base_agent import AgentError, HalfDuplexAgent, ValidAgentInputMessage
from tau2.data_model.message import (
    AssistantMessage,
    MultiToolMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from tau2.data_model.tasks import Task

AGENT_INSTRUCTION = """
You are a customer service agent that helps the user according to the <policy> provided below.
In each turn you can either:
- Send a message to the user.
- Make a tool call.
You cannot do both at the same time.

Try to be helpful and always follow the policy. Always make sure you generate valid JSON only.
""".strip()

SYSTEM_PROMPT = """
<instructions>
{agent_instruction}
</instructions>
<policy>
{domain_policy}
</policy>
""".strip()

READ_TIMEOUT_S = 600


class DshAgent(HalfDuplexAgent[None]):
    """A tau2 agent whose brain is one DeepSeek Harness session."""

    def __init__(
        self,
        tools,
        domain_policy: str,
        llm: str,
        llm_args: Optional[dict] = None,
        task: Optional[Task] = None,
        **_,
    ):
        super().__init__(tools=tools, domain_policy=domain_policy)
        self.llm = llm
        self.llm_args = dict(llm_args or {})
        self.task_id = getattr(task, "id", None)
        self.proc: Optional[subprocess.Popen] = None
        self.events: queue.Queue = queue.Queue()
        self.usage = {"input": 0, "output": 0}
        self.flushed = False
        self.system_prompt = SYSTEM_PROMPT.format(
            agent_instruction=AGENT_INSTRUCTION, domain_policy=domain_policy
        )

    # -- child process plumbing -------------------------------------------------

    def _ensure_started(self) -> None:
        if self.proc is not None:
            return
        repo = self.llm_args["repo"]
        bridge = os.path.join(repo, "examples", "blockade-bench", "tau2-bridge.ts")
        env = os.environ.copy()
        env.setdefault("DASHSCOPE_API_KEY", self.llm_args.get("api_key", ""))
        env.setdefault(
            "DASHSCOPE_BASE_URL",
            self.llm_args.get(
                "api_base", "https://dashscope.aliyuncs.com/compatible-mode/v1"
            ),
        )
        stderr_path = self.llm_args.get("bridge_stderr")
        stderr = open(stderr_path, "w", encoding="utf-8") if stderr_path else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx/esm", bridge],
            cwd=repo,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        threading.Thread(target=self._reader, daemon=True).start()
        serialized = []
        for tool in self.tools:
            schema = tool.openai_schema["function"]
            serialized.append(
                {
                    "name": schema["name"],
                    "description": schema.get("description", schema["name"]),
                    "parameters": schema.get("parameters", {"type": "object", "properties": {}}),
                }
            )
        self._send(
            {
                "type": "start",
                "sessionId": f"tau2-{self.task_id}-{uuid.uuid4().hex[:8]}",
                "system": self.system_prompt,
                "tools": serialized,
                "guard": self.llm_args.get("guard", False),
                "model": self.llm,
            }
        )
        ready = self._next()
        if ready.get("type") != "ready":
            raise AgentError(f"bridge failed to start: {ready}")

    def _reader(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                self.events.put({"type": "error", "message": f"bad bridge line: {line[:200]}"})
        self.events.put({"type": "error", "message": "bridge exited"})

    def _send(self, payload: dict) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise AgentError("bridge not running")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def _next(self) -> dict:
        return self.events.get(timeout=READ_TIMEOUT_S)

    def _account(self, event: dict) -> None:
        usage = event.get("usage")
        if usage:
            self.usage["input"] = max(self.usage["input"], usage.get("input", 0))
            self.usage["output"] = max(self.usage["output"], usage.get("output", 0))

    # -- tau2 protocol ------------------------------------------------------------

    def get_init_state(self, message_history=None) -> None:
        return None

    def generate_next_message(self, message: ValidAgentInputMessage, state=None):
        self._ensure_started()
        if isinstance(message, UserMessage):
            self._send({"type": "user", "text": message.content or ""})
        elif isinstance(message, MultiToolMessage):
            for tool_message in message.tool_messages:
                self._send(
                    {
                        "type": "toolResult",
                        "callId": tool_message.id,
                        "output": tool_message.content or "",
                        "isError": bool(tool_message.error),
                    }
                )
        elif isinstance(message, ToolMessage):
            self._send(
                {
                    "type": "toolResult",
                    "callId": message.id,
                    "output": message.content or "",
                    "isError": bool(message.error),
                }
            )
        else:
            raise AgentError(f"unsupported input message type: {type(message)!r}")

        event = self._next()
        self._account(event)
        if event["type"] == "toolCalls":
            calls = [
                ToolCall(id=call["callId"], name=call["name"], arguments=call["arguments"])
                for call in event["calls"]
            ]
            return AssistantMessage.text("", tool_calls=calls), None
        if event["type"] == "final":
            return AssistantMessage.text(event.get("text", "")), None
        raise AgentError(f"bridge error: {event.get('message', event)}")

    def stop(self, message=None, state=None) -> None:
        self._flush_usage()
        if self.proc is not None:
            try:
                self._send({"type": "stop"})
                self.proc.wait(timeout=15)
            except Exception:
                self.proc.kill()
            self.proc = None

    def _flush_usage(self) -> None:
        usage_file = self.llm_args.get("usage_file")
        if not usage_file or self.flushed:
            return
        self.flushed = True
        record = {
            "task_id": self.task_id,
            "input": self.usage["input"],
            "output": self.usage["output"],
        }
        try:
            with open(usage_file, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
        except OSError:
            pass


def register(agent_name: str = "dsh_agent") -> None:
    """Register the DshAgent factory so the tau2 CLI can select it by name."""

    def factory(tools, domain_policy, llm, llm_args=None, task=None, **kwargs):
        return DshAgent(
            tools=tools,
            domain_policy=domain_policy,
            llm=llm,
            llm_args=llm_args,
            task=task,
            **kwargs,
        )

    from tau2.registry import registry as global_registry

    if agent_name not in global_registry.get_agents():
        global_registry.register_agent_factory(factory, agent_name)
