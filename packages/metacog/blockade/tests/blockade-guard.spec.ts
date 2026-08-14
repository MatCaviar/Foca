import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as BlockadeGuard from '@deepseek-ai/dsh-blockade'
import type { Config } from '@deepseek-ai/dsh-blockade'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the blockade guard through a real agent loop: fake-success
 * steering, the identity-grid flow, reframe/dual-path triggers, unverified
 * claims, enforce-mode blocking plus the escalation deny, and lesson commit
 * plus recall — all keyless against the scripted mock adapter.
 */

/** Fixture world state shared by the tools below. */
const state = { applied: false, admin: false, tokenIssued: false, weakStore: 0 }

function resetState(): void {
  state.applied = false
  state.admin = false
  state.tokenIssued = false
  state.weakStore = 0
}

const GUARD_CONFIG: Config = {
  families: [
    { tools: ['fx_write', 'fx_e1', 'fx_e2', 'fx_e3', 'fx_admin'], family: 'direct', familyClass: 'direct_write', pathClass: 'A_direct' },
    { tools: ['fx_user_path'], family: 'user', familyClass: 'user_equivalent_input', pathClass: 'B_user_equivalent' },
    { tools: ['fx_weak'], family: 'vendor', familyClass: 'official_entry', pathClass: 'A_direct' },
    { tools: ['fx_setup'], family: 'env', familyClass: 'env_setup', pathClass: 'A_direct' },
    { tools: ['fx_su'], family: 'esc', familyClass: 'privilege_shift', pathClass: 'A_direct' },
  ],
  probes: [
    { writes: ['fx_write'], tool: 'fx_readback', independence: 'independent', argumentMap: [{ probe: 'expect', write: 'value' }] },
    { writes: ['fx_user_path'], tool: 'fx_readback', independence: 'independent', argumentMap: [{ probe: 'expect', write: 'target' }] },
    { writes: ['fx_admin'], tool: 'fx_admin_status', independence: 'ground_truth', argumentMap: [{ probe: 'expect', write: 'enabled' }] },
    { writes: ['fx_weak'], tool: 'fx_weak_read', independence: 'actuator_store', argumentMap: [{ probe: 'expect', write: 'value' }] },
  ],
}

/** Enforce-mode copy of the standard mapping. */
function enforceConfig(): Config {
  return {
    families: GUARD_CONFIG.families ?? [],
    probes: GUARD_CONFIG.probes ?? [],
    mode: 'enforce',
  }
}

/** Boot the spine, the guard, and the fixture tool surface. */
async function harness(config: Config = GUARD_CONFIG): Promise<Context> {
  resetState()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BlockadeGuard, config)
  registerFixtureTools(ctx)
  return ctx
}

