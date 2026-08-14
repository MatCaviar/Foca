# @deepseek-ai/dsh-blockade

English | [中文](README.zh.md)

Blockade guard: internalized metacognition for agents stuck on blocked writes.

One plugin turns the four deadlock mechanisms recorded in real agent postmortems into fixed runtime behavior:

| Mechanism (why agents get stuck) | Protocol (what this plugin does) |
|---|---|
| Frame lock: the plan enumerates one semantic family, so out-of-frame knowledge is never searched | **P1** — the first direct-path failure injects the dual-path enumeration requirement (direct invocation AND user-equivalent paths) |
| Terminal misattribution: "permission denied" ends the investigation | **P2** — every failure is classified (`explicit_denial` / `silent_swallow` / `target_missing` / other); each form has a fixed next action; a verified swallow forbids the escalation reflex |
| Trusted declared success: `ok=true` is banked as done | **P3** — declared successes on mapped writes are downgraded to claims and verified through independent probe tools, graded by evidence independence; an actuator-store readback alone stays `unverified` |
| No switch trigger: same-family variants deepen forever | **P5** — `familyFailureLimit` failures in one family pause deepening and force the dual-path enumeration |
| (extension of M2) "no permission" hides an identity grid | **P4** — an explicit denial injects the identity-dimension enumeration (process uid / higher uid / platform signature / privileged component / daemon identity / trust boundary) |
| Every human hint is spent once | **P6** — a verified breakthrough after failures in other family classes commits a lesson (`blockade/lesson` session event, log-only) that later sessions in the deployment recall at start |

## Service

`ctx.blockadeGuard: BlockadeGuard` (key `blockadeGuard`) exposes:

- `familyOf(tool)` / `probesFor(tool)` — the resolved mappings;
- `verifyWrite(exec)` — run the configured probes for one settled write and return graded evidence;
- `ledgerOf(agent)` — the attempt ledger (family statistics, exhaustion marks);
- `lessonStore()` — the cross-session lesson store.

## Config

```yaml
familyFailureLimit: 3
mode: advisory
families:
  - tools: ['car_*_set', 'car_audio_*']
    family: std-api
    familyClass: direct_write
    pathClass: A_direct
probes:
  - writes: ['car_hvac_set']
    tool: car_get_hvac
    independence: independent
    argumentMap:
      - { probe: expectTemperature, write: temperature }
protocols:
  dualPath: true
  truthSource: true
  identityGrid: true
  reframe: true
  lessons: true
  escalationGuard: true
```

Validation fails loud at plugin load: empty tool lists, unknown enum values, conflicting semantics for one family id, invalid limits, and probe rows without arguments all throw.

### Probe contract

A probe tool accepts the mapped arguments (typically an `expect*` field) and returns a JSON value with an optional boolean `agrees` plus an `observed` account. An erroring probe contributes an uncommitted observation only. Verdict composition is fixed code: any disagreement rules a fake success; only an `independent` or `ground_truth` confirmation upgrades a claim to verified success.

### Modes

`advisory` injects directive contexts only. `enforce` additionally withholds a fake success as a blocked error result and denies `privilege_shift` calls once any family had a write swallowed.

## Events

- consumes `tools/post-execute` (verification, classification, steering), `tools/pre-execute` (enforce-mode escalation deny), `agent/session-start` (lesson recall);
- emits model-visible directive contexts as `user/message` with source `{ kind: 'plugin', plugin: 'blockade-guard', form: 'notice' }`;
- appends log-only `blockade/lesson` session events (durable, replayable, never model-visible).

Every directive carries a stable machine marker (`[blockade:p2_fake_success]`, …) usable by logs, tests, and scripted policies.

## Extension points

New failure forms, identity dimensions, or directive texts live in `src/domain.ts` as data. Domain logic (classification, verdict composition, ledger, lessons) is Cordis-free and reusable from any runner.

## Model Experience

### Request context and condition

#### What the model sees

A directive context is appended after a settled tool call when a protocol fires (fake success ruled, unverified claim, explicit denial, reframe threshold, session-start lesson recall). Example verbatim opening:

##### Directive opening, from `directiveText('p2_fake_success', …)`

```markdown
[blockade:p2_fake_success] The tool reported success, but independent verification contradicts it: this write was silently swallowed by a policy layer. …
```

#### Token effect

Conditional: zero while no protocol fires; one bounded context per fired directive (throttled once per kind per family or tool per agent).

#### KV Cache effect

Append-only: directives append after the newest tool result and never rewrite earlier request tokens. A directive invalidates reuse only for requests newer than its own append.

## Known Limitations and Deferred Work

- **Lesson persistence is process-local** — the store lives on `ctx.blockadeGuard`; cross-restart persistence and projection folding (the `goal/change` pattern) are deferred. Lessons survive agent restarts within one process only.
- **Probe arguments map write-call arguments, not effects** — verification presumes the write's arguments declare their intended observable outcome (e.g. a `targetVolume` on a key-event call). Tools whose effect is not derivable from arguments verify as `unverified`, which is the honest ruling.
- **Family mapping is configuration, not discovery** — tools are assigned semantic families by wildcard rows; a deployment with unmapped tools runs them transparent (no verification, no steering).
