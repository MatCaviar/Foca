# Blockade lab（封锁实验场）

[English](README.md) | 中文

元认知包的无密钥确定性实验矩阵：基线对照、引导对照、逐协议消融与经验迁移，覆盖三个模拟封锁世界（车机、Web 后端、托管文件系统）。

## 运行

```sh
npx vitest run examples/blockade-lab
```

每个实验组都启动真实的 agent 回路（`dsh-agent-loop` + mock provider）。唯一脚本化的部分是替代模型的认知策略——两组使用同一个 `PolicyAdapter` 类，差别仅在于是否服从守卫指令。真值存于模拟世界，从不进入 agent 视野。

## 结果

见 [report.md](./report.md)（每次运行重新生成）。要点：

- 基线组：8 个场景中 **5 次假成功**（声明成功被信任而世界不认）与 2 次放弃；
- 引导组：**0 假成功**；5 次验证突破（含记录在案的车机音量突破：API 写被吞 → 假成功裁定 → 身份栅格 → 本地 adbd 准备 → shell 身份按键注入 → 验证）与 3 次有证据的诚实阻塞；
- 每个单协议消融恰好恢复其防护的机制失败；
- 共享经验库把后续领域的首接触尝试减半（2 → 1 次调用）。

## 真模型

配置提供商密钥后，同一世界与守卫可用真模型运行：

```sh
pnpm dsh --profile headless "Set the media volume to 23." --patch examples/blockade-lab/cordis.yml
```

## 布局

- `tests/blockade-lab.spec.ts` — 实验矩阵及其断言
- `cordis.yml` — 在 headless profile 上叠加模拟世界与守卫的组合层
- `report.md` — 生成的实验报告
