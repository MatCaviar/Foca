#!/usr/bin/env python3
"""Paired clean-vs-Focas analysis for Harbor result.json files.

The parser uses Harbor's reward_stats inventory, pairs identical trial ids,
and reports effect size, discordant outcomes, an exact two-sided sign test,
and a deterministic paired bootstrap interval.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path
from typing import Any


def _identifier(item: Any) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, (int, float)):
        return str(item)
    if isinstance(item, dict):
        for key in ("trial_id", "id", "name", "task_id", "task"):
            if key in item:
                return str(item[key])
    return json.dumps(item, sort_keys=True, ensure_ascii=False)


def load_rewards(path: Path) -> tuple[dict[str, float], dict[str, Any]]:
    data = json.loads(path.read_text())
    stats = data.get("stats", {})
    evals = stats.get("evals", {})
    if not evals:
        raise ValueError(f"{path}: stats.evals is empty")
    first_eval = next(iter(evals.values()))
    reward_stats = first_eval.get("reward_stats", {}).get("reward", {})
    if not reward_stats:
        raise ValueError(f"{path}: reward_stats.reward is empty")

    rewards: dict[str, float] = {}
    for raw_reward, items in reward_stats.items():
        try:
            reward = float(raw_reward)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{path}: non-numeric reward key {raw_reward!r}") from exc
        for item in items:
            identifier = _identifier(item)
            if identifier in rewards:
                raise ValueError(f"{path}: duplicate trial id {identifier}")
            rewards[identifier] = reward
    return rewards, stats


def exact_two_sided_sign_test(wins: int, losses: int) -> float:
    n = wins + losses
    if n == 0:
        return 1.0
    tail = min(wins, losses)
    probability = sum(math.comb(n, k) for k in range(tail + 1)) / (2**n)
    return min(1.0, 2 * probability)


def bootstrap_interval(deltas: list[float], samples: int, seed: int) -> tuple[float, float]:
    if not deltas:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(deltas)
    means = [sum(deltas[rng.randrange(n)] for _ in range(n)) / n for _ in range(samples)]
    means.sort()
    low_index = max(0, int(0.025 * samples) - 1)
    high_index = min(samples - 1, int(0.975 * samples))
    return means[low_index], means[high_index]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean", type=Path, required=True)
    parser.add_argument("--guard", type=Path, required=True)
    parser.add_argument("--bootstrap", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20260817)
    parser.add_argument("--show-discordant", action="store_true")
    args = parser.parse_args()

    clean, clean_stats = load_rewards(args.clean)
    guard, guard_stats = load_rewards(args.guard)
    matched = sorted(clean.keys() & guard.keys())
    clean_only = sorted(clean.keys() - guard.keys())
    guard_only = sorted(guard.keys() - clean.keys())
    if not matched:
        raise SystemExit("no matched trial ids; verify both arms used the same task list and ids")

    pairs = [(identifier, clean[identifier], guard[identifier]) for identifier in matched]
    deltas = [guard_reward - clean_reward for _, clean_reward, guard_reward in pairs]
    clean_mean = sum(clean_reward for _, clean_reward, _ in pairs) / len(pairs)
    guard_mean = sum(guard_reward for _, _, guard_reward in pairs) / len(pairs)
    wins = sum(guard_reward > clean_reward for _, clean_reward, guard_reward in pairs)
    losses = sum(guard_reward < clean_reward for _, clean_reward, guard_reward in pairs)
    ties = len(pairs) - wins - losses
    low, high = bootstrap_interval(deltas, args.bootstrap, args.seed)
    p_value = exact_two_sided_sign_test(wins, losses)

    print(f"matched={len(pairs)} clean_only={len(clean_only)} guard_only={len(guard_only)}")
    print(f"clean_mean={clean_mean:.4f} guard_mean={guard_mean:.4f} delta={guard_mean - clean_mean:+.4f}")
    print(f"paired_wins={wins} paired_losses={losses} ties={ties} exact_sign_p={p_value:.6f}")
    print(f"paired_bootstrap_95ci=[{low:+.4f}, {high:+.4f}] samples={args.bootstrap} seed={args.seed}")
    print(
        "infra: "
        f"clean_total={clean_stats.get('n_total_trials')} clean_errored={clean_stats.get('n_errored_trials')} "
        f"guard_total={guard_stats.get('n_total_trials')} guard_errored={guard_stats.get('n_errored_trials')}"
    )

    if clean_only:
        print("clean-only ids:", ", ".join(clean_only[:20]))
    if guard_only:
        print("guard-only ids:", ", ".join(guard_only[:20]))
    if args.show_discordant:
        for identifier, clean_reward, guard_reward in pairs:
            if clean_reward != guard_reward:
                direction = "guard-win" if guard_reward > clean_reward else "guard-loss"
                print(f"{direction}\t{identifier}\t{clean_reward:g}->{guard_reward:g}")


if __name__ == "__main__":
    main()
