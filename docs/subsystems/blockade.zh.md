# 封锁守卫

[English](blockade.md) | 中文

把 agent 从被封锁写操作上引导开走的元认知服务。[blockade-guard Agent Note](../../.agents/notes/implemented/feature/2026-08-14-blockade-guard-metacognition.md) 持有设计决策；本页记录 [`packages/metacog/blockade/src/index.ts`](../../packages/metacog/blockade/src/index.ts) 的服务面。

## 服务

`ctx.blockadeGuard: BlockadeGuard` 提供解析后的映射、按 agent 的账本、写验证器与跨会话经验库：

```ts ignore-check
/** Service face of the blockade guard plugin. */
interface BlockadeGuard {
  /** Cross-session lesson store (protocol 6). */
  lessonStore(): BlockadeLessonStore
  /** One agent's attempt ledger. */
  ledgerOf(agent: Agent): AgentLedger
  /** First family row matching a tool name, or undefined for transparent tools. */
  familyOf(tool: string): FamilyEntry | undefined
  /** Every probe row whose write patterns match a tool name. */
  probesFor(tool: string): readonly ProbeEntry[]
  /** Run the mapped probes for one settled write and collect graded evidence. */
  verifyWrite(exec: ToolExecution): Promise<readonly Evidence[]>
}
```

## 映射行

工具归入语义族；写获得独立验证通道：

```ts type-equiv
/** One family mapping row: which tools belong to one semantic family. */
interface FamilyEntry {
  /** `*`-wildcard tool-name patterns; first matching row wins. */
  tools: string[]
  /** Semantic family id shared by the mapped tools. */
  family: string
  /** Cross-domain family class used for lesson transfer. */
  familyClass: FamilyClass
  /** Path semantic (direct call, user-equivalent, identity shift, reverse). */
  pathClass: PathClass
}
```

```ts type-equiv
/** One probe-argument to write-argument mapping pair. */
interface ArgumentMapping {
  /** The argument name the probe tool accepts. */
  probe: string
  /** The argument name on the verified write call. */
  write: string
}
```

```ts type-equiv
/**
 * One probe mapping row. The probe tool must accept the mapped arguments and
 * return a JSON value with an optional boolean `agrees` plus an `observed`
 * account; an erroring probe contributes uncommitted evidence only.
 */
interface ProbeEntry {
  /** `*`-wildcard patterns over write tool names this probe verifies. */
  writes: string[]
  /** The probe tool invoked to verify a matched write. */
  tool: string
  /** Independence grade of the channel this probe provides. */
  independence: Independence
  /** probe argument name → write-call argument name, as explicit pairs. */
  argumentMap: ArgumentMapping[]
}
```

## 真值词表

纯域类型在 [`src/domain.ts`](../../packages/metacog/blockade/src/domain.ts) 并从包根重导出：`FailureForm`、`Verdict`、`Independence`、`Evidence`、`VerdictRuling`、`PathClass`、`FamilyClass`、`Lesson` 与尝试记录。值得复述的一条分级规则：仅有执行器同源回读时声明保持 `unverified`（它与写者共享状态），任何反对即判假成功，只有 `independent` 或 `ground_truth` 确认才算验证。

## 会话事件

守卫为每条已提交经验追加一个仅记日志事件；它从不派生模型历史：

```ts type-equiv
/** Durable session fact for one committed lesson; log-only, never model-visible. */
interface BlockadeLessonEvent {
  readonly kind: 'blockade/lesson'
  readonly version: 1
  readonly lesson: Lesson
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxblockadeguard--blockadeguard"></a>

### `ctx.blockadeGuard` — `BlockadeGuard`

The service face: ledger registry plus the cross-session lesson store.

```ts cordis-catalog
/**
 * The lesson store, for operators and experiment runners.
 * @returns the cross-session lesson store.
 */
lessonStore(): BlockadeLessonStore

/**
 * One agent's ledger; read-only introspection for tests and reports.
 * @param agent - the live agent owning the ledger.
 * @returns the agent's attempt ledger.
 */
ledgerOf(agent: Agent): AgentLedger

/**
 * First family row matching a tool name, or undefined for transparent tools.
 * @param tool - the tool name to resolve.
 * @returns the first matching family row, or undefined when unmapped.
 */
familyOf(tool: string): FamilyEntry | undefined

/**
 * Every probe row whose write patterns match a tool name.
 * @param tool - the write tool name to resolve.
 * @returns every probe row mapped to the tool.
 */
probesFor(tool: string): readonly ProbeEntry[]

/**
 * Run every probe mapped to one settled write call and collect graded
 * evidence. A probe error contributes an observation without agreement.
 * @param exec - the settled write execution to verify.
 * @returns the graded evidence from every mapped probe.
 */
async verifyWrite(exec: ToolExecution): Promise<readonly Evidence[]>
```

Types: [Agent](core.md) · [ToolExecution](tools.md)

Source: [`packages/metacog/blockade/src/index.ts:183`](../../packages/metacog/blockade/src/index.ts)
<!-- END GENERATED cordis-surface -->
