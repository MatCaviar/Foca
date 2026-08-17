/**
 * Focas blockade guard: progress-aware metacognitive recovery for agents that
 * get trapped in one action frame. The plugin classifies failures, verifies
 * configured writes, partitions broad tools into semantic families, detects
 * consecutive no-progress failures, and injects the smallest applicable
 * recovery directive.
 * @module @deepseek-ai/dsh-blockade
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  PreToolDecision,
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import { classifyFailure, composeVerdict } from './classify.ts'
import type { Evidence, Verdict, VerdictRuling } from './domain.ts'
import type {
  DirectiveKind,
  FamilyClass,
  Independence,
  PathClass,
} from './domain.ts'
import { resolveDirective } from './domain.ts'
import type { DirectiveOverrides } from './domain.ts'
import { AgentLedger, LedgerRegistry, extractLesson } from './ledger.ts'
import { BlockadeLessonStore } from './lessons.ts'

export type {
  AttemptRecord,
  DirectiveKind,
  DirectiveOverrides,
  Evidence,
  FailureForm,
  FamilyClass,
  Independence,
  Lesson,
  NextAction,
  PathClass,
  Verdict,
  VerdictRuling,
} from './domain.ts'
export { directiveMarker, directiveText, resolveDirective } from './domain.ts'
export { classifyFailure, composeVerdict } from './classify.ts'
export { AgentLedger, extractLesson } from './ledger.ts'
export { BlockadeLessonStore } from './lessons.ts'

/** How a broad tool family is partitioned into narrower recovery episodes. */
export type FamilyPartitionMode = 'command_kind' | 'path_root'

/** Declarative argument-based family partition. */
export interface FamilyPartition {
  /** Preferred tool argument carrying the command or path. */
  argument: string
  /** Built-in partition strategy. */
  mode: FamilyPartitionMode
}

/** Whether a successful mapped tool requires truth-source verification. */
export type VerificationPolicy = 'mapped' | 'required' | 'none'

/** One family mapping row: which tools belong to one semantic family. */
export interface FamilyEntry {
  /** `*`-wildcard tool-name patterns; first matching row wins. */
  tools: string[]
  /** Semantic family id shared by the mapped tools. */
  family: string
  /** Cross-domain family class used for lesson transfer. */
  familyClass: FamilyClass
  /** Path semantic (direct call, user-equivalent, identity shift, reverse). */
  pathClass: PathClass
  /** Optional argument-based partition for broad tools such as `run_command`. */
  partition?: FamilyPartition
  /** `mapped`: verify only when probes exist; `required`: no probe stays unverified; `none`: transparent success. */
  verification?: VerificationPolicy
  /** Whether an unchecked successful call starts a new recovery episode. */
  progressOnSuccess?: boolean
}

/** Resolved family semantics for one concrete execution. */
export interface FamilyResolution {
  readonly family: string
  readonly familyClass: FamilyClass
  readonly pathClass: PathClass
  readonly verification: VerificationPolicy
  readonly progressOnSuccess: boolean
}

/** One probe mapping row. */
export interface ProbeEntry {
  /** `*`-wildcard patterns over write tool names this probe verifies. */
  writes: string[]
  /** The probe tool invoked to verify a matched write. */
  tool: string
  /** Independence grade of the channel this probe provides. */
  independence: Independence
  /** Probe argument name → write argument name. */
  argumentMap: ArgumentMapping[]
}

/** One probe-argument to write-argument mapping pair. */
export interface ArgumentMapping {
  readonly probe: string
  readonly write: string
}

/** Per-protocol switches; every ablation flips exactly one. */
export interface ProtocolSwitches {
  dualPath?: boolean
  truthSource?: boolean
  carrierSearch?: boolean
  identityGrid?: boolean
  reframe?: boolean
  lessons?: boolean
  escalationGuard?: boolean
}

/** Plugin configuration. */
export interface Config {
  /** Consecutive same-family failures before the reframe trigger (default 3). */
  familyFailureLimit?: number
  /** Repeated identical failures that trigger an early reframe (default 2). */
  repeatedFailureLimit?: number
  /** Maximum wall time for one independent verification probe (default 10 seconds). */
  probeTimeoutMs?: number
  /** `advisory` injects contexts; `enforce` also blocks fake success/escalation. */
  mode?: 'advisory' | 'enforce'
  families?: FamilyEntry[]
  probes?: ProbeEntry[]
  protocols?: ProtocolSwitches
  directives?: DirectiveOverrides
}

