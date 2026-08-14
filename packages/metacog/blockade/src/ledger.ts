/**
 * Per-agent attempt ledger: family statistics, exhaustion marks, the
 * escalation guard, and directive throttling. Pure bookkeeping over
 * {@link AttemptRecord}s; the plugin owns one ledger per live agent.
 * @module @deepseek-ai/dsh-blockade
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AttemptRecord,
  DirectiveKind,
  FailureForm,
  FamilyClass,
  FamilyStats,
  Lesson,
} from './domain.ts'

/** One agent's complete blockade bookkeeping. */
export class AgentLedger {
  private readonly stats = new Map<string, FamilyStats>()
  private readonly records: AttemptRecord[] = []
  private readonly firedDirectives = new Set<string>()
  private exhaustedFamilies = new Set<string>()
  /** Classes whose writes were swallowed — targets of the escalation guard. */
  private readonly swallowedClasses = new Set<FamilyClass>()
  private dualPathInjected = false
  private lessonRecalled = false

  /**
   * Record one settled attempt and update every derived statistic.
   * @param attempt - the settled attempt to append.
   */
  record(attempt: AttemptRecord): void {
    this.records.push(attempt)
    const stats = this.statsOf(attempt.family)
    stats.attempts += 1
    if (attempt.verdict === 'declared_failure' || attempt.verdict === 'fake_success') stats.failures += 1
    if (attempt.verdict === 'fake_success') {
      stats.swallowed = true
      this.swallowedClasses.add(attempt.familyClass)
    }
  }

  /**
   * All attempts in settlement order.
   * @returns the recorded attempts, oldest first.
   */
  attempts(): readonly AttemptRecord[] {
    return this.records
  }

  /**
   * Failure count (declared failures plus fake successes) in one family.
   * @param family - the semantic family id.
   * @returns how many attempts in the family failed either way.
   */
  failuresIn(family: string): number {
    return this.stats.get(family)?.failures ?? 0
  }

  /**
   * Whether any attempt in the family was ruled a swallowed write.
   * @param family - the semantic family id.
   * @returns true once a fake success was ruled in the family.
   */
  familySwallowed(family: string): boolean {
    return this.stats.get(family)?.swallowed ?? false
  }

  /**
   * Whether escalating privileges is forbidden: some family already had a
   * write swallowed. Escalation cannot repair a swallowed write, so the
   * guard blocks the reflex instead of arguing it.
   */
  /**
   * Whether escalating privileges is forbidden: some family already had a
   * write swallowed.
   * @returns true after the first fake success in any family.
   */
  anySwallowed(): boolean {
    return this.swallowedClasses.size > 0
  }

  /**
   * Mark a family as exhausted: further variants would deepen a dead end.
   * @param family - the semantic family id.
   */
  exhaust(family: string): void {
    this.exhaustedFamilies.add(family)
  }

  /**
   * Whether the family was marked exhausted.
   * @param family - the semantic family id.
   * @returns true once {@link AgentLedger.exhaust} marked the family.
   */
  isExhausted(family: string): boolean {
    return this.exhaustedFamilies.has(family)
  }

  /**
   * Whether a family has hit the reframe threshold: `limit` or more failures
   * without any success. The trigger pauses deepening and forces the
   * dual-path enumeration.
   */
  /**
   * Whether a family has hit the reframe threshold.
   * @param family - the semantic family id.
   * @param limit - same-family failures before the trigger fires.
   * @returns true when the family's failure count reached the limit.
   */
  reframeDue(family: string, limit: number): boolean {
    return this.failuresIn(family) >= limit
  }

  /**
   * Fire-once gate for a directive keyed by kind plus scope (family or tool).
   * @param kind - the directive kind.
   * @param scope - the family or tool the directive is scoped to.
   * @returns true exactly once per (kind, scope) pair.
   */
  shouldFire(kind: DirectiveKind, scope: string): boolean {
    const key = `${kind}:${scope}`
    if (this.firedDirectives.has(key)) return false
    this.firedDirectives.add(key)
    return true
  }

  /**
   * Whether the protocol-1 dual-path directive has not fired yet.
   * @returns true exactly once per agent.
   */
  needsDualPath(): boolean {
    if (this.dualPathInjected) return false
    this.dualPathInjected = true
    return true
  }

  /**
   * Whether the protocol-6 lesson recall has not fired yet.
   * @returns true exactly once per agent.
   */
  needsLessonRecall(): boolean {
    if (this.lessonRecalled) return false
    this.lessonRecalled = true
    return true
  }

  /**
   * Families that recorded at least one failure, for lesson extraction.
   * @returns family id to its class and whether it swallowed a write.
   */
  failedFamilies(): Map<string, { familyClass: FamilyClass; swallowed: boolean }> {
    const failed = new Map<string, { familyClass: FamilyClass; swallowed: boolean }>()
    for (const record of this.records) {
      if (record.verdict !== 'declared_failure' && record.verdict !== 'fake_success') continue
      failed.set(record.family, { familyClass: record.familyClass, swallowed: record.verdict === 'fake_success' })
    }
    return failed
  }

  /**
   * Every settled verdict, for breakthrough detection.
   * @returns verdicts in settlement order.
   */
  verdicts(): readonly (AttemptRecord['verdict'])[] {
    return this.records.map(record => record.verdict)
  }

  private statsOf(family: string): FamilyStats {
    let stats = this.stats.get(family)
    if (stats === undefined) {
      stats = { failures: 0, attempts: 0, swallowed: false }
      this.stats.set(family, stats)
    }
    return stats
  }
}

/** Ledger registry keyed by live agent; entries die with the agent (WeakMap). */
export class LedgerRegistry {
  private readonly ledgers = new WeakMap<Agent, AgentLedger>()

  /**
   * The (lazily created) ledger of one agent.
   * @param agent - the live agent owning the ledger.
   * @returns the agent's ledger, created on first access.
   */
  of(agent: Agent): AgentLedger {
    let ledger = this.ledgers.get(agent)
    if (ledger === undefined) {
      ledger = new AgentLedger()
      this.ledgers.set(agent, ledger)
    }
    return ledger
  }
}

/**
 * Extract a lesson from a ledger whose latest attempt was a verified
 * breakthrough (protocol 6). A lesson exists only when the breakthrough
 * arrived through a different family class than the failed ones — a
 * same-class rescue carries no transferable reframe.
 * @param ledger - the agent ledger after a verified success.
 * @returns the lesson, or undefined when nothing transferable happened.
 */
export function extractLesson(ledger: AgentLedger): Lesson | undefined {
  const attempts = ledger.attempts()
  const last = attempts[attempts.length - 1]
  if (last === undefined || last.verdict !== 'verified_success') return undefined
  const failed = ledger.failedFamilies()
  const avoidClasses = new Set<FamilyClass>()
  const forms = new Set<FailureForm>()
  for (const [family, info] of failed) {
    if (family === last.family) continue
    avoidClasses.add(info.familyClass)
    for (const record of attempts) {
      if (record.family === family && record.failureForm !== undefined) forms.add(record.failureForm)
    }
  }
  if (avoidClasses.size === 0 || avoidClasses.has(last.familyClass)) return undefined
  const worked = last.familyClass
  return {
    avoidClasses: [...avoidClasses],
    workedClass: worked,
    forms: [...forms],
    summary: `writes via ${[...avoidClasses].join('/')} failed (${[...forms].join(', ') || 'failures'}); the verified path was ${worked}`,
  }
}
