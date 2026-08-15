import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as BlockadeGuard from '@deepseek-ai/dsh-blockade'
import type { Config as BlockadeConfig } from '@deepseek-ai/dsh-blockade'
import {
  CarWorld,
  FsWorld,
  PolicyAdapter,
  SCENARIOS,
  WebWorld,
  blockadeConfigFor,
} from '@deepseek-ai/dsh-blockade-sim'
import type { PolicyMode, Scenario } from '@deepseek-ai/dsh-blockade-sim'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * The blockade lab: the keyless experiment matrix. Every arm boots a REAL
 * agent loop; the only scripted part is the cognitive policy standing in for
 * the model — the same `PolicyAdapter` class in both arms, differing solely
 * in whether it obeys the guard's directives. Ground truth lives in the
 * simulated worlds, never in the agent's view.
 *
 * Arms:
 * - baseline  — naive policy, no guard: the four deadlock mechanisms;
 * - steered   — compliant policy plus the six-protocol guard;
 * - ablations — one protocol switched off per run, each predicted to restore
 *   exactly one mechanism's failure;
 * - transfer  — shared lesson store across sequential sessions vs isolated
 *   stores: the protocol-6 learning curve.
 */

interface RunResult {
  readonly scenario: string
  readonly arm: string
  readonly outcome: string
  readonly toolCalls: number
  readonly directives: readonly string[]
  readonly truth: boolean | undefined
  readonly trace: readonly string[]
}

const WORLD_IDS = ['car', 'web', 'fs'] as const

interface Lab {
  readonly ctx: Context
  readonly worlds: { car: CarWorld; web: WebWorld; fs: FsWorld }
}

async function boot(guard: boolean, overrides: Partial<BlockadeConfig> = {}): Promise<Lab> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const worlds = { car: new CarWorld(), web: new WebWorld(), fs: new FsWorld() }
  worlds.car.register(ctx)
  worlds.web.register(ctx)
  worlds.fs.register(ctx)
  if (guard) {
    const mapping = blockadeConfigFor([...WORLD_IDS])
    await ctx.plugin(BlockadeGuard, { ...mapping, ...overrides })
  }
  return { ctx, worlds }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status }) => { if (s === agent && status === 'idle') { d(); resolve() } }) })
}

function classify(finalText: string, truth: boolean | undefined): string {
  if (finalText.includes('FINAL:SUCCESS')) {
    if (truth === true) return 'verified_success'
    if (truth === false) return 'false_success'
    return 'success_claim_only'
  }
  if (finalText.includes('FINAL:GAVE_UP_ENV')) return 'gave_up_env_limit'
  if (finalText.includes('FINAL:GAVE_UP')) return 'gave_up'
  if (finalText.includes('FINAL:BLOCKED_HONEST')) return truth === false ? 'honest_blocked' : 'overly_conservative'
  return 'no_final_token'
}

async function runScenario(lab: Lab, scenario: Scenario, policy: PolicyMode, arm: string): Promise<RunResult> {
  const provider = `policy-${arm}-${scenario.id}`
  lab.ctx.llm.registerAdapter([provider], new PolicyAdapter(policy, scenario.script))
  const agent = lab.ctx.agentLoop.create(SessionId(`${arm}-${scenario.id}`), { provider, model: 'mock' })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: scenario.script.taskText }],
    source: { kind: 'user' },
  }))
  await waitForIdle(lab.ctx, agent)

  const events = [...agent.session.events]
  const toolCalls = events.filter(e => e.type === 'tool/result').length
  const directives: string[] = []
  const trace: string[] = []
  let finalText = ''
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'plugin') {
      const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
      const marker = /\[blockade:([a-z0-9_]+)\]/.exec(text)?.[1]
      if (marker !== undefined) {
        directives.push(marker)
        trace.push(`  ⟵ directive ${marker}`)
      }
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const isError = block.type === 'tool-result' && block.isError === true
      const text = block.type === 'tool-result'
        ? block.content.map(item => item.type === 'text' ? item.text : '').join(' ').slice(0, 90)
        : ''
      trace.push(`call ${trace.filter(line => line.startsWith('call ')).length + 1}: ${isError ? 'ERROR' : 'ok'} — ${text}`)
    }
    if (event.type === 'assistant/message') {
      const text = event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')
      if (text.length > 0) finalText = text
    }
  }
  const world = lab.worlds[scenario.world]
  return {
    scenario: scenario.id,
    arm,
    outcome: classify(finalText, scenario.groundTruth(world)),
    toolCalls,
    directives,
    truth: scenario.groundTruth(world),
    trace,
  }
}

function byId(id: string): Scenario {
  const scenario = SCENARIOS.find(item => item.id === id)
  if (scenario === undefined) throw new Error(`unknown scenario ${id}`)
  return scenario
}

const results: RunResult[] = []

