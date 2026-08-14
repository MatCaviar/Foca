import { describe, expect, it } from 'vitest'
import { classifyFailure, composeVerdict } from '@deepseek-ai/dsh-blockade'
import type { Evidence, Independence } from '@deepseek-ai/dsh-blockade'

/** Behavior suite for the pure domain: failure classification, verdict
 * composition with graded evidence, ledger triggers, lesson extraction and
 * store retrieval, and fail-loud config validation. */

describe('classifyFailure', () => {
  it('recognizes explicit identity denials by wording', () => {
    expect(classifyFailure('SecurityException: uid not in gid 1004')).toBe('explicit_denial')
    expect(classifyFailure('EACCES: permission denied')).toBe('explicit_denial')
    expect(classifyFailure('HTTP 403: forbidden')).toBe('explicit_denial')
    expect(classifyFailure('su: permission denied — not in allowlist')).toBe('explicit_denial')
  })

  it('recognizes missing targets distinctly from denials', () => {
    expect(classifyFailure('GET /api/x: 404 not found')).toBe('target_missing')
    expect(classifyFailure('open(): no such file or directory (ENOENT)')).toBe('target_missing')
    expect(classifyFailure('symbol not exported')).toBe('target_missing')
  })

  it('everything else is an ordinary declared error', () => {
    expect(classifyFailure('HTTP 500: internal write path disabled')).toBe('declared_error_other')
    expect(classifyFailure('HTTP 405: method not allowed')).toBe('declared_error_other')
  })
})

describe('composeVerdict (protocol 3, graded evidence)', () => {
  const evidence = (over: { probe?: string; independence?: Independence; agrees?: boolean; observed?: string }): Evidence => ({
    probe: over.probe ?? 'probe',
    independence: over.independence ?? 'independent',
    observed: over.observed ?? '',
    ...(over.agrees === undefined ? {} : { agrees: over.agrees }),
  })

  it('a declared failure stays a declared failure regardless of evidence', () => {
    expect(composeVerdict(false, []).verdict).toBe('declared_failure')
    expect(composeVerdict(false, [evidence({ agrees: true })]).verdict).toBe('declared_failure')
  })

  it('an independent or ground-truth confirmation upgrades to verified success', () => {
    expect(composeVerdict(true, [evidence({ agrees: true, independence: 'independent' })]).verdict).toBe('verified_success')
    expect(composeVerdict(true, [evidence({ agrees: true, independence: 'ground_truth' })]).verdict).toBe('verified_success')
  })

  it('an actuator-store agreement alone stays unverified — the same-store lie', () => {
    const ruling = composeVerdict(true, [evidence({ agrees: true, independence: 'actuator_store' })])
    expect(ruling.verdict).toBe('unverified')
  })

  it('any disagreement rules a fake success, even from the actuator store', () => {
    expect(composeVerdict(true, [evidence({ agrees: false, independence: 'actuator_store' })]).verdict).toBe('fake_success')
    expect(composeVerdict(true, [evidence({ agrees: true, independence: 'actuator_store' }), evidence({ agrees: false, independence: 'ground_truth' })]).verdict).toBe('fake_success')
  })

  it('no committed evidence leaves the claim unverified', () => {
    expect(composeVerdict(true, []).verdict).toBe('unverified')
    expect(composeVerdict(true, [evidence({})]).verdict).toBe('unverified')
  })
})
