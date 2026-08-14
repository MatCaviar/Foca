/**
 * Pure vocabulary of the blockade metacognition domain: path semantics,
 * failure forms, truth verdicts, graded evidence, and the directive texts
 * the guard injects. Everything here is Cordis-free so tests, the simulated
 * worlds, and experiment runners can reuse it directly.
 *
 * The domain encodes one claim from the blockade postmortems: most deadlocks
 * are frame lock (Einstellung effect), not missing knowledge. Each directive
 * below is the internalized form of an external hint that once unblocked a
 * real agent — kept as data so the guard can issue them deterministically.
 * @module @deepseek-ai/dsh-blockade
 */

/** Semantic role of one tool-call path family member (protocol 1). */
export type PathClass =
  | 'A_direct'
  | 'B_user_equivalent'
  | 'C_identity_shift'
  | 'D_reverse_engineer'

/**
 * Cross-domain abstraction over concrete tool families. Lessons transfer at
 * this level, not at the tool level: "a swallowed direct write" means the
 * same thing on a car head unit, a web backend, and a managed filesystem.
 */
export type FamilyClass =
  | 'direct_write'
  | 'user_equivalent_input'
  | 'official_entry'
  | 'privilege_shift'
  | 'env_setup'

/** Failure forms with distinct fixed next-actions (protocol 2). */
export type FailureForm =
  | 'explicit_denial'
  | 'silent_swallow'
  | 'target_missing'
  | 'declared_error_other'

/**
 * Truth verdict over one attempt (protocol 3). `declared_ok` from a tool is a
 * claim; only independent evidence upgrades it.
 */
export type Verdict =
  | 'verified_success'
  | 'fake_success'
  | 'declared_failure'
  | 'unverified'

/**
 * Independence grade of one verification channel. An actuator-store readback
 * shares state with the writer and can confirm it while the real effect is
 * absent — the recorded failure that motivated the grade.
 */
export type Independence = 'actuator_store' | 'independent' | 'ground_truth'

/** Machine-readable directive kinds the guard injects; also log markers. */
export type DirectiveKind =
  | 'p1_dual_path'
  | 'p2_fake_success'
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
  /** Whether the observation agrees with the declared effect; absent when the channel observed nothing. */
  readonly agrees?: boolean
  readonly observed: string
}

/** Complete truth ruling over one attempt's declared outcome. */
export interface VerdictRuling {
  readonly verdict: Verdict
  readonly evidences: readonly Evidence[]
}

/**
 * Hard-wired next-action for a failure form. The mapping is code, not advice:
 * a swallowed write can never be fixed by privilege escalation, so the guard
 * both forbids that default and names the required direction switch.
 */
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
}

/** Per-family failure statistics driving the reframe trigger (protocol 5). */
export interface FamilyStats {
  /** Attempts whose verdict is a failure (`declared_failure` or `fake_success`). */
  failures: number
  /** Attempts total. */
  attempts: number
  /** True once a fake success was ruled in this family: escalation targeting it is forbidden. */
  swallowed: boolean
}

