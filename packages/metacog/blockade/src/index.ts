/**
 * Blockade guard: internalized metacognition for blocked agents. One plugin
 * turns the four deadlock mechanisms recorded in the blockade postmortems
 * (frame lock, terminal misattribution, missing switch trigger, trusted
 * declared success) into fixed runtime behavior:
 *
 * - protocol 1 (dual-path enumeration) — the first direct-path failure injects
 *   the requirement to enumerate BOTH direct and user-equivalent paths;
 * - protocol 2 (failure-form classifier) — every failure is classified, and a
 *   verified silent swallow maps to "switch family, escalation forbidden";
 * - protocol 3 (truth source) — declared successes on mapped writes are
 *   downgraded to claims and verified through configured independent probe
 *   tools, graded by evidence independence;
 * - protocol 4 (identity grid) — an explicit denial injects the identity
 *   dimension enumeration instead of accepting "no permission" as terminal;
 * - protocol 5 (reframe trigger) — `familyFailureLimit` failures in one
 *   semantic family pause deepening and force the dual-path enumeration;
 * - protocol 6 (lesson internalization) — a verified breakthrough after
 *   failures in other classes commits a lesson, logged durably and recalled
 *   into later sessions in this deployment.
 *
 * Advisory mode only injects contexts; enforce mode additionally blocks fake
 * successes and denies post-swallow escalation calls. Every directive is
 * model-visible and therefore logged (a `user/message` with a plugin source).
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
import type { Evidence, VerdictRuling } from './domain.ts'
import type {
  DirectiveKind,
  FamilyClass,
  Independence,
  PathClass,
} from './domain.ts'
import { directiveText } from './domain.ts'
import { AgentLedger, LedgerRegistry, extractLesson } from './ledger.ts'
import { BlockadeLessonStore } from './lessons.ts'

export type {
  AttemptRecord,
  DirectiveKind,
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
export { directiveMarker, directiveText } from './domain.ts'
export { classifyFailure, composeVerdict } from './classify.ts'
export { AgentLedger, extractLesson } from './ledger.ts'
export { BlockadeLessonStore } from './lessons.ts'

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
}

/**
 * One probe mapping row. The probe tool must accept the mapped arguments and
 * return a JSON value with an optional boolean `agrees` plus an `observed`
 * account; an erroring probe contributes uncommitted evidence only.
 */
export interface ProbeEntry {
  /** `*`-wildcard patterns over write tool names this probe verifies. */
  writes: string[]
  /** The probe tool invoked to verify a matched write. */
  tool: string
  /** Independence grade of the channel this probe provides. */
  independence: Independence
  /** probe argument name → write-call argument name, as explicit pairs. */
  argumentMap: ArgumentMapping[]
}

/** One probe-argument to write-argument mapping pair. */
export interface ArgumentMapping {
  /** The argument name the probe tool accepts. */
  probe: string
  /** The argument name on the verified write call. */
  write: string
}

/** Per-protocol switches; every ablation flips exactly one. */
export interface ProtocolSwitches {
  /** Protocol 1: dual-path enumeration directive on the first direct-path failure. */
  dualPath?: boolean
  /** Protocols 2+3: probe-verified truth rulings and their steering. */
  truthSource?: boolean
  /** Protocol 4: identity-grid directive on explicit denials. */
  identityGrid?: boolean
  /** Protocol 5: reframe trigger at the family failure limit. */
  reframe?: boolean
  /** Protocol 6: lesson commit on breakthroughs and recall at session start. */
  lessons?: boolean
  /** Protocol 2 guard: forbid escalation after a swallowed write. */
  escalationGuard?: boolean
}

/** Plugin configuration: family and probe mappings plus per-protocol switches. */
export interface Config {
  /** Same-family failures before the reframe trigger fires (default 3). */
  familyFailureLimit?: number
  /** `advisory` injects contexts only; `enforce` also blocks/denies (default `advisory`). */
  mode?: 'advisory' | 'enforce'
  /** Tool-to-family mappings; unmapped tools run transparent. */
  families?: FamilyEntry[]
  /** Write-to-probe mappings powering truth rulings. */
  probes?: ProbeEntry[]
  /** Per-protocol switches; every ablation flips exactly one. */
  protocols?: ProtocolSwitches
}

