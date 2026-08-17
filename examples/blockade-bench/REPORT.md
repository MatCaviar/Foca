# Focas evaluation record

This file records completed experiments. It is not a leaderboard claim. Every number below must be interpreted with the exact model endpoint, task subset, harness revision, and guard profile used in that run.

## Summary

| Benchmark | Model | Clean | Focas | Profile | Scope |
|---|---:|---:|---:|---|---|
| τ²-bench retail | qwen3.7-max | 0.775 | 0.850 | full | 40 paired tasks per arm |
| τ²-bench retail | qwen3.6-flash | 0.825 | 0.850 | lite | 40 paired tasks per arm |
| τ²-bench retail | qwen3.6-flash | 0.825 | 0.650 | full | 40 paired tasks per arm |
| τ²-bench retail | deepseek-v4-flash | 0.900 | 0.800 | full | 40 paired tasks per arm |
| AutomationBench v1 sales | qwen3.7-max | 0.452 partial | 0.530 partial | v1 full | 50 paired tasks |
| Terminal-Bench 2.1 | qwen3.7-max | pilot | +9.2 pp | full | 20-task paired subset |
| Terminal-Bench 2.1 | deepseek-v4-flash | pilot | +5.0 pp | lite | 20-task paired subset |
| Terminal-Bench 2.1 | qwen3.6-flash | pilot | -5.0 pp | lite | 20-task paired subset |

The Terminal-Bench rows are subset deltas retained for regression tracking. They are not comparable with official full-benchmark scores.

## Main finding

Focas is not a uniformly beneficial prompt prefix. The full protocol helps a stronger model on the tested tool-loop tasks, but can crowd out flash models. The lite profile recovers most of the useful behavior by retaining carrier search and no-progress reframing while removing broad verification and identity instructions. Profile choice is therefore part of the system configuration and must be selected by paired pilot runs.

## What v3 changes

The earlier terminal bridge treated all `run_command` calls as one lifetime family and treated every mapped success without a probe as unverified. Focas v3 changes the runtime unit:

- commands are partitioned into inspect, edit, test, build, install, service, VCS-change, and execute families;
- repeated identical outcomes can trigger an early cutoff;
- successful state-changing actions reset stale blockade streaks;
- no-probe successes remain transparent unless verification is explicitly required;
- directive wording is shorter for terminal workloads.

These changes target the failure mode observed in flash models: useful recovery guidance was mixed with unnecessary instructions during ordinary edit-test iteration.

## Required next experiments

1. Re-run the same paired pilot tasks with v3 and all three profiles (`off`, `lite`, `full`).
2. Freeze the best profile per model using paired outcomes, not aggregate mean alone.
3. Run all 89 Terminal-Bench 2.1 tasks and all 113 DeepSWE tasks.
4. Run Agents' Last Exam with the exact committed public task manifest and tier selection.
5. Report matched-task delta, wins/losses, exact sign test, paired bootstrap interval, infrastructure errors, tokens, and wall time.

Use [`BENCHMARK.md`](../../BENCHMARK.md) for the protocol and `bench-ops/paired_eval.py` for paired statistics.
