"""Patch pass: re-run only the infrastructure-error tasks, then merge.

The stock evaluator's keyless LLM calls poisoned ~11 tasks per arm before the
routing fix; those simulations were recorded as empty error stubs. This pass
re-runs exactly those task ids with the patched evaluator routing and merges
the fresh simulations into the rescored results, producing results-final.json
per run.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = r"D:\AgenticSyS\bench"
MODELS = ["qwen3.7-max", "qwen3.6-flash", "deepseek-v4-flash"]
ARMS = ["clean", "guard"]


def infra_task_ids(run_dir: str) -> list[str]:
    data = json.load(open(os.path.join(run_dir, "updated_results.json"), encoding="utf-8"))
    return [
        str(s.get("task_id"))
        for s in data.get("simulations", [])
        if s.get("termination_reason") == "infrastructure_error"
    ]


API_ROUTES = {
    "deepseek-v4-flash": ("https://api.deepseek.com/v1", "${DEEPSEEK_API_KEY:?}"),
}


def run_patch(model: str, arm: str, ids: list[str]) -> None:
    out = os.path.join(BENCH, "runs", f"{model}-{arm}-patch")
    api_base, api_key = API_ROUTES.get(
        model, ("https://dashscope.aliyuncs.com/compatible-mode/v1", "${DASHSCOPE_API_KEY:?}")
    )
    env = os.environ.copy()
    env["DASHSCOPE_API_KEY"] = api_key
    env["DASHSCOPE_BASE_URL"] = api_base
    env["PYTHONUNBUFFERED"] = "1"
    log = open(os.path.join(BENCH, "logs", f"{model}-{arm}-patch.log"), "w", encoding="utf-8")
    code = subprocess.call(
        [
            sys.executable,
            os.path.join(HERE, "run_arm.py"),
            "--model",
            model,
            "--arm",
            arm,
            "--api-base",
            api_base,
            "--out",
            out,
            "--task-ids",
            *ids,
        ],
        cwd=os.path.join(BENCH, "tau2-bench"),
        stdout=log,
        stderr=subprocess.STDOUT,
        env=env,
    )
    log.close()
    print(f"patch {model}-{arm}: exit {code}", flush=True)


def merge(model: str, arm: str) -> dict:
    run_dir = os.path.join(BENCH, "runs", f"{model}-{arm}")
    base = json.load(open(os.path.join(run_dir, "updated_results.json"), encoding="utf-8"))
    patch_path = os.path.join(BENCH, "runs", f"{model}-{arm}-patch", "results.json")
    replacements: dict[str, dict] = {}
    if os.path.exists(patch_path):
        patch = json.load(open(patch_path, encoding="utf-8"))
        for s in patch.get("simulations", []):
            if s.get("termination_reason") != "infrastructure_error":
                replacements[str(s.get("task_id"))] = s
    sims = [replacements.get(str(s.get("task_id")), s) for s in base.get("simulations", [])]
    base["simulations"] = sims
    out_path = os.path.join(run_dir, "results-final.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(base, handle, ensure_ascii=False, indent=1)
    remaining = sum(1 for s in sims if s.get("termination_reason") == "infrastructure_error")
    print(f"merged {model}-{arm}: {len(sims)} sims, {len(replacements)} patched, {remaining} still infra", flush=True)
    return base


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-runs", action="store_true", help="only merge existing patch outputs")
    args = parser.parse_args()

    for model in MODELS:
        for arm in ARMS:
            run_dir = os.path.join(BENCH, "runs", f"{model}-{arm}")
            final_path = os.path.join(run_dir, "results-final.json")
            if os.path.exists(final_path):
                final = json.load(open(final_path, encoding="utf-8"))
                remaining = sum(
                    1
                    for s in final.get("simulations", [])
                    if s.get("termination_reason") == "infrastructure_error"
                )
                if remaining == 0:
                    print(f"{model}-{arm}: already final, skipping", flush=True)
                    continue
            ids = infra_task_ids(run_dir)
            print(f"{model}-{arm}: infra tasks {ids}", flush=True)
            if not args.skip_runs and ids:
                run_patch(model, arm, ids)
            merge(model, arm)


if __name__ == "__main__":
    main()
