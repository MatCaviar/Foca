/**
 * Harbor bridge: the same stdio JSON protocol as the tau2 bridge, exposed as
 * a general agent-loop bridge for harbor/Terminal-Bench. Tool calls park
 * until the harbor-side environment executes them; every real result flows
 * back through the harness pipeline where the Reframe guard observes it.
 *
 * The tool surface is fixed (run_command/read_file/write_file/list_dir) and
 * the guard families map command-style tools with write semantics
 * (write_file, run_command with mutation verbs) so P5/O3 logic applies to
 * terminal work; guard config: full or lite profiles from GUARD_PROFILE.
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
  readonly guard: boolean | 'lite'
  readonly model: string
}

type InMessage =
  | StartMessage
  | { readonly type: 'user'; readonly text: string }
  | { readonly type: 'toolResult'; readonly callId: string; readonly output: string; readonly isError: boolean }
  | { readonly type: 'stop' }

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * Reframe directives adapted for terminal work: the carrier vocabulary maps
 * to "who can already do this in the system" (package managers, existing
 * scripts, git, system services), and P5 to stopping doomed command families.
 */
const TERMINAL_DIRECTIVES = {
  carrier_search: 'The current approach cannot achieve this (command denied, missing tool, or the change had no effect). Do not retry it unchanged or escalate privileges. Search for the CAPABILITY CARRIER — what already in this system can do this: an installed tool or package, an existing script or service, git, a scheduler, a different interpreter or entrypoint? Find the cheapest controllable trigger and go through it. Search for the causal path to the target state, not for the command you first thought of.',
  p1_dual_path: 'A direct approach just failed. Before the next command, enumerate in parallel: (A) corrected direct routes (fix flags, paths, dependencies), (B) user-equivalent routes — how would the system achieve this effect itself (config reload, service restart, package hook, git workflow)? Pick the cheapest verifiable one.',
  p3_unverified: 'Several changes were made without verification. Before claiming completion, verify the real effect: run the test suite, re-read the changed file, or check the service state. Do not report success without evidence.',
  p5_reframe: 'Multiple attempts in one command family have failed. Stop iterating variants. Re-derive the goal from the task description, inspect the actual state (files, logs, versions) instead of assuming, and choose a structurally different approach — or document precisely what blocks completion.',
} as const

const TERMINAL_GUARD_CONFIG: BlockadeGuard.Config = {
  families: [
    {
      tools: ['run_command'],
      family: 'shell',
      familyClass: 'direct_write',
      pathClass: 'A_direct',
    },
    {
      tools: ['write_file'],
      family: 'file-write',
      familyClass: 'direct_write',
      pathClass: 'A_direct',
    },
  ],
  directives: TERMINAL_DIRECTIVES,
}

interface Parked {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

class BridgeSession {
  private readonly parked = new Map<string, Parked>()
  private inputTokens = 0
  private outputTokens = 0
  private usageCursor = 0

  constructor(private readonly ctx: Context, private readonly agent: Agent) {}

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

  async userTurn(text: string): Promise<void> {
    console.error(`[bridge] userTurn: ${text.slice(0, 60)}...`)
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await this.waitIdle()
    console.error(`[bridge] turn complete, events: ${this.agent.session.events.length}`)
  }

  resolveTool(callId: string, output: string, isError: boolean): void {
    const parked = this.parked.get(callId)
    if (parked === undefined) return
    this.parked.delete(callId)
    if (isError) {
      parked.reject(new Error(output.length > 0 ? output.slice(0, 8000) : 'tool call failed'))
    } else {
      parked.resolve({ result: output })
    }
  }

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
      const timer = setTimeout(() => {
        if (this.agent.status === 'idle') done()
      }, 50)
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
  if (start.guard === true) {
    await ctx.plugin(BlockadeGuard, TERMINAL_GUARD_CONFIG)
  } else if (start.guard === 'lite') {
    await ctx.plugin(BlockadeGuard, {
      ...TERMINAL_GUARD_CONFIG,
      protocols: {
        carrierSearch: true,
        dualPath: false,
        truthSource: false,
        identityGrid: false,
        reframe: true,
        lessons: false,
        escalationGuard: true,
      },
      directives: {
        carrier_search: 'That approach failed (denied, missing, or no effect). Do not retry it unchanged. Find what already works in this system — another tool, an existing script or service, a different route — and go through it.',
        p5_reframe: 'Repeated failures on the same approach. Stop; inspect the actual state (files/logs/versions), re-derive the goal, and choose a structurally different approach — or document what blocks completion.',
      },
    })
  }
  const agent = ctx.agentLoop.create(SessionId(start.sessionId), { provider: 'dashscope', model: start.model })
  // Log model request failures for debugging
  ctx.on('agent/request-error', ({ failure }) => {
    console.error(`[model-error] ${JSON.stringify(failure).slice(0, 300)}`)
  })
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
        if (message.type === ('credentials' as never)) {
          const cred = message as unknown as { apiKey: string; apiBase: string }
          process.env.DASHSCOPE_API_KEY = cred.apiKey
          process.env.DASHSCOPE_BASE_URL = cred.apiBase
          emit({ type: 'credentials_ack' })
          return
        }
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
