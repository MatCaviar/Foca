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
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: current, status }) => {
      if (current === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function guardTexts(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
    .map(event => event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

function directiveSeen(options: GenerateOptions, marker: string): boolean {
  return options.messages.some(message => message.role === 'user'
    && message.source.kind === 'plugin'
    && message.source.plugin === 'blockade-guard'
    && message.content.some(block => block.type === 'text' && block.text.includes(marker)))
}

async function boot(config: BlockadeGuard.Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BlockadeGuard, config)
  return ctx
}

describe('progress-aware guard', () => {
  it('keeps mapped successes transparent when no probe is configured', async () => {
    const ctx = await boot({
      families: [{
        tools: ['fx_write'],
        family: 'write',
        familyClass: 'direct_write',
        pathClass: 'A_direct',
        verification: 'mapped',
        progressOnSuccess: true,
      }],
    })
    ctx.tools.register(defineTool({
      name: 'fx_write',
      description: 'Successful write with no deployment probe.',
      parameters: {},
      output: {
        schema: { type: 'object' as const, additionalProperties: false as const, properties: { ok: { type: 'boolean' as const, required: true as const } } },
        render: (_args: unknown, value: { ok: boolean }) => [{ type: 'text' as const, text: value.ok ? 'ok' : 'not ok' }],
      },
      execute: () => Promise.resolve({ ok: true }),
    }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c0', 'fx_write', {}),
      options => directiveSeen(options, '[blockade:p3_unverified]') ? textResponse('over-steered') : textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('progress-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(guardTexts(agent)).toEqual([])
    expect(ctx.blockadeGuard.ledgerOf(agent).attempts()[0]?.verdict).toBe('declared_success')
  })

  it('partitions broad terminal tools by command kind and path root', async () => {
    const ctx = await boot({
      families: [
        {
          tools: ['run_command'], family: 'shell', familyClass: 'direct_write', pathClass: 'A_direct',
          partition: { argument: 'command', mode: 'command_kind' }, verification: 'none',
        },
        {
          tools: ['write_file'], family: 'file', familyClass: 'direct_write', pathClass: 'A_direct',
          partition: { argument: 'path', mode: 'path_root' }, verification: 'none', progressOnSuccess: true,
        },
      ],
    })
    expect(ctx.blockadeGuard.resolveFamily('run_command', { command: 'pytest -q' })?.family).toBe('shell:test')
    expect(ctx.blockadeGuard.resolveFamily('run_command', { command: 'rg TODO src' })?.family).toBe('shell:inspect')
    expect(ctx.blockadeGuard.resolveFamily('write_file', { path: 'src/core/a.ts' })?.family).toBe('file:src')
    expect(ctx.blockadeGuard.familyOf('prefix-run_command-suffix')).toBeUndefined()
  })



  it('keeps internal verification probes out of the agent attempt ledger', async () => {
    const ctx = await boot({
      families: [{
        tools: ['fx_*'],
        family: 'write',
        familyClass: 'direct_write',
        pathClass: 'A_direct',
        verification: 'mapped',
      }],
      probes: [{
        writes: ['fx_write'],
        tool: 'fx_probe',
        independence: 'independent',
        argumentMap: [{ probe: 'expect', write: 'value' }],
      }],
    })
    const output = {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          agrees: { type: 'boolean' as const },
          observed: { type: 'string' as const, required: true as const },
        },
      },
      render: (_args: unknown, value: { observed: string }) => [{ type: 'text' as const, text: value.observed }],
    }
    ctx.tools.register(defineTool({
      name: 'fx_write',
      description: 'Verified write.',
      parameters: { value: { type: 'integer', required: true } },
      output,
      execute: () => Promise.resolve({ observed: 'write accepted' }),
    }))
    ctx.tools.register(defineTool({
      name: 'fx_probe',
      description: 'Independent probe that is also covered by the broad family wildcard.',
      parameters: { expect: { type: 'integer', required: true } },
      output,
      execute: () => Promise.resolve({ agrees: true, observed: 'effect present' }),
    }))
    ctx.llm.registerAdapter(['mock-probe'], new MockAdapter([
      toolCallResponse('c0', 'fx_write', { value: 7 }),
      textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('progress-probe'), { provider: 'mock-probe', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const attempts = ctx.blockadeGuard.ledgerOf(agent).attempts()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.tool).toBe('fx_write')
    expect(attempts[0]?.verdict).toBe('verified_success')
  })

  it('rejects a non-positive probe timeout at load', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(BlockadeGuard, { probeTimeoutMs: 0 })).rejects.toThrow(/probeTimeoutMs/)
  })

  it('applies deployment carrier-search wording instead of the generic fallback', async () => {
    const ctx = await boot({
      families: [{ tools: ['fx_denied'], family: 'x', familyClass: 'direct_write', pathClass: 'A_direct' }],
      directives: { carrier_search: 'CUSTOM CARRIER RECOVERY' },
    })
    ctx.tools.register(defineTool({
      name: 'fx_denied',
      description: 'Denied call.',
      parameters: {},
      output: {
        schema: { type: 'object' as const, additionalProperties: false as const, properties: {} },
        render: () => [{ type: 'text' as const, text: 'denied' }],
      },
      execute() { throw new Error('permission denied') },
    }))
    ctx.llm.registerAdapter(['mock-carrier'], new MockAdapter([
      toolCallResponse('c0', 'fx_denied', {}),
      textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('progress-2'), { provider: 'mock-carrier', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(guardTexts(agent).some(text => text.includes('CUSTOM CARRIER RECOVERY'))).toBe(true)
  })
})
