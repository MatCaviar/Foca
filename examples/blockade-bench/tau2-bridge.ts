/**
 * Tau2 bridge: runs one DeepSeek Harness agent loop as the agent backend of
 * the official τ²-bench orchestrator over a stdio JSON-line protocol.
 *
 * The harness owns the model loop; every τ² tool is registered with a parked
 * execute whose promise resolves when the orchestrator (the single writer of
 * environment state) supplies the real result. Tool results therefore flow
 * through the harness tool pipeline, where the blockade guard observes them.
 *
 * Protocol (one JSON object per line):
 * - in  `start`  {sessionId, system, tools:[{name,description,parameters}], guard, model}
 * - in  `user`   {text}                              — next user turn
 * - in  `toolResult` {callId, output, isError}       — orchestrator-executed result
 * - in  `stop`   {}                                  — terminate
 * - out `ready`  {}
 * - out `toolCalls` {calls:[{callId,name,arguments}], usage:{input,output}}
 * - out `final`  {text, usage:{input,output}}
 * - out `error`  {message}
 *
 * Usage is the cumulative harness-side token count (input+output) of this
 * session, reported on every emission for accounting.
 * @module @deepseek-ai/dsh-blockade-bench
 */

import * as readline from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as PiAiLlm from '@deepseek-ai/dsh-llm-pi-ai'
import * as BlockadeGuard from '@deepseek-ai/dsh-blockade'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

interface BridgeToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties?: Record<string, Record<string, unknown>>
    readonly required?: readonly string[]
  }
}

interface StartMessage {
  readonly type: 'start'
  readonly sessionId: string
  readonly system: string
  readonly tools: readonly BridgeToolSpec[]
  readonly guard: boolean
  readonly model: string
}

interface UserMessageIn {
  readonly type: 'user'
  readonly text: string
}

interface ToolResultIn {
  readonly type: 'toolResult'
  readonly callId: string
  readonly output: string
  readonly isError: boolean
}

type InMessage = StartMessage | UserMessageIn | ToolResultIn | { readonly type: 'stop' }

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * Domain-adapted directive texts for τ² retail: the same decision rules
 * (verify state instead of assuming, stop retrying policy-denied variants,
 * read back writes before reporting them) phrased for a customer-service
 * policy domain.
 */
const TAU2_DIRECTIVES = {
  p1_dual_path: 'A direct action just failed. Before the next attempt: (1) identify the exact policy constraint or state condition that rejected it, (2) verify the current order/user state with a read call instead of assuming, and only then (3) choose a policy-compliant variant, an alternative permitted action, or an honest explanation to the user.',
  p3_unverified: 'This write succeeded, but nothing independently confirms the resulting state. Before telling the user it is done, verify by reading the current state (for example get_order_details / get_user_details); do not describe the change as complete until you have read it back.',
  p5_reframe: 'Multiple attempts in one action family have failed. Stop retrying variants of the same approach. Re-check whether the policy actually permits this action in the current state — verify with read calls, and if the action is genuinely policy-gated, tell the user clearly what cannot be done and proceed with what is allowed.',
} as const

const TAU2_GUARD_CONFIG: BlockadeGuard.Config = {
  families: [
    {
      tools: ['cancel_pending_order', 'exchange_delivered_order_items', 'modify_pending_order_address', 'modify_pending_order_items', 'modify_pending_order_payment', 'modify_user_address', 'return_delivered_order_items'],
      family: 'order-write',
      familyClass: 'direct_write',
      pathClass: 'A_direct',
    },
    {
      tools: ['transfer_to_human_agents'],
      family: 'human-escalation',
      familyClass: 'user_equivalent_input',
      pathClass: 'B_user_equivalent',
    },
    {
      tools: ['authenticate_user', 'send_verification_code'],
      family: 'auth',
      familyClass: 'env_setup',
      pathClass: 'A_direct',
    },
  ],
  directives: TAU2_DIRECTIVES,
}

interface Parked {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

class BridgeSession {
  private readonly ctx: Context
  private readonly agent: Agent
  private readonly parked = new Map<string, Parked>()
  private inputTokens = 0
  private outputTokens = 0
  private idleWatcher: (() => void) | undefined

  constructor(ctx: Context, agent: Agent) {
    this.ctx = ctx
    this.agent = agent
  }

  /**
   * Cumulative harness token usage of this session. Each `assistant/message`
   * event carries its request's usage; new messages are folded in on read.
   */
  usage(): { input: number; output: number } {
    const events = [...this.agent.session.events]
    while (this.usageCursor < events.length) {
      const event = events[this.usageCursor]
      this.usageCursor += 1
      if (event.type !== 'assistant/message') continue
      const usage = (event as { data?: { usage?: { inputTokens?: number; outputTokens?: number } } }).data?.usage
      if (usage !== undefined) {
        this.inputTokens += usage.inputTokens ?? 0
        this.outputTokens += usage.outputTokens ?? 0
      }
    }
    return { input: this.inputTokens, output: this.outputTokens }
  }

