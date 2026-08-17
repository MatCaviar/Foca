/**
 * Pure vocabulary of the blockade metacognition domain: path semantics,
 * failure forms, truth verdicts, graded evidence, and directive texts.
 * Everything here is Cordis-free so tests, simulated worlds, and benchmark
 * runners can reuse it directly.
 * @module @deepseek-ai/dsh-blockade
 */

/** Semantic role of one tool-call path family member (protocol 1). */
export type PathClass =
  | 'A_direct'
  | 'B_user_equivalent'
  | 'C_identity_shift'
  | 'D_reverse_engineer'

/** Cross-domain abstraction over concrete tool families. */
export type FamilyClass =
  | 'direct_write'
  | 'user_equivalent_input'
  | 'official_entry'
  | 'privilege_shift'
  | 'env_setup'

/** Failure forms with distinct fixed next actions (protocol 2). */
export type FailureForm =
  | 'explicit_denial'
  | 'silent_swallow'
  | 'target_missing'
  | 'declared_error_other'

/**
 * Truth verdict over one attempt (protocol 3).
 *
 * `declared_success` is intentionally distinct from `verified_success`: it is
 * a successful call for which this deployment did not require or configure an
 * independent probe. It remains transparent to the model and cannot teach a
 * cross-session lesson.
 */
export type Verdict =
  | 'verified_success'
  | 'declared_success'
  | 'fake_success'
  | 'declared_failure'
  | 'unverified'

/** Independence grade of one verification channel. */
export type Independence = 'actuator_store' | 'independent' | 'ground_truth'

/** Machine-readable directive kinds the guard injects; also log markers. */
export type DirectiveKind =
  | 'p1_dual_path'
  | 'p2_fake_success'
  | 'carrier_search'
  | 'p3_unverified'
  | 'p4_identity_grid'
  | 'p5_reframe'
  | 'p6_lesson_recall'
  | 'target_missing'
  | 'escalation_forbidden'

/** One observed fact from a verification channel after a declared write. */
export interface Evidence {
  /** Probe tool that produced this evidence. */
  readonly probe: string
  readonly independence: Independence
  /** Whether the observation agrees with the declared effect. */
  readonly agrees?: boolean
  readonly observed: string
}

/** Complete truth ruling over one attempt's declared outcome. */
export interface VerdictRuling {
  readonly verdict: Verdict
  readonly evidences: readonly Evidence[]
}

/** Hard-wired next action for a failure form. */
export interface NextAction {
  readonly kind: 'switch_family' | 'enumerate_identity' | 'reverse_engineer' | 'seek_independent_channel' | 'stop_deepening'
  readonly reason: string
}

/** One attempt as the ledger records it. */
export interface AttemptRecord {
  readonly tool: string
  readonly family: string
  readonly familyClass: FamilyClass
  readonly pathClass: PathClass
  readonly declaredOk: boolean
  readonly verdict: Verdict
  readonly failureForm: FailureForm | undefined
  readonly ruling: VerdictRuling | undefined
  /** Whether this success establishes task-state progress and starts a new recovery episode. */
  readonly progress?: boolean
  /** Normalized error/result signature used to detect identical failed attempts. */
  readonly failureFingerprint?: string
}

/** Per-family statistics driving the reframe trigger (protocol 5). */
export interface FamilyStats {
  /** Total failed attempts retained for diagnostics. */
  failures: number
  /** Attempts total. */
  attempts: number
  /** Consecutive failures since the most recent successful attempt in this family or global progress. */
  failureStreak: number
  /** Consecutive failures with the same normalized outcome. */
  repeatedFailureStreak: number
  /** Last normalized failure outcome, if one was available. */
  lastFailureFingerprint: string | undefined
  /** True once a fake success was ruled in this family. */
  swallowed: boolean
}

/** A lesson extracted after a breakthrough (protocol 6). */
export interface Lesson {
  readonly avoidClasses: readonly FamilyClass[]
  readonly workedClass: FamilyClass
  readonly forms: readonly FailureForm[]
  readonly summary: string
}

/** Durable session fact for one committed lesson; log-only, never model-visible. */
export interface BlockadeLessonEvent {
  readonly kind: 'blockade/lesson'
  readonly version: 1
  readonly lesson: Lesson
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One metacognition lesson committed after a verified breakthrough. */
    'blockade/lesson': BlockadeLessonEvent
  }
}

