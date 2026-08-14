# Blockade guard

English | [中文](blockade.zh.md)

The metacognition service that steers agents off blocked writes. The [blockade-guard Agent Note](../../.agents/notes/implemented/feature/2026-08-14-blockade-guard-metacognition.md) owns the design decisions; this page records the service face from [`packages/metacog/blockade/src/index.ts`](../../packages/metacog/blockade/src/index.ts).

## Service

`ctx.blockadeGuard: BlockadeGuard` exposes the resolved mappings, the per-agent ledger, the write verifier, and the cross-session lesson store:

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

## Mapping rows

Tools join semantic families; writes gain independent verification channels:

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

## Truth vocabulary

The pure domain types live in [`src/domain.ts`](../../packages/metacog/blockade/src/domain.ts) and are re-exported at the package root: `FailureForm`, `Verdict`, `Independence`, `Evidence`, `VerdictRuling`, `PathClass`, `FamilyClass`, `Lesson`, and the attempt record. The one grading rule worth restating: an actuator-store readback alone leaves a claim `unverified` (it shares state with the writer), any disagreement rules a fake success, and only `independent` or `ground_truth` confirmations verify.

## Session events

The guard appends one log-only event per committed lesson; it never derives model history:

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