export const Config: z<Config> = z.object({
  familyFailureLimit: z.natural().min(1).default(3),
  mode: z.union(['advisory', 'enforce'] as const).default('advisory'),
  families: z.array(z.object({
    tools: z.array(z.string()),
    family: z.string(),
    familyClass: z.union(['direct_write', 'user_equivalent_input', 'official_entry', 'privilege_shift', 'env_setup'] as const),
    pathClass: z.union(['A_direct', 'B_user_equivalent', 'C_identity_shift', 'D_reverse_engineer'] as const),
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
    identityGrid: z.boolean().default(true),
    reframe: z.boolean().default(true),
    lessons: z.boolean().default(true),
    escalationGuard: z.boolean().default(true),
  }).default({ dualPath: true, truthSource: true, identityGrid: true, reframe: true, lessons: true, escalationGuard: true }),
})

/** Resolved plugin configuration after schemastery defaults. */
export interface ResolvedConfig {
  readonly familyFailureLimit: number
  readonly mode: 'advisory' | 'enforce'
  readonly families: readonly FamilyEntry[]
  readonly probes: readonly ProbeEntry[]
  readonly protocols: Required<ProtocolSwitches>
}

const FAMILY_CLASSES: readonly FamilyClass[] = ['direct_write', 'user_equivalent_input', 'official_entry', 'privilege_shift', 'env_setup']
const PATH_CLASSES: readonly PathClass[] = ['A_direct', 'B_user_equivalent', 'C_identity_shift', 'D_reverse_engineer']
const INDEPENDENCES: readonly Independence[] = ['actuator_store', 'independent', 'ground_truth']

/** The plugin's source stamp on every injected context. */
const GUARD_SOURCE_KIND = 'plugin' as const
/** The plugin name stamped on every injected context. */
export const GUARD_PLUGIN_NAME = 'blockade-guard'

function renderText(content: readonly { type: string; text?: string }[]): string {
  return content.map(block => block.type === 'text' ? (block.text ?? '') : `[${block.type}]`).join('\n')
}

/** The service face: ledger registry plus the cross-session lesson store. */
export class BlockadeGuard extends Service {
  private readonly ledgers = new LedgerRegistry()
  private readonly lessons = new BlockadeLessonStore()
  private readonly familyMatchers: readonly { pattern: RegExp; entry: FamilyEntry }[]
  private readonly probeMatchers: readonly { pattern: RegExp; entry: ProbeEntry }[]

  constructor(ctx: Context, readonly options: ResolvedConfig) {
    super(ctx, 'blockadeGuard')
    this.familyMatchers = options.families.map(entry => ({
      pattern: compileFirstMatch(entry.tools),
      entry,
    }))
    this.probeMatchers = options.probes.map(entry => ({
      pattern: compileFirstMatch(entry.writes),
      entry,
    }))
  }

  /**
   * The lesson store, for operators and experiment runners.
   * @returns the cross-session lesson store.
   */
  lessonStore(): BlockadeLessonStore {
    return this.lessons
  }

  /**
   * One agent's ledger; read-only introspection for tests and reports.
   * @param agent - the live agent owning the ledger.
   * @returns the agent's attempt ledger.
   */
  ledgerOf(agent: Agent): AgentLedger {
    return this.ledgers.of(agent)
  }

  /**
   * First family row matching a tool name, or undefined for transparent tools.
   * @param tool - the tool name to resolve.
   * @returns the first matching family row, or undefined when unmapped.
   */
  familyOf(tool: string): FamilyEntry | undefined {
    for (const { pattern, entry } of this.familyMatchers) {
      if (pattern.test(tool)) return entry
    }
    return undefined
  }

  /**
   * Every probe row whose write patterns match a tool name.
   * @param tool - the write tool name to resolve.
   * @returns every probe row mapped to the tool.
   */
  probesFor(tool: string): readonly ProbeEntry[] {
    return this.probeMatchers.filter(({ pattern }) => pattern.test(tool)).map(({ entry }) => entry)
  }

  /**
   * Run every probe mapped to one settled write call and collect graded
   * evidence. A probe error contributes an observation without agreement.
   * @param exec - the settled write execution to verify.
   * @returns the graded evidence from every mapped probe.
   */
  async verifyWrite(exec: ToolExecution): Promise<readonly Evidence[]> {
    const evidences: Evidence[] = []
    const writeArgs = (exec.arguments ?? {}) as Record<string, unknown>
    for (const probe of this.probesFor(exec.name)) {
      const args: Record<string, unknown> = {}
      for (const mapping of probe.argumentMap) {
        args[mapping.probe] = writeArgs[mapping.write]
      }
      const result = await this.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`blockade-probe-${crypto.randomUUID()}`),
        name: probe.tool,
        arguments: args,
      })
      if (result.isError) {
        evidences.push({ probe: probe.tool, independence: probe.independence, observed: renderText(result.content) })
        continue
      }
      const value = (result.value ?? {}) as Record<string, unknown>
      const agrees = typeof value.agrees === 'boolean' ? value.agrees : undefined
      evidences.push({
        probe: probe.tool,
        independence: probe.independence,
        ...(agrees === undefined ? {} : { agrees }),
        observed: typeof value.observed === 'string' ? value.observed : JSON.stringify(value),
      })
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

/** Fail-loud validation of the resolved configuration, at plugin load. */
function validateConfig(config: ResolvedConfig): void {
  if (!Number.isInteger(config.familyFailureLimit) || config.familyFailureLimit < 1) {
    throw new Error(`blockade-guard: invalid familyFailureLimit ${String(config.familyFailureLimit)} — must be an integer >= 1`)
  }
  const familyConsistency = new Map<string, { familyClass: FamilyClass; pathClass: PathClass }>()
  for (const entry of config.families) {
    if (!FAMILY_CLASSES.includes(entry.familyClass)) {
      throw new Error(`blockade-guard: unknown familyClass ${entry.familyClass} in family ${entry.family}`)
    }
    if (!PATH_CLASSES.includes(entry.pathClass)) {
      throw new Error(`blockade-guard: unknown pathClass ${entry.pathClass} in family ${entry.family}`)
    }
    if (entry.tools.length === 0) {
      throw new Error(`blockade-guard: family ${entry.family} maps no tools`)
    }
    const prior = familyConsistency.get(entry.family)
    if (prior !== undefined && (prior.familyClass !== entry.familyClass || prior.pathClass !== entry.pathClass)) {
      throw new Error(`blockade-guard: family ${entry.family} declared with conflicting semantics`)
    }
    familyConsistency.set(entry.family, { familyClass: entry.familyClass, pathClass: entry.pathClass })
  }
  for (const probe of config.probes) {
    if (!INDEPENDENCES.includes(probe.independence)) {
      throw new Error(`blockade-guard: unknown independence ${probe.independence} in probe ${probe.tool}`)
    }
    if (probe.writes.length === 0) {
      throw new Error(`blockade-guard: probe ${probe.tool} verifies no tools`)
    }
    if (Object.keys(probe.argumentMap).length === 0) {
      throw new Error(`blockade-guard: probe ${probe.tool} maps no arguments`)
    }
  }
}

/** Compile a first-match-wins alternation over wildcard patterns. */
function compileFirstMatch(patterns: readonly string[]): RegExp {
  return new RegExp(`(?:${patterns.map((pattern) => {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
    return escaped.replaceAll('*', '.*')
  }).join('|')})`)
}

function directiveMessage(kind: DirectiveKind, detail: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: directiveText(kind, detail) }],
    source: {
      kind: GUARD_SOURCE_KIND,
      plugin: GUARD_PLUGIN_NAME,
      form: 'notice',
      summary: summary.slice(0, 120),
    },
  })
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - schemastery-resolved configuration, re-validated fail-loud.
 */