const directiveKeys = z.union(['p1_dual_path', 'p2_fake_success', 'carrier_search', 'p3_unverified', 'p4_identity_grid', 'p5_reframe', 'p6_lesson_recall', 'target_missing', 'escalation_forbidden'] as const)

export const Config: z<Config> = z.object({
  familyFailureLimit: z.natural().min(1).default(3),
  repeatedFailureLimit: z.natural().min(1).default(2),
  probeTimeoutMs: z.natural().min(1).default(10000),
  mode: z.union(['advisory', 'enforce'] as const).default('advisory'),
  families: z.array(z.object({
    tools: z.array(z.string()),
    family: z.string(),
    familyClass: z.union(['direct_write', 'user_equivalent_input', 'official_entry', 'privilege_shift', 'env_setup'] as const),
    pathClass: z.union(['A_direct', 'B_user_equivalent', 'C_identity_shift', 'D_reverse_engineer'] as const),
    partition: z.object({
      argument: z.string(),
      mode: z.union(['command_kind', 'path_root'] as const),
    }),
    verification: z.union(['mapped', 'required', 'none'] as const),
    progressOnSuccess: z.boolean(),
  })).default([]),
  probes: z.array(z.object({
    writes: z.array(z.string()),
    tool: z.string(),
    independence: z.union(['actuator_store', 'independent', 'ground_truth'] as const),
    argumentMap: z.array(z.object({ probe: z.string(), write: z.string() })),
  })).default([]),
  protocols: z.object({
    dualPath: z.boolean().default(true),
    truthSource: z.boolean().default(true),
    carrierSearch: z.boolean().default(true),
    identityGrid: z.boolean().default(true),
    reframe: z.boolean().default(true),
    lessons: z.boolean().default(true),
    escalationGuard: z.boolean().default(true),
  }).default({
    dualPath: true,
    truthSource: true,
    carrierSearch: true,
    identityGrid: true,
    reframe: true,
    lessons: true,
    escalationGuard: true,
  }),
  directives: z.dict(z.string(), directiveKeys) as unknown as z<DirectiveOverrides>,
})

/** Resolved plugin configuration after defaults. */
export interface ResolvedConfig {
  readonly familyFailureLimit: number
  readonly repeatedFailureLimit: number
  readonly probeTimeoutMs: number
  readonly mode: 'advisory' | 'enforce'
  readonly families: readonly FamilyEntry[]
  readonly probes: readonly ProbeEntry[]
  readonly protocols: Required<ProtocolSwitches>
  readonly directives: DirectiveOverrides
}

const FAMILY_CLASSES: readonly FamilyClass[] = ['direct_write', 'user_equivalent_input', 'official_entry', 'privilege_shift', 'env_setup']
const PATH_CLASSES: readonly PathClass[] = ['A_direct', 'B_user_equivalent', 'C_identity_shift', 'D_reverse_engineer']
const INDEPENDENCES: readonly Independence[] = ['actuator_store', 'independent', 'ground_truth']
const PARTITION_MODES: readonly FamilyPartitionMode[] = ['command_kind', 'path_root']
const VERIFICATION_POLICIES: readonly VerificationPolicy[] = ['mapped', 'required', 'none']

const GUARD_SOURCE_KIND = 'plugin' as const
export const GUARD_PLUGIN_NAME = 'blockade-guard'

function renderText(content: readonly { type: string; text?: string }[]): string {
  return content.map(block => block.type === 'text' ? (block.text ?? '') : `[${block.type}]`).join('\n')
}

function argumentRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function firstStringArgument(args: Record<string, unknown>, preferred: string, fallbacks: readonly string[]): string | undefined {
  const candidates = [preferred, ...fallbacks]
  for (const key of candidates) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

function compactKey(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return compact.length === 0 ? 'unknown' : compact.slice(0, 48)
}

/** Coarse terminal command class used to avoid treating all shell work as one failure family. */
export function classifyCommandKind(command: string): { readonly key: string; readonly progressOnSuccess: boolean } {
  const normalized = command
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/u, '')
    .replace(/^(?:sudo|timeout\s+\S+)\s+/u, '')
    .toLowerCase()
  const segments = normalized
    .split(/\s*(?:&&|\|\||;|\n)\s*/u)
    .map(segment => segment.replace(/^cd\s+\S+\s*/u, '').trim())
    .filter(segment => segment.length > 0)
  const any = (pattern: RegExp): boolean => segments.some(segment => pattern.test(segment))

  if (any(/\b(pytest|vitest|jest|ctest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|mvn\s+test|gradle\w*\s+test|make\s+test)\b/u)) {
    return { key: 'test', progressOnSuccess: true }
  }
  if (any(/\b(tsc|go\s+build|cargo\s+build|npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+build|mvn\s+(?:package|verify)|gradle\w*\s+build|cmake\s+--build|make(?:\s|$))\b/u)) {
    return { key: 'build', progressOnSuccess: true }
  }
  if (any(/\b(apt(?:-get)?|dnf|yum|apk|brew)\s+(?:install|add)|\b(?:pip|pip3|uv)\s+(?:install|add)|\b(?:npm|pnpm|yarn)\s+(?:install|add)|\bcargo\s+install\b/u)) {
    return { key: 'install', progressOnSuccess: true }
  }
  if (any(/\b(apply_patch|sed\s+-i|perl\s+-pi|tee\b|touch\b|mkdir\b|cp\b|mv\b|rm\b|chmod\b|chown\b)|(?:^|\s)(?:>>?|2>)[^&]|\b(write_text|write_bytes|json\.dump|yaml\.dump|shutil\.(?:copy|move)|os\.(?:remove|rename|mkdir))\b|\bopen\([^)]*,\s*['"][wax]/u)) {
    return { key: 'edit', progressOnSuccess: true }
  }
  if (any(/^git\s+(?:add|apply|checkout|switch|restore|reset|merge|rebase|cherry-pick|commit|clean)\b/u)) {
    return { key: 'vcs-change', progressOnSuccess: true }
  }
  if (any(/^(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable)\b|^docker(?:\s+compose)?\s+(?:build|up|down|start|stop|restart|rm|run|exec)\b|^docker-compose\s+(?:build|up|down|start|stop|restart|rm|run|exec)\b|^(?:kubectl|helm)\s+(?:apply|create|delete|patch|replace|rollout|scale|upgrade|install|uninstall)\b/u)) {
    return { key: 'service', progressOnSuccess: true }
  }
  if (any(/^(?:ls|pwd|cat|head|tail|grep|rg|find|stat|file|which|whereis|wc|tree)\b|^git\s+(?:status|diff|log|show|branch)\b|^docker(?:\s+compose)?\s+(?:ps|images|inspect|logs|config)\b|^docker-compose\s+(?:ps|images|logs|config)\b|^(?:kubectl|helm)\s+(?:get|describe|logs|status|list|show)\b|^(?:npm|pnpm|yarn)\s+(?:list|why|view|info)\b|^(?:pip|pip3)\s+(?:show|list|freeze)\b/u)) {
    return { key: 'inspect', progressOnSuccess: false }
  }
  return { key: 'execute', progressOnSuccess: false }
}

function pathRoot(path: string): string {
  const segments = path.replaceAll('\\', '/').split('/').filter(segment => segment.length > 0 && segment !== '.')
  const generic = new Set(['tmp', 'workspace', 'workspaces', 'repo', 'project', 'root', 'home'])
  const useful = segments.find(segment => !generic.has(segment.toLowerCase())) ?? segments[0] ?? 'unknown'
  return compactKey(useful)
}

function partitionFamily(entry: FamilyEntry, args: Record<string, unknown>): { key?: string; progressOnSuccess?: boolean } {
  const partition = entry.partition
  if (partition === undefined) return {}
  if (partition.mode === 'command_kind') {
    const command = firstStringArgument(args, partition.argument, ['command', 'cmd', 'script'])
    if (command === undefined) return { key: 'unknown' }
    const kind = classifyCommandKind(command)
    return { key: kind.key, progressOnSuccess: kind.progressOnSuccess }
  }
  const path = firstStringArgument(args, partition.argument, ['path', 'file', 'file_path', 'filename'])
  return { key: path === undefined ? 'unknown' : pathRoot(path) }
}

/** Stable normalized signature for repeated-error detection. */
export function failureFingerprint(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s:]+/giu, '<path>')
    .replace(/<path>:\d+(?::\d+)?/gu, '<path>:<line>')
    .replace(/\b[0-9a-f]{8,}\b/giu, '<hex>')
    .replace(/\b(?:pid|process|port|attempt|run)[\s:=#-]*\d+\b/giu, '<volatile-id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?)?\b/giu, '<time>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|msec|milliseconds?|sec|seconds?|mins?|minutes?)\b/giu, '<duration>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 320)
}

/** The service face: mappings, ledgers, verification, and lesson memory. */
export class BlockadeGuard extends Service {
  private readonly ledgers = new LedgerRegistry()
  private readonly lessons = new BlockadeLessonStore()
  private readonly familyMatchers: readonly { pattern: RegExp; entry: FamilyEntry }[]
  private readonly probeMatchers: readonly { pattern: RegExp; entry: ProbeEntry }[]
  private readonly internalProbeCalls = new Set<string>()

  constructor(ctx: Context, readonly options: ResolvedConfig) {
    super(ctx, 'blockadeGuard')
    this.familyMatchers = options.families.map(entry => ({ pattern: compileFirstMatch(entry.tools), entry }))
    this.probeMatchers = options.probes.map(entry => ({ pattern: compileFirstMatch(entry.writes), entry }))
  }

  lessonStore(): BlockadeLessonStore {
    return this.lessons
  }

  ledgerOf(agent: Agent): AgentLedger {
    return this.ledgers.of(agent)
  }

  /** First static mapping row matching a tool name. */
  familyOf(tool: string): FamilyEntry | undefined {
    for (const { pattern, entry } of this.familyMatchers) {
      if (pattern.test(tool)) return entry
    }
    return undefined
  }

  /** Resolve a concrete execution into a narrow semantic family. */
  resolveFamily(tool: string, args: unknown): FamilyResolution | undefined {
    const entry = this.familyOf(tool)
    if (entry === undefined) return undefined
    const partition = partitionFamily(entry, argumentRecord(args))
    return {
      family: partition.key === undefined ? entry.family : `${entry.family}:${partition.key}`,
      familyClass: entry.familyClass,
      pathClass: entry.pathClass,
      verification: entry.verification ?? 'mapped',
      progressOnSuccess: entry.progressOnSuccess ?? partition.progressOnSuccess ?? false,
    }
  }

  probesFor(tool: string): readonly ProbeEntry[] {
    return this.probeMatchers.filter(({ pattern }) => pattern.test(tool)).map(({ entry }) => entry)
  }

  /** Whether this execution was initiated internally as a verification probe. */
  isInternalProbe(callId: unknown): boolean {
    return this.internalProbeCalls.has(String(callId))
  }

  /** Run the selected probes for one settled call. */
  async verifyWrite(exec: ToolExecution, probes: readonly ProbeEntry[] = this.probesFor(exec.name)): Promise<readonly Evidence[]> {
    const evidences: Evidence[] = []
    const writeArgs = argumentRecord(exec.arguments)
    for (const probe of probes) {
      const args: Record<string, unknown> = {}
      for (const mapping of probe.argumentMap) args[mapping.probe] = writeArgs[mapping.write]
      const callId = CallId(`blockade-probe-${crypto.randomUUID()}`)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`probe ${probe.tool} timed out`)), this.options.probeTimeoutMs)
      this.internalProbeCalls.add(String(callId))
      try {
        let result: ToolExecutionResult
        try {
          result = await this.ctx.tools.execute({ signal: controller.signal, callId, name: probe.tool, arguments: args })
        } catch (error) {
          evidences.push({
            probe: probe.tool,
            independence: probe.independence,
            observed: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (result.isError) {
          evidences.push({ probe: probe.tool, independence: probe.independence, observed: renderText(result.content) })
          continue
        }
        const value = argumentRecord(result.value)
        const agrees = typeof value.agrees === 'boolean' ? value.agrees : undefined
        evidences.push({
          probe: probe.tool,
          independence: probe.independence,
          ...(agrees === undefined ? {} : { agrees }),
          observed: typeof value.observed === 'string' ? value.observed : JSON.stringify(value),
        })
      } finally {
        clearTimeout(timer)
        this.internalProbeCalls.delete(String(callId))
      }
    }
    return evidences
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    blockadeGuard: BlockadeGuard
  }
}

export const name = GUARD_PLUGIN_NAME
export const inject = ['tools']

function validateConfig(config: ResolvedConfig): void {
  if (!Number.isInteger(config.familyFailureLimit) || config.familyFailureLimit < 1) {
    throw new Error(`blockade-guard: invalid familyFailureLimit ${String(config.familyFailureLimit)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(config.repeatedFailureLimit) || config.repeatedFailureLimit < 1) {
    throw new Error(`blockade-guard: invalid repeatedFailureLimit ${String(config.repeatedFailureLimit)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(config.probeTimeoutMs) || config.probeTimeoutMs < 1) {
    throw new Error(`blockade-guard: invalid probeTimeoutMs ${String(config.probeTimeoutMs)} — must be an integer >= 1`)
  }
  const familyConsistency = new Map<string, { familyClass: FamilyClass; pathClass: PathClass }>()
  for (const entry of config.families) {
    if (!FAMILY_CLASSES.includes(entry.familyClass)) throw new Error(`blockade-guard: unknown familyClass ${entry.familyClass} in family ${entry.family}`)
    if (!PATH_CLASSES.includes(entry.pathClass)) throw new Error(`blockade-guard: unknown pathClass ${entry.pathClass} in family ${entry.family}`)
    if (entry.tools.length === 0) throw new Error(`blockade-guard: family ${entry.family} maps no tools`)
    if (entry.partition !== undefined) {
      if (!PARTITION_MODES.includes(entry.partition.mode)) throw new Error(`blockade-guard: unknown partition mode ${entry.partition.mode} in family ${entry.family}`)
      if (entry.partition.argument.trim().length === 0) throw new Error(`blockade-guard: empty partition argument in family ${entry.family}`)
    }
    if (entry.verification !== undefined && !VERIFICATION_POLICIES.includes(entry.verification)) {
      throw new Error(`blockade-guard: unknown verification policy ${entry.verification} in family ${entry.family}`)
    }
    const prior = familyConsistency.get(entry.family)
    if (prior !== undefined && (prior.familyClass !== entry.familyClass || prior.pathClass !== entry.pathClass)) {
      throw new Error(`blockade-guard: family ${entry.family} declared with conflicting semantics`)
    }
    familyConsistency.set(entry.family, { familyClass: entry.familyClass, pathClass: entry.pathClass })
  }
  for (const probe of config.probes) {
    if (!INDEPENDENCES.includes(probe.independence)) throw new Error(`blockade-guard: unknown independence ${probe.independence} in probe ${probe.tool}`)
    if (probe.writes.length === 0) throw new Error(`blockade-guard: probe ${probe.tool} verifies no tools`)
    if (probe.argumentMap.length === 0) throw new Error(`blockade-guard: probe ${probe.tool} maps no arguments`)
  }
}

/** Compile exact, wildcard-aware, first-row matchers. */
function compileFirstMatch(patterns: readonly string[]): RegExp {
  return new RegExp(`^(?:${patterns.map((pattern) => {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
    return escaped.replaceAll('*', '.*')
  }).join('|')})$`)
}

function directiveMessage(kind: DirectiveKind, detail: string, summary: string, overrides: DirectiveOverrides = {}): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: resolveDirective(kind, detail, overrides) }],
    source: {
      kind: GUARD_SOURCE_KIND,
      plugin: GUARD_PLUGIN_NAME,
      form: 'notice',
      summary: summary.slice(0, 120),
    },
  })
}