/** Stable prefix every guard directive carries, for logs and policy parsing. */
export const DIRECTIVE_MARKER = '[blockade:'

/** Stable marker for one directive kind inside its text. */
export function directiveMarker(kind: DirectiveKind): string {
  return `${DIRECTIVE_MARKER}${kind}]`
}

/** Deployment-provided directive text overrides. */
export type DirectiveOverrides = Partial<Record<DirectiveKind, string>>

/** Identity-dimension grid offered by protocol 4 after an explicit denial. */
export const IDENTITY_GRID: readonly string[] = [
  'current process identity (the uid/groups the call runs as right now)',
  'a higher uid reachable in this environment (su to root where the platform allows it)',
  'platform/system signature (re-signing with the vendor platform key)',
  'a privileged component (priv-app install plus allowlisted privileged permissions)',
  'a daemon identity that already holds the needed grant (for example a local shell served by the device daemon)',
  'a policy/trust boundary the checker actually consults (SELinux domain, service allowlist)',
]

/** Full model-facing directive text for one protocol. */
export function directiveText(kind: DirectiveKind, detail: string): string {
  const marker = directiveMarker(kind)
  switch (kind) {
    case 'p1_dual_path':
      return `${marker} A direct-invocation path just failed. Before the next attempt, enumerate BOTH path lists, in writing: (A) direct invocation alternatives (APIs, functions, protocols) AND (B) user-equivalent paths — the operations a human user performs on this system to get the same effect (physical controls, standard entry points, official importers, commands a user could run). A plan without a path-B entry is incomplete. ${detail}`
    case 'p2_fake_success':
      return `${marker} The tool reported success, but independent verification contradicts it: this write was silently swallowed by a policy layer. Do not retry this path or a cosmetic variant, and do not escalate privileges. Switch to a semantically different family, starting with the user-equivalent path. ${detail}`
    case 'carrier_search':
      return `${marker} The current executor cannot perform this action. Do not keep repairing or escalating the same executor. Search for a CAPABILITY CARRIER instead: who in this system can already do it (the user, a system UI entry, a daemon, an existing service, a diagnostic tool, a scheduler, a browser, a CLI, another application, or a remote worker)? Find the cheapest controllable trigger channel to that carrier. Search for the causal path that produces the target world-state, not for another spelling of the same API. ${detail}`
    case 'p3_unverified':
      return `${marker} The tool reported success, but no independent channel confirms the effect, so the outcome is UNVERIFIED. Verify through a channel that does not share state with the writer: a different service readback, system logs, a second API, or a physical/ground-truth observation. If none exists, report unverified rather than successful. ${detail}`
    case 'p4_identity_grid':
      return `${marker} The call was explicitly denied, and "no permission" is one cell of the identity grid, not a terminal verdict. Enumerate: ${IDENTITY_GRID.join('; ')}. For each dimension answer whether it is obtainable here and whether it changes the denied operation. ${detail}`
    case 'p5_reframe':
      return `${marker} Consecutive attempts in one semantic family have failed without intervening progress. Stop deepening this family. Re-read the actual state and the first unresolved error, enumerate direct and user-equivalent paths, then continue through a family not yet exhausted. ${detail}`
    case 'p6_lesson_recall':
      return `${marker} Prior verified recovery episodes left relevant lessons. Treat them as defaults: ${detail}`
    case 'target_missing':
      return `${marker} The target is not exposed on this route. Recover the owning contract by discovering or reverse-engineering the component, or surface the missing capability explicitly. More attempts against the same route cannot create the target. ${detail}`
    case 'escalation_forbidden':
      return `${marker} This call escalates privileges after a write was silently swallowed. That is the wrong recovery direction: more privilege cannot repair a policy-swallowed path. Move to a different causal family. ${detail}`
  }
}

/** Resolve one directive with optional deployment wording. */
export function resolveDirective(kind: DirectiveKind, detail: string, overrides?: DirectiveOverrides): string {
  const custom = overrides?.[kind]
  if (custom !== undefined) return `${directiveMarker(kind)} ${custom} ${detail}`
  return directiveText(kind, detail)
}
