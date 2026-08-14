# Blockade lab

English | [中文](README.zh.md)

Keyless, deterministic experiment matrix for the metacognition packages: baseline vs steered vs ablations vs lesson transfer, over three simulated blockade worlds (car head unit, web backend, managed filesystem).

## Run

```sh
npx vitest run examples/blockade-lab
```

The run boots a REAL agent loop per arm (`dsh-agent-loop` + mock provider). The only scripted part is the cognitive policy standing in for the model — the same `PolicyAdapter` class in both arms, differing solely in whether it obeys the guard's directives. Ground truth lives in the simulated worlds and never reaches the agent.

## Results

See [report.md](./report.md) (regenerated on every run). Headline numbers:

- baseline arm: **5 false successes** (declared success trusted while the world disagrees) and 2 gave-ups across 8 scenarios;
- steered arm: **0 false successes**; 5 verified breakthroughs (including the recorded car-volume breakthrough: swallowed API write → fake-success ruling → identity grid → local adbd preparation → shell-identity key injection → verified) and 3 evidence-based honest blocks;
- each single-protocol ablation restores exactly the mechanism failure it guards against;
- a shared lesson store halves first-contact attempts in later domains (2 → 1 calls).

## Live model

With a provider key, the same worlds and guard run against a real model:

```sh
pnpm dsh --profile headless "Set the media volume to 23." --patch examples/blockade-lab/cordis.yml
```

## Layout

- `tests/blockade-lab.spec.ts` — the matrix and its assertions
- `cordis.yml` — composition overlay mounting the sim worlds and the guard over a headless profile
- `report.md` — generated experiment report
