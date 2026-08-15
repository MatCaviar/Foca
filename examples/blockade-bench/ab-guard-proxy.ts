/**
 * FRAMESHIFT guard proxy v2 — the six-protocol metacognition as an
 * OpenAI-compatible request middleware, with the optimizations the first
 * evaluation round motivated:
 *
 * O1 capability-adaptive profiles — GUARD_PROFILE=full|lite. The lite profile
 *    carries only the essential reframe directives (P4 denial guidance, P5
 *    stop-deepening) in compressed form, for models whose instruction
 *    capacity the full set crowds out (the measured regressions on
 *    qwen3.6-flash and deepseek-v4-flash).
 * O2 readback discipline — P3 fires once per conversation, and only after a
 *    write streak (>=2 writes with no intervening read), instead of once per
 *    write tool; the first write of a streak is where mistakes are cheap.
 * O3 step-budget awareness — beyond a conversation-length threshold, only
 *    failure-driven directives (P4/P5) fire; P1/P3 are suppressed so steering
 *    never consumes the benchmark's step budget.
 * O6 zero-config families — when GUARD_TOOLS is unset, write tools are
 *    auto-classified by verb patterns, so new benchmarks need no mapping.
 *
 * Env: GUARD_UPSTREAM, GUARD_API_KEY, GUARD_PORT, GUARD_PROFILE (full|lite,
 * default full), GUARD_TOOLS (comma list; default auto), GUARD_DEBUG.
 * @module @deepseek-ai/dsh-blockade-bench
 */

import * as http from 'node:http'
import * as https from 'node:https'
import { createHash } from 'node:crypto'
import { AgentLedger } from '@deepseek-ai/dsh-blockade'
import type { DirectiveKind } from '@deepseek-ai/dsh-blockade'
import { directiveMarker } from '@deepseek-ai/dsh-blockade'

interface ChatMessage {
  role?: string
  content?: unknown
  tool_calls?: Array<{ id?: string; function?: { name?: string } }>
  tool_call_id?: string
}

type SteerKind = DirectiveKind | 'carrier_search'

const CARRIER_SEARCH_FULL = 'The current executor cannot perform this action (denied, or the write was swallowed). Do not retry it unchanged and do not escalate. Search for a CAPABILITY CARRIER — who in this system can ALREADY do this: the user, a system UI entry, a daemon, an existing service, a diagnostic tool, a scheduler, a browser, a CLI, another application, a remote worker? Find the cheapest controllable trigger channel from where you are to that carrier and fire the action through it. Search for the causal path that produces the target state, not for an API to call.'

const FULL_DIRECTIVES: Partial<Record<SteerKind, string>> = {
  p1_dual_path: 'A direct action just failed. Generate BOTH candidate lists in parallel (not as fallback): (A) direct paths — corrected calls and alternative apps or routes (api_search); (B) user-equivalent paths — the entry a human would use for this effect, and whether you can trigger it. Then pick the cheapest, boundary-correct, verifiable candidate.',
  p3_unverified: 'Several changes have been made without any read-back. Before reporting the task as done, read the affected records back (GET what you just modified) and confirm the changes took effect; do not claim completion until verified.',
  p4_identity_grid: 'The call was rejected as unauthorized or unavailable (e.g. no connected account for that service). That is one cell of a grid, not a verdict: enumerate the alternatives — a different connected app offering the same capability, a different route for the same app (api_search again), or the correct workspace/credential — and proceed through one of those instead of retrying the rejected call unchanged.',
  target_missing: 'The route you called does not exist. The contract is discoverable: run api_search for the capability you need and call the endpoint it returns; do not guess or mutate URLs.',
  p5_reframe: 'Multiple attempts in one approach have failed. Stop retrying variants of the same call. Re-discover the correct endpoint with api_search, verify preconditions (IDs, credentials, connected apps) with reads, and if the capability is genuinely unavailable, complete what is possible and state clearly what could not be done and why.',
}

/** O1: the lite profile — only the failure-driven essentials, compressed. */
const LITE_DIRECTIVES: Partial<Record<SteerKind, string>> = {
  p4_identity_grid: 'That call was rejected (unauthorized or unavailable). Do not retry it unchanged: use api_search to find the correct endpoint or an alternative connected app, then call that instead.',
  carrier_search: 'That call failed (denied or swallowed). Do not retry it. Find who already can do this — another connected app, a different route (api_search), or another entry — and trigger it there.',
  p5_reframe: 'Repeated failures on the same approach. Stop; use api_search to find the right endpoint or an alternative carrier, verify with one read, then proceed — or state clearly what cannot be done.',
}

