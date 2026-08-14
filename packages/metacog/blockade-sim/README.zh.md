# @deepseek-ai/dsh-blockade-sim

[English](README.md) | 中文

无密钥实验用的模拟封锁世界与脚本化认知策略。

三个确定性世界复现了记录在案的卡死结构：

| 世界 | 封锁 | 突破 |
|---|---|---|
| `car`（车机） | 标准写 API 被厂商层吞掉；输入注入对 app 身份拒绝；imaudio 音场写只改服务自身存储 | 本地 adbd socket 准备，再以 shell 身份注入按键 — 记录在案的 bridge-cockpit 突破 |
| `web`（后端） | 废弃的内部写端点返回普通错误；管理写是显式 403 | 设置表单保存（官方入口）；管理身份的服务间令牌 |
| `fs`（托管文件系统） | 直接写入落盘后在下一个同步周期被守护进程母本重铺 | 官方配置导入器 |

探针工具实现守卫的验证契约（`expect*` 参数，`{ observed, agrees? }` 值）。`blockadeConfigFor(worlds)` 返回配套的 families/probes 行。

## PolicyAdapter

一个类、两种策略，在无密钥运行中替代 LLM：

- `naive` 编码四种卡死机制：信任声明成功、重试同框变体、把拒绝当终结、从不枚举路径 B；
- `compliant` 是同一个 agent 加上对 `blockade-guard` 指令的服从（换族、身份枚举、双路径枚举、经验召回）。

两者读取同一候选列表 — 被引导组的优势归因于元认知层，而非知识差异。默认框是 `inNaiveFrame` 子集；指令将其扩展。

## 场景

`SCENARIOS` 定义八个可运行任务，含候选列表、身份解锁与世界真值（`scenario.groundTruth(world)`），供 [`examples/blockade-lab`](../../../examples/blockade-lab) 判定结果（`verified_success`、`false_success`、`honest_blocked`、`gave_up`、`gave_up_env_limit`）。

## 配置

```yaml
worlds: [car, web, fs]
```

## Model Experience

Indirectly, through the model-facing tools this package registers; their schemas join prompt assembly through the tool registry, and the `dsh-tool-*` catalog entries carry the visible surface.

#### KV Cache effect

Independent model requests are unaffected; the package appends nothing to a live model's request prefix.

## Known Limitations and Deferred Work

- **脚本化策略而非模型** — compliant 策略是"服从注入指令的 LLM"的显式替身。真实验证经 `blockade-lab` 示例叶配提供商密钥运行，不在无密钥套件覆盖内。
- **世界是内存态单租户的** — 无跨 agent 隔离、无跨运行持久化；场景真值读取活对象。
