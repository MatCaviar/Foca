"""Resume the three lost AutomationBench arms at 50 tasks each.

The 10:56 python kill took down qwen3.7-max (both arms) and
deepseek-v4-flash-guard before their exports were written. This reruns them at
N=50 to bound token spend; the report pairs deepseek's guard-50 against the
first 50 tasks of its completed clean-100 run.
"""

from __future__ import annotations

import os
import subprocess
import sys

BENCH = r"D:\AgenticSyS\bench"
RUNNER = os.path.join(BENCH, "automationbench")

RUNS = [
    ("qwen3.7-max", "clean", "https://dashscope.aliyuncs.com/compatible-mode/v1", "REDACTED-DASHSCOPE-KEY"),
    ("qwen3.7-max", "guard", "http://127.0.0.1:8787/v1", "REDACTED-DASHSCOPE-KEY"),
    ("deepseek-v4-flash", "guard", "http://127.0.0.1:8788/v1", "REDACTED-DEEPSEEK-KEY"),
]


def main() -> None:
    for model, arm, url, key in RUNS:
        out_dir = os.path.join(BENCH, "ab-runs", f"{model}-{arm}")
        os.makedirs(out_dir, exist_ok=True)
        export = os.path.join(out_dir, "results-sales.json")
        if os.path.exists(export):
            print(f"{model}-{arm}: exists, skipping", flush=True)
            continue
        log = open(os.path.join(BENCH, "logs", f"ab-{model}-{arm}.log"), "a", encoding="utf-8")
        env = os.environ.copy()
        env["OPENAI_API_KEY"] = key
        env["UV_CACHE_DIR"] = r"D:\uv-cache"
        env["PYTHONUNBUFFERED"] = "1"
        code = subprocess.call(
            [
                "uv", "run", "auto-bench",
                "--model", model,
                "--base-url", url,
                "--domains", "sales",
                "--num-examples", "50",
                "--max-concurrent", "6",
                "--export-json", export,
            ],
            cwd=RUNNER,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )
        print(f"{model}-{arm}: exit {code}", flush=True)
    print("RESUME COMPLETE", flush=True)


if __name__ == "__main__":
    main()