describe('blockade lab: baseline vs steered vs ablations vs transfer', () => {
  it('baseline arm: the naive policy exhibits the recorded deadlock mechanisms', async () => {
    for (const scenario of SCENARIOS) {
      const lab = await boot(false)
      results.push(await runScenario(lab, scenario, 'naive', 'baseline'))
    }
    const falseSuccesses = results.filter(r => r.arm === 'baseline' && r.outcome === 'false_success')
    expect(falseSuccesses.map(r => r.scenario).sort()).toEqual(['car_hvac', 'car_media_next', 'car_sound_stage', 'car_volume', 'fs_banner'])
    const gaveUps = results.filter(r => r.arm === 'baseline' && (r.outcome === 'gave_up' || r.outcome === 'gave_up_env_limit'))
    expect(gaveUps.map(r => r.scenario).sort()).toEqual(['web_maintenance', 'web_profile'])
  })

  it('steered arm: the six-protocol guard turns fake successes into honest or verified outcomes', async () => {
    for (const scenario of SCENARIOS) {
      const lab = await boot(true)
      results.push(await runScenario(lab, scenario, 'compliant', 'steered'))
    }
    const steered = results.filter(r => r.arm === 'steered')
    expect(steered.filter(r => r.outcome === 'false_success')).toHaveLength(0)
    const volume = steered.find(r => r.scenario === 'car_volume')
    expect(volume?.outcome).toBe('verified_success')
    expect(volume?.directives).toContain('p2_fake_success')
    expect(volume?.directives).toContain('p4_identity_grid')
    expect(volume?.trace.some(line => line.includes('call 4'))).toBe(true)
    const maintenance = steered.find(r => r.scenario === 'web_maintenance')
    expect(maintenance?.outcome).toBe('verified_success')
    expect(maintenance?.directives).toContain('p4_identity_grid')
    const profile = steered.find(r => r.scenario === 'web_profile')
    expect(profile?.outcome).toBe('verified_success')
    expect(profile?.directives).toContain('p1_dual_path')
    const banner = steered.find(r => r.scenario === 'fs_banner')
    expect(banner?.outcome).toBe('verified_success')
    expect(banner?.directives).toContain('p2_fake_success')
    const honest = steered.filter(r => r.outcome === 'honest_blocked')
    expect(honest.map(r => r.scenario).sort()).toEqual(['car_hvac', 'car_media_next', 'car_sound_stage'])
    const mic = steered.find(r => r.scenario === 'car_mic_vocal')
    expect(mic?.outcome).toBe('verified_success')
  })

  it('ablation: truth source off restores mechanism 4 (trusted fake success)', async () => {
    const lab = await boot(true, { protocols: { truthSource: false } })
    const run = await runScenario(lab, byId('car_volume'), 'compliant', 'ablate-truth')
    results.push(run)
    expect(run.outcome).toBe('false_success')
  })

  it('ablation: carrier search + identity grid off restores mechanism 2 (terminal misattribution)', async () => {
    const lab = await boot(true, { protocols: { carrierSearch: false, identityGrid: false } })
    const run = await runScenario(lab, byId('web_maintenance'), 'compliant', 'ablate-identity')
    results.push(run)
    expect(run.outcome).toBe('gave_up_env_limit')
  })

  it('ablation: dual path off keeps the reframe backstop but wastes attempts', async () => {
    const lab = await boot(true, { protocols: { dualPath: false } })
    const run = await runScenario(lab, byId('web_profile'), 'compliant', 'ablate-dualpath')
    results.push(run)
    expect(run.outcome).toBe('verified_success')
    const steeredProfile = results.find(r => r.arm === 'steered' && r.scenario === 'web_profile')
    expect(run.toolCalls).toBeGreaterThan(steeredProfile?.toolCalls ?? 0)
  })

  it('ablation: dual path and reframe both off restore mechanism 3 (endless deepening, never crossing)', async () => {
    const lab = await boot(true, { protocols: { dualPath: false, reframe: false } })
    const run = await runScenario(lab, byId('web_profile'), 'compliant', 'ablate-both')
    results.push(run)
    expect(run.outcome).toBe('gave_up')
  })

  it('transfer: a shared lesson store halves first-contact attempts in later domains', async () => {
    // Isolated stores: every domain pays the discovery cost once.
    const isolated: RunResult[] = []
    for (const id of ['car_volume', 'web_profile', 'fs_banner']) {
      const lab = await boot(true, { protocols: { lessons: false } })
      isolated.push(await runScenario(lab, byId(id), 'compliant', 'transfer-isolated'))
    }
    results.push(...isolated)

    // One shared store: the car breakthrough teaches the web and fs runs.
    const shared = await boot(true)
    results.push(await runScenario(shared, byId('car_volume'), 'compliant', 'transfer-shared'))
    const webShared = await runScenario(shared, byId('web_profile'), 'compliant', 'transfer-shared')
    const fsShared = await runScenario(shared, byId('fs_banner'), 'compliant', 'transfer-shared')
    results.push(webShared, fsShared)

    expect(webShared.directives).toContain('p6_lesson_recall')
    expect(fsShared.directives).toContain('p6_lesson_recall')
    const webIsolated = isolated.find(r => r.scenario === 'web_profile')
    const fsIsolated = isolated.find(r => r.scenario === 'fs_banner')
    expect(webShared.toolCalls).toBeLessThan(webIsolated?.toolCalls ?? 99)
    expect(fsShared.toolCalls).toBeLessThan(fsIsolated?.toolCalls ?? 99)
    expect(webShared.outcome).toBe('verified_success')
    expect(fsShared.outcome).toBe('verified_success')
  })

  it('writes the experiment report', () => {
    const reportPath = resolve(fileURLToPath(new URL('.', import.meta.url)), '../report.md')
    writeFileSync(reportPath, renderReport(results), 'utf-8')
  })
})

