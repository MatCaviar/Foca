# @deepseek-ai/dsh-blockade

[English](README.md) | 中文

封锁守卫：为困在"被封锁写操作"上的 agent 内置元认知。

一个插件把真实 agent 事后复盘中记录的四种卡死机制变成固定的运行时行为：

| 机制（为什么会卡死） | 协议（本插件做什么） |
|---|---|
| 框架锁定：计划只枚举一个语义族，族外知识从不进入搜索空间 | **P1** — 首次直连路径失败注入双路径枚举要求（直接调用 AND 用户等价路径） |
| 终止性错误归因："permission denied"终结了调查 | **P2** — 每次失败先分类（显式拒绝 / 静默吞掉 / 目标缺失 / 其他）；每类固定下一步动作；被证实的吞掉禁止提权反射 |
| 信任声明成功：`ok=true` 被当作完成 | **P3** — 映射写操作的声明成功降级为"声明"，经独立探针工具验证，按证据独立性分级；仅有执行器同源回读时保持 `unverified` |
| 缺少切换触发器：同族变体无限深挖 | **P5** — 同语义族失败达 `familyFailureLimit` 次即暂停深挖，强制双路径枚举 |
| （机制2延伸）"没权限"遮住了身份栅格 | **P4** — 显式拒绝注入身份维度枚举（进程 uid / 更高 uid / 平台签名 / 特权组件 / 守护进程身份 / 信任边界） |
| 每次人工提示只花一次 | **P6** — 在其他族类失败后取得验证突破时沉淀经验（`blockade/lesson` 会话事件，仅记日志），部署内后续会话启动时召回 |

## 服务

`ctx.blockadeGuard: BlockadeGuard`（键 `blockadeGuard`）提供：

- `familyOf(tool)` / `probesFor(tool)` — 解析后的映射；
- `verifyWrite(exec)` — 为一次已落定的写运行配置的探针，返回分级证据；
- `ledgerOf(agent)` — 尝试账本（族统计、穷尽标记）；
- `lessonStore()` — 跨会话经验库。

## 配置

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

配置校验在插件加载时失败即报错：空工具列表、未知枚举值、同一族 id 语义冲突、非法阈值、无参数探针行都会抛错。

### 探针契约

探针工具接受映射参数（通常是 `expect*` 字段）并返回带可选布尔 `agrees` 与 `observed` 描述的 JSON 值。探针出错只贡献一条无承诺的观测。判定合成是写死的代码：任何不一致即判假成功；只有 `independent` 或 `ground_truth` 级的确认才把声明升级为已验证成功。

### 模式

`advisory` 只注入指令上下文。`enforce` 额外把假成功扣留为 blocked 错误结果，并在任一族出现被吞写之后拒绝 `privilege_shift` 类调用。

## 事件

- 消费 `tools/post-execute`（验证、分类、转向）、`tools/pre-execute`（enforce 模式提权拒绝）、`agent/session-start`（经验召回）；
- 以 `user/message`（source `{ kind: 'plugin', plugin: 'blockade-guard', form: 'notice' }`）发出模型可见的指令上下文；
- 追加仅记日志的 `blockade/lesson` 会话事件（持久、可重放、不进模型上下文）。

每条指令带稳定机器标记（`[blockade:p2_fake_success]` 等），可供日志、测试与脚本化策略使用。

## 扩展点

新的失败形态、身份维度或指令文本作为数据放在 `src/domain.ts`。域逻辑（分类、判定合成、账本、经验）不依赖 Cordis，任何运行器都可复用。

## Model Experience

### Request context and condition

#### What the model sees

协议触发时（判定假成功、未证实声明、显式拒绝、换框阈值、会话启动经验召回），在已落定的工具调用之后追加一条指令上下文。示例原文开头：

##### Directive opening, from `directiveText('p2_fake_success', …)`

```markdown
[blockade:p2_fake_success] The tool reported success, but independent verification contradicts it: this write was silently swallowed by a policy layer. …
```

#### Token effect

条件性：无协议触发时为零；每个触发的指令一条有界上下文（按 kind × family 或 tool × agent 限流一次）。

#### KV Cache effect

只追加：指令附加在最新工具结果之后，从不改写更早的请求 token。指令只使其自身之后的新请求失去复用。

## Known Limitations and Deferred Work

- **经验持久化是进程内的** — 存储挂在 `ctx.blockadeGuard`；跨重启持久化与投影折叠（`goal/change` 模式）暂缓。经验仅在单进程内的 agent 重启间存活。
- **探针参数映射的是写调用参数而非效果** — 验证假定写的参数声明了其预期可观测结果（如按键调用上的 `targetVolume`）。效果不可从参数推导的工具验证为 `unverified`，这是诚实的裁决。
- **族映射是配置而非发现** — 工具按通配行归入语义族；未映射工具的部署对其透明（不验证、不转向）。