function successVerdict(policy: VerificationPolicy, ruling: VerdictRuling | undefined): Verdict {
  if (ruling !== undefined) return ruling.verdict
  if (policy === 'required') return 'unverified'
  return 'declared_success'
}

/** Install the guard listeners. */
export function apply(ctx: Context, config: Config): void {
  const options: ResolvedConfig = {
    familyFailureLimit: config.familyFailureLimit ?? 3,
    repeatedFailureLimit: config.repeatedFailureLimit ?? 2,
    probeTimeoutMs: config.probeTimeoutMs ?? 10000,
    mode: config.mode ?? 'advisory',
    // schemastery materializes an omitted nested object as {} — collapse it back
    // so optional FamilyEntry.partition stays truly optional (exactOptionalPropertyTypes-safe).
    families: (config.families ?? []).map(({ partition, ...rest }) => ({
      ...rest,
      ...(partition !== undefined && partition.mode !== undefined ? { partition } : {}),
    })),
    probes: config.probes ?? [],
    protocols: {
      dualPath: config.protocols?.dualPath ?? true,
      truthSource: config.protocols?.truthSource ?? true,
      carrierSearch: config.protocols?.carrierSearch ?? true,
      identityGrid: config.protocols?.identityGrid ?? true,
      reframe: config.protocols?.reframe ?? true,
      lessons: config.protocols?.lessons ?? true,
      escalationGuard: config.protocols?.escalationGuard ?? true,
    },
    directives: config.directives ?? {},
  }
  validateConfig(options)
  const directive = (kind: DirectiveKind, detail: string, summary: string): UserMessage =>
    directiveMessage(kind, detail, summary, options.directives)
  const guard = new BlockadeGuard(ctx, options)
  const { protocols } = options

  ctx.on('agent/session-start', ({ agent }: { agent: Agent }) => {
    if (!protocols.lessons) return
    const classes = [...new Set(options.families.map(entry => entry.familyClass))]
    const relevant = guard.lessonStore().relevantTo(classes)
    if (relevant.length === 0 || !guard.ledgerOf(agent).needsLessonRecall()) return
    agent.inject(directive('p6_lesson_recall', BlockadeLessonStore.render(relevant), `recall: ${relevant.length} lessons`))
  })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    if (guard.isInternalProbe(exec.callId)) return downstream
    if (options.mode !== 'enforce' || !protocols.escalationGuard || !exec.agent) return downstream
    const mapping = guard.resolveFamily(exec.name, exec.arguments)
    if (mapping === undefined || mapping.familyClass !== 'privilege_shift') return downstream
    if (!guard.ledgerOf(exec.agent).anySwallowed()) return downstream
    return {
      kind: 'deny',
      reason: 'blocked by blockade-guard escalation policy: a prior write was silently swallowed, so privilege escalation is not a valid repair; use a different path family',
    }
  })

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const downstream = await next()
    const agent = exec.agent
    if (agent === undefined) return downstream
    if (guard.isInternalProbe(exec.callId)) return downstream
    const mapping = guard.resolveFamily(exec.name, exec.arguments)
    if (mapping === undefined) return downstream

    const ledger = guard.ledgerOf(agent)
    const declaredOk = !result.isError
    const contexts: UserMessage[] = []
    let blockFeedback: string | undefined

    const probes = guard.probesFor(exec.name)
    let ruling: VerdictRuling | undefined
    if (declaredOk && protocols.truthSource && mapping.verification !== 'none'
      && (mapping.verification === 'required' || probes.length > 0)) {
      ruling = composeVerdict(true, await guard.verifyWrite(exec, probes))
    }
    const verdict = declaredOk
      ? (protocols.truthSource ? successVerdict(mapping.verification, ruling) : 'declared_success')
      : 'declared_failure'
    const resultText = renderText(result.content)
    const failureForm = declaredOk
      ? (verdict === 'fake_success' ? 'silent_swallow' as const : undefined)
      : classifyFailure(resultText)
    const fingerprint = failureForm === undefined
      ? undefined
      : failureFingerprint(verdict === 'fake_success'
        ? (ruling?.evidences ?? []).map(evidence => evidence.observed).join(' | ')
        : resultText)
    const progress = declaredOk && (verdict === 'verified_success' || mapping.progressOnSuccess)

    ledger.record({
      tool: exec.name,
      family: mapping.family,
      familyClass: mapping.familyClass,
      pathClass: mapping.pathClass,
      declaredOk,
      verdict,
      failureForm,
      ruling,
      progress,
      ...(fingerprint === undefined ? {} : { failureFingerprint: fingerprint }),
    })

    if (verdict === 'verified_success' || verdict === 'declared_success') {
      if (verdict === 'verified_success' && protocols.lessons) {
        const lesson = extractLesson(ledger)
        if (lesson !== undefined && guard.lessonStore().record(lesson)) {
          agent.session.append('blockade/lesson', { kind: 'blockade/lesson', version: 1, lesson })
        }
      }
      return downstream
    }

    if (verdict === 'fake_success') {
      ledger.exhaust(mapping.family)
      const evidenceDetail = (ruling?.evidences ?? [])
        .map(evidence => `${evidence.probe} (${evidence.independence}) observed ${evidence.observed}`)
        .join('; ')
      if (protocols.carrierSearch && ledger.shouldFire('carrier_search', mapping.family)) {
        contexts.push(directive(
          'carrier_search',
          `Tool ${exec.name} claimed success but the intended effect is absent. ${evidenceDetail}`,
          `carrier search: ${exec.name}`,
        ))
      }
      if (ledger.shouldFire('p2_fake_success', mapping.family)) {
        contexts.push(directive('p2_fake_success', `Tool ${exec.name} claimed success. ${evidenceDetail}`, `fake success: ${mapping.family}`))
      }
      if (options.mode === 'enforce') {
        blockFeedback = `blockade-guard: ${exec.name} reported success but independent verification contradicted it; the result is withheld as a fake success.`
      }
    } else if (verdict === 'unverified' && protocols.truthSource) {
      if (ledger.shouldFire('p3_unverified', exec.name)) {
        contexts.push(directive('p3_unverified', `Tool ${exec.name} has no confirming independent evidence.`, `unverified: ${exec.name}`))
      }
    } else if (failureForm === 'explicit_denial') {
      if (protocols.carrierSearch && ledger.shouldFire('carrier_search', `denial:${mapping.family}`)) {
        contexts.push(directive('carrier_search', `Tool ${exec.name} was denied: ${resultText}`, `carrier search: ${exec.name}`))
      }
      if (protocols.identityGrid && ledger.shouldFire('p4_identity_grid', mapping.family)) {
        contexts.push(directive('p4_identity_grid', `Tool ${exec.name} was denied: ${resultText}`, `identity grid: ${exec.name}`))
      }
    } else if (failureForm === 'target_missing') {
      if (ledger.shouldFire('target_missing', mapping.family)) {
        contexts.push(directive('target_missing', `Tool ${exec.name} could not find or expose the target: ${resultText}`, `target missing: ${exec.name}`))
      }
    } else {
      const repeated = ledger.repeatedFailureDue(mapping.family, options.repeatedFailureLimit)
      const streak = ledger.reframeDue(mapping.family, options.familyFailureLimit)
      if (protocols.reframe && (repeated || streak)) {
        ledger.exhaust(mapping.family)
        if (ledger.shouldFire('p5_reframe', mapping.family)) {
          const reason = repeated
            ? `${ledger.repeatedFailureStreakIn(mapping.family)} repeated identical failures`
            : `${ledger.failureStreakIn(mapping.family)} consecutive failures`
          contexts.push(directive('p5_reframe', `Family ${mapping.family} (${mapping.familyClass}) has ${reason} without progress.`, `reframe: ${mapping.family}`))
        }
      } else if (protocols.dualPath && mapping.pathClass === 'A_direct' && ledger.needsDualPath()) {
        contexts.push(directive('p1_dual_path', `First direct-path failure: ${exec.name}.`, 'dual-path enumeration'))
      }
    }

    if (mapping.familyClass === 'privilege_shift' && protocols.escalationGuard && ledger.anySwallowed()) {
      if (ledger.shouldFire('escalation_forbidden', mapping.family)) {
        contexts.push(directive('escalation_forbidden', `Tool ${exec.name} escalates while a swallowed write remains unresolved.`, `escalation reflex: ${exec.name}`))
      }
    }

    if (contexts.length === 0 && blockFeedback === undefined) return downstream
    const additionalContexts = [...contexts, ...downstream.additionalContexts ?? []]
    if (blockFeedback !== undefined) {
      if (downstream.kind === 'block') return { kind: 'block', feedback: downstream.feedback, additionalContexts }
      return { kind: 'block', feedback: [{ type: 'text', text: blockFeedback }], additionalContexts }
    }
    if (downstream.kind === 'block') return { kind: 'block', feedback: downstream.feedback, additionalContexts }
    return { ...downstream, additionalContexts }
  })
}
