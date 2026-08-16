"""Harbor custom agent: the DeepSeek Harness loop (with or without the
Reframe blockade guard) as a Terminal-Bench agent.

The agent brain runs on the Windows host (the full dsh agent loop with bash +
str_replace_editor over the container's filesystem through harbor's exec);
this class runs inside WSL where harbor drives it, and bridges to the host
bridge process via stdio JSON — the same parked-execution protocol as the
tau2 integration, extended with a filesystem/exec tool surface.

Tools exposed to the model (minimal-bench shape):
- run_command: execute a shell command in the task container (environment.exec)
- read_file / write_file / list_dir: container filesystem operations
The guard observes every tool result through the harness pipeline.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
try:
    from typing import override
except ImportError:

    def override(func):
        return func

from typing import Optional

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BRIDGE = r"D:\AgenticSyS\deepseek-harness\examples\blockade-bench\harbor-bridge.ts"
REPO = r"D:\AgenticSyS\deepseek-harness"

READ_TIMEOUT_S = 900
MAX_TURNS = 40

SYSTEM_PROMPT = """You are an autonomous software engineering agent working inside a container to complete a task.
You have these tools:
- run_command(command): run a shell command in the container (bash). Use it for everything executable: building, testing, editing via sed/patch, searching, git.
- read_file(path), write_file(path, content), list_dir(path): direct file operations.
Work iteratively: inspect, plan, act, verify. Prefer standard tools (compilers, test runners) to verify your work before finishing.
When you are done, say: TASK_COMPLETE. If truly impossible, say: TASK_IMPOSSIBLE and explain why."""


class DshHarborAgent(BaseAgent):
    SUPPORTS_WINDOWS: bool = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.proc: Optional[subprocess.Popen] = None
        self.events: queue.Queue = queue.Queue()
        self.environment: Optional[BaseEnvironment] = None
        self.pending: dict[str, dict] = {}
        self.usage = {"input": 0, "output": 0}

    @staticmethod
    def name() -> str:
        return "dsh-reframe"

    @override
    def version(self) -> str:
        return "1.0.0"

    # -- bridge plumbing (host process via WSL interop) -----------------------

    def _ensure_bridge(self, guard: object) -> None:
        if self.proc is not None:
            return
        stderr_path = os.path.join(str(self.logs_dir), "bridge.stderr.log")
        NODE = "/mnt/c/Program Files/nodejs/node.exe"
        self.proc = subprocess.Popen(
            [NODE, "--import", "tsx/esm", BRIDGE],
            cwd="/mnt/d/AgenticSyS/deepseek-harness",
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=open(stderr_path, "w", encoding="utf-8"),
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        threading.Thread(target=self._reader, daemon=True).start()
        # Send credentials first — env vars don't propagate WSL→Windows reliably
        self._send({
            "type": "credentials",
            "apiKey": os.environ.get("DASHSCOPE_API_KEY", ""),
            "apiBase": os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        })
        self._send(
            {
                "type": "start",
                "sessionId": str(self.context_id or self.session_id or "harbor"),
                "system": SYSTEM_PROMPT,
                "tools": [
                    {
                        "name": "run_command",
                        "description": "Run a shell command in the container.",
                        "parameters": {
                            "type": "object",
                            "properties": {"command": {"type": "string", "description": "The bash command to run."}},
                            "required": ["command"],
                        },
                    },
                    {
                        "name": "read_file",
                        "description": "Read a file from the container.",
                        "parameters": {
                            "type": "object",
                            "properties": {"path": {"type": "string", "description": "Absolute path."}},
                            "required": ["path"],
                        },
                    },
                    {
                        "name": "write_file",
                        "description": "Write a file in the container (full content).",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "Absolute path."},
                                "content": {"type": "string", "description": "Full file content."},
                            },
                            "required": ["path", "content"],
                        },
                    },
                    {
                        "name": "list_dir",
                        "description": "List a directory in the container.",
                        "parameters": {
                            "type": "object",
                            "properties": {"path": {"type": "string", "description": "Absolute path."}},
                            "required": ["path"],
                        },
                    },
                ],
                "guard": guard,
                "model": (self.model_name or "qwen3.7-max").replace("openai/", "").replace("anthropic/", ""),
            }
        )
        # Wait for credentials_ack, then send start and wait for ready
        ack = self._next()
        if ack.get("type") != "credentials_ack":
            raise RuntimeError(f"bridge credentials failed: {ack}")
        ready = self._next()
        if ready.get("type") != "ready":
            raise RuntimeError(f"bridge failed: {ready}")

    def _reader(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                self.events.put({"type": "error", "message": f"bad line: {line[:200]}"})
        self.events.put({"type": "error", "message": "bridge exited"})

    def _send(self, payload: dict) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError("bridge not running")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def _next(self) -> dict:
        return self.events.get(timeout=READ_TIMEOUT_S)

    # -- tool execution against the harbor environment ------------------------

    async def _execute_tool(self, name: str, args: dict) -> tuple[str, bool]:
        self.logger.info(f"tool_call: {name} args={str(args)[:100]}")
        assert self.environment is not None
        if name == "run_command":
            result = await self.environment.exec(args["command"], timeout_sec=600)
            output = (result.stdout or "") + (("\n[stderr]\n" + result.stderr) if result.stderr else "")
            output = output.strip() or "(no output)"
            return output[:60000], result.return_code != 0
        if name == "read_file":
            result = await self.environment.exec(f"cat {args['path']}")
            return (result.stdout or "(empty)")[:60000], result.return_code != 0
        if name == "write_file":
            import base64

            encoded = base64.b64encode(args["content"].encode("utf-8")).decode("ascii")
            result = await self.environment.exec(
                f"echo {encoded} | base64 -d > {args['path']}"
            )
            return ("wrote " + args["path"]) if result.return_code == 0 else (result.stderr or "write failed"), result.return_code != 0
        if name == "list_dir":
            result = await self.environment.exec(f"ls -la {args['path']}")
            return (result.stdout or "(empty)")[:30000], result.return_code != 0
        return f"unknown tool {name}", True

    # -- harbor interface -------------------------------------------------------

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        self.environment = environment

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        import traceback
        self.logger.info(f"DshAgent.run() called, instruction={instruction[:80]}...")
        self.environment = environment
        guard = os.environ.get("DSH_GUARD", "off")  # off | full | lite
        try:
            self._ensure_bridge(True if guard == "full" else ("lite" if guard == "lite" else False))
            self.logger.info(f"bridge started, guard={guard}")
        except Exception as e:
            tb = traceback.format_exc()
            self.logger.error("bridge start failed: " + str(e) + " | " + tb[-300:])
            context.metadata = {"error": "bridge_start: " + str(e)}
            return
        self._send({"type": "user", "text": instruction})
        turns = 0
        while turns < MAX_TURNS:
            turns += 1
            event = self._next()
            self.logger.info(f"bridge event: {event.get('type')} usage={event.get('usage', {})}")
            usage = event.get("usage") or {}
            self.usage["input"] = max(self.usage["input"], usage.get("input", 0))
            self.usage["output"] = max(self.usage["output"], usage.get("output", 0))
            if event["type"] == "toolCalls":
                for call in event["calls"]:
                    output, is_error = await self._execute_tool(call["name"], call["arguments"])
                    self._send({"type": "toolResult", "callId": call["callId"], "output": output, "isError": is_error})
                continue
            if event["type"] == "final":
                text = event.get("text", "")
                self.logger.info(f"final text ({len(text)} chars): {text[:200]}")
                context.n_input_tokens = self.usage["input"]
                context.n_output_tokens = self.usage["output"]
                context.metadata = {
                    "task_completed": "TASK_COMPLETE" in text,
                    "task_impossible": "TASK_IMPOSSIBLE" in text,
                    "final_message": text[:2000],
                    "guard": guard,
                }
                return
            raise RuntimeError(f"bridge error: {event.get('message', event)}")
        context.n_input_tokens = self.usage["input"]
        context.n_output_tokens = self.usage["output"]
        context.metadata = {"task_completed": False, "final_message": "step budget exhausted"}
