import type { CoreEngineInterface, ToolSpec } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet } from './api.ts'
import type { ApiOptions } from './api.ts'
import type { TeamProjectBinding } from '../types/index.d.ts'

export type MemberRef = { memberId: string; name: string }

export type InstructionsDto = {
  version: number
  body: string
  changeNote: string | null
  editedBy: MemberRef
  editedAt: string
}

export type DecisionIndexDto = { id: string; title: string; scope: string | null }

export type DecisionDto = {
  id: string
  title: string
  reasoning: string
  alternatives: string | null
  scope: string | null
  status: string
  sourceThread: string | null
  prUrl: string | null
  supersededBy: string | null
  createdBy: MemberRef
  createdAt: string
  // the library file versions it cites (absent from older servers)
  libraryRefs?: { fileId: string; name: string; version: number }[]
}

/** The part of `$` the memory code uses. */
export type MemoryDollar = Pick<CoreEngineInterface, 'process' | 'state' | 'ui' | 'clock'>

export const MEMORY_TTL_MS = 60_000
/** The memory text's first line, which tells a conversation that holds it. */
export const memoryHeading = (name: string) => `## Team Project: ${name}`

/** One decision's line in the index the prompt carries. */
export const decisionLine = (d: DecisionIndexDto): string => `${d.id} · ${d.title} · scope: ${d.scope ?? '-'}`

/** The line telling the model the library exists (only when it holds files). */
export const libraryLine = (count: number): string =>
  `Team library: ${count} files. Search with library_search, open with library_get.`

export function memorySection(name: string, instructions: InstructionsDto, index: DecisionIndexDto[], libraryCount = 0): string {
  const lines = index.map(decisionLine)
  return [
    memoryHeading(name),
    '',
    instructions.body,
    '',
    '### Decisions (call get_decision for reasoning)',
    ...(lines.length > 0 ? lines : ['(none yet)']),
    ...(libraryCount > 0 ? ['', libraryLine(libraryCount)] : []),
  ].join('\n')
}

/** How many files the project library holds; 0 when the list cannot be had (the line is left out). Never throws. */
async function libraryCount($: MemoryDollar, opts: ApiOptions, base: string): Promise<number> {
  try {
    const res = await apiGet($, opts, `${base}/library`)
    return res.status === 200 && Array.isArray(res.json) ? res.json.length : 0
  } catch {
    return 0
  }
}

type Entry = { text: string; at: number } | { failure: Error; at: number }
const cache = new Map<string, Entry>()
// A failed fetch is remembered briefly, so a down server costs one wait, not one per prompt.
const FAILURE_TTL_MS = 15_000

/** Drops the cached memory of a project, so the next prompt reads fresh. */
export const invalidateMemory = (projectId: string): void => {
  cache.delete(projectId)
}

/** The memory text for a bound project, cached per project id; rejects ApiUnavailable / TokenRejected. */
export async function loadMemory($: MemoryDollar, opts: ApiOptions, binding: TeamProjectBinding): Promise<string> {
  const hit = cache.get(binding.projectId)
  const now = await $.clock.now()
  if (hit !== undefined) {
    if ('text' in hit && now - hit.at < MEMORY_TTL_MS) return hit.text
    if ('failure' in hit && now - hit.at < FAILURE_TTL_MS) throw hit.failure
  }
  try {
    const base = `/projects/${encodeURIComponent(binding.projectId)}`
    const [ins, idx, files] = await Promise.all([
      apiGet($, opts, `${base}/instructions`),
      apiGet($, opts, `${base}/decisions/index`),
      libraryCount($, opts, base),
    ])
    if (ins.status !== 200 || idx.status !== 200 || ins.json === null || !Array.isArray(idx.json)) {
      throw new ApiUnavailable(`memory fetch: HTTP ${ins.status}/${idx.status}`)
    }
    const text = memorySection(binding.name, ins.json as InstructionsDto, idx.json as DecisionIndexDto[], files)
    cache.set(binding.projectId, { text, at: now })
    return text
  } catch (err) {
    if (err instanceof ApiUnavailable || err instanceof TokenRejected) {
      cache.set(binding.projectId, { failure: err, at: now })
    }
    throw err
  }
}

export const getDecisionSpec: ToolSpec = {
  name: 'get_decision',
  description:
    'Get the full reasoning of a team decision from this project\'s memory, by id (e.g. "D-7"). ' +
    'The decisions index in the system prompt lists the ids.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Decision id like "D-7" (or just "7")' } },
    required: ['id'],
  },
  isDeferred: false,
}

