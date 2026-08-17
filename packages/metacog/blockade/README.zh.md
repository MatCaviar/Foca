# @deepseek-ai/dsh-blockade

Focas 的运行时插件，用于智能体受阻后的元认知恢复。

该插件把反复无效的行动转化为确定性的恢复行为：分类失败形态、区分声明成功与真实生效、把宽工具划分为语义族、统计连续无进展失败、搜索能力承载者，并且只在跨族突破获得独立验证后沉淀经验。

## 恢复行为

| 观测 | 动作 |
|---|---|
| 第一次直接路径失败 | 同时比较直接路径与用户等价路径 |
| 明确权限拒绝 | 搜索能力承载者与身份替代项 |
| 目标缺失 | 发现或恢复所属接口契约 |
| 声明成功与独立证据冲突 | 标记假成功并切换语义族 |
| 完全相同的失败重复 | 提前换框 |
| 同族连续失败且无进展 | 停止深挖并换框 |
| 跨族突破通过独立验证 | 记录当前恢复回合的经验 |

## 进展感知的能力族

宽工具需要进一步划分，避免无关尝试共用同一个计数器。当前提供两种内置划分：

- `command_kind`：检查、编辑、测试、构建、安装、版本控制变更、服务操作与一般执行；
- `path_root`：按首个有效路径组件划分。

能力族可以把成功调用标记为进展。进展会重置当前恢复回合中的陈旧失败串，因此正常的“编辑—测试”循环不会被误判，同时反复无效重试仍会被及时熔断。

## 配置

```yaml
familyFailureLimit: 3
repeatedFailureLimit: 2
probeTimeoutMs: 10000
mode: advisory
families:
  - tools: [run_command]
    family: shell
    familyClass: direct_write
    pathClass: A_direct
    partition:
      argument: command
      mode: command_kind
    verification: none

  - tools: [write_file]
    family: file-write
    familyClass: direct_write
    pathClass: A_direct
    partition:
      argument: path
      mode: path_root
    verification: none
    progressOnSuccess: true

probes:
  - writes: [car_hvac_set]
    tool: car_get_hvac
    independence: independent
    argumentMap:
      - { probe: expectTemperature, write: temperature }
```

### 验证策略

- `mapped`（默认）：存在探针映射时才执行独立验证，否则记录透明的 `declared_success`；
- `required`：缺少确认性证据时仍保持 `unverified`；
- `none`：该能力族不执行真值源验证。

该区分避免通用终端工具在每次成功命令后都产生“未验证”提示，同时保留高责任写操作所需的严格验证。

### 模式

- `advisory`：仅追加恢复上下文；
- `enforce`：额外扣留已证实的假成功结果，并拒绝已配置的错误提权反射。

## 服务接口

`ctx.blockadeGuard: BlockadeGuard` 提供：

- `familyOf(tool)`：静态映射；
- `resolveFamily(tool, args)`：具体执行对应的细粒度语义族与进展策略；
- `probesFor(tool)` / `verifyWrite(exec)`：分级真值源证据；
- `ledgerOf(agent)`：尝试记录、总失败数、连续失败串与耗尽状态；
- `lessonStore()`：进程内的已验证经验。

## 事件

插件消费 `tools/pre-execute`、`tools/post-execute` 和 `agent/session-start`。所有模型可见提示都记录为来源为 `{ kind: 'plugin', plugin: 'blockade-guard' }` 的 `user/message`；已验证经验追加为仅日志可见的 `blockade/lesson` 事件。

## 保证

- 通配模式匹配完整工具名，不匹配任意子串；
- 部署侧提示覆写对 `carrier_search` 等全部提示生效；
- 目标缺失发出专用 `target_missing`；
- 换框触发基于连续无进展失败，而不是会话终身累计值；
- 经验提取不会混入已经完成的旧恢复回合。

## 当前限制

- 经验存储仍为进程内；
- 效果验证仍需部署侧提供探针；
- 命令类型划分有意保持粗粒度，应依据实测失败扩展；
- enforce 模式下的提权控制仍以当前智能体为全局范围，未明确映射提权工具时应保持关闭。
