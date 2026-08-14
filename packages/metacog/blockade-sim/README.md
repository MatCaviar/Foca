# @deepseek-ai/dsh-blockade-sim

English | [中文](README.zh.md)

Simulated blockade worlds and the scripted cognitive policy for keyless experiments.

Three deterministic worlds reproduce the recorded deadlock structures:

| world | blockades | breakthrough |
|---|---|---|
| `car` (head unit) | standard write APIs swallowed by the vendor layer; input injection denied to the app identity; imaudio sound-stage writes mutate only the service store | local adbd socket preparation, then key injection under the shell identity — the recorded bridge-cockpit breakthrough |
| `web` (backend) | deprecated internal write endpoints return ordinary errors; admin writes are an explicit 403 | settings-form save (official entry); service-to-service token for the admin identity |
| `fs` (managed filesystem) | direct writes land and are re-materialized from the daemon master at the next sync | the official config importer |

Probe tools implement the guard's verification contract (`expect*` argument, `{ observed, agrees? }` value). `blockadeConfigFor(worlds)` returns the matching families/probes rows.

## PolicyAdapter

One class, two policies, standing in for the LLM in keyless runs:

- `naive` encodes the four deadlock mechanisms: trusts declared success, retries same-frame variants, treats denial as terminal, never enumerates path B;
- `compliant` is the same agent plus obedience to `blockade-guard` directives (family switch, identity enumeration, dual-path enumeration, lesson recall).

Both read the same candidate list — the steered arm's advantage is attributable to the metacognition layer, not to different knowledge. The naive frame is the `inNaiveFrame` subset; directives expand it.

## Scenarios

`SCENARIOS` defines eight runnable tasks with candidate lists, identity unlocks, and world ground truth (`scenario.groundTruth(world)`) used by [`examples/blockade-lab`](../../../examples/blockade-lab) to score outcomes (`verified_success`, `false_success`, `honest_blocked`, `gave_up`, `gave_up_env_limit`).

## Config

```yaml
worlds: [car, web, fs]
```

## Model Experience

Indirectly, through the model-facing tools this package registers; their schemas join prompt assembly through the tool registry, and the `dsh-tool-*` catalog entries carry the visible surface.

#### KV Cache effect

Independent model requests are unaffected; the package appends nothing to a live model's request prefix.

## Known Limitations and Deferred Work

- **Scripted policy, not a model** — the compliant policy is an explicit stand-in for "an LLM that follows injected directives". Real-model validation runs through the `blockade-lab` example leaf with a provider key and is not covered by the keyless suite.
- **Worlds are in-memory and single-tenant** — no cross-agent isolation, no persistence between runs; scenario ground truth reads live objects.
