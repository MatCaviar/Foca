/**
 * Failure-form classification and verdict composition (protocols 2 and 3).
 * Pure functions over tool results and graded evidence; no Cordis.
 * @module @deepseek-ai/dsh-blockade
 */

import type {
  Evidence,
  FailureForm,
  Independence,
  Verdict,
  VerdictRuling,
} from './domain.ts'

/**
 * Substrings that mark an error text as an explicit identity denial rather
 * than a missing target or an ordinary failure. Matched case-insensitively.
 */
const DENIAL_MARKERS: readonly string[] = [
  'permission denied',
  'eacces',
  'eperm',
  'securityexception',
  'operation not permitted',
  'forbidden',
  '403',
  'unauthorized',
  '401',
  'inject_events',
  'requires signature',
  'not granted',
]

/** Substrings that mark an error text as a missing target. */
const MISSING_MARKERS: readonly string[] = [
  'no such file',
  'enoent',
  'not found',
  '404',
  'no route',
  'unknown tool',
  'does not exist',
  'not exported',
]

function matchesAny(lowered: string, markers: readonly string[]): boolean {
  return markers.some(marker => lowered.includes(marker))
}

/**
 * Classify a declared failure from its rendered error text. Explicit denials
 * and missing targets are recognized by their wording because that wording
 * is what fixes the correct next action; everything else is an ordinary
 * declared error.
 * @param errorText - the tool result's rendered error message.
 * @returns the failure form for the ruling.
 */
export function classifyFailure(errorText: string): FailureForm {
  const lowered = errorText.toLowerCase()
  if (matchesAny(lowered, DENIAL_MARKERS)) return 'explicit_denial'
  if (matchesAny(lowered, MISSING_MARKERS)) return 'target_missing'
  return 'declared_error_other'
}

/**
 * Compose the truth verdict for one attempt (protocol 3).
 *
 * Grading rules, fixed: any evidence that disagrees — at any independence
 * level — rules a declared success fake (even the writer's own store
 * contradicting it is decisive). A confirmation counts only from an
 * `independent` or `ground_truth` channel; an actuator-store agreement alone
 * leaves the attempt `unverified`, because a store shared with the writer
 * can confirm a write that never took effect.
 * @param declaredOk - whether the tool result claims success.
 * @param evidences - verification-channel observations collected after the call.
 * @returns the ruling with every evidence attached.
 */
export function composeVerdict(declaredOk: boolean, evidences: readonly Evidence[]): VerdictRuling {
  if (!declaredOk) return { verdict: 'declared_failure', evidences }
  if (evidences.some(evidence => evidence.agrees === false)) {
    return { verdict: 'fake_success', evidences }
  }
  const confirming = evidences.some(
    evidence => evidence.agrees === true && (evidence.independence === 'independent' || evidence.independence === 'ground_truth'),
  )
  if (confirming) return { verdict: 'verified_success', evidences }
  return { verdict: 'unverified', evidences }
}

/**
 * Numeric strength ordering of independence grades; higher is stronger.
 * @param independence - the grade to rank.
 * @returns 1 for actuator-store, 2 for independent, 3 for ground truth.
 */
export function independenceStrength(independence: Independence): number {
  switch (independence) {
    case 'actuator_store': return 1
    case 'independent': return 2
    case 'ground_truth': return 3
  }
}

/**
 * The hard-wired failure-form → next-action mapping (protocol 2's table,
 * written as code). One row per form; none of them is "escalate".
 * @param form - the classified failure form of a failed attempt.
 * @param verdict - the truth verdict of the same attempt.
 * @returns the fixed next action.
 */
export function nextActionFor(form: FailureForm, verdict: Verdict): { kind: 'switch_family' | 'enumerate_identity' | 'reverse_engineer' | 'seek_independent_channel' | 'stop_deepening'; reason: string } {
  if (verdict === 'fake_success' && form === 'silent_swallow') {
    return {
      kind: 'switch_family',
      reason: 'declared success contradicted by independent evidence: the write was swallowed; escalation is forbidden and the family is exhausted',
    }
  }
  switch (form) {
    case 'explicit_denial':
      return { kind: 'enumerate_identity', reason: 'explicit denial: enumerate identity dimensions before concluding anything is impossible' }
    case 'target_missing':
      return { kind: 'reverse_engineer', reason: 'target not exposed: recover the contract by reverse engineering or surface to the operator' }
    case 'declared_error_other':
      return { kind: 'stop_deepening', reason: 'ordinary declared error: bounded variants only, then the reframe trigger decides' }
    case 'silent_swallow':
      return { kind: 'switch_family', reason: 'silent swallow: switch semantic family; prefer the user-equivalent path' }
  }
}
