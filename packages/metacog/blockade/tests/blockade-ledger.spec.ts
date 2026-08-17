import { describe, expect, it } from 'vitest'
import { AgentLedger, BlockadeLessonStore, extractLesson } from '@deepseek-ai/dsh-blockade'
import type { AttemptRecord } from '@deepseek-ai/dsh-blockade'

function attempt(over: Partial<AttemptRecord> & Pick<AttemptRecord, 'family' | 'familyClass' | 'verdict'>): AttemptRecord {
  return {
    tool: 'tool',
    pathClass: 'A_direct',
    declaredOk: true,
    failureForm: undefined,
    ruling: undefined,
    progress: false,
    ...over,
  }
}

describe('AgentLedger', () => {
  it('counts failures but triggers on the consecutive streak', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    expect(ledger.reframeDue('a', 3)).toBe(false)
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'fake_success', failureForm: 'silent_swallow' }))
    expect(ledger.reframeDue('a', 3)).toBe(true)
    expect(ledger.failuresIn('a')).toBe(3)
    expect(ledger.failureStreakIn('a')).toBe(3)
  })

  it('global progress resets stale failure streaks and exhausted families', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'test', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'test', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.exhaust('test')
    ledger.record(attempt({ family: 'file:src', familyClass: 'direct_write', verdict: 'declared_success', progress: true }))
    expect(ledger.failureStreakIn('test')).toBe(0)
    expect(ledger.isExhausted('test')).toBe(false)
    expect(ledger.failuresIn('test')).toBe(2)
  })

  it('a non-progress success resets only its own family streak', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'test', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'inspect', familyClass: 'direct_write', verdict: 'declared_success', progress: false }))
    expect(ledger.failureStreakIn('test')).toBe(1)
    ledger.record(attempt({ family: 'test', familyClass: 'direct_write', verdict: 'declared_success', progress: false }))
    expect(ledger.failureStreakIn('test')).toBe(0)
  })

  it('detects repeated identical failures before the broad family limit', () => {
    const ledger = new AgentLedger()
    for (let index = 0; index < 2; index += 1) {
      ledger.record(attempt({
        family: 'shell:test',
        familyClass: 'direct_write',
        verdict: 'declared_failure',
        declaredOk: false,
        failureFingerprint: 'pytest assertion <path>:<n>',
      }))
    }
    expect(ledger.repeatedFailureDue('shell:test', 2)).toBe(true)
    expect(ledger.reframeDue('shell:test', 3)).toBe(false)
  })

  it('a changed failure signature restarts the identical-failure streak', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'shell:test', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false, failureFingerprint: 'a' }))
    ledger.record(attempt({ family: 'shell:test', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false, failureFingerprint: 'b' }))
    expect(ledger.repeatedFailureStreakIn('shell:test')).toBe(1)
    expect(ledger.failureStreakIn('shell:test')).toBe(2)
  })

  it('a fake success marks the family swallowed and arms the escalation guard', () => {
    const ledger = new AgentLedger()
    expect(ledger.anySwallowed()).toBe(false)
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'fake_success', failureForm: 'silent_swallow' }))
    expect(ledger.anySwallowed()).toBe(true)
    expect(ledger.familySwallowed('a')).toBe(true)
  })

  it('fires a directive kind once per scope', () => {
    const ledger = new AgentLedger()
    expect(ledger.shouldFire('p2_fake_success', 'family-a')).toBe(true)
    expect(ledger.shouldFire('p2_fake_success', 'family-a')).toBe(false)
    expect(ledger.shouldFire('p2_fake_success', 'family-b')).toBe(true)
  })
})

describe('extractLesson', () => {
  it('extracts a cross-class lesson from the current recovery episode', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ tool: 'adjust', family: 'std', familyClass: 'direct_write', verdict: 'fake_success', failureForm: 'silent_swallow' }))
    ledger.record(attempt({ tool: 'key', family: 'input', familyClass: 'user_equivalent_input', verdict: 'declared_failure', declaredOk: false, failureForm: 'explicit_denial' }))
    ledger.record(attempt({ tool: 'key-shell', family: 'input', familyClass: 'user_equivalent_input', verdict: 'verified_success', progress: true }))
    const lesson = extractLesson(ledger)
    expect(lesson?.avoidClasses).toEqual(['direct_write'])
    expect(lesson?.workedClass).toBe('user_equivalent_input')
    expect(lesson?.forms).toContain('silent_swallow')
  })

  it('does not mix failures from an earlier completed episode', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'old', familyClass: 'privilege_shift', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'checkpoint', familyClass: 'official_entry', verdict: 'declared_success', progress: true }))
    ledger.record(attempt({ family: 'direct', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'user', familyClass: 'user_equivalent_input', verdict: 'verified_success', progress: true }))
    expect(extractLesson(ledger)?.avoidClasses).toEqual(['direct_write'])
  })

  it('a same-class rescue carries no transferable reframe', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'b', familyClass: 'direct_write', verdict: 'verified_success', progress: true }))
    expect(extractLesson(ledger)).toBeUndefined()
  })
})

describe('BlockadeLessonStore', () => {
  it('collapses duplicates and retrieves at family-class level', () => {
    const store = new BlockadeLessonStore()
    const lesson = {
      avoidClasses: ['direct_write' as const],
      workedClass: 'user_equivalent_input' as const,
      forms: ['silent_swallow' as const],
      summary: 's',
    }
    expect(store.record(lesson)).toBe(true)
    expect(store.record({ ...lesson, summary: 's2' })).toBe(false)
    expect(store.relevantTo(['direct_write'])).toHaveLength(1)
    expect(store.relevantTo(['official_entry'])).toHaveLength(0)
  })
})
