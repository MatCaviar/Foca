"""Progress and token-usage report across the running benchmark matrix.

Reads each run's checkpointed results (tau2 writes results.json on completion
and checkpoint files during) plus the per-arm usage JSONL, and prints one
compact table: tasks done, average reward so far, harness-side and
user-simulator token totals.
"""

from __future__ import annotations

import glob
import json
import os

BENCH = r"D:\AgenticSyS\bench"


def harness_usage(model: str, arm: str) -> tuple[int, int, int]:
    path = os.path.join(BENCH, "runs", "usage", f"{model}-{arm}.jsonl")
    if not os.path.exists(path):
        return 0, 0, 0
    tasks: dict[str, tuple[int, int]] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            tasks[str(rec.get("task_id"))] = (rec.get("input", 0), rec.get("output", 0))
    inp = sum(v[0] for v in tasks.values())
    out = sum(v[1] for v in tasks.values())
    return len(tasks), inp, out


def run_state(model: str, arm: str) -> tuple[int, float, int, int]:
    """(sims recorded, mean reward, user-sim in, user-sim out)."""
    out_dir = os.path.join(BENCH, "runs", f"{model}-{arm}")
    best: tuple[int, float] = (0, 0.0)
    user_in = user_out = 0
    for path in glob.glob(os.path.join(out_dir, "**", "*.json"), recursive=True) + [
        os.path.join(out_dir, "results.json")
    ]:
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            continue
        try:
            data = json.load(open(path, encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        sims = data.get("simulations") if isinstance(data, dict) else None
        if not isinstance(sims, list):
            continue
        rewards = [
            (s.get("reward_info") or {}).get("reward", 0.0)
            for s in sims
            if isinstance(s, dict)
        ]
        if len(rewards) > best[0]:
            best = (len(rewards), sum(rewards) / len(rewards))
        for s in sims:
            usage = (s or {}).get("user_usage") or {}
            user_in += usage.get("prompt_tokens", 0) or 0
            user_out += usage.get("completion_tokens", 0) or 0
    return best[0], best[1], user_in, user_out


def main() -> None:
    print(f"{'run':<28}{'sims':>5}{'avgR':>7}{'agent-in':>12}{'agent-out':>11}{'user-in':>12}{'user-out':>11}")
    totals: dict[str, int] = {}
    for model in ["qwen3.7-max", "qwen3.6-flash", "deepseek-v4-flash"]:
        for arm in ["clean", "guard"]:
            n_tasks, a_in, a_out = harness_usage(model, arm)
            sims, avg, u_in, u_out = run_state(model, arm)
            print(
                f"{model + '-' + arm:<28}{sims:>5}{avg:>7.3f}{a_in:>12}{a_out:>11}{u_in:>12}{u_out:>11}"
            )
            for key, value in (("agent_in", a_in), ("agent_out", a_out), ("user_in", u_in), ("user_out", u_out)):
                totals[key] = totals.get(key, 0) + value
    print(
        "TOTAL tokens: agent-in {agent_in}, agent-out {agent_out}, user-in {user_in}, user-out {user_out}".format(**totals)
    )


if __name__ == "__main__":
    main()
