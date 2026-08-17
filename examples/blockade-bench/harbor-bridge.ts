/**
 * Harbor bridge for Terminal-Bench and DeepSWE. Real tool results flow back
 * through the DeepSeek Harness tool pipeline so Focas observes failures and
 * injects recovery only when a semantic command family stagnates.
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

/** Terminal-specific wording stays concrete and intentionally short. */
const TERMINAL_DIRECTIVES = {
  carrier_search: 'This route is denied, missing, or ineffective. Do not rerun it unchanged. Find what already carries the capability: a declared project script, the repository package manager, an installed binary, an existing service, git, or another interpreter/entrypoint. Inspect manifests and command availability, then trigger that carrier and verify the resulting state.',
  p1_dual_path: 'The direct command failed. Before another attempt, compare two concrete routes: (A) repair the current command from the actual error; (B) use the project or system entrypoint that normally produces the same effect. Choose the cheaper verifiable route.',
  p3_unverified: 'The command claims success but this deployment requires independent evidence. Verify the artifact, file diff, test result, or service state before reporting completion.',
  p4_identity_grid: 'The command was denied. Treat the current identity as one option, not the conclusion: check a repository-local/user-space route, an existing service or script, the correct workspace credential, or another already-authorized carrier. Do not retry the denied call unchanged.',
  p5_reframe: 'This command kind is repeating the same failure without progress. Stop rerunning variants. Read the first unresolved error and current files/logs, make one state-changing correction, then validate once. If the required capability is absent, state the exact missing prerequisite.',
  target_missing: 'The command or target does not exist. Inspect the project manifest, scripts, PATH, and repository layout to discover the real entrypoint; do not guess another name or path.',
} as const

const TERMINAL_GUARD_CONFIG: BlockadeGuard.Config = {
  familyFailureLimit: 3,
  repeatedFailureLimit: 2,
  families: [
    {
      tools: ['run_command'],
      family: 'shell',
      familyClass: 'direct_write',
      pathClass: 'A_direct',
      partition: { argument: 'command', mode: 'command_kind' },
      verification: 'none',
    },
    {
      tools: ['write_file'],
      family: 'file-write',
      familyClass: 'direct_write',
      pathClass: 'A_direct',
      partition: { argument: 'path', mode: 'path_root' },
      verification: 'none',
      progressOnSuccess: true,
    },
  ],
  directives: TERMINAL_DIRECTIVES,
}

const LITE_GUARD_CONFIG: BlockadeGuard.Config = {
  ...TERMINAL_GUARD_CONFIG,
  protocols: {
    carrierSearch: true,
    dualPath: false,
    truthSource: false,
    identityGrid: false,
    reframe: true,
    lessons: false,
    escalationGuard: false,
  },
  directives: {
    carrier_search: 'Stop retrying that route. Inspect the repository and environment for the existing script, tool, service, package-manager command, or alternate entrypoint that already performs the capability; use it and verify once.',
    p5_reframe: 'The same command kind is failing again with no successful change in between. Read the first error and actual state, make one structurally different correction, then run one focused validation.',
    target_missing: 'The target is absent. Discover the declared entrypoint from manifests, scripts, PATH, or repository layout instead of guessing.',
  },
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
      if (event?.type !== 'assistant/message') continue
      const usage = (event as { data?: { usage?: { inputTokens?: number; outputTokens?: number } } }).data?.usage
      if (usage !== undefined) {
        this.inputTokens += usage.inputTokens ?? 0
        this.outputTokens += usage.outputTokens ?? 0
      }
    }
    return { input: this.inputTokens, output: this.outputTokens }
  }

  async userTurn(text: string): Promise<void> {
    console.error(`[bridge] userTurn: ${text.slice(0, 80)}...`)
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
    if (isError) parked.reject(new Error(output.length > 0 ? output.slice(0, 8000) : 'tool call failed'))
    else parked.resolve({ result: output })
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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
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

  const baseURL = process.env.DASHSCOPE_BASE_URL?.trim()
    || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const contextWindow = positiveInteger(process.env.DSH_CONTEXT_WINDOW, 262144)
  const maxTokens = positiveInteger(process.env.DSH_MAX_TOKENS, 32768)
  await ctx.plugin(PiAiLlm, {
    providers: {
      dashscope: {
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        api: 'openai-completions',
        baseURL,
        defaultContextWindow: contextWindow,
        defaultMaxTokens: maxTokens,
        models: [{ id: start.model, name: start.model, contextWindow, maxTokens }],
      },
    },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (start.guard === true) await ctx.plugin(BlockadeGuard, TERMINAL_GUARD_CONFIG)
  else if (start.guard === 'lite') await ctx.plugin(BlockadeGuard, LITE_GUARD_CONFIG)

  const agent = ctx.agentLoop.create(SessionId(start.sessionId), { provider: 'dashscope', model: start.model })
  ctx.on('agent/request-error', ({ failure }) => {
    console.error(`[model-error] ${JSON.stringify(failure).slice(0, 500)}`)
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
          const credentials = message as unknown as { apiKey: string; apiBase: string }
          process.env.DASHSCOPE_API_KEY = credentials.apiKey
          process.env.DASHSCOPE_BASE_URL = credentials.apiBase
          emit({ type: 'credentials_ack' })
          return
        }
        if (message.type === 'start') {
          session = await boot(message)
          emit({ type: 'ready' })
          return
        }
        if (message.type === 'stop') process.exit(0)
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
        if (message.type === 'toolResult') session.resolveTool(message.callId, message.output, message.isError)
      } catch (error: unknown) {
        emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
  })

  process.stdin.on('end', () => process.exit(0))
}

void main()