export function apply(ctx: Context, config: Config): void {
  const options: ResolvedConfig = {
    familyFailureLimit: config.familyFailureLimit ?? 3,
    mode: config.mode ?? 'advisory',
    families: config.families ?? [],
    probes: config.probes ?? [],
    protocols: {
      dualPath: config.protocols?.dualPath ?? true,
      truthSource: config.protocols?.truthSource ?? true,
      identityGrid: config.protocols?.identityGrid ?? true,
      reframe: config.protocols?.reframe ?? true,
      lessons: config.protocols?.lessons ?? true,
      escalationGuard: config.protocols?.escalationGuard ?? true,
    },
  }
  validateConfig(options)
  const guard = new BlockadeGuard(ctx, options)
  const { protocols } = options

  // Protocol 6, recall half: at session start, prior lessons for the
  // deployment's mapped families become model-visible defaults.
  ctx.on('agent/session-start', ({ agent }) => {
    if (!protocols.lessons) return
    const ledger = guard.lessonStore()
    const classes = [...new Set(options.families.map(entry => entry.familyClass))]
    const relevant = ledger.relevantTo(classes)
    if (relevant.length === 0) return
    if (!guard.ledgerOf(agent).needsLessonRecall()) return
    agent.inject(directiveMessage('p6_lesson_recall', BlockadeLessonStore.render(relevant), `recall: ${relevant.length} lessons`))
  })

  // Protocol 2, enforce half of the escalation guard: deny a privilege-shift
  // call once any family had a write swallowed. Escalation cannot repair a
  // swallowed write; the deny reason deliberately avoids denial markers so the
  // failed attempt classifies as an ordinary error, not a new identity wall.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    if (options.mode !== 'enforce' || !protocols.escalationGuard || !exec.agent) return downstream
    const mapping = guard.familyOf(exec.name)
    if (mapping === undefined || mapping.familyClass !== 'privilege_shift') return downstream
    if (!guard.ledgerOf(exec.agent).anySwallowed()) return downstream
    return {
      kind: 'deny',
      reason: 'blocked by blockade-guard escalation policy: a write in another family was silently swallowed, and escalation cannot repair that; route the effort to a different path family',
    }
  })

  // The main pipeline: verify declared writes (protocol 3), classify failures
  // (protocol 2), fire the reframe trigger (protocol 5), enumerate identities
  // on explicit denials (protocol 4), seed dual-path enumeration on the first
  // direct-path failure (protocol 1), and commit breakthrough lessons
  // (protocol 6, record half).
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const downstream = await next()
    const agent = exec.agent
    if (agent === undefined) return downstream
    const mapping = guard.familyOf(exec.name)
    if (mapping === undefined) return downstream
    const ledger = guard.ledgerOf(agent)
    const declaredOk = !result.isError
    const contexts: UserMessage[] = []
    let blockFeedback: string | undefined

    let ruling: VerdictRuling | undefined
    if (declaredOk && protocols.truthSource) {
      const evidences = await guard.verifyWrite(exec)
      ruling = composeVerdict(true, evidences)
    }
    const verdict = ruling?.verdict ?? (declaredOk ? 'unverified' as const : 'declared_failure' as const)
    const failureForm = declaredOk
      ? (verdict === 'fake_success' ? 'silent_swallow' as const : undefined)
      : classifyFailure(renderText(result.content))

    ledger.record({
      tool: exec.name,
      family: mapping.family,
      familyClass: mapping.familyClass,
      pathClass: mapping.pathClass,
      declaredOk,
      verdict,
      failureForm,
      ruling,
    })

    if (verdict === 'verified_success') {
      if (protocols.lessons) {
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
      if (ledger.shouldFire('p2_fake_success', mapping.family)) {
        contexts.push(directiveMessage(
          'p2_fake_success',
          `Tool ${exec.name} claimed success. ${evidenceDetail}`,
          `fake success in ${mapping.family}`,
        ))
      }
      if (options.mode === 'enforce') {
        blockFeedback = `blockade-guard: ${exec.name} reported success but independent verification contradicts it; the result is withheld as a fake success.`
      }
    } else if (verdict === 'unverified' && protocols.truthSource) {
      if (ledger.shouldFire('p3_unverified', exec.name)) {
        contexts.push(directiveMessage(
          'p3_unverified',
          `Tool ${exec.name} claimed success and no independent channel confirms the effect.`,
          `unverified: ${exec.name}`,
        ))
      }
    } else if (failureForm === 'explicit_denial') {
      if (protocols.identityGrid && ledger.shouldFire('p4_identity_grid', mapping.family)) {
        contexts.push(directiveMessage(
          'p4_identity_grid',
          `Tool ${exec.name} was denied: ${renderText(result.content)}`,
          `denial grid: ${exec.name}`,
        ))
      }
    } else if (failureForm === 'target_missing') {
      if (ledger.shouldFire('target_missing', mapping.family)) {
        contexts.push(directiveMessage(
          'p5_reframe',
          `Tool ${exec.name} reports the target itself is not exposed. Recovering the contract needs reverse engineering or an operator decision; enumerate what interfaces exist before more attempts.`,
          `target missing: ${exec.name}`,
        ))
      }
    } else {
      // Ordinary declared error: the reframe trigger at the family limit,
      // and the one-time dual-path seeding on the first direct-path failure.
      if (protocols.reframe && ledger.reframeDue(mapping.family, options.familyFailureLimit)) {
        ledger.exhaust(mapping.family)
        if (ledger.shouldFire('p5_reframe', mapping.family)) {
          contexts.push(directiveMessage(
            'p5_reframe',
            `Family ${mapping.family} (${mapping.familyClass}) has ${ledger.failuresIn(mapping.family)} failed attempts.`,
            `reframe: ${mapping.family} × ${ledger.failuresIn(mapping.family)}`,
          ))
        }
      } else if (protocols.dualPath && mapping.pathClass === 'A_direct' && ledger.needsDualPath()) {
        contexts.push(directiveMessage(
          'p1_dual_path',
          `First direct-invocation failure: ${exec.name}.`,
          'dual-path enumeration',
        ))
      }
    }

    // Advisory escalation nudge: the call went through, but it was the wrong
    // default after a swallow.
    if (mapping.familyClass === 'privilege_shift' && protocols.escalationGuard && ledger.anySwallowed()) {
      if (ledger.shouldFire('escalation_forbidden', mapping.family)) {
        contexts.push(directiveMessage(
          'escalation_forbidden',
          `Tool ${exec.name} escalates privileges while a swallowed write is unresolved.`,
          `escalation reflex: ${exec.name}`,
        ))
      }
    }

    if (contexts.length === 0 && blockFeedback === undefined) return downstream
    const additionalContexts = [...contexts, ...downstream.additionalContexts ?? []]
    if (blockFeedback !== undefined) {
      if (downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts }
      }
      return { kind: 'block', feedback: [{ type: 'text', text: blockFeedback }], additionalContexts }
    }
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts }
    }
    return { ...downstream, additionalContexts }
  })
}
