# Agent Note: Blockade guard — internalized metacognition for blocked writes

Status: implemented

English | [中文](2026-08-14-blockade-guard-metacognition.zh.md)

## Problem

Real agent postmortems (recorded in the source insight case: a car-head-unit bridge agent) show four deadlock mechanisms that human-in-the-loop hints repeatedly unblock: frame lock (the plan enumerates one semantic family, so known-but-out-of-frame paths are never searched), terminal misattribution ("permission denied" ends the investigation), trusted declared success (`ok=true` is banked while a policy layer swallowed the write), and no switch trigger (same-family variants deepen forever). Each hint that unblocked the agent was reusable knowledge — but only after a human supplied it. The gap was a runtime layer that issues those hints deterministically, verifies writes independently, and internalizes each breakthrough so the next session starts smarter.

## Decision

**A new `metacog` package group with two packages.** `dsh-blockade` is the guard plugin: pure domain (failure-form classification, independence-graded verdict composition, attempt ledger, lesson store) plus Cordis listeners on `tools/post-execute` (verify declared writes through configured probe tools, classify failures, steer), `tools/pre-execute` (enforce-mode escalation deny), and `agent/session-start` (lesson recall). `dsh-blockade-sim` mounts three deterministic blockade worlds (car head unit faithful to the recorded case, web backend, managed filesystem) and a scripted cognitive policy for keyless experiments.

**The six protocols are fixed code, not prompt advice.** The failure-form → next-action mapping, the "any disagreement rules fake success / only independent-or-stronger confirmation upgrades a claim" verdict rule, the reframe threshold, and the post-swallow escalation prohibition are all hard-wired; the model only ever receives directive contexts the rules emit.

**Evidence is graded by independence.** An actuator-store readback (state shared with the writer) can confirm a write that never took effect — recorded in the source case — so it alone leaves a claim `unverified`; any channel disagreeing rules it fake; only `independent`/`ground_truth` confirmations verify.

**Verification presumes writes declare their intended observable effect.** Probe rows map probe arguments to write-call arguments (e.g. a key-event call carries `targetVolume`), which keeps the guard generic over domains: the world, not the guard, knows which state a write should move.

**Lessons transfer at the family-class level.** A breakthrough commits `{avoidClasses, workedClass, forms}` as a log-only `blockade/lesson` session event; later sessions in the deployment recall matching lessons at start. Classes (`direct_write`, `user_equivalent_input`, `official_entry`, …) are abstract enough to cross domains — the car lesson halves first-contact attempts on the web and filesystem worlds.

**Experiment evidence is keyless and attributable.** `examples/blockade-lab` runs the same scripted policy in both arms; the steered arm only adds directive obedience, so outcome deltas attribute to the guard. The lab asserts every prediction (baseline false successes, steered zero-false-success, per-protocol ablations restoring exactly their mechanism, transfer halving attempts) and regenerates `report.md` on each run.

## Alternatives considered

**Prompt-only guidance (a system-prompt section listing the six protocols).** Rejected: the postmortems show the mechanisms operate precisely when the model is confidently wrong mid-loop; advisory prose competes with task focus at the exact moment steering is needed, and nothing verifies a declared success.

**Extending `agent-loop` with blockade awareness.** Rejected: the loop is a documented core package and the repo convention is "plugins, not loop changes"; every needed seam (`tools/*` waterfalls, `agent/session-start`, `user/message` contexts) already exists as an extension point.

**Detecting silent swallows by output heuristics (e.g. "SUCCESS with no stderr").** Rejected: a swallow is a contradiction between a claim and the world, detectable only through an independent channel; heuristics on the claim itself cannot see the difference between a real and a swallowed write.

**Per-tool self-verification (each write tool verifies its own effect).** Rejected: a tool reporting its own success is the actuator-store failure mode; independence must come from a channel the writer does not own, so verification lives in the guard with probe tools configured per deployment.

## Consequences

## Scope and status

Advisory mode injects contexts only; enforce mode additionally withholds fake successes and denies post-swallow escalation. Lesson persistence is process-local; projection folding (the `goal/change` pattern) is deferred and recorded in the package README's limitations. Real-model validation runs through the `blockade-lab` example leaf with a provider key; the keyless suite covers the steering machinery.
