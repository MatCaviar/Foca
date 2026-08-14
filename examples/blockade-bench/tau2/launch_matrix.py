"""Launch the 2x2 benchmark matrix in parallel: {qwen3.7-max, qwen3.6-flash} x {clean, guard}.

Each run is one tau2-bench process over the retail `test` split (40 tasks)
with the DshAgent backend. Output dirs: runs/<model>-<arm>; logs: logs/.
"""

from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = r"D:\AgenticSyS\bench"
RUNNER = os.path.join(HERE, "run_arm.py")

MODELS = ["qwen3.7-max", "qwen3.6-flash"]
ARMS = ["clean", "guard"]


def main() -> None:
    procs = []
    for model in MODELS:
        for arm in ARMS:
            out = os.path.join(BENCH, "runs", f"{model}-{arm}")
            log = open(os.path.join(BENCH, "logs", f"{model}-{arm}.log"), "w", encoding="utf-8")
            env = os.environ.copy()
            env["DASHSCOPE_API_KEY"] = "REDACTED-DASHSCOPE-KEY"
            env["PYTHONUNBUFFERED"] = "1"
            procs.append(
                (
                    f"{model}-{arm}",
                    subprocess.Popen(
                        [sys.executable, RUNNER, "--model", model, "--arm", arm, "--out", out],
                        cwd=os.path.join(BENCH, "tau2-bench"),
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        env=env,
                    ),
                    log,
                )
            )
    print("launched:", ", ".join(name for name, _, _ in procs), flush=True)
    failed = []
    for name, proc, log in procs:
        code = proc.wait()
        log.close()
        print(f"{name}: exit {code}", flush=True)
        if code != 0:
            failed.append(name)
    print("FAILED:" if failed else "ALL RUNS COMPLETE", failed if failed else "", flush=True)


if __name__ == "__main__":
    main()
