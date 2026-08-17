# Focas — Frame on Carriers! Metacognitive Recovery from Agentic Blockade

Focas is a research fork of **DeepSeek Harness** that adds a progress-aware metacognitive recovery layer for agents trapped in repeated, ineffective action families.

- Method overview and benchmark integration: [README-FoCa.md](README-FoCa.md)
- Reproducible evaluation protocol: [BENCHMARK.md](BENCHMARK.md)
- Core runtime: [`packages/metacog/blockade`](packages/metacog/blockade)

The central operation is capability-carrier search: when the current executor is denied, missing, or silently ineffective, the agent stops repairing the same route and searches for the system actor, official entrypoint, service, tool, or workflow that already produces the target state.

---

## DeepSeek Harness upstream

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com). It uses an architecture where **everything is a plugin**, powered by [Cordis](https://github.com/cordiverse/cordis).

### Developer preview

DeepSeek Harness is in developer preview and may introduce compatibility-breaking changes.

### Run from npm

```sh
npx @deepseek-ai/dsh web
```

### Run from source

```sh
git clone https://github.com/MatCaviar/Foca.git
cd Foca
pnpm install
pnpm run build
pnpm dsh web
```

See [docs/development.md](docs/development.md), [docs/architecture.md](docs/architecture.md), and [AGENTS.md](AGENTS.md).

## License

MIT. Third-party dependencies and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
