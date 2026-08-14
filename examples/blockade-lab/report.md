# Blockade lab — experiment report

Keyless, deterministic, fully reproducible (`npx vitest run examples/blockade-lab`).
Both arms run the same scripted cognitive policy; the steered arm only adds obedience to blockade-guard directives.
Ground truth lives in the simulated worlds, never in the agent's view.

## Main comparison

| scenario | baseline (no guard) | steered (six protocols) | calls (base→steered) |
|---|---|---|---|
| car_volume | ❌ FALSE SUCCESS | ✅ verified | 1→4 |
| car_mic_vocal | ✅ verified | ✅ verified | 1→1 |
| car_sound_stage | ❌ FALSE SUCCESS | 🟡 honest blocked | 1→1 |
| car_hvac | ❌ FALSE SUCCESS | 🟡 honest blocked | 1→1 |
| car_media_next | ❌ FALSE SUCCESS | 🟡 honest blocked | 1→4 |
| web_profile | ⛔ gave up | ✅ verified | 3→2 |
| web_maintenance | ⛔ gave up (env limit) | ✅ verified | 1→3 |
| fs_banner | ❌ FALSE SUCCESS | ✅ verified | 1→2 |

**False successes: 5 (baseline) → 0 (steered). Verified breakthroughs with the guard: 5.**

## Ablations (one protocol off each)

| arm | scenario | outcome | calls | restored mechanism |
|---|---|---|---|---|
| ablate-truth | car_volume | ❌ FALSE SUCCESS | 1 | M4: trusted declared success |
| ablate-identity | web_maintenance | ⛔ gave up (env limit) | 1 | M2: terminal misattribution |
| ablate-dualpath | web_profile | ✅ verified | 4 | M1: no dual-path enumeration (backstop survives) |
| ablate-both | web_profile | ⛔ gave up | 3 | M3: endless deepening, never crossing |

## Lesson transfer (protocol 6)

| store | car_volume calls | web_profile calls | fs_banner calls |
|---|---|---|---|
| isolated | 4 | 2 | 2 |
| shared (car first) | 4 | 1 | 1 |

The shared-store web and fs runs receive the `p6_lesson_recall` directive at session start and go straight to the official entry point.

## Cognitive trace — car_volume, steered (the recorded breakthrough, replayed autonomously)

```text
call 1: ok — SUCCESS: adjustVolume returned SUCCESS (requested 23)
  ⟵ directive p2_fake_success
call 2: ERROR — Error: SecurityException: injecting input events requires the input group (INJECT_EVENTS i
  ⟵ directive p4_identity_grid
call 3: ok — chmod 666 /dev/socket/adbd done; local adb can now reach the shell identity (uid 2000, gid
  ⟵ directive p3_unverified
call 4: ok — injected VOLUME_DOWN × 2 as shell
```

Directives fired: p2_fake_success, p4_identity_grid, p3_unverified
