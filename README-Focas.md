# Focas — Frame on Carriers! Metacognitive Recovery from Agentic Blockade

> **Who already carries the capability?** Focas recovers agents from frame lock by switching the search target from another variant of the same action to the system actor, entrypoint, service, tool, or workflow that already produces the required state change.

Focas is implemented as a DeepSeek Harness plugin (`packages/metacog/blockade`) plus benchmark bridges for tool-loop, terminal, and desktop-agent evaluations. The package name remains `@deepseek-ai/dsh-blockade` for compatibility; **Focas** is the method and system name.

## Why Focas

A blocked agent often has enough knowledge but searches the wrong space. Typical trajectories repeatedly vary flags, APIs, permissions, or parameters inside one semantic family. A human resolves the task by reframing it: identify the capability carrier and trigger the causal path that already works.

Focas turns that recovery behavior into runtime policy:

1. classify the failure form;
2. distinguish declared success from verified effect;
3. partition broad tools into semantic families;
4. count only consecutive no-progress failures;
5. search for a capability carrier when the current executor is denied or ineffective;
6. record a lesson only after an independently verified cross-family breakthrough.

## Runtime protocols

| Trigger | Runtime response |
|---|---|
| First direct-path failure | Compare direct and user-equivalent routes |
| Explicit denial | Search carriers and identity/entrypoint alternatives |
| Missing target | Discover or recover the owning contract |
| Declared success contradicted by evidence | Mark fake success, exhaust the family, switch causal path |
| Repeated identical failure | Reframe early after two identical outcomes by default |
| Three consecutive same-family failures without progress | Stop deepening and change semantic family |
| Verified cross-family breakthrough | Commit an episode-scoped lesson |

## Focas v3: progress-aware recovery

The current implementation removes three sources of benchmark regression found in the earlier guard:

- **No-probe successes stay transparent.** `verification: mapped` verifies only when a probe exists. A broad terminal tool no longer generates an `unverified` warning after every successful command.
- **Streaks are progress-delimited.** A successful state-changing edit resets stale failure streaks, so normal edit–test iteration is not mistaken for a blockade.
- **Broad tools are semantically partitioned.** `run_command` is separated into `inspect`, `edit`, `test`, `build`, `install`, `service`, and other families; `write_file` can be partitioned by path root.
- **Verification probes are contained.** Probe calls are excluded from the attempt ledger, exceptions become uncommitted evidence instead of breaking the original call, and `probeTimeoutMs` bounds verification latency.

The same change also fixes deployment directive overrides for `carrier_search`, uses the dedicated `target_missing` directive, anchors wildcard matching, and scopes lesson extraction to the current recovery episode. The ALE proxy now keeps task-isolated ledgers, deduplicates retried tool results, bounds idle state with TTL/LRU eviction, selects lite guidance automatically for flash models, and serves concurrent workers through `ThreadingHTTPServer`.

## Core configuration

```yaml
familyFailureLimit: 3
repeatedFailureLimit: 2
probeTimeoutMs: 10000
mode: advisory
families:
  - tools: [run_command]
    family: shell
    familyClass: direct_write
    pathClass: A_direct
    partition:
      argument: command
      mode: command_kind
    verification: none

  - tools: [write_file]
    family: file-write
    familyClass: direct_write
    pathClass: A_direct
    partition:
      argument: path
      mode: path_root
    verification: none
    progressOnSuccess: true
```

Verification policies:

- `mapped`: run independent verification only when a probe mapping exists;
- `required`: a success without confirming evidence remains `unverified`;
- `none`: treat the tool result transparently and do not inject truth-source guidance.

## Repository map

| Path | Purpose |
|---|---|
| `packages/metacog/blockade/` | Focas runtime plugin and pure recovery domain |
| `packages/metacog/blockade-sim/` | Cross-domain simulated blockade worlds |
| `examples/blockade-bench/tau2-bridge.ts` | Tool-loop benchmark bridge |
| `examples/blockade-bench/harbor-bridge.ts` | Terminal-Bench / DeepSWE bridge |
| `examples/blockade-bench/ale_guard_proxy.py` | Agents' Last Exam proxy integration |
| `bench-ops/paired_eval.py` | Paired clean-vs-Focas statistics and confidence interval |
| `examples/blockade-bench/REPORT.md` | Existing experimental record |

## Profiles

| `DSH_GUARD` | Behavior | Intended use |
|---|---|---|
| `off` | DeepSeek Harness baseline | clean arm |
| `full` | all applicable protocols | strong models or diagnosis |
| `lite` | carrier search + progress-aware reframe | flash models and terminal benchmarks |

Profile choice remains an empirical systems parameter. Earlier results showed full guidance can help a stronger model but crowd out weaker models; therefore every claim should use paired runs with identical tasks, seeds, limits, environment, and model endpoint.

## Evaluation status

Existing repository experiments report gains on selected paired runs, including a 20-task Terminal-Bench 2.1 subset. These are pilot results, not official full-benchmark scores. Full public evaluation should use all **89 Terminal-Bench 2.1 tasks** and all **113 DeepSWE tasks**, preferably with repeated trials where the benchmark protocol supports them.

See [BENCHMARK.md](BENCHMARK.md) for the evaluation procedure and [examples/blockade-bench/REPORT.md](examples/blockade-bench/REPORT.md) for the historical record.

## Quick start

```bash
corepack enable
pnpm install
pnpm run build

# clean
DSH_GUARD=off harbor run ...

# Focas lite
DSH_GUARD=lite harbor run ...
```

For DeepSeek-compatible endpoints, set the base URL and key explicitly. An empty base URL is normalized by the bridge to the default endpoint rather than passed through as an invalid provider configuration.
