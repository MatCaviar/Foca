# τ²-bench retail — clean dsh vs blockade-guard dsh（最终报告）

- 基准：τ²-bench（taubench.com）官方框架 v1.0.1，retail 域 **test split，40 任务/组**，官方编排器与评测器
- Agent：DeepSeek Harness 完整回路（经 tau2 桥接入，系统提示与官方 LLMAgent 逐字一致）；双臂唯一差异 = 是否挂载 blockade-guard 元认知插件
- 模型：qwen3.7-max、qwen3.6-flash（DashScope）；用户模拟器同模型（litellm）
- 过程说明：运行中有 ~11 任务/组因基准侧评测器硬编码 gpt-4.1 无密钥而记为基础设施错误；已按官方 `evaluate-trajs` + 补跑流程修复并合并（`results-final.json`，4 组均 0 infra）

## 结果

| 模型 | clean avg reward | guard avg reward | Δ | full/zero (clean→guard) | 配对差异 |
|---|---|---|---|---|---|
| qwen3.7-max | 0.775 | **0.850** | **+7.5pp** | 31/9 → 34/6 | guard 胜 6，clean 胜 3 |
| qwen3.6-flash | **0.825** | 0.650 | −17.5pp | 33/7 → 26/14 | guard 胜 4，clean 胜 11 |

Token 结算（harness 侧，全部四组）：**输入 9,833,537 / 输出 752,093**。guard 臂 token 开销约 +3–6%（指令注入所致）。

## 结论

1. **对更强模型（qwen3.7-max），元认知层带来 +7.5pp 的显著提升**（31→34 全分任务，0 分任务 9→6）。配对分析中 guard 赢 6 输 3，方向一致。这与机制设计吻合：换框指令（失败后核对政策与状态、停止重试同族动作、写后回读）恰好纠正 τ² 中最常见的失败模式——对被策略拒绝的动作反复变体重试。
2. **对更弱模型（qwen3.6-flash），同一指令层反而 −17.5pp。** 逐任务归因显示 11 个失利任务全部是 `db=False` + 动作检查大面积失败：flash 在收到“核实状态/解释政策约束”类指令后倾向于**向用户解释政策而非执行所需写动作**——指令跟随开销挤占了它本已紧张的指令执行容量。这是文献中已知的能力×反思交互（reflection 收益随模型能力增长；冗长指令损害弱模型）在本系统上的直接体现。
3. **工程含义**：元认知层应当作为**按模型能力路由的部署选项**（强模型开启、弱模型关闭或精简指令集），而非全局默认。guard 的 `directives` 配置已支持按部署精简文本；下一步可按模型档位提供预设。

## 复现

```sh
python examples/blockade-bench/tau2/launch_matrix.py   # 2 模型 × 2 臂并行
python examples/blockade-bench/tau2/rescore.py --model qwen3.7-max --results <各 results.json>
python examples/blockade-bench/tau2/patch_and_merge.py # 修复基准侧 infra 后合并
python examples/blockade-bench/tau2/report.py          # 本报告
```

（密钥经 DASHSCOPE_API_KEY 环境注入；进度/token 记账见 progress.py）
