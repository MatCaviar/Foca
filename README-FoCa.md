# FoCa — Frame on Carriers! Metacognitive Recovery from Agentic Blockade

> **Who, not How.** 换框不落在路径上，落在载体上：死锁时刻替 agent 问出"谁已经会做这件事？"，元认知恢复，封锁解除。
> 守卫机制名：**FAQ — Framing Agents through Questioning**（以问破局，六问即注入形式）
> 论文标题建议：*Frame on Carriers! Metacognitive Recovery from Agentic Blockade*（简称 FoCa，谐音 focus——把 agent 的焦点从"路怎么修"聚到"谁已有此能力"）

DeepSeek Harness 官方仓库 + **FAQ 守卫**（六问协议 + carrier_search 换框算子，
内部模块名 `packages/metacog/blockade`），含全部基准桥接件、启动脚本与 LLM 密钥配置。
基线 commit：`a6d655d metacog: Reframe v2`。

## 六问（注入时机各不相同）

| 问句 | 协议 |
|---|---|
| "还有别的路吗？" | P1 双路径枚举 |
| "谁已经会做这件事？" | **carrier_search**（核心算子） |
| "我怎么验证这是真的？" | P3 真源验证 |
| "我在这任务里是谁？" | P4 身份栅格 |
| "该停了吗？" | P5 语义熔断（同族失败 ≥3） |
| "我学到了什么？" | P6 经验内化 |

## 目录速览

| 路径 | 内容 |
|---|---|
| `packages/metacog/blockade/` | 守卫核心：六协议（P1 双路径枚举 / P2 失败形态分类 / P3 真源验证 / P4 身份栅格 / P5 语义熔断 / P6 经验内化）+ carrier_search 换框算子 |
| `packages/metacog/blockade-sim/` | 三域仿真验证（Car / Web / Fs），跨域经验迁移实验 |
| `examples/blockade-bench/tau2-bridge.ts` | τ²-bench 桥（stdio JSON 协议） |
| `examples/blockade-bench/harbor-bridge.ts` | Harbor 桥（TB2.1 / DeepSWE 用） |
| `examples/blockade-bench/ab-guard-proxy.ts` | OpenAI 兼容代理（AutomationBench 等，benchmark 自持 agent loop 时用） |
| `examples/blockade-bench/ale_guard_proxy.py` | ALE 用 Python 守卫代理（Docker 内可达） |
| `examples/blockade-bench/launch_sequential3.sh` | 最新分批启动器（qwen 走 DashScope 默认端点、deepseek 走官方端点） |
| `examples/blockade-bench/REPORT.md` | τ² + AutomationBench v1 完整报告 |
| `conf/llm/` | 全部 LLM 端点与密钥（qwen = DashScope，deepseek = api.deepseek.com） |

## Profile 选择（DSH_GUARD 环境变量）

| 值 | 行为 | 适用 |
|---|---|---|
| `off` | 裸 dsh（clean 臂） | 基线 |
| `full` | 六协议全量注入 | 强推理模型（qwen3.7-max 实测 τ² +7.5pp / TB2.1 +9.2pp） |
| `lite` | 仅 carrier_search + 语义熔断，压缩指令 | 推理型 flash（deepseek-v4-flash TB2.1 +5.0pp）；注意浅推理模型在终端域可能回归（qwen3.6-flash TB2.1 −5.0pp） |

## 关键环境变量

```bash
DASHSCOPE_API_KEY=...          # qwen 系
DASHSCOPE_BASE_URL=            # 留空或不设置 = DashScope 默认；deepseek 模型设 https://api.deepseek.com/v1 并配 DeepSeek key
DSH_GUARD=off|full|lite
```

## 已踩过的坑（务必避开）

1. **`DASHSCOPE_BASE_URL=""`（空串）会击穿 bridge 的 `??` 默认值回退** → provider "empty baseURL"，全任务静默零分。空就用 `unset`。
2. **harbor 环境超时会泄漏 `docker compose up --wait` 子进程** → 用 `bench/compose_watchdog.sh` 定期清理 15 分钟以上的 compose。
3. **WSL→Windows 互操作偶发握手挂死**（bridge 进程活着但无响应）→ 杀掉该 bridge 进程，trial 记异常，harbor 自动带新 bridge 续跑。
4. **并发上限**：2 任务在飞最稳；6 在飞（--n-concurrent 3）是速度/稳定平衡点；18 容器级别会压垮 WSL。
5. `--n-tasks 20` 是子集冒烟用，**对官方榜必须全量**（TB2.1=90、DeepSWE=117）。

## 环境搭建（新机器，一次性）

```bash
# 1. Node 依赖（跑 bridge 用 tsx）
corepack enable && pnpm install        # 或 npm i -g tsx typescript
# 2. Python 依赖（跑 agent / ALE 代理）
python -m pip install openai
# 3. Harbor（TB2.1 / DeepSWE harness）
uv tool install harbor                  # 或 pipx install harbor
# 4. Docker 可用即可；WSL 用户建议 systemd=false + service docker start
```

本包自带 `.git` 历史（基线 `a6d655d`，可直接 `git log` / 对上游 diff）；
`insight_case/` 是最初的方法论原始材料；`bench-ops/` 是跑批运维脚本
（compose 看门狗、进度检查、trial 检查），跨机通用。

## 快速跑法（TB2.1 全量示例）

```bash
# WSL 内：qwen3.7-max 双臂
DSH_GUARD=off  harbor run -p /mnt/d/.../terminal-bench-2-1/tasks \
  -a dsh_harbor_agent:DshHarborAgent -m openai/qwen3.7-max \
  -e docker -o /root/jobs/qwen3.7-max-clean/tb21 --n-concurrent 3
# guard 臂同上，DSH_GUARD=full
```

## 已完成基准成绩（详见 REPORT.md）

- τ²-bench：qwen3.7-max full **+7.5pp**；qwen3.6-flash lite **+2.5pp**（full −17.5pp）
- AutomationBench v1：qwen3.7-max partial **+17%**
- TB2.1（20 任务子集，配对有效、绝对值不可比官方）：qwen3.7-max **+9.2pp**、deepseek-v4-flash **+5.0pp**、qwen3.6-flash **−5.0pp**
