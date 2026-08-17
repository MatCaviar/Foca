# Focas — Frame on Carriers! Metacognitive Recovery from Agentic Blockade

Focas 是 **DeepSeek Harness** 的研究分支，为陷入重复无效行动族的智能体增加面向进展感知的元认知恢复层。

- 方法概览与基准接入：[README-FoCa.md](README-FoCa.md)
- 可复现实验协议：[BENCHMARK.md](BENCHMARK.md)
- 核心运行时：[`packages/metacog/blockade`](packages/metacog/blockade)

核心操作是能力承载者搜索：当前执行主体遭遇拒绝、目标缺失或静默无效时，智能体停止修补同一条路径，转而寻找系统中已经能够产生目标状态的主体、官方入口、服务、工具或工作流。

---

## DeepSeek Harness 上游

DeepSeek Harness（`dsh`）是 DeepSeek AI 开源的智能体 harness，采用“**一切皆插件**”的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动。

### 开发者预览

DeepSeek Harness 仍处于开发者预览阶段，可能引入不兼容变更。

### 从 npm 运行

```sh
npx @deepseek-ai/dsh web
```

### 从源码运行

```sh
git clone https://github.com/MatCaviar/Foca.git
cd Foca
pnpm install
pnpm run build
pnpm dsh web
```

参见 [docs/development.md](docs/development.md)、[docs/architecture.md](docs/architecture.md) 和 [AGENTS.md](AGENTS.md)。

## 许可证

MIT。第三方依赖及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
