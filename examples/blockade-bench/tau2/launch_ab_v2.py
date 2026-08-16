"""AutomationBench v2 runs: re-run with carrier_search proxy (full + lite).

qwen3.7-max: clean vs full (strong model, full profile)
qwen3.6-flash: clean vs lite (weak model, lite profile)
deepseek-v4-flash: clean vs lite (medium model, lite profile)

Uses the v2 ab-guard-proxy with carrier_search, O2/O3/O6 optimizations.
50 tasks per arm to bound token spend (matching the first round's subset size
for max/deepseek where possible).
"""

from __future__ import annotations

import os
import subprocess

BENCH = r"D:\AgenticSyS\bench"
RUNNER = os.path.join(BENCH, "automationbench")
NUM = os.environ.get("AB_NUM", "50")

RUNS = [
    # (model, arm, upstream_key, profile, port)
    ("qwen3.7-max", "clean", "${DASHSCOPE_API_KEY:?}", None, None),
    ("qwen3.7-max", "guard", "${DASHSCOPE_API_KEY:?}", "full", 8787),
    ("qwen3.6-flash", "clean", "${DASHSCOPE_API_KEY:?}", None, None),
    ("qwen3.6-flash", "guard", "${DASHSCOPE_API_KEY:?}", "lite", 8789),
    ("deepseek-v4-flash", "clean", "${DEEPSEEK_API_KEY:?}", None, None),
    ("deepseek-v4-flash", "guard", "${DEEPSEEK_API_KEY:?}", "lite", 8788),
]

DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEEPSEEK_BASE = "https://api.deepseek.com/v1"


def main() -> None:
    for model, arm, key, profile, port in RUNS:
        out_dir = os.path.join(BENCH, "ab-v2", f"{model}-{arm}")
        export = os.path.join(out_dir, "results-sales.json")
        if os.path.exists(export):
            print(f"{model}-{arm}: exists, skip", flush=True)
            continue
        os.makedirs(out_dir, exist_ok=True)

        if port is not None:
            base_url = f"http://127.0.0.1:{port}/v1"
        elif "deepseek" in model:
            base_url = DEEPSEEK_BASE
        else:
            base_url = DASHSCOPE_BASE

        log = open(os.path.join(BENCH, "logs", f"ab-v2-{model}-{arm}.log"), "w", encoding="utf-8")
        env = os.environ.copy()
        env["OPENAI_API_KEY"] = key
        env["UV_CACHE_DIR"] = r"D:\uv-cache"
        env["PYTHONUNBUFFERED"] = "1"
        code = subprocess.call(
            [
                "uv", "run", "auto-bench",
                "--model", model,
                "--base-url", base_url,
                "--domains", "sales",
                "--num-examples", NUM,
                "--max-concurrent", "6",
                "--export-json", export,
            ],
            cwd=RUNNER,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )
        print(f"{model}-{arm} ({profile}): exit {code}", flush=True)
    print("AB v2 COMPLETE", flush=True)


if __name__ == "__main__":
    main()
