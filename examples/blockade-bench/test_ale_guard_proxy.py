"""Keyless behavior tests for the Focas ALE proxy."""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("ale_guard_proxy.py")
os.environ.setdefault("FOCAS_PROFILE", "lite")
SPEC = importlib.util.spec_from_file_location("focas_ale_guard_proxy", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PROXY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PROXY
SPEC.loader.exec_module(PROXY)


def request(task: str, call_id: str, tool: str, result: str, model: str = "deepseek-v4-flash") -> dict:
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": "agent"},
            {"role": "user", "content": task},
            {"role": "assistant", "tool_calls": [{"id": call_id, "function": {"name": tool}}]},
            {"role": "tool", "tool_call_id": call_id, "content": result},
        ],
    }


class ProxyStateTests(unittest.TestCase):
    def setUp(self) -> None:
        PROXY.CONVERSATIONS.clear()

    def test_denial_uses_carrier_search_and_is_idempotent(self) -> None:
        body = request("task-a", "c1", "update_record", "HTTP 403 permission denied")
        self.assertIn("carrier_search", PROXY.steer(body) or "")
        self.assertIsNone(PROXY.steer(body))

    def test_tasks_do_not_share_failure_or_directive_state(self) -> None:
        first = request("task-a", "c1", "update_record", "HTTP 403 permission denied")
        second = request("task-b", "c2", "update_record", "HTTP 403 permission denied")
        self.assertIn("carrier_search", PROXY.steer(first) or "")
        self.assertIn("carrier_search", PROXY.steer(second) or "")
        self.assertEqual(len(PROXY.CONVERSATIONS), 2)

    def test_successful_write_resets_prior_failure_episode(self) -> None:
        key_body = request("task-a", "c1", "update_record", "error: backend failed")
        self.assertIsNone(PROXY.steer(key_body))
        success = request("task-a", "c2", "write_file", '{"ok": true}')
        self.assertIsNone(PROXY.steer(success))
        after = request("task-a", "c3", "update_record", "error: backend failed")
        self.assertIsNone(PROXY.steer(after))

    def test_auto_profile_routes_flash_to_lite(self) -> None:
        original = PROXY.REQUESTED_PROFILE
        try:
            PROXY.REQUESTED_PROFILE = "auto"
            self.assertEqual(PROXY.profile_for("deepseek-v4-flash-0731"), "lite")
            self.assertEqual(PROXY.profile_for("deepseek-v4-pro"), "full")
        finally:
            PROXY.REQUESTED_PROFILE = original


if __name__ == "__main__":
    unittest.main()
