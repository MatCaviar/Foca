/**
 * The scripted cognitive policy that stands in for an LLM in keyless
 * experiments. One class, two policies:
 *
 * - `naive` encodes the four recorded deadlock mechanisms: it trusts declared
 *   success, retries same-family variants, treats an explicit denial as a
 *   terminal environment limitation, and never enumerates path B;
 * - `compliant` is the SAME agent plus one behavior: it follows directives
 *   injected by the blockade guard (family switches, identity enumeration,
 *   dual-path enumeration, lesson recall).
 *
 * The measured difference between arms is therefore attributable to the
 * metacognition layer, not to different knowledge: both policies read the
 * same candidate list, ordered direct-path first.
 * @module @deepseek-ai/dsh-blockade-sim
 */

import {
  CallId,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { FamilyClass } from '@deepseek-ai/dsh-blockade'

/** Which deadlock posture the scripted agent takes. */
export type PolicyMode = 'naive' | 'compliant'

/** One candidate action the agent knows, with the family class it belongs to. */
export interface Candidate {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly familyClass: FamilyClass
  /** True when the naive policy also considers it (its frame). */
  readonly inNaiveFrame: boolean
}

/** How a denied call becomes executable in one scenario. */
export interface IdentityUnlock {
  readonly setupTool: string
  readonly retryArgs: Readonly<Record<string, unknown>>
}

/** One scenario's script: the task text, the knowledge, and the unlock. */
export interface ScenarioScript {
  readonly taskText: string
  readonly candidates: readonly Candidate[]
  readonly identityUnlock?: IdentityUnlock
}

const B_CLASSES: readonly FamilyClass[] = ['user_equivalent_input', 'official_entry']

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallChunks(rawCallId: string, name: string, args: Readonly<Record<string, unknown>>): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId(rawCallId), name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Everything the model sees since its own last output. */
interface TrailingContext {
  readonly directives: readonly string[]
  readonly lastToolResult: { readonly isError: boolean; readonly text: string } | undefined
}

function parseTrailing(messages: readonly Message[]): TrailingContext {
  const lastAssistant = [...messages].reverse().findIndex(message => message.role === 'assistant')
  const trailing = lastAssistant === -1 ? messages : messages.slice(messages.length - lastAssistant)
  const directives: string[] = []
  let lastToolResult: TrailingContext['lastToolResult']
  for (const message of trailing) {
    if (message.role !== 'user') continue
    if (message.source.kind === 'plugin' && message.source.plugin === 'blockade-guard') {
      const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
      const match = /\[blockade:([a-z0-9_]+)\]/.exec(text)
      if (match !== null) directives.push(match[1] ?? '')
      continue
    }
    const block = message.content[0]
    if (block !== undefined && block.type === 'tool-result') {
      lastToolResult = {
        isError: block.isError === true,
        text: block.content.map(item => item.type === 'text' ? item.text : '').join('\n'),
      }
    }
  }
  return { directives, lastToolResult }
}

/**
 * The scripted agent. Not thread-safe by design: one instance drives one
 * scenario run, mirroring one model serving one session.
 */
export class PolicyAdapter extends LlmAdapter {
  private readonly tried = new Set<string>()
  private readonly blacklist = new Set<FamilyClass>()
  private preferB = false
  private frameExpanded = false
  private taught = false
  private pendingRetry: Candidate | undefined
  private lastCandidate: Candidate | undefined
  private callSeq = 0

  constructor(
    private readonly policy: PolicyMode,
    private readonly script: ScenarioScript,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  // The scripted policy decides synchronously; the async shape only serves
  // the LlmAdapter contract.
  // oxlint-disable-next-line typescript/require-await
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { directives, lastToolResult } = parseTrailing(options.messages)
    const chunks = this.decide(directives, lastToolResult)
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }

  /** The final-answer token the runner classifies against world ground truth. */
  private static final(text: string): StreamChunk[] {
    return textChunks(text)
  }

  private decide(directives: readonly string[], lastToolResult: TrailingContext['lastToolResult']): StreamChunk[] {
    // Naive policy: directives are invisible; declared success is success,
    // denial is terminal, and only same-frame variants get retried.
    if (this.policy === 'naive') {
      if (lastToolResult !== undefined) {
        if (!lastToolResult.isError) {
          return PolicyAdapter.final('FINAL:SUCCESS — done.')
        }
        if (/permission denied|securityexception|403|forbidden/i.test(lastToolResult.text)) {
          return PolicyAdapter.final('FINAL:GAVE_UP_ENV — cannot proceed: permission denied; environment limitation.')
        }
      }
      const next = this.nextCandidate(candidate => candidate.inNaiveFrame)
      if (next === undefined) return PolicyAdapter.final('FINAL:GAVE_UP — all known approaches failed.')
      return this.emit(next)
    }

    // Compliant policy: same instincts, plus obedience to guard directives.
    // The frame starts identical to the naive one (`inNaiveFrame` candidates);
    // a dual-path, reframe, fake-success, or recall directive EXPANDS it to the
    // full knowledge — modeling "the agent has the knowledge, the directive
    // puts it into the search space".
    if (directives.length > 0) {
      this.taught = true
      this.frameExpanded = true
    }
    if (directives.includes('p6_lesson_recall')) this.preferB = true
    if (directives.includes('p1_dual_path') || directives.includes('p5_reframe')) this.preferB = true
    if ((directives.includes('p2_fake_success') || directives.includes('escalation_forbidden')) && this.lastCandidate !== undefined) {
      this.blacklist.add(this.lastCandidate.familyClass)
      this.preferB = true
    }
    if (directives.includes('p4_identity_grid') && this.lastCandidate !== undefined && this.script.identityUnlock !== undefined) {
      this.pendingRetry = this.lastCandidate
    }

    // A prepared identity unlocks the remembered denied call.
    const unlock = this.script.identityUnlock
    const unlockReady = this.lastCandidate?.tool === unlock?.setupTool
      && lastToolResult !== undefined && !lastToolResult.isError
    if (this.pendingRetry !== undefined && unlock !== undefined && unlockReady) {
      const retry = this.pendingRetry
      this.pendingRetry = undefined
      return this.emit({ ...retry, args: { ...retry.args, ...unlock.retryArgs } })
    }

    // A declared success counts only without a contradicting directive: the
    // guard's fake-success and unverified rulings veto the stop.
    const succeeded = lastToolResult !== undefined && !lastToolResult.isError
    const contradicted = directives.some(kind => kind === 'p2_fake_success' || kind === 'p3_unverified' || kind === 'escalation_forbidden')
    if (succeeded && !contradicted && this.pendingRetry === undefined) {
      return PolicyAdapter.final('FINAL:SUCCESS — done.')
    }

    if (lastToolResult !== undefined && lastToolResult.isError && directives.length === 0
      && /permission denied|securityexception|403|forbidden/i.test(lastToolResult.text)) {
      return PolicyAdapter.final('FINAL:GAVE_UP_ENV — cannot proceed: permission denied; environment limitation.')
    }

    const next = this.nextCandidate()
    if (next === undefined) {
      return this.taught
        ? PolicyAdapter.final('FINAL:BLOCKED_HONEST — every path family is exhausted (swallowed or denied); remaining routes are physical user actions or vendor reverse engineering; no success is claimed.')
        : PolicyAdapter.final('FINAL:GAVE_UP — all known approaches failed.')
    }
    return this.emit(next)
  }

  /**
   * Next untried candidate inside the active frame, B-first when preferred.
   * The default frame is the naive one; only directive-driven expansion
   * reaches the out-of-frame knowledge.
   */
  private nextCandidate(frame?: (candidate: Candidate) => boolean): Candidate | undefined {
    const eligible = this.script.candidates.filter((candidate) => {
      if (this.tried.has(this.key(candidate))) return false
      if (this.blacklist.has(candidate.familyClass)) return false
      if (frame !== undefined && !frame(candidate)) return false
      if (frame === undefined && !candidate.inNaiveFrame && !this.frameExpanded) return false
      return true
    })
    const preferred = this.preferB
      ? eligible.find(candidate => B_CLASSES.includes(candidate.familyClass))
      : undefined
    return preferred ?? eligible[0]
  }

  private emit(candidate: Candidate): StreamChunk[] {
    this.tried.add(this.key(candidate))
    this.lastCandidate = candidate
    this.callSeq += 1
    return toolCallChunks(`${this.policy}-${this.callSeq}`, candidate.tool, candidate.args)
  }

  private key(candidate: Candidate): string {
    return `${candidate.tool}:${JSON.stringify(candidate.args)}`
  }
}