function outcomeMark(outcome: string): string {
  switch (outcome) {
    case 'verified_success': return '✅ verified'
    case 'false_success': return '❌ FALSE SUCCESS'
    case 'honest_blocked': return '🟡 honest blocked'
    case 'gave_up_env_limit': return '⛔ gave up (env limit)'
    case 'gave_up': return '⛔ gave up'
    default: return outcome
  }
}

function renderReport(runs: readonly RunResult[]): string {
  const lines: string[] = []
  lines.push('# Blockade lab — experiment report', '')
  lines.push('Keyless, deterministic, fully reproducible (`npx vitest run examples/blockade-lab`).')
  lines.push('Both arms run the same scripted cognitive policy; the steered arm only adds obedience to blockade-guard directives.')
  lines.push('Ground truth lives in the simulated worlds, never in the agent\'s view.', '')
  lines.push('## Main comparison', '')
  lines.push('| scenario | baseline (no guard) | steered (six protocols) | calls (base→steered) |')
  lines.push('|---|---|---|---|')
  for (const scenario of SCENARIOS) {
    const base = runs.find(r => r.arm === 'baseline' && r.scenario === scenario.id)
    const steered = runs.find(r => r.arm === 'steered' && r.scenario === scenario.id)
    lines.push(`| ${scenario.id} | ${outcomeMark(base?.outcome ?? '?')} | ${outcomeMark(steered?.outcome ?? '?')} | ${base?.toolCalls ?? '?'}→${steered?.toolCalls ?? '?'} |`)
  }
  const baseFalse = runs.filter(r => r.arm === 'baseline' && r.outcome === 'false_success').length
  const steeredFalse = runs.filter(r => r.arm === 'steered' && r.outcome === 'false_success').length
  const steeredVerified = runs.filter(r => r.arm === 'steered' && r.outcome === 'verified_success').length
  lines.push('', `**False successes: ${baseFalse} (baseline) → ${steeredFalse} (steered). Verified breakthroughs with the guard: ${steeredVerified}.**`, '')
  lines.push('## Ablations (one protocol off each)', '')
  lines.push('| arm | scenario | outcome | calls | restored mechanism |')
  lines.push('|---|---|---|---|---|')
  const ablationMechanisms: Record<string, string> = {
    'ablate-truth': 'M4: trusted declared success',
    'ablate-identity': 'M2: terminal misattribution',
    'ablate-dualpath': 'M1: no dual-path enumeration (backstop survives)',
    'ablate-both': 'M3: endless deepening, never crossing',
  }
  for (const arm of ['ablate-truth', 'ablate-identity', 'ablate-dualpath', 'ablate-both']) {
    const run = runs.find(r => r.arm === arm)
    if (run === undefined) continue
    lines.push(`| ${arm} | ${run.scenario} | ${outcomeMark(run.outcome)} | ${run.toolCalls} | ${ablationMechanisms[arm] ?? ''} |`)
  }
  lines.push('', '## Lesson transfer (protocol 6)', '')
  lines.push('| store | car_volume calls | web_profile calls | fs_banner calls |')
  lines.push('|---|---|---|---|')
  const iso = (id: string): number => runs.find(r => r.arm === 'transfer-isolated' && r.scenario === id)?.toolCalls ?? -1
  const sha = (id: string): number => runs.find(r => r.arm === 'transfer-shared' && r.scenario === id)?.toolCalls ?? -1
  lines.push(`| isolated | ${iso('car_volume')} | ${iso('web_profile')} | ${iso('fs_banner')} |`)
  lines.push(`| shared (car first) | ${sha('car_volume')} | ${sha('web_profile')} | ${sha('fs_banner')} |`)
  lines.push('', 'The shared-store web and fs runs receive the `p6_lesson_recall` directive at session start and go straight to the official entry point.', '')
  lines.push('## Cognitive trace — car_volume, steered (the recorded breakthrough, replayed autonomously)', '')
  const volume = runs.find(r => r.arm === 'steered' && r.scenario === 'car_volume')
  lines.push('```text')
  lines.push(...(volume?.trace ?? ['(missing)']))
  lines.push('```', '')
  lines.push('Directives fired: ' + (volume?.directives.join(', ') ?? '-'), '')
  return lines.join('\n')
}