/** "D-7" or "7" -> 7; anything else -> null. */
export const parseDecisionNo = (id: unknown): number | null => {
  const m = typeof id === 'string' ? /^(?:D-)?(\d{1,9})$/.exec(id.trim()) : null
  return m ? Number(m[1]) : null
}

export function decisionText(d: DecisionDto): string {
  const refs = Array.isArray(d.libraryRefs) ? d.libraryRefs.map(r => `${r.name} v${r.version}`) : []
  return [
    `${d.id} · ${d.title}`,
    `Status: ${d.status}${d.supersededBy ? ` (superseded by ${d.supersededBy})` : ''}`,
    `Scope: ${d.scope ?? '-'}`,
    `Source thread: ${d.sourceThread ?? '-'}`,
    `PR: ${d.prUrl ?? '-'}`,
    ...(refs.length > 0 ? [`Library files: ${refs.join(', ')} (open with library_get)`] : []),
    '',
    'Reasoning:',
    d.reasoning,
    '',
    'Alternatives:',
    d.alternatives ?? '-',
  ].join('\n')
}

/** Runs get_decision: resolves the text, or `{ error }` the tool call should deny with. */
export async function getDecision(
  $: MemoryDollar,
  opts: ApiOptions,
  binding: TeamProjectBinding | null,
  id: unknown,
): Promise<{ text: string } | { error: string }> {
  const no = parseDecisionNo(id)
  if (no === null) return { error: 'Expected a decision id like D-7' }
  if (binding === null) return { error: 'No Team Project is bound to this session. Use /team use <name>.' }
  try {
    const res = await apiGet($, opts, `/projects/${encodeURIComponent(binding.projectId)}/decisions/${no}`)
    if (res.status === 404) return { error: `D-${no} not found` }
    if (res.status !== 200 || res.json === null) return { error: `Team Project server answered HTTP ${res.status}` }
    return { text: decisionText(res.json as DecisionDto) }
  } catch (err) {
    if (err instanceof TokenRejected) return { error: 'Team Project token rejected; check the plugin token.' }
    if (err instanceof ApiUnavailable) return { error: 'Team Project server is unreachable (offline).' }
    throw err
  }
}

function appendUser($: Pick<CoreEngineInterface, 'session'>, text: string) {
  return $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

/**
 * A thread's system prompt is fixed once its first request is sent (a changed
 * `prompt.compose` answer is not sent while the recorded prompt stands), so a
 * memory change made from this session also reaches the model as a user-role
 * message. Never throws.
 */
export async function noteMemory($: Pick<CoreEngineInterface, 'session'>, change: string): Promise<void> {
  try {
    await appendUser($, `Team memory updated: ${change}`)
  } catch {
    // the change is saved on the server; the note is only a courtesy to the model
  }
}

/**
 * Whether the main conversation still holds `binding`'s memory: a user message that carries its
 * heading (sent as a message, or context the engine shows in the text), or the prompt it last rode
 * beside. False after a compaction took them, past the read's cap, or when the read fails.
 */
export async function hasMemory(
  $: Pick<CoreEngineInterface, 'session'>,
  binding: TeamProjectBinding,
  prompt: string | undefined,
): Promise<boolean> {
  try {
    const heading = memoryHeading(binding.name)
    const messages = await $.session.messages()
    return messages.some(m => m.role === 'user' && typeof m.text === 'string' && (m.text.includes(heading) || (prompt !== undefined && prompt !== '' && m.text.startsWith(prompt))))
  } catch {
    return false
  }
}

/** Sends the whole memory text as a message, for a conversation that started without it. Resolves whether it was sent; never throws. */
export async function sendMemory($: Pick<CoreEngineInterface, 'session'>, text: string): Promise<boolean> {
  try {
    const r = await appendUser($, `Team memory (the project this session is now bound to):\n${text}`)
    return r.deny === undefined
  } catch {
    return false
  }
}

/** Loads the memory and sends it as a message (after `/team use` binds another project). Resolves whether it was sent; never throws. */
export async function announceMemory(
  $: MemoryDollar & Pick<CoreEngineInterface, 'session'>,
  opts: ApiOptions,
  binding: TeamProjectBinding,
): Promise<boolean> {
  try {
    return await sendMemory($, await loadMemory($, opts, binding))
  } catch {
    return false // offline or refused: the next compose tries again
  }
}
