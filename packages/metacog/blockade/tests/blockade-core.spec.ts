import { describe, expect, it } from 'vitest'
import {
  classifyCommandKind,
  classifyFailure,
  composeVerdict,
  failureFingerprint,
} from '@deepseek-ai/dsh-blockade'
import type { Evidence, Independence } from '@deepseek-ai/dsh-blockade'

describe('classifyFailure', () => {
  it('recognizes explicit identity denials', () => {
    expect(classifyFailure('SecurityException: uid not in gid 1004')).toBe('explicit_denial')
    expect(classifyFailure('EACCES: permission denied')).toBe('explicit_denial')
    expect(classifyFailure('HTTP 403: forbidden')).toBe('explicit_denial')
  })

  it('recognizes missing targets distinctly', () => {
    expect(classifyFailure('GET /api/x: 404 not found')).toBe('target_missing')
    expect(classifyFailure('open(): no such file or directory (ENOENT)')).toBe('target_missing')
    expect(classifyFailure('symbol not exported')).toBe('target_missing')
  })

  it('keeps other failures ordinary', () => {
    expect(classifyFailure('HTTP 500: internal write path disabled')).toBe('declared_error_other')
  })
})

describe('composeVerdict', () => {
  const evidence = (over: { probe?: string; independence?: Independence; agrees?: boolean; observed?: string }): Evidence => ({
    probe: over.probe ?? 'probe',
    independence: over.independence ?? 'independent',
    observed: over.observed ?? '',
    ...(over.agrees === undefined ? {} : { agrees: over.agrees }),
  })

  it('requires an independent confirmation for verified success', () => {
    expect(composeVerdict(true, [evidence({ agrees: true, independence: 'independent' })]).verdict).toBe('verified_success')
    expect(composeVerdict(true, [evidence({ agrees: true, independence: 'ground_truth' })]).verdict).toBe('verified_success')
    expect(composeVerdict(true, [evidence({ agrees: true, independence: 'actuator_store' })]).verdict).toBe('unverified')
  })

  it('any disagreement rules fake success', () => {
    expect(composeVerdict(true, [evidence({ agrees: false, independence: 'actuator_store' })]).verdict).toBe('fake_success')
  })

  it('no evidence stays unverified', () => {
    expect(composeVerdict(true, []).verdict).toBe('unverified')
  })
})

describe('terminal semantic partitioning', () => {
  it('separates inspection, edits, tests, builds, installs, and services', () => {
    expect(classifyCommandKind('rg "TODO" src').key).toBe('inspect')
    expect(classifyCommandKind('sed -i s/foo/bar/ src/a.ts').key).toBe('edit')
    expect(classifyCommandKind('pytest -q').key).toBe('test')
    expect(classifyCommandKind('pnpm run build').key).toBe('build')
    expect(classifyCommandKind('pip install -e .').key).toBe('install')
    expect(classifyCommandKind('docker compose up -d').key).toBe('service')
    expect(classifyCommandKind('cd repo && git diff --stat').key).toBe('inspect')
    expect(classifyCommandKind('docker ps').key).toBe('inspect')
    expect(classifyCommandKind(`python -c "from pathlib import Path; Path('x').write_text('y')"`).key).toBe('edit')
  })

  it('marks only state-changing or validating kinds as progress on success', () => {
    expect(classifyCommandKind('ls -la').progressOnSuccess).toBe(false)
    expect(classifyCommandKind('pytest -q').progressOnSuccess).toBe(true)
    expect(classifyCommandKind('apply_patch <<PATCH').progressOnSuccess).toBe(true)
  })

  it('normalizes volatile paths and numbers in repeated-error fingerprints', () => {
    const first = failureFingerprint('/tmp/run-123/src/a.ts:41 expected 7 got 9')
    const second = failureFingerprint('/tmp/run-456/src/a.ts:88 expected 7 got 9')
    expect(first).toBe(second)
    expect(first).not.toBe(failureFingerprint('/tmp/run-789/src/a.ts:99 expected 8 got 10'))
  })
})