/** O1: which protocols each profile may fire. */
const PROFILE_PROTOCOLS: Record<string, ReadonlySet<DirectiveKind>> = {
  full: new Set(['carrier_search', 'p1_dual_path', 'p3_unverified', 'p4_identity_grid', 'target_missing', 'p5_reframe'] as SteerKind[]),
  lite: new Set(['carrier_search', 'p5_reframe'] as SteerKind[]),
}

/** O6: verb-pattern auto-classification of write tools. */
const WRITE_VERBS = /(fetch|call|send|create|update|patch|delete|remove|add|set|post|put|mutate|write|execute|submit|book|cancel|modify|transfer|issue|apply)/i
const READ_VERBS = /^(api_)?(search|get|list|read|query|find|lookup|describe|show|check)/i

function classifyWriteTools(messages: ChatMessage[], configured: string | undefined): Set<string> {
  if (configured !== undefined && configured !== '') {
    return new Set(configured.split(',').map(name => name.trim()).filter(name => name.length > 0))
  }
  const names = new Set<string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name
      if (name === undefined) continue
      if (READ_VERBS.test(name)) continue
      if (WRITE_VERBS.test(name)) names.add(name)
    }
  }
  return names
}

const FAMILY = { family: 'api-write', familyClass: 'direct_write' as const, pathClass: 'A_direct' as const }
const LIMIT = 3
/** O3: beyond this many messages, only failure-driven directives fire. */
const LONG_CONVERSATION = 40
/** O2: writes without an intervening read before the P3 nudge fires. */
const WRITE_STREAK_FOR_P3 = 2

interface Conversation {
  ledger: AgentLedger
  writeStreak: number
  p3Fired: boolean
}

const conversations = new Map<string, Conversation>()

function conversationKey(body: { model?: string; messages?: ChatMessage[] }): string {
  const messages = body.messages ?? []
  const system = messages[0]?.role === 'system' ? JSON.stringify(messages[0]?.content) : ''
  const firstUser = messages.find(message => message.role === 'user')
  const seed = `${body.model ?? ''}|${system}|${JSON.stringify(firstUser?.content ?? '')}`
  return createHash('md5').update(seed).digest('hex')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: string }).text ?? '') : '').join('')
  return ''
}

interface ToolOutcome {
  readonly tool: string
  readonly isError: boolean
  readonly form: 'explicit_denial' | 'target_missing' | 'declared_error_other' | 'success'
}

function analyze(messages: ChatMessage[], writeTools: Set<string>): ToolOutcome[] {
  const nameById = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.id !== undefined && call.function?.name !== undefined) nameById.set(call.id, call.function.name)
    }
  }
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') { lastAssistant = i; break }
  }
  const outcomes: ToolOutcome[] = []
  for (const message of messages.slice(lastAssistant + 1)) {
    if (message.role !== 'tool') continue
    const tool = nameById.get(message.tool_call_id ?? '') ?? 'unknown'
    if (!writeTools.has(tool)) continue
    const raw = textOf(message.content)
    let form: ToolOutcome['form'] = 'success'
    let isError = false
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: number; message?: string } }
      if (parsed?.error !== undefined) {
        isError = true
        const code = parsed.error.code
        if (code === 401 || code === 403) form = 'explicit_denial'
        else if (code === 404 || /no handler/i.test(parsed.error.message ?? '')) form = 'target_missing'
        else form = 'declared_error_other'
      }
    } catch {
      if (/^error|"error"/i.test(raw.slice(0, 40))) { isError = true; form = 'declared_error_other' }
    }
    outcomes.push({ tool, isError, form })
  }
  return outcomes
}

