"""Launch the AutomationBench matrix: 3 models x 2 arms, sales domain.

Clean arms hit the upstream directly; guard arms go through the local
ab-guard-proxy (six-protocol steering as request middleware). One proxy per
upstream serves both guard arms of that upstream concurrently (conversations
are keyed per task).
"""

from __future__ import annotations

import os
import subprocess
import sys

BENCH = r"D:\AgenticSyS\bench"
REPO = r"D:\AgenticSyS\deepseek-harness"
RUNNER = os.path.join(BENCH, "automationbench")

MODELS = [
    ("qwen3.7-max", "https://dashscope.aliyuncs.com/compatible-mode/v1", "REDACTED-DASHSCOPE-KEY"),
    ("qwen3.6-flash", "https://dashscope.aliyuncs.com/compatible-mode/v1", "REDACTED-DASHSCOPE-KEY"),
    ("deepseek-v4-flash", "https://api.deepseek.com/v1", "REDACTED-DEEPSEEK-KEY"),
]

DOMAIN = os.environ.get("AB_DOMAIN", "sales")
NUM = os.environ.get("AB_NUM", "100")
PROXY_PORT = int(os.environ.get("AB_PROXY_PORT", "8787"))


def proxy_port(base: str) -> int:
    # One proxy per distinct upstream: dashscope on 8787, deepseek on 8788.
    return 8788 if "deepseek" in base else PROXY_PORT


def launch(model: str, arm: str, base: str, key: str) -> subprocess.Popen:
    out_dir = os.path.join(BENCH, "ab-runs", f"{model}-{arm}")
    os.makedirs(out_dir, exist_ok=True)
    export = os.path.join(out_dir, f"results-{DOMAIN}.json")
    url = f"http://127.0.0.1:{proxy_port(base)}/v1" if arm == "guard" else base
    log = open(os.path.join(BENCH, "logs", f"ab-{model}-{arm}.log"), "w", encoding="utf-8")
    env = os.environ.copy()
    env["OPENAI_API_KEY"] = key
    env["UV_CACHE_DIR"] = r"D:\uv-cache"
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.Popen(
        [
            "uv", "run", "auto-bench",
            "--model", model,
            "--base-url", url,
            "--domains", DOMAIN,
            "--num-examples", NUM,
            "--max-concurrent", "8",
            "--export-json", export,
        ],
        cwd=RUNNER,
        stdout=log,
        stderr=subprocess.STDOUT,
        env=env,
    )


def main() -> None:
    os.makedirs(os.path.join(BENCH, "logs"), exist_ok=True)

    proxies = []
    # One proxy per distinct upstream family: dashscope on 8787, deepseek on 8788.
    dash = next(((base, key) for _, base, key in MODELS if "dashscope" in base), None)
    deep = next(((base, key) for _, base, key in MODELS if "deepseek" in base), None)
    for port, entry in zip((8787, 8788), (dash, deep)):
        if entry is None:
            continue
        base, key = entry
        upstream = base.removesuffix("/v1")
        log = open(os.path.join(BENCH, "logs", f"ab-guard-proxy-{port}.log"), "w", encoding="utf-8")
        proxies.append(subprocess.Popen(
            ["node", "--import", "tsx/esm", os.path.join(REPO, "examples", "blockade-bench", "ab-guard-proxy.ts")],
            cwd=REPO,
            stdout=log,
            stderr=subprocess.STDOUT,
            env={**os.environ, "GUARD_UPSTREAM": upstream, "GUARD_API_KEY": key, "GUARD_PORT": str(port)},
        ))
    import time

    time.sleep(6)

    procs = []
    for model, base, key in MODELS:
        procs.append((f"{model}-clean", launch(model, "clean", base, key)))
    # One proxy per distinct upstream.
    for model, base, key in MODELS:
        procs.append((f"{model}-guard", launch(model, "guard", base, key)))
    print("launched:", ", ".join(name for name, _ in procs), flush=True)
    failed = []
    for name, proc in procs:
        code = proc.wait()
        print(f"{name}: exit {code}", flush=True)
        if code != 0:
            failed.append(name)
    for proxy in proxies:
        proxy.terminate()
    print("FAILED:" if failed else "ALL AB RUNS COMPLETE", failed if failed else "", flush=True)


if __name__ == "__main__":
    main()
