# @deepseek-ai/dsh-blockade

Focas runtime plugin for metacognitive recovery from agentic blockade.

The package turns repeated ineffective actions into deterministic recovery behavior. It classifies failure forms, distinguishes declared success from verified effect, narrows broad tools into semantic families, tracks consecutive no-progress failures, searches for capability carriers, and commits lessons only after independently verified cross-family breakthroughs.

## Recovery behavior

| Observation | Action |
|---|---|
| first direct failure | compare direct and user-equivalent routes |
| explicit denial | search capability carriers and identity alternatives |
| target missing | discover or recover the owning contract |
| success contradicted by independent evidence | mark fake success and switch family |
| repeated identical failure | early reframe |
| consecutive same-family failures without progress | stop deepening and reframe |
| verified cross-family breakthrough | record an episode-scoped lesson |

## Progress-aware families

Broad tools should be partitioned so unrelated attempts do not share a counter. Two built-in partitions are available:

- `command_kind`: `inspect`, `edit`, `test`, `build`, `install`, `vcs-change`, `service`, or `execute`;
- `path_root`: the first meaningful path component.

A family may mark successful calls as progress. Progress resets stale failure streaks across the current recovery episode, which preserves normal edit–test iteration while still cutting off repeated no-op retries.

## Configuration

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

probes:
  - writes: [car_hvac_set]
    tool: car_get_hvac
    independence: independent
    argumentMap:
      - { probe: expectTemperature, write: temperature }
```

### Verification policy

- `mapped` (default): verify only when a probe mapping exists; otherwise the successful call is transparent `declared_success`;
- `required`: a successful call without confirming evidence remains `unverified`;
- `none`: never run truth-source verification for this family.

This distinction prevents generic terminal tools from generating an unverified warning after every successful command while preserving strict verification where the deployment defines an observable effect.

### Modes

- `advisory`: append recovery contexts only;
- `enforce`: additionally withhold verified fake-success results and deny the configured escalation reflex.

## Service

`ctx.blockadeGuard: BlockadeGuard` exposes:

- `familyOf(tool)` — static mapping row;
- `resolveFamily(tool, args)` — concrete partitioned family and progress policy;
- `probesFor(tool)` / `verifyWrite(exec)` — graded truth-source evidence;
- `ledgerOf(agent)` — attempts, failure totals, consecutive streaks, and exhaustion;
- `lessonStore()` — process-local verified lessons.

## Events

The plugin consumes `tools/pre-execute`, `tools/post-execute`, and `agent/session-start`. Model-visible directives are logged as `user/message` events with source `{ kind: 'plugin', plugin: 'blockade-guard' }`. Verified lessons are appended as log-only `blockade/lesson` events.

## Guarantees

- wildcard mappings match complete tool names, not substrings;
- deployment directive overrides apply to carrier search and every other directive;
- a missing target emits `target_missing`, not a generic reframe;
- family triggers use consecutive no-progress failures, not lifetime totals;
- lesson extraction ignores failures from earlier completed recovery episodes.

## Current limits

- lesson storage is process-local;
- effect verification still requires deployment-provided probes;
- command-kind partitioning is intentionally coarse and should be extended only from measured failure cases;
- enforce-mode escalation control is global to the live agent and should remain disabled unless the deployment has mapped privilege-shift tools deliberately.
