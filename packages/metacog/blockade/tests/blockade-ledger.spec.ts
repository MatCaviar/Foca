import { describe, expect, it } from 'vitest'
import { AgentLedger, BlockadeLessonStore, extractLesson } from '@deepseek-ai/dsh-blockade'
import type { AttemptRecord } from '@deepseek-ai/dsh-blockade'

/** Ledger bookkeeping, reframe triggers, and lesson behavior. */

function attempt(over: Partial<AttemptRecord> & Pick<AttemptRecord, 'family' | 'familyClass' | 'verdict'>): AttemptRecord {
  return {
    tool: 'tool',
    pathClass: 'A_direct',
    declaredOk: true,
    failureForm: undefined,
    ruling: undefined,
    ...over,
  }
}

describe('AgentLedger', () => {
  it('counts declared failures and fake successes alike toward the reframe trigger', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    expect(ledger.reframeDue('a', 3)).toBe(false)
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'fake_success', failureForm: 'silent_swallow' }))
    expect(ledger.reframeDue('a', 3)).toBe(true)
    expect(ledger.failuresIn('a')).toBe(3)
  })

  it('a fake success marks the family swallowed and arms the escalation guard', () => {
    const ledger = new AgentLedger()
    expect(ledger.anySwallowed()).toBe(false)
    ledger.record(attempt({ family: 'a', familyClass: 'direct_write', verdict: 'fake_success', failureForm: 'silent_swallow' }))
    expect(ledger.anySwallowed()).toBe(true)
    expect(ledger.familySwallowed('a')).toBe(true)
  })

  it('a verified success does not count as a family failure', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'a', familyClass: 'official_entry', verdict: 'verified_success' }))
    expect(ledger.failuresIn('a')).toBe(0)
  })

  it('fires a directive kind once per scope and never again', () => {
    const ledger = new AgentLedger()
    expect(ledger.shouldFire('p2_fake_success', 'family-a')).toBe(true)
    expect(ledger.shouldFire('p2_fake_success', 'family-a')).toBe(false)
    expect(ledger.shouldFire('p2_fake_success', 'family-b')).toBe(true)
  })

  it('exhausted families stay exhausted', () => {
    const ledger = new AgentLedger()
    ledger.exhaust('a')
    expect(ledger.isExhausted('a')).toBe(true)
    expect(ledger.isExhausted('b')).toBe(false)
  })
})

describe('extractLesson', () => {
  it('extracts a cross-class lesson from a breakthrough after failures elsewhere', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ tool: 'adjust', family: 'std', familyClass: 'direct_write', verdict: 'fake_success', failureForm: 'silent_swallow' }))
    ledger.record(attempt({ tool: 'key', family: 'input', familyClass: 'user_equivalent_input', verdict: 'declared_failure', declaredOk: false, failureForm: 'explicit_denial' }))
    ledger.record(attempt({ tool: 'key-shell', family: 'input', familyClass: 'user_equivalent_input', verdict: 'verified_success' }))
    const lesson = extractLesson(ledger)
    expect(lesson).toBeDefined()
    expect(lesson?.avoidClasses).toEqual(['direct_write'])
    expect(lesson?.workedClass).toBe('user_equivalent_input')
    expect(lesson?.forms).toContain('silent_swallow')
  })

  it('a same-class rescue carries no transferable reframe', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ tool: 'try1', family: 'a', familyClass: 'direct_write', verdict: 'declared_failure', declaredOk: false }))
    ledger.record(attempt({ tool: 'try2', family: 'b', familyClass: 'direct_write', verdict: 'verified_success' }))
    expect(extractLesson(ledger)).toBeUndefined()
  })

  it('a first-try success has nothing to teach', () => {
    const ledger = new AgentLedger()
    ledger.record(attempt({ family: 'a', familyClass: 'official_entry', verdict: 'verified_success' }))
    expect(extractLesson(ledger)).toBeUndefined()
  })
})

describe('BlockadeLessonStore', () => {
  it('collapses duplicate lessons and matches retrieval at the family-class level', () => {
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

  it('renders lessons as one compact recall line', () => {
    const store = new BlockadeLessonStore()
    store.record({ avoidClasses: ['direct_write'], workedClass: 'user_equivalent_input', forms: ['silent_swallow'], summary: 'writes via direct_write failed' })
    const text = BlockadeLessonStore.render(store.all())
    expect(text).toContain('direct_write')
    expect(text).toContain('user_equivalent_input')
  })
})