/** A lesson extracted after a breakthrough (protocol 6). */
export interface Lesson {
  /** Classes whose direct writes were swallowed or denied before the breakthrough. */
  readonly avoidClasses: readonly FamilyClass[]
  /** Class that carried the verified breakthrough. */
  readonly workedClass: FamilyClass
  /** Failure forms observed on the avoided classes. */
  readonly forms: readonly FailureForm[]
  /** Human-readable account, bounded to one line. */
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

/**
 * Stable marker for one directive kind inside its text.
 * @param kind - the directive kind.
 * @returns the `[blockade:<kind>]` marker string.
 */
export function directiveMarker(kind: DirectiveKind): string {
  return `${DIRECTIVE_MARKER}${kind}]`
}

/**
 * Deployment-provided directive text overrides: same decision rules, same
 * marker, domain-adapted instruction wording. A missing key falls back to the
 * built-in text.
 */
export type DirectiveOverrides = Partial<Record<DirectiveKind, string>>

/** Identity-dimension grid offered by protocol 4 when a call is explicitly denied. */
export const IDENTITY_GRID: readonly string[] = [
  'current process identity (the uid/groups the call runs as right now)',
  'a higher uid reachable in this environment (su to root where the platform allows it)',
  'platform/system signature (re-signing with the vendor platform key)',
  'a privileged component (priv-app install plus allowlisted privileged permissions)',
  'a daemon identity that already holds the needed grant (e.g. a local shell served by the device daemon)',
  'a policy/trust boundary the checker actually consults (SELinux domain, service allowlist)',
]

/**
 * Directive texts. Each is the distilled form of an external hint that
 * unblocked a real agent: the protocol number, the machine marker, and an
 * instruction the model can act on without further context.
 */
/**
 * The full directive text for one kind: marker, fixed instruction, detail.
 * @param kind - the directive kind.
 * @param detail - the situation-specific account appended to the fixed text.
 * @returns the complete model-facing directive text.
 */
export function directiveText(kind: DirectiveKind, detail: string): string {
  const marker = directiveMarker(kind)
  switch (kind) {
    case 'p1_dual_path':
      return `${marker} A direct-invocation path just failed. Before the next attempt, enumerate BOTH path lists, in writing: (A) direct invocation alternatives (APIs, functions, protocols) AND (B) user-equivalent paths — the operations a human user performs on this system to get the same effect (physical keys and controls, standard entry points, official importers, commands a user could run). A plan without a path-B entry is incomplete; do not proceed until both exist. ${detail}`
    case 'p2_fake_success':
      return `${marker} The tool reported success, but independent verification contradicts it: this write was silently swallowed by a policy layer. Two fixed rules follow. (1) Do NOT retry this path or any variant of it — the success is fake, deeper attempts in the same family cannot change that. (2) Do NOT escalate privileges — escalation cannot repair a swallowed write and is the classic wrong default here. Switch to a semantically different path family, starting with the user-equivalent path from your dual-path enumeration. ${detail}`
    case 'p3_unverified':
      return `${marker} The tool reported success, but no independent channel confirms the effect, so the outcome is UNVERIFIED — not success. Before relying on it, verify through a channel that does not share state with the writer: a different service's readback, system logs, a second API, or a physical/ground-truth observation. If no such channel exists, report the result as unverified rather than successful. ${detail}`
    case 'p4_identity_grid':
      return `${marker} The call was explicitly denied, and "no permission" is one cell of the identity grid, not a terminal verdict. Enumerate every identity dimension before deciding anything is impossible: ${IDENTITY_GRID.join('; ')}. For each dimension answer: is it obtainable here, and does the denied operation become allowed under it? An unavailable dimension (e.g. a vendor-held signing key) is a fact to record, not a reason to stop. ${detail}`
    case 'p5_reframe':
      return `${marker} Enough attempts in one semantic family have failed. Stop deepening this family — no further variants of it. Execute the dual-path enumeration now: list path A (direct invocation) AND path B (user-equivalent: what a human would physically do) candidates, then continue with a family you have not tried yet, preferring path B. The block is most likely a frame lock, not missing knowledge. ${detail}`
    case 'p6_lesson_recall':
      return `${marker} Prior sessions in this deployment left verified lessons. Treat them as defaults, not trivia: ${detail}`
    case 'target_missing':
      return `${marker} The target itself is not exposed at this route: the contract lives behind something you must recover — reverse-engineer the owning component or surface the gap to an operator. More attempts against the same route cannot create the target. ${detail}`
    case 'escalation_forbidden':
      return `${marker} This call escalates privileges after a write in the same family was silently swallowed. That is the forbidden default: a policy-swallowed write cannot be repaired by more privilege. Route the effort to a different path family instead. ${detail}`
  }
}

/**
 * Resolve one directive's full text with optional deployment overrides. An
 * override replaces the fixed instruction wording but keeps the stable marker
 * prefix and the situation-specific detail suffix, so logs and scripted
 * policies keep working across deployments.
 * @param kind - the directive kind.
 * @param detail - the situation-specific account appended to the text.
 * @param overrides - deployment-provided texts keyed by kind.
 * @returns the complete model-facing directive text.
 */
export function resolveDirective(kind: DirectiveKind, detail: string, overrides?: DirectiveOverrides): string {
  const custom = overrides?.[kind]
  if (custom !== undefined) return `${directiveMarker(kind)} ${custom} ${detail}`
  return directiveText(kind, detail)
}
