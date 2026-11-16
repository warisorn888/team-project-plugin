import type { CoreEngineInterface, ToolSpec } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet, apiRequest } from './api.ts'
import type { ApiOptions } from './api.ts'
import { currentBinding, markOffline } from './binding.ts'
import { recapTurn } from './recap.ts'
import { NOT_BOUND, apiFailure, parseThreadNo, pickSeq, pickedThread, resolveThread } from './threads.ts'
import type { Out } from './threads.ts'
import {
  FILTER_RULES_VERSION, applyGitleaks, fnv1a64Hex, redactRegex, renderTurn, splitChunks, turnAnchor, turnSince,
} from './transcript-filter.ts'
import type { TurnAnchor } from './transcript-filter.ts'

export type TranscriptOptions = ApiOptions & { uploadTranscript: boolean }
export type TranscriptDollar = Pick<CoreEngineInterface, 'process' | 'state' | 'ui' | 'session' | 'model'>

const SESSION = { plugin: 'team-project', key: 'transcriptSession' } as const
const FILTER = { plugin: 'team-project', key: 'transcriptFilter' } as const
const WARNED = { plugin: 'team-project', key: 'transcriptWarned' } as const
const FAILED = { plugin: 'team-project', key: 'transcriptFailed' } as const

export const GITLEAKS_ARGV = ['gitleaks', 'stdin', '--report-format', 'json', '--report-path', '-', '--no-banner', '--exit-code', '0'] as const
const GITLEAKS_TIMEOUT_MS = 20_000
export const TOAST_NO_FILTER = 'Transcript not uploaded: gitleaks unavailable (worklog still works)'
export const USAGE = 'Usage: /team transcript on|off|status'

/** The cached filter version (`tp-filter/2+gitleaks/<v>`), checking `gitleaks version` once per session; null when gitleaks is unavailable. */
async function filterVersion($: Pick<CoreEngineInterface, 'process' | 'state'>): Promise<string | null> {
  const cached = (await $.state.get(FILTER)).value
  if (cached) return cached.ok ? cached.version : null
  let version: string | null = null
  try {
    const r = await $.process.run(['gitleaks', 'version'], { timeoutMs: GITLEAKS_TIMEOUT_MS })
    const v = r.stdout.trim()
    if (r.exitCode === 0 && v !== '') version = `${FILTER_RULES_VERSION}+gitleaks/${v}`
  } catch {
    // missing binary or timeout: unavailable
  }
  await $.state.set(FILTER, version === null ? { ok: false } : { ok: true, version })
  return version
}

/** Gitleaks then our rules over `text`; null when the filter could not run (missing, timeout, non-zero exit, unreadable report). */
async function filterText($: Pick<CoreEngineInterface, 'process'>, text: string): Promise<string | null> {
  try {
    const r = await $.process.run(GITLEAKS_ARGV, { stdin: text, timeoutMs: GITLEAKS_TIMEOUT_MS })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return null
    return redactRegex(applyGitleaks(text, r.stdout))
  } catch {
    // FilterFailed (unreadable report), or a run that rejected: never send what was not filtered
    return null
  }
}

/** Tells the person once per session that nothing is uploaded. Never throws. */
async function warnOnce($: Pick<CoreEngineInterface, 'state' | 'ui'>): Promise<void> {
  try {
    if ((await $.state.get(WARNED)).value === true) return
    await $.state.set(WARNED, true)
    $.ui.toast(TOAST_NO_FILTER)
  } catch {
    // a toast never fails the turn
  }
}

/** Why nothing is uploaded, or null when uploading is on (gitleaks not checked here). */
async function offReason($: Pick<CoreEngineInterface, 'state'>, opts: { uploadTranscript?: boolean }): Promise<string | null> {
  if (opts.uploadTranscript === false) return 'turned off in settings'
  if ((await $.state.get(SESSION)).value === 'off') return 'turned off for this session'
  return null
}

// The main loop's running turn: the thread picked and the pick count when it started, and
// where the transcript stood (turnAnchor). A module value: a reload mid-turn loses it, and
// that one turn is then not uploaded.
type Started = { turnId: string; threadId: string; pickSeq: number; anchor: TurnAnchor | null; isCompacted: boolean }
let started: Started | undefined

// Uploads run one after another, off the turn: two turns' uploads never interleave, so the
// gitleaks check runs once and the toast is raised once.
let queue: Promise<void> = Promise.resolve()
// Cards run apart from uploads: a slow model call never holds up the next upload.
let recapQueue: Promise<void> = Promise.resolve()

