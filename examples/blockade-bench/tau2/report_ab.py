"""AutomationBench matrix report: aggregate the per-arm result exports.

Reads D:/AgenticSyS/bench/ab-runs/<model>-<arm>/results-<domain>.json
(official exporter output with per-task pass rates and token usage) and writes
the comparison table with token accounting.
"""

from __future__ import annotations

import glob
import json
import os
from datetime import datetime

BENCH = r"D:\AgenticSyS\bench"
MODELS = ["qwen3.7-max", "qwen3.6-flash", "deepseek-v4-flash"]
ARMS = ["clean", "guard"]


def load(model: str, arm: str) -> dict | None:
    for path in glob.glob(os.path.join(BENCH, "ab-runs", f"{model}-{arm}", "results-*.json")):
        try:
            return json.load(open(path, encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
    return None


def stats(data: dict) -> dict:
    tasks = data.get("tasks", [])
    if not tasks:
        return {"n": 0}
    passed = sum(1 for t in tasks if t.get("passed"))
    return {
        "n": len(tasks),
        "pass_rate": passed / len(tasks),
        "passed": passed,
        "avg_score": sum(t.get("score") or 0.0 for t in tasks) / len(tasks),
        "in": sum(t.get("input_tokens") or 0 for t in tasks),
        "out": sum(t.get("output_tokens") or 0 for t in tasks),
    }


def main() -> None:
    lines = []
    lines.append("# AutomationBench (public) — clean dsh-proxy vs guard-proxy")
    lines.append("")
    lines.append(f"Generated {datetime.now().isoformat(timespec='seconds')} · sales domain, 100 tasks/arm · "
                 "guard = six-protocol request middleware (same rules as the harness plugin)")
    lines.append("")
    lines.append("| model | arm | tasks | pass rate | avg score | agent-in | agent-out |")
    lines.append("|---|---|---|---|---|---|---|")
    totals = {"in": 0, "out": 0}
    for model in MODELS:
        for arm in ARMS:
            data = load(model, arm)
            if data is None:
                lines.append(f"| {model} | {arm} | - | - | - | - | - |")
                continue
            st = stats(data)
            totals["in"] += st.get("in", 0)
            totals["out"] += st.get("out", 0)
            lines.append(
                f"| {model} | {arm} | {st['n']} | {st['pass_rate']:.3f} | {st['avg_score']:.3f} | {st['in']:,} | {st['out']:,} |"
            )
    lines.append("")
    lines.append(f"Total agent tokens: input **{totals['in']:,}** · output **{totals['out']:,}**")
    report = "\n".join(lines)
    out = os.path.join(BENCH, "report-automationbench.md")
    with open(out, "w", encoding="utf-8") as handle:
        handle.write(report)
    print(report)
    print(f"\nwritten: {out}")


if __name__ == "__main__":
    main()