  private usageCursor = 0

  /** Run one user turn; resolves when the agent goes idle again. */
  async userTurn(text: string): Promise<void> {
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await this.waitIdle()
  }

  /** Resolve a parked tool execution; the loop resumes inside the open turn. */
  resolveTool(callId: string, output: string, isError: boolean): void {
    const parked = this.parked.get(callId)
    if (parked === undefined) return
    this.parked.delete(callId)
    if (isError) {
      parked.reject(new Error(output.length > 0 ? output : 'tool call failed'))
    } else {
      parked.resolve({ result: output })
    }
  }

  /** The final assistant text of the (now idle) turn. */
  finalText(): string {
    let text = ''
    for (const event of this.agent.session.events) {
      if (event.type !== 'assistant/message') continue
      const message = (event as { data?: { message?: { content: { type: string; text?: string }[] } } }).data?.message
      if (message === undefined) continue
      const joined = message.content.map(block => block.type === 'text' ? (block.text ?? '') : '').join('')
      if (joined.length > 0) text = joined
    }
    return text
  }

  private waitIdle(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        dispose?.()
        clearTimeout(timer)
        resolve()
      }
      const dispose = this.ctx.on('agent/status', ({ agent, status }) => {
        if (agent === this.agent && status === 'idle') done()
      })
      // Defensive: an already-idle handle (no waking work) must not hang.
      const timer = setTimeout(() => {
        if (this.agent.status === 'idle') done()
      }, 50)
      this.idleWatcher = done
    })
  }

  registerTools(specs: readonly BridgeToolSpec[]): void {
    for (const spec of specs) {
      const properties = spec.parameters.properties ?? {}
      const required = new Set(spec.parameters.required ?? [])
      const parameters: Record<string, Record<string, unknown>> = {}
      for (const [name, schema] of Object.entries(properties)) {
        parameters[name] = { ...schema, ...(required.has(name) ? { required: true } : {}) }
      }
      this.ctx.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { result: { type: 'string', required: true } },
          },
          render: (_args: unknown, value: { result: string }) => [{ type: 'text', text: value.result }],
        },
        execute: (_args: unknown, exec: ToolRunContext) => new Promise((resolve, reject) => {
          this.parked.set(exec.callId, { resolve: resolve as (value: unknown) => void, reject })
          emit({
            type: 'toolCalls',
            calls: [{ callId: exec.callId, name: exec.name, arguments: exec.arguments }],
            usage: this.usage(),
          })
        }),
      }))
    }
  }
}

async function boot(start: StartMessage): Promise<BridgeSession> {
  const ctx = new Context()
  // Benchmark fidelity: the model sees exactly the tau2 system prompt, with
  // no harness identity or runtime-context additions.
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: {
      persona: start.system,
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    },
  })
  await ctx.plugin(PiAiLlm, {
    providers: {
      dashscope: {
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        api: 'openai-completions',
        baseURL: process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultContextWindow: 131072,
        defaultMaxTokens: 16384,
        models: [{ id: start.model, name: start.model, contextWindow: 131072, maxTokens: 16384 }],
      },
    },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (start.guard) {
    await ctx.plugin(BlockadeGuard, TAU2_GUARD_CONFIG)
  }
  const agent = ctx.agentLoop.create(SessionId(start.sessionId), { provider: 'dashscope', model: start.model })
  const session = new BridgeSession(ctx, agent)
  session.registerTools(start.tools)
  return session
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin })
  let session: BridgeSession | undefined
  let turn: Promise<void> = Promise.resolve()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: InMessage
    try {
      message = JSON.parse(trimmed) as InMessage
    } catch {
      emit({ type: 'error', message: `unparseable line: ${trimmed.slice(0, 120)}` })
      return
    }
    void (async () => {
      try {
        if (message.type === 'start') {
          session = await boot(message)
          emit({ type: 'ready' })
          return
        }
        if (message.type === 'stop') {
          process.exit(0)
        }
        if (session === undefined) {
          emit({ type: 'error', message: 'session not started' })
          return
        }
        if (message.type === 'user') {
          turn = session.userTurn(message.text)
          await turn
          emit({ type: 'final', text: session.finalText(), usage: session.usage() })
          return
        }
        if (message.type === 'toolResult') {
          session.resolveTool(message.callId, message.output, message.isError)
        }
      } catch (error: unknown) {
        emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
  })

  process.stdin.on('end', () => {
    process.exit(0)
  })
}

void main()