/**
 * At a main-loop turn's start: notes the thread picked now and where the transcript stands, so
 * only what this turn adds is ever uploaded. Reads nothing when nothing would be uploaded.
 * Never throws.
 */
export async function noteTurnStart(
  $: Pick<CoreEngineInterface, 'state' | 'session'>,
  opts: { uploadTranscript?: boolean },
  e: { turnId: string; text: string; agentId?: string },
): Promise<void> {
  if (e.agentId !== undefined) return
  started = undefined
  try {
    if ((await offReason($, opts)) !== null) return
    const thread = await pickedThread($)
    if (thread === null) return
    const seq = await pickSeq($)
    const anchor = turnAnchor(await $.session.messages(), e.text)
    started = { turnId: e.turnId, threadId: thread.threadId, pickSeq: seq, anchor, isCompacted: false }
  } catch {
    started = undefined
  }
}

/**
 * A compaction of the main conversation while a turn runs: the summary covers the whole
 * session (before the pick, other threads, time with upload off), so that turn is not uploaded.
 */
export function noteCompaction(e: { agentId?: string; trigger: string }): void {
  if (e.agentId !== undefined || e.trigger === 'precompute') return
  if (started !== undefined) started.isCompacted = true
}

/**
 * After a main-session turn on a picked thread of a bound project: reads the
 * turn now, then filters it and POSTs it in parts of at most 200,000 chars in
 * the background (queued behind earlier uploads), so the turn ends at once.
 * Only a turn whose thread was picked when it started and is still picked, with
 * no pick, release or compaction in between, is sent, and only the messages it
 * added. Anything the filter cannot handle is dropped, never sent. Never throws.
 */
export async function uploadTurn(
  $: TranscriptDollar,
  opts: TranscriptOptions,
  e: { turnId?: string; agentId?: string },
): Promise<void> {
  if (e.agentId !== undefined) return
  const begun = started
  started = undefined
  try {
    if (begun === undefined || begun.turnId !== e.turnId || begun.isCompacted) return
    if ((await offReason($, opts)) !== null) return
    if ((await currentBinding($)) === null) return
    const thread = await pickedThread($)
    if (thread === null) return
    // picked, released or switched during the turn: its text is not all this thread's
    if (begun.threadId !== thread.threadId || begun.pickSeq !== (await pickSeq($))) return
    // read before returning: the next turn's messages must not slip in
    const turn = turnSince(await $.session.messages(), begun.anchor)
    if (turn === null) return // the turn's start is gone (compacted): never guess where it began
    const text = renderTurn(turn)
    if (text === '') return
    queue = queue.then(() => sendTurn($, opts, thread.threadId, text))
  } catch {
    // a failed read never fails the turn
  }
}

/** Filters and POSTs one turn's text. Never rejects. */
async function sendTurn($: TranscriptDollar, opts: TranscriptOptions, threadId: string, text: string): Promise<void> {
  try {
    const version = await filterVersion($)
    const filtered = version === null ? null : await filterText($, text)
    if (version === null || filtered === null) {
      // marks the pane header and status until a later scan succeeds
      if (version !== null) await $.state.set(FAILED, true)
      await warnOnce($)
      return
    }
    if ((await $.state.get(FAILED)).value === true) await $.state.set(FAILED, false)

    const sessionId = await $.session.id()
    const parts = splitChunks(filtered)
    for (let part = 0; part < parts.length; part++) {
      const res = await apiRequest($, opts, 'POST', `/threads/${threadId}/transcript`, {
        sessionId,
        turnHash: fnv1a64Hex(`${filtered}${part}`),
        part,
        content: parts[part],
        filterVersion: version,
      })
      if (res.status === 401) throw new TokenRejected('transcript: 401')
      if (res.status >= 500) throw new ApiUnavailable(`transcript: HTTP ${res.status}`)
      if (res.status !== 200 && res.status !== 201) return // 403 (no longer the owner), 404, 400: drop the turn
    }
    recapQueue = recapQueue.then(() => recapTurn($, opts, threadId, filtered))
  } catch (err) {
    if (!(err instanceof ApiUnavailable || err instanceof TokenRejected)) return
    try {
      await markOffline($, err)
    } catch {
      // even the status write may not fail anything
    }
  }
}