function steer(conversation: Conversation, outcomes: ToolOutcome[], profile: string, longConversation: boolean): { kind: DirectiveKind; text: string } | undefined {
  const allowed = PROFILE_PROTOCOLS[profile] ?? new Set(['carrier_search', 'p1_dual_path', 'p3_unverified', 'p4_identity_grid', 'target_missing', 'p5_reframe'] as DirectiveKind[])
  const directives = profile === 'lite' ? LITE_DIRECTIVES : FULL_DIRECTIVES
  const { ledger } = conversation
  for (const outcome of outcomes) {
    if (!outcome.isError) {
      conversation.writeStreak += 1
      ledger.record({ tool: outcome.tool, ...FAMILY, declaredOk: true, verdict: 'verified_success', failureForm: undefined, ruling: undefined })
      // O2: one nudge per conversation, only once a write streak has built up.
      if (
        allowed.has('p3_unverified')
        && !longConversation
        && !conversation.p3Fired
        && conversation.writeStreak >= WRITE_STREAK_FOR_P3
        && ledger.shouldFire('p3_unverified', 'conversation')
      ) {
        conversation.p3Fired = true
        return { kind: 'p3_unverified', text: FULL_DIRECTIVES.p3_unverified ?? '' }
      }
      continue
    }
    conversation.writeStreak = 0
    const failureForm = outcome.form
    ledger.record({ tool: outcome.tool, ...FAMILY, declaredOk: false, verdict: 'declared_failure', failureForm, ruling: undefined })
    if (failureForm === 'explicit_denial' && allowed.has('carrier_search') && ledger.shouldFire('carrier_search', FAMILY.family)) {
      return { kind: 'carrier_search', text: CARRIER_SEARCH_FULL }
    }
    if (failureForm === 'explicit_denial' && allowed.has('p4_identity_grid') && ledger.shouldFire('p4_identity_grid', FAMILY.family)) {
      return { kind: 'p4_identity_grid', text: directives.p4_identity_grid ?? '' }
    }
    if (failureForm === 'target_missing' && allowed.has('target_missing') && ledger.shouldFire('target_missing', FAMILY.family)) {
      return { kind: 'target_missing', text: directives.target_missing ?? '' }
    }
    if (allowed.has('p5_reframe') && ledger.reframeDue(FAMILY.family, LIMIT) && ledger.shouldFire('p5_reframe', FAMILY.family)) {
      return { kind: 'p5_reframe', text: directives.p5_reframe ?? '' }
    }
    if (allowed.has('p1_dual_path') && !longConversation && ledger.shouldFire('p1_dual_path', FAMILY.family)) {
      return { kind: 'p1_dual_path', text: directives.p1_dual_path ?? '' }
    }
  }
  return undefined
}

function handler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf-8')
    let body: { model?: string; messages?: ChatMessage[]; tools?: unknown[] } & Record<string, unknown> = {}
    try {
      body = JSON.parse(bodyText)
    } catch { /* passthrough */ }

    let outgoing = bodyText
    const profile = process.env.GUARD_PROFILE ?? 'full'
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const writeTools = classifyWriteTools(body.messages, process.env.GUARD_TOOLS)
      const key = conversationKey(body)
      let conversation = conversations.get(key)
      if (conversation === undefined) {
        conversation = { ledger: new AgentLedger(), writeStreak: 0, p3Fired: false }
        conversations.set(key, conversation)
      }
      const outcomes = analyze(body.messages, writeTools)
      if (process.env.GUARD_DEBUG !== undefined && outcomes.length > 0) {
        console.error(`[analyze] key=${key.slice(0, 8)} profile=${profile} outcomes=${JSON.stringify(outcomes)}`)
      }
      const longConversation = body.messages.length > LONG_CONVERSATION
      const directive = steer(conversation, outcomes, profile, longConversation)
      if (directive !== undefined) {
        const messages = [...body.messages, { role: 'user', content: `${directiveMarker(directive.kind)} ${directive.text}` }]
        outgoing = JSON.stringify({ ...body, messages })
        console.error(`[steer] key=${key.slice(0, 8)} profile=${profile} ${directiveMarker(directive.kind)} msgs=${body.messages.length}`)
      }
    }

    const upstream = new URL((process.env.GUARD_UPSTREAM ?? '') + request.url)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name === 'host' || name === 'content-length' || name === 'connection') continue
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    if (process.env.GUARD_API_KEY !== undefined && process.env.GUARD_API_KEY !== '') headers.authorization = `Bearer ${process.env.GUARD_API_KEY}`
    headers['content-length'] = String(Buffer.byteLength(outgoing))

    const transport = upstream.protocol === 'https:' ? https : http
    const upstreamRequest = transport.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        method: request.method,
        path: `${upstream.pathname}${upstream.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstreamRequest.on('error', (error: Error) => {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `guard proxy upstream failure: ${error.message}` } }))
    })
    upstreamRequest.end(outgoing)
  })
}

const port = Number(process.env.GUARD_PORT ?? 8787)
http.createServer(handler).listen(port, '127.0.0.1', () => {
  console.log(`reframe guard proxy v2 on 127.0.0.1:${port} -> ${process.env.GUARD_UPSTREAM} profile=${process.env.GUARD_PROFILE ?? 'full'}`)
})
