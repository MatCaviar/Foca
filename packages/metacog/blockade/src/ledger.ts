/**
 * Per-agent attempt ledger: family statistics, progress-delimited recovery
 * episodes, exhaustion marks, the escalation guard, and directive throttling.
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

function isFailure(attempt: AttemptRecord): boolean {
  return attempt.verdict === 'declared_failure' || attempt.verdict === 'fake_success'
}

function isSuccess(attempt: AttemptRecord): boolean {
  return attempt.verdict === 'verified_success' || attempt.verdict === 'declared_success'
}

/** One agent's complete blockade bookkeeping. */
export class AgentLedger {
  private readonly stats = new Map<string, FamilyStats>()
  private readonly records: AttemptRecord[] = []
  private readonly firedDirectives = new Set<string>()
  private exhaustedFamilies = new Set<string>()
  private readonly swallowedClasses = new Set<FamilyClass>()
  private dualPathInjected = false
  private lessonRecalled = false

  /** Record one settled attempt and update every derived statistic. */
  record(attempt: AttemptRecord): void {
    this.records.push(attempt)
    const stats = this.statsOf(attempt.family)
    stats.attempts += 1

    if (isFailure(attempt)) {
      stats.failures += 1
      stats.failureStreak += 1
      if (attempt.failureFingerprint !== undefined) {
        stats.repeatedFailureStreak = attempt.failureFingerprint === stats.lastFailureFingerprint
          ? stats.repeatedFailureStreak + 1
          : 1
        stats.lastFailureFingerprint = attempt.failureFingerprint
      } else {
        stats.repeatedFailureStreak = 0
        stats.lastFailureFingerprint = undefined
      }
      if (attempt.verdict === 'fake_success') {
        stats.swallowed = true
        this.swallowedClasses.add(attempt.familyClass)
      }
      return
    }

    if (isSuccess(attempt)) {
      this.resetFamilyStreak(stats)
      if (attempt.progress) this.markProgress()
    }
  }

  /** All attempts in settlement order. */
  attempts(): readonly AttemptRecord[] {
    return this.records
  }

  /** Total failure count in one family. */
  failuresIn(family: string): number {
    return this.stats.get(family)?.failures ?? 0
  }

  /** Consecutive failures in one family since its last success or global progress. */
  failureStreakIn(family: string): number {
    return this.stats.get(family)?.failureStreak ?? 0
  }

  /** Consecutive failures with an identical normalized outcome. */
  repeatedFailureStreakIn(family: string): number {
    return this.stats.get(family)?.repeatedFailureStreak ?? 0
  }

  /** Whether any attempt in the family was ruled a swallowed write. */
  familySwallowed(family: string): boolean {
    return this.stats.get(family)?.swallowed ?? false
  }

  /** Whether any family class has recorded a swallowed write. */
  anySwallowed(): boolean {
    return this.swallowedClasses.size > 0
  }

  /** Mark a family as exhausted. */
  exhaust(family: string): void {
    this.exhaustedFamilies.add(family)
  }

  /** Whether the family was marked exhausted. */
  isExhausted(family: string): boolean {
    return this.exhaustedFamilies.has(family)
  }

  /** Whether a family has reached the consecutive-failure reframe threshold. */
  reframeDue(family: string, limit: number): boolean {
    return this.failureStreakIn(family) >= limit
  }

  /** Whether an identical failure has repeated often enough to cut off early. */
  repeatedFailureDue(family: string, limit: number): boolean {
    return this.repeatedFailureStreakIn(family) >= limit
  }

  /** Fire-once gate for a directive keyed by kind plus scope. */
  shouldFire(kind: DirectiveKind, scope: string): boolean {
    const key = `${kind}:${scope}`
    if (this.firedDirectives.has(key)) return false
    this.firedDirectives.add(key)
    return true
  }

  /** Whether the protocol-1 dual-path directive has not fired yet. */
  needsDualPath(): boolean {
    if (this.dualPathInjected) return false
    this.dualPathInjected = true
    return true
  }

  /** Whether the protocol-6 lesson recall has not fired yet. */
  needsLessonRecall(): boolean {
    if (this.lessonRecalled) return false
    this.lessonRecalled = true
    return true
  }

  /** Families that failed inside the current recovery episode. */
  failedFamilies(): Map<string, { familyClass: FamilyClass; swallowed: boolean }> {
    const failed = new Map<string, { familyClass: FamilyClass; swallowed: boolean }>()
    for (const record of this.currentEpisode()) {
      if (!isFailure(record)) continue
      failed.set(record.family, { familyClass: record.familyClass, swallowed: record.verdict === 'fake_success' })
    }
    return failed
  }

  /** Every settled verdict, for breakthrough detection. */
  verdicts(): readonly AttemptRecord['verdict'][] {
    return this.records.map(record => record.verdict)
  }

  /** Attempts since the previous progress-producing success. */
  currentEpisode(): readonly AttemptRecord[] {
    if (this.records.length === 0) return []
    const end = this.records.length - 1
    for (let index = end - 1; index >= 0; index -= 1) {
      const record = this.records[index]
      if (record !== undefined && isSuccess(record) && record.progress) {
        return this.records.slice(index + 1)
      }
    }
    return this.records
  }

  private markProgress(): void {
    for (const stats of this.stats.values()) this.resetFamilyStreak(stats)
    this.exhaustedFamilies.clear()
  }

  private resetFamilyStreak(stats: FamilyStats): void {
    stats.failureStreak = 0
    stats.repeatedFailureStreak = 0
    stats.lastFailureFingerprint = undefined
  }

  private statsOf(family: string): FamilyStats {
    let stats = this.stats.get(family)
    if (stats === undefined) {
      stats = {
        failures: 0,
        attempts: 0,
        failureStreak: 0,
        repeatedFailureStreak: 0,
        lastFailureFingerprint: undefined,
        swallowed: false,
      }
      this.stats.set(family, stats)
    }
    return stats
  }
}

/** Ledger registry keyed by live agent; entries die with the agent. */
export class LedgerRegistry {
  private readonly ledgers = new WeakMap<Agent, AgentLedger>()

  /** The lazily created ledger of one agent. */
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
 * Extract a lesson from the current recovery episode after a verified
 * breakthrough through a different family class.
 */
export function extractLesson(ledger: AgentLedger): Lesson | undefined {
  const attempts = ledger.currentEpisode()
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

  return {
    avoidClasses: [...avoidClasses],
    workedClass: last.familyClass,
    forms: [...forms],
    summary: `writes via ${[...avoidClasses].join('/')} failed (${[...forms].join(', ') || 'failures'}); the verified path was ${last.familyClass}`,
  }
}
