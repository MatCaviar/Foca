# Agent Note: Progress-aware Focas recovery episodes

Status: implemented

English | [中文](2026-08-17-progress-aware-focas-recovery.zh.md)

## Problem

The first Focas guard correctly detected denials, fake successes, and repeated family failures, but its runtime unit was too coarse for long-horizon coding and terminal tasks. A broad tool such as `run_command` formed one lifetime family. Three failures anywhere in that family triggered a reframe even when a successful edit had changed the program between test runs. Conversely, every mapped successful command with no configured probe became `unverified`, so full-profile terminal runs could receive verification instructions after ordinary successful inspection and build commands. These false positives consume model instruction capacity and explain why stronger profiles can regress on flash models.

The same implementation had three correctness gaps: deployment-specific `carrier_search` overrides were bypassed by direct calls to `directiveMessage`; missing targets emitted the generic reframe directive instead of `target_missing`; and wildcard patterns matched substrings rather than complete tool names.

## Decision

**Recovery is an episode delimited by progress, not a lifetime counter.** Each family keeps total failures for diagnostics and a separate consecutive failure streak. A successful call in that family resets its streak. A success marked as task progress resets all family streaks and clears exhaustion, allowing a normal edit–test cycle to continue. Lesson extraction reads only the current episode after the previous progress-producing success.

**Broad tools can be partitioned from arguments.** `command_kind` divides terminal calls into inspection, edit, test, build, install, version-control change, service, and general execution families. `path_root` divides file writes by the first meaningful path component. This keeps unrelated failures from voting in the same reframe decision.

**Verification is explicit policy.** `mapped` verifies only when probes exist and otherwise records a transparent `declared_success`; `required` keeps an unprobed success `unverified`; `none` disables truth-source verification. Only independently verified success can produce a transferable lesson, while a declared success may still reset progress when the deployment marks it as state-changing.

**Identical failures cut off earlier.** A normalized failure fingerprint removes volatile paths, hexadecimal identifiers, and numbers. Two identical outcomes trigger an early reframe by default, while heterogeneous failures still use the three-consecutive-failure limit.

## Consequences

The Harbor bridge now partitions `run_command` by command kind, partitions `write_file` by path root, treats those generic tools as unprobed, and marks successful file writes as progress. Terminal directives are shorter and concrete. Empty provider base URLs fall back safely, and context/output limits are environment-configurable with larger defaults for long-horizon tasks. Verification probes are tagged as internal calls so they cannot recursively enter the guard ledger; exceptions become non-confirming evidence and a configurable timeout bounds latency.

The ALE proxy now isolates state by model, system prompt, and first task message instead of sharing one model-level ledger across tasks. It processes each tool result once, expires inactive conversations through a bounded LRU store, selects lite guidance automatically for flash-class models, and uses a threaded HTTP server for concurrent benchmark workers.

Evaluation launchers no longer hard-code a 20-task subset. `FOCAS_N_TASKS` selects an explicit smoke subset; leaving it unset runs the complete local dataset. `bench-ops/paired_eval.py` provides matched clean/guard effect size, discordant outcomes, an exact sign test, and a paired bootstrap interval.

## Alternatives considered

- **Lower the global failure threshold.** This reacts faster but increases false positives because unrelated terminal failures remain mixed.
- **Treat every successful command as progress.** Inspection commands would erase genuine stagnation.
- **Require probes for every write.** Terminal and desktop benchmarks do not expose a universal effect probe, so this would turn the guard into constant prompt noise.
- **Model-based failure clustering.** It adds cost and variance inside the mechanism intended to stabilize the model. Deterministic coarse partitions and normalized fingerprints are the initial policy; measured gaps can extend them later.