function registerFixtureTools(ctx: Context): void {
  const jsonOut = () => ({
    schema: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        observed: { type: 'string' as const, required: true as const },
        agrees: { type: 'boolean' as const },
        status: { type: 'string' as const },
      },
    },
    render: (_args: unknown, value: { observed?: string; status?: string }) => [{
      type: 'text' as const,
      text: `${value.status ?? ''} ${value.observed ?? ''}`.trim(),
    }],
  })

  ctx.tools.register(defineTool({
    name: 'fx_write',
    description: 'Swallowed direct write.',
    parameters: { value: { type: 'integer', required: true } },
    output: jsonOut(),
    execute() {
      return Promise.resolve({ status: 'SUCCESS', observed: 'write returned SUCCESS' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_user_path',
    description: 'Working user-equivalent path.',
    parameters: { target: { type: 'integer', required: true } },
    output: jsonOut(),
    execute(args: { target: number }) {
      state.applied = args.target === 42 ? true : state.applied
      return Promise.resolve({ status: 'SUCCESS', observed: 'user path applied' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_readback',
    description: 'Independent readback.',
    parameters: { expect: { type: 'integer' } },
    output: jsonOut(),
    execute(args: { expect?: number }) {
      return Promise.resolve({
        observed: `applied = ${state.applied}`,
        ...(args.expect === undefined ? {} : { agrees: state.applied }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_admin',
    description: 'Admin write requiring the service identity.',
    parameters: { enabled: { type: 'boolean', required: true }, token: { type: 'string' } },
    output: jsonOut(),
    execute(args: { enabled: boolean; token?: string }) {
      if (args.token !== 'svc') throw new Error('HTTP 403: permission denied — admin writes require the service-to-service identity')
      state.admin = args.enabled
      return Promise.resolve({ status: 'SUCCESS', observed: 'admin flag set' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_setup',
    description: 'One-time identity preparation.',
    parameters: {},
    output: jsonOut(),
    execute() {
      state.tokenIssued = true
      return Promise.resolve({ status: 'SUCCESS', observed: 'service token issued' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_admin_status',
    description: 'Ground-truth admin status.',
    parameters: { expect: { type: 'boolean' } },
    output: jsonOut(),
    execute(args: { expect?: boolean }) {
      return Promise.resolve({
        observed: `admin = ${state.admin}`,
        ...(args.expect === undefined ? {} : { agrees: state.admin === args.expect }),
      })
    },
  }))

  for (const [name, message] of [['fx_e1', 'HTTP 500: write path disabled'], ['fx_e2', 'HTTP 405: method not allowed'], ['fx_e3', 'HTTP 410: endpoint gone']] as const) {
    ctx.tools.register(defineTool({
      name,
      description: 'Erroring direct variant.',
      parameters: {},
      output: jsonOut(),
      execute() {
        throw new Error(message)
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'fx_weak',
    description: 'Write whose only readback shares the writer store.',
    parameters: { value: { type: 'integer', required: true } },
    output: jsonOut(),
    execute(args: { value: number }) {
      state.weakStore = args.value
      return Promise.resolve({ status: 'SUCCESS', observed: 'weak write accepted' })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_weak_read',
    description: 'Actuator-store readback (weak evidence).',
    parameters: { expect: { type: 'integer' } },
    output: jsonOut(),
    execute(args: { expect?: number }) {
      return Promise.resolve({
        observed: `store = ${state.weakStore}`,
        ...(args.expect === undefined ? {} : { agrees: state.weakStore === args.expect }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fx_su',
    description: 'Escalation attempt.',
    parameters: {},
    output: jsonOut(),
    execute() {
      throw new Error('su: permission denied — not in allowlist')
    },
  }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** All guard-injected contexts in an agent's log, as joined text. */
function guardTexts(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

function directiveSeen(options: GenerateOptions, marker: string): boolean {
  return options.messages.some(message => message.role === 'user'
    && message.source.kind === 'plugin'
    && message.source.plugin === 'blockade-guard'
    && message.content.some(block => block.type === 'text' && block.text.includes(marker)))
}

function callCount(agent: Agent): number {
  return [...agent.session.events].filter(e => e.type === 'tool/result').length
}

async function drive(ctx: Context, adapter: MockAdapter, followupText = 'do it'): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: followupText }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

describe('protocol 2 + 3: a swallowed write is caught and steered off the family', () => {
  it('injects the fake-success directive and the agent lands on the user-equivalent path', async () => {
    const ctx = await harness()
    const agent = await drive(ctx, new MockAdapter([
      toolCallResponse('c0', 'fx_write', { value: 42 }),
      options => (directiveSeen(options, '[blockade:p2_fake_success]')
        ? toolCallResponse('c1', 'fx_user_path', { target: 42 })
        : textResponse('done')),
      textResponse('done'),
    ]))
    const texts = guardTexts(agent)
    expect(texts.some(text => text.includes('[blockade:p2_fake_success]'))).toBe(true)
    expect(texts.some(text => text.includes('escalate'))).toBe(true)
    expect(state.applied).toBe(true)
    expect(callCount(agent)).toBe(2)
  })
})

describe('protocol 4: an explicit denial injects the identity grid', () => {
  it('steers through setup plus retry and the breakthrough verifies', async () => {
    const ctx = await harness()
    const agent = await drive(ctx, new MockAdapter([
      toolCallResponse('c0', 'fx_admin', { enabled: true }),
      options => (directiveSeen(options, '[blockade:p4_identity_grid]')
        ? toolCallResponse('c1', 'fx_setup', {})
        : textResponse('gave up')),
      toolCallResponse('c2', 'fx_admin', { enabled: true, token: 'svc' }),
      textResponse('done'),
    ]))
    expect(guardTexts(agent).some(text => text.includes('[blockade:p4_identity_grid]'))).toBe(true)
    expect(state.admin).toBe(true)
    expect(callCount(agent)).toBe(3)
  })
})

describe('protocols 1 + 5: first error seeds dual-path, third error reframes', () => {
  it('both directives fire for a same-family error run', async () => {
    const ctx = await harness()
    const agent = await drive(ctx, new MockAdapter([
      toolCallResponse('c0', 'fx_e1', {}),
      toolCallResponse('c1', 'fx_e2', {}),
      toolCallResponse('c2', 'fx_e3', {}),
      options => (directiveSeen(options, '[blockade:p5_reframe]')
        ? toolCallResponse('c3', 'fx_user_path', { target: 42 })
        : textResponse('more variants')),
      textResponse('done'),
    ]))
    const texts = guardTexts(agent)
    expect(texts.some(text => text.includes('[blockade:p1_dual_path]'))).toBe(true)
    expect(texts.some(text => text.includes('[blockade:p5_reframe]'))).toBe(true)
    expect(state.applied).toBe(true)
  })
})

describe('protocol 3: an actuator-store-only confirmation stays unverified', () => {
  it('injects the unverified directive for the same-store readback', async () => {
    const ctx = await harness()
    const agent = await drive(ctx, new MockAdapter([
      toolCallResponse('c0', 'fx_weak', { value: 7 }),
      options => (directiveSeen(options, '[blockade:p3_unverified]') ? textResponse('reporting as unverified') : textResponse('done')),
    ]))
    expect(guardTexts(agent).some(text => text.includes('[blockade:p3_unverified]'))).toBe(true)
  })
})

describe('enforce mode', () => {
  it('withholds a fake success as an error result and denies post-swallow escalation', async () => {
    const ctx = await harness(enforceConfig())
    const agent = await drive(ctx, new MockAdapter([
      toolCallResponse('c0', 'fx_write', { value: 42 }),
      toolCallResponse('c1', 'fx_su', {}),
      textResponse('done'),
    ]))
    const results = [...agent.session.events].filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results[0]!.data.message.content[0].isError).toBe(true)
    expect(results[0]!.data.message.content[0].content).toEqual([{ type: 'text', text: 'blockade-guard: fx_write reported success but independent verification contradicts it; the result is withheld as a fake success.' }])
    expect(results[1]!.data.message.content[0].isError).toBe(true)
    const suText = JSON.stringify(results[1]!.data.message.content[0].content)
    expect(suText).toContain('escalation policy')
    expect(guardTexts(agent).some(text => text.includes('[blockade:p2_fake_success]'))).toBe(true)
  })
})

describe('protocol 6: a breakthrough commits a durable lesson that later sessions recall', () => {
  it('records the lesson event and injects the recall for the next agent', async () => {
    const ctx = await harness()
    await drive(ctx, new MockAdapter([
      toolCallResponse('c0', 'fx_write', { value: 42 }),
      options => (directiveSeen(options, '[blockade:p2_fake_success]')
        ? toolCallResponse('c1', 'fx_user_path', { target: 42 })
        : textResponse('done')),
      textResponse('done'),
    ]))
    // The lesson commits inside post-execute, synchronously with the step.
    expect(ctx.blockadeGuard.lessonStore().all()[0]?.workedClass).toBe('user_equivalent_input')
    expect(ctx.blockadeGuard.lessonStore().all()[0]?.avoidClasses).toEqual(['direct_write'])

    ctx.llm.registerAdapter(['mock-recall'], new MockAdapter([
      options => (directiveSeen(options, '[blockade:p6_lesson_recall]')
        ? toolCallResponse('d0', 'fx_user_path', { target: 42 })
        : toolCallResponse('d0', 'fx_write', { value: 42 })),
      textResponse('done'),
    ]))
    const agent2 = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock-recall', model: 'mock' })
    agent2.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent2)
    expect(guardTexts(agent2).some(text => text.includes('[blockade:p6_lesson_recall]'))).toBe(true)
    // The recalled agent went straight to the working path.
    const firstCall = [...agent2.session.events].find((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(JSON.stringify(firstCall?.data.message.content)).toContain('user path applied')
  })
})

describe('config validation fails loud', () => {
  it('rejects a family row mapping no tools', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(BlockadeGuard, {
      families: [{ tools: [], family: 'x', familyClass: 'direct_write', pathClass: 'A_direct' }],
    })).rejects.toThrow(/maps no tools/)
  })

  it('rejects conflicting semantics for one family id', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(BlockadeGuard, {
      families: [
        { tools: ['a'], family: 'x', familyClass: 'direct_write', pathClass: 'A_direct' },
        { tools: ['b'], family: 'x', familyClass: 'env_setup', pathClass: 'A_direct' },
      ],
    })).rejects.toThrow(/conflicting semantics/)
  })

  it('rejects an invalid reframe limit', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(BlockadeGuard, { familyFailureLimit: 0 })).rejects.toThrow(/familyFailureLimit/)
  })
})
