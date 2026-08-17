# Focas benchmark protocol

Focas changes the agent harness, so evaluation must compare the **same model and task instances** under clean and guarded arms. Do not compare a Focas score with a separately published model score that used another harness, prompt, tool surface, timeout, or environment image.

## Required paired design

Keep these fixed across arms:

- model identifier, endpoint, decoding parameters, context window, and output limit;
- benchmark revision and exact task list;
- environment image, CPU/RAM limits, timeout, concurrency, and agent system prompt;
- task order and random seed;
- retries and infrastructure-error policy.

Change only `DSH_GUARD=off|lite|full`.

## Dataset sizes

- Terminal-Bench 2.1: **89 tasks**;
- DeepSWE: **113 tasks**;
- Agents' Last Exam public release: use the exact committed task list from the experiment YAML, because the public suite is organized into multiple tiers and subsets.

A smoke subset is useful for debugging but must be labelled as a subset. The launchers accept `FOCAS_N_TASKS`; leaving it unset runs the complete local dataset.

## Recommended sequence

1. Run 10–20 paired pilot tasks to detect integration errors.
2. Compare `off`, `lite`, and `full` on the same pilot tasks.
3. Select a profile using paired task outcomes, not aggregate means alone.
4. Freeze the code commit and configuration.
5. Run the full benchmark.
6. Report pass rate, paired wins/losses, infrastructure errors, token use, wall time, and bootstrap confidence interval.

## Terminal-Bench / DeepSWE

```bash
export DASHSCOPE_API_KEY=...
export DEEPSEEK_API_KEY=...

# Optional smoke run. Unset for the full local dataset.
export FOCAS_N_TASKS=20
export FOCAS_CONCURRENCY=1

bash examples/blockade-bench/launch_sequential3.sh
```

The Harbor bridge uses semantic command partitions and progress resets. A failing test followed by a successful edit does not accumulate toward the same blockade streak; two identical failures or three consecutive same-kind failures without progress trigger recovery.

## Paired analysis

```bash
python bench-ops/paired_eval.py \
  --clean /root/jobs/deepseek-v4-flash-clean/tb21/<run>/result.json \
  --guard /root/jobs/deepseek-v4-flash-guard/tb21/<run>/result.json
```

The script reports matched outcomes, clean/guard pass rates, absolute delta, paired wins and losses, an exact two-sided sign-test p-value, and a task-level bootstrap interval.

## Agents' Last Exam

Run the benchmark through `examples/blockade-bench/ale_guard_proxy.py` with a frozen public task manifest. Use `FOCAS_PROFILE=auto` unless the profile is part of an explicit ablation; `auto` selects lite for flash-class models and full otherwise. The proxy isolates recovery state per task conversation, deduplicates repeated transport delivery of the same tool result, and bounds inactive state, so parallel tasks cannot contaminate one another.

## Interpreting gains

A higher mean on one small subset is not sufficient. A credible improvement should satisfy all of the following:

- positive paired delta on the full task list;
- no material increase in infrastructure errors;
- gains distributed across more than one task family;
- stable or lower token and wall-time overhead;
- trajectory evidence that Focas changed a blocked strategy rather than accidentally altering benchmark plumbing.

Historical pilot results are in [examples/blockade-bench/REPORT.md](examples/blockade-bench/REPORT.md). They should remain labelled as pilots until reproduced under the full protocol above.
