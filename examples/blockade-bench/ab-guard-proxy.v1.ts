/**
 * AutomationBench guard proxy: the six-protocol blockade logic as an
 * OpenAI-compatible request middleware.
 *
 * The benchmark runner owns the agent loop and tool execution; this proxy sits
 * between the runner and the model. Each chat.completions request carries the
 * full conversation, so the trailing tool results (the ones the environment
 * just produced) are visible here: they are classified exactly as the
 * blockade guard classifies them inside the harness tool pipeline, the same
 * per-conversation ledger rules fire, and the resulting directive is appended
 * as one final user-role steering message for THIS request only — the same
 * placement additionalContexts gets in the harness integration.
 *
 * Wire shapes seen in AutomationBench tool results:
 * - {"error": {"code": 401|403, "message": ...}}  -> explicit_denial (P4)
 * - {"error": {"code": 404, "message": ...}}      -> target_missing
 * - other {"error": ...}                          -> declared_error_other (P1/P5)
 * - {"results": ...} / non-error                  -> success (P3 readback nudge)
 *
 * Env: GUARD_UPSTREAM (base url), GUARD_API_KEY, GUARD_PORT (default 8787).
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
  tool_calls?: Array<{ id?: string, function?: { name?: string } }>
  tool_call_id?: string
}

const DIRECTIVES: Partial<Record<DirectiveKind, string>> = {
  p1_dual_path: 'A direct API action just failed. Before the next call: (1) name the exact constraint that rejected it (missing credential, wrong route, wrong parameters), (2) use api_search to discover the correct endpoint or an alternative application that provides the same data, and only then retry a corrected call or an alternative route.',
  p3_unverified: 'This action succeeded, but nothing confirms the resulting state. Before reporting the task as done, read the affected record back (GET the resource you just modified) and confirm the change took effect; do not claim completion to the user until you have read it back.',
  p4_identity_grid: 'The call was rejected as unauthorized or unavailable (e.g. no connected account for that service). That is one cell of a grid, not a verdict: enumerate the alternatives — a different connected app offering the same capability, a different route for the same app (api_search again), or the correct workspace/credential — and proceed through one of those instead of retrying the rejected call unchanged.',
  target_missing: 'The route you called does not exist. The contract is discoverable: run api_search for the capability you need and call the endpoint it returns; do not guess or mutate URLs.',
  p5_reframe: 'Multiple attempts in one approach have failed. Stop retrying variants of the same call. Re-discover the correct endpoint with api_search, verify preconditions (IDs, credentials, connected apps) with reads, and if the capability is genuinely unavailable, complete what is possible and state clearly what could not be done and why.',
}

const WRITE_TOOLS = new Set(['api_fetch', 'api_call', 'fetch'])
const FAMILY = { family: 'api-write', familyClass: 'direct_write' as const, pathClass: 'A_direct' as const }
const LIMIT = 3

interface Conversation {
  ledger: AgentLedger
}

const conversations = new Map<string, Conversation>()

function conversationKey(body: { model?: string, messages?: ChatMessage[] }): string {
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

/** Classify the trailing environment results of one request. */
function analyze(messages: ChatMessage[]): ToolOutcome[] {
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
    if (!WRITE_TOOLS.has(tool)) continue
    const raw = textOf(message.content)
    let form: ToolOutcome['form'] = 'success'
    let isError = false
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: number, message?: string } }
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

/** Decide at most one directive for this request from the ledger + outcomes. */
function steer(conversation: Conversation, outcomes: ToolOutcome[]): { kind: DirectiveKind, text: string } | undefined {
  const { ledger } = conversation
  for (const outcome of outcomes) {
    if (!outcome.isError) {
      // Success without readback verification: the P3 nudge, once per tool.
      if (ledger.shouldFire('p3_unverified', outcome.tool)) {
        return { kind: 'p3_unverified', text: DIRECTIVES.p3_unverified ?? '' }
      }
      ledger.record({ tool: outcome.tool, ...FAMILY, declaredOk: true, verdict: 'verified_success', failureForm: undefined, ruling: undefined })
      continue
    }
    const failureForm = outcome.form
    ledger.record({ tool: outcome.tool, ...FAMILY, declaredOk: false, verdict: 'declared_failure', failureForm, ruling: undefined })
    if (failureForm === 'explicit_denial' && ledger.shouldFire('p4_identity_grid', FAMILY.family)) {
      return { kind: 'p4_identity_grid', text: DIRECTIVES.p4_identity_grid ?? '' }
    }
    if (failureForm === 'target_missing' && ledger.shouldFire('target_missing', FAMILY.family)) {
      return { kind: 'target_missing', text: DIRECTIVES.target_missing ?? '' }
    }
    if (ledger.reframeDue(FAMILY.family, LIMIT) && ledger.shouldFire('p5_reframe', FAMILY.family)) {
      return { kind: 'p5_reframe', text: DIRECTIVES.p5_reframe ?? '' }
    }
    if (ledger.shouldFire('p1_dual_path', FAMILY.family)) {
      return { kind: 'p1_dual_path', text: DIRECTIVES.p1_dual_path ?? '' }
    }
  }
  return undefined
}

function handler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf-8')
    let body: { model?: string, messages?: ChatMessage[], stream?: boolean } & Record<string, unknown> = {}
    try {
      body = JSON.parse(bodyText)
    } catch { /* passthrough */ }

    let outgoing = bodyText
    if (process.env.GUARD_DEBUG !== undefined && Array.isArray(body.messages)) {
      const tail = body.messages.slice(-3).map(m => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `${m.role ?? '?'}:${text.slice(0, 40).replaceAll('\n', ' ')}`
      })
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map(tool => (tool as { function?: { name?: string } }).function?.name ?? '?').join(',')
        : ''
      console.error(`[wire] msgs=${body.messages.length} tail=${JSON.stringify(tail)} tools=${toolNames}`)
    }
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const key = conversationKey(body)
      let conversation = conversations.get(key)
      if (conversation === undefined) {
        conversation = { ledger: new AgentLedger() }
        conversations.set(key, conversation)
      }
      const outcomes = analyze(body.messages)
      if (outcomes.length > 0) console.error(`[analyze] key=${key.slice(0, 8)} outcomes=${JSON.stringify(outcomes)}`)
      const directive = steer(conversation, outcomes)
      if (directive !== undefined) {
        const messages = [...body.messages, { role: 'user', content: `${directiveMarker(directive.kind)} ${directive.text}` }]
        outgoing = JSON.stringify({ ...body, messages })
        console.error(`[steer] key=${key.slice(0, 8)} ${directiveMarker(directive.kind)} after ${messages.filter(m => m.role === 'tool').length} tool results`)
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
  console.log(`guard proxy on 127.0.0.1:${port} -> ${process.env.GUARD_UPSTREAM}`)
})