/** `/team transcript on|off|status` */
export async function transcriptCommand(
  $: Pick<CoreEngineInterface, 'process' | 'state'>,
  opts: { uploadTranscript?: boolean },
  arg: string,
): Promise<Out> {
  switch (arg.trim()) {
    case 'on':
      await $.state.set(SESSION, 'on')
      // check gitleaks again: it may have been installed since
      await $.state.set(FILTER, null)
      await $.state.set(WARNED, false)
      await $.state.set(FAILED, false)
      return { text: 'Transcript upload on for this session.' }
    case 'off':
      await $.state.set(SESSION, 'off')
      return { text: 'Transcript upload off for this session.' }
    case 'status': {
      const reason = await offReason($, opts)
      if (reason !== null) return { text: `Transcript upload: off (${reason})` }
      const version = await filterVersion($)
      if (version === null) return { text: 'Transcript upload: off (gitleaks unavailable)' }
      if ((await $.state.get(FAILED)).value === true) return { text: 'Transcript upload: off (last turn dropped: gitleaks failed; retried next turn)' }
      return { text: `Transcript upload: on (${version})` }
    }
    default:
      return { text: USAGE }
  }
}

/**
 * Whether this session uploads nothing: off in settings or for the session, gitleaks found
 * missing, or the last chunk dropped because the scan failed (until a later one succeeds).
 * Reads state only.
 */
export async function transcriptOff($: Pick<CoreEngineInterface, 'state'>, opts: { uploadTranscript?: boolean }): Promise<boolean> {
  if ((await offReason($, opts)) !== null) return true
  if ((await $.state.get(FILTER)).value?.ok === false) return true
  return (await $.state.get(FAILED)).value === true
}

// ---- tools ----

export const searchTranscriptsSpec: ToolSpec = {
  name: 'search_transcripts',
  description:
    'Search the team\'s saved conversation history (filtered transcripts of earlier sessions on this project) ' +
    'for a word or phrase. Returns matching snippets with a chunk id; use read_transcript to read one in full. ' +
    'Pass thread (e.g. "T-12") to search only that thread.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '2 to 200 characters' },
      thread: { type: 'string', description: 'Optional thread id like "T-12"' },
    },
    required: ['query'],
  },
  isDeferred: false,
}

export const readTranscriptSpec: ToolSpec = {
  name: 'read_transcript',
  description: 'Read one saved transcript chunk in full, by the chunk id a search_transcripts hit shows (after "#").',
  inputSchema: {
    type: 'object',
    properties: { chunkId: { type: 'string' } },
    required: ['chunkId'],
  },
  isDeferred: false,
}

export const transcriptToolSpecs: ToolSpec[] = [searchTranscriptsSpec, readTranscriptSpec]

type Hit = { chunkId: string; thread: string; author: { name: string }; createdAt: string; snippet: string }

const unexpected = (what: string, status: number, json: unknown) => {
  const detail = (json as { error?: unknown } | null)?.error
  return `${what}: the server answered HTTP ${status}${typeof detail === 'string' ? ` (${detail})` : ''}`
}

/** The tool `search_transcripts`. */
export async function searchTranscripts(
  $: Pick<CoreEngineInterface, 'process' | 'state'>,
  opts: ApiOptions,
  input: Record<string, unknown>,
): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const query = typeof input.query === 'string' ? input.query : ''
  const thread = typeof input.thread === 'string' && input.thread.trim() !== '' ? input.thread : undefined
  try {
    let threadParam = ''
    if (thread !== undefined) {
      const t = await resolveThread($, opts, binding, thread)
      if (t === null) return { error: `No thread "${thread.trim()}" in ${binding.name}.` }
      threadParam = `&thread=T-${parseThreadNo(t.id)}`
    }
    const res = await apiGet($, opts, `/projects/${encodeURIComponent(binding.projectId)}/transcript/search?q=${encodeURIComponent(query)}${threadParam}`)
    if (res.status === 400) return { error: unexpected('search', 400, res.json) }
    if (res.status !== 200 || !Array.isArray(res.json)) return { error: unexpected('search', res.status, res.json) }
    const hits = res.json as Hit[]
    if (hits.length === 0) return { text: `No transcript matches "${query}".` }
    return { text: hits.map(h => `${h.thread} · ${h.author.name} · ${h.createdAt} · #${h.chunkId}\n${h.snippet}`).join('\n\n') }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** The tool `read_transcript`. */
export async function readTranscript(
  $: Pick<CoreEngineInterface, 'process'>,
  opts: ApiOptions,
  input: Record<string, unknown>,
): Promise<Out> {
  const id = typeof input.chunkId === 'string' ? input.chunkId.trim().replace(/^#/, '') : ''
  if (id === '') return { error: 'chunkId is required' }
  try {
    const res = await apiGet($, opts, `/transcript/${encodeURIComponent(id)}`)
    if (res.status === 404) return { error: `Transcript chunk ${id} not found (it may have expired).` }
    if (res.status !== 200 || res.json === null) return { error: unexpected('read', res.status, res.json) }
    return { text: String((res.json as { content?: unknown }).content ?? '') }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}
