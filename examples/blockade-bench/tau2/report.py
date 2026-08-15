"""Final scoring and comparison report for the benchmark matrix.

Reads each completed run's results.json (official tau2 evaluator already
scored every simulation), aggregates rewards by arm, and writes a markdown
report with the 2x2 comparison, token accounting, and significance notes.
"""

from __future__ import annotations

import json
import os
from datetime import datetime

BENCH = r"D:\AgenticSyS\bench"
MODELS = ["qwen3.7-max", "qwen3.6-flash", "deepseek-v4-flash"]
ARMS = ["clean", "guard"]


def load_run(model: str, arm: str) -> list[dict]:
    # Prefer the merged final results (rescored + patched infra tasks).
    for name in ("results-final.json", "updated_results.json", "results.json"):
        path = os.path.join(BENCH, "runs", f"{model}-{arm}", name)
        if os.path.exists(path):
            data = json.load(open(path, encoding="utf-8"))
            return [s for s in data.get("simulations", []) if isinstance(s, dict)]
    return []


def reward_of(sim: dict) -> float:
    return float((sim.get("reward_info") or {}).get("reward", 0.0) or 0.0)


def stats(sims: list[dict]) -> dict:
    rewards = [reward_of(s) for s in sims]
    full = sum(1 for r in rewards if r >= 1.0)
    zero = sum(1 for r in rewards if r <= 0.0)
    partial = len(rewards) - full - zero
    term: dict[str, int] = {}
    for s in sims:
        term[s.get("termination_reason", "?")] = term.get(s.get("termination_reason", "?"), 0) + 1
    return {
        "n": len(rewards),
        "avg": sum(rewards) / len(rewards) if rewards else 0.0,
        "full": full,
        "partial": partial,
        "zero": zero,
        "termination": term,
    }


def harness_usage(model: str, arm: str) -> tuple[int, int]:
    path = os.path.join(BENCH, "runs", "usage", f"{model}-{arm}.jsonl")
    tasks: dict[str, tuple[int, int]] = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                tasks[str(rec.get("task_id"))] = (rec.get("input", 0), rec.get("output", 0))
    return sum(v[0] for v in tasks.values()), sum(v[1] for v in tasks.values())


def per_task_rewards(sims: list[dict]) -> dict[str, float]:
    out: dict[str, float] = {}
    for s in sims:
        out[str(s.get("task_id"))] = reward_of(s)
    return out


def mcnemar_paired(a: dict[str, float], b: dict[str, float]) -> tuple[int, int]:
    """Paired discordant counts (a win, b win) over shared task ids."""
    a_win = b_win = 0
    for task_id in set(a) & set(b):
        if a[task_id] > b[task_id]:
            a_win += 1
        elif b[task_id] > a[task_id]:
            b_win += 1
    return a_win, b_win


def main() -> None:
    lines: list[str] = []
    lines.append("# tau2-bench retail (test split) — clean dsh vs blockade-guard dsh")
    lines.append("")
    lines.append(f"Generated {datetime.now().isoformat(timespec='seconds')} · official tau2-bench evaluator · "
                 "agent = DeepSeek Harness loop via the tau2 bridge · user simulator = same model via litellm")
    lines.append("")
    for model in MODELS:
        lines.append(f"## {model}")
        lines.append("")
        lines.append("| arm | tasks | avg reward | full | partial | zero | agent-in | agent-out |")
        lines.append("|---|---|---|---|---|---|---|---|")
        per_task: dict[str, dict[str, float]] = {}
        for arm in ARMS:
            sims = load_run(model, arm)
            st = stats(sims)
            a_in, a_out = harness_usage(model, arm)
            per_task[arm] = per_task_rewards(sims)
            lines.append(
                f"| {arm} | {st['n']} | {st['avg']:.3f} | {st['full']} | {st['partial']} | {st['zero']} | {a_in:,} | {a_out:,} |"
            )
        clean_win, guard_win = mcnemar_paired(per_task["clean"], per_task["guard"])
        lines.append("")
        lines.append(f"Paired discordant tasks: guard wins **{guard_win}**, clean wins **{clean_win}**.")
        lines.append("")
        lines.append(f"Termination (clean): `{json.dumps(stats(load_run(model, 'clean'))['termination'])}`")
        lines.append(f"Termination (guard): `{json.dumps(stats(load_run(model, 'guard'))['termination'])}`")
        lines.append("")
    total_in = total_out = 0
    for model in MODELS:
        for arm in ARMS:
            a_in, a_out = harness_usage(model, arm)
            total_in += a_in
            total_out += a_out
    lines.append("## Token accounting (harness-side, all runs)")
    lines.append("")
    lines.append(f"Total agent input tokens: **{total_in:,}** · output: **{total_out:,}**")
    lines.append("")
    report = "\n".join(lines)
    out_path = os.path.join(BENCH, "report-tau2.md")
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(report)
    print(report)
    print(f"\nwritten: {out_path}")


if __name__ == "__main__":
    main()
