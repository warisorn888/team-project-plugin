import type { CoreEngineInterface, ToolSpec } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet, apiRequest } from './api.ts'
import type { ApiOptions } from './api.ts'
import { markAnswersSeen, stopWaiting } from './answers.ts'
import { currentBinding } from './binding.ts'
import { redactRegex } from './transcript-filter.ts'
import type { RecapDto } from './recap.ts'
import { decisionLine, invalidateMemory, noteMemory } from './memory.ts'
import type { InstructionsDto, MemberRef } from './memory.ts'
import type { TeamProjectBinding, TeamProjectThread } from '../types/index.d.ts'

export type ThreadDto = {
  id: string
  threadId: string
  title: string
  goal: string
  status: string
  owner: MemberRef | null
  prUrl: string | null
  lastActivityAt: string
  recap?: RecapDto | null
}
export type WorklogDto = {
  entryId: string
  author: MemberRef
  kind: string
  summary: string
  reasoning: string | null
  refs: string[]
  trigger: string
  decisionId: string | null
  // an answer: the question (blocker entry) it answers; null otherwise
  replyTo: string | null
  createdAt: string
}
export type ThreadDetailDto = { thread: ThreadDto; worklog: WorklogDto[]; transcriptChunks?: number }

export type Trigger = 'pr_open' | 'waiting' | 'release'
export type Summary = { summary: string; reasoning: string }

/** The part of `$` the thread commands and tools use. */
export type ThreadDollar = Pick<
  CoreEngineInterface,
  'process' | 'state' | 'store' | 'ui' | 'clock' | 'model' | 'session'
>

/** A command's reply text, or a tool's result text / error text. */
export type Out = { text: string } | { error: string }

const THREAD = { plugin: 'team-project', key: 'thread' } as const

/** Notes that the server saw activity on the picked thread now (pick, worklog, status and touch all bump it). */
export async function noteTouch($: Pick<CoreEngineInterface, 'state' | 'clock'>): Promise<void> {
  await $.state.set({ plugin: 'team-project', key: 'lastTouch' }, await $.clock.now())
}

/** When the server last saw activity on the picked thread, or undefined if unknown. */
export async function lastTouch($: Pick<CoreEngineInterface, 'state'>): Promise<number | undefined> {
  return (await $.state.get({ plugin: 'team-project', key: 'lastTouch' })).value
}
export const NOT_BOUND = 'No Team Project is bound to this session. Use /team use <name>.'
const NO_THREAD = 'No thread picked; use /team pick'
const UNREACHABLE = 'The Team Project server is unreachable. Try again later.'
const REJECTED = 'The Team Project server rejected the token. Check the plugin token.'

/** The readable text for an API failure, or null for any other error. */
export function apiFailure(err: unknown): string | null {
  if (err instanceof TokenRejected) return REJECTED
  if (err instanceof ApiUnavailable) return UNREACHABLE
  return null
}

const base = (b: TeamProjectBinding) => `/projects/${encodeURIComponent(b.projectId)}`
const unexpected = (what: string, status: number, json: unknown) => {
  const detail = (json as { error?: unknown } | null)?.error
  return `${what}: the server answered HTTP ${status}${typeof detail === 'string' ? ` (${detail})` : ''}`
}

const entryLine = (w: WorklogDto) =>
  w.kind === 'answer'
    ? `[answer from ${w.author.name}] ${w.reasoning ?? w.summary}`
    : `[${w.kind}] ${w.summary}${w.reasoning ? ` — ${w.reasoning}` : ''}`

/** The worklog in order, each answer right after the question it answers (an orphan stays in place). */
export function orderWorklog(worklog: WorklogDto[]): WorklogDto[] {
  const ids = new Set(worklog.map(w => w.entryId))
  const placed = (w: WorklogDto) => w.kind === 'answer' && w.replyTo !== null && ids.has(w.replyTo)
  const ordered: WorklogDto[] = []
  for (const w of worklog) {
    if (placed(w)) continue
    ordered.push(w)
    for (const a of worklog) if (placed(a) && a.replyTo === w.entryId) ordered.push(a)
  }
  return ordered
}

const worklogLines = (worklog: WorklogDto[]): string[] => orderWorklog(worklog).map(entryLine)

/** Goal, who worked on it, the worklog; asks for a recap when someone else wrote last. */
export function threadContext(detail: ThreadDetailDto, me: string): string {
  const { thread, worklog } = detail
  const owners: string[] = []
  for (const w of worklog) if (!owners.includes(w.author.name)) owners.push(w.author.name)
  const lines = [
    `You picked up thread ${thread.id}: ${thread.title}`,
    `Goal: ${thread.goal || '(none)'}`,
    `Status: ${thread.status}`,
    `Owner history: ${owners.length > 0 ? owners.join(' -> ') : '(nobody yet)'}`,
    '',
    'Worklog:',
    ...(worklog.length > 0 ? worklogLines(worklog) : ['(empty)']),
  ]
  const last = worklog.at(-1)
  if (last !== undefined && last.author.memberId !== me) {
    lines.push(
      '',
      'Before doing anything, summarize where this thread stands from the worklog above and confirm the next step with me.',
    )
  }
  if ((detail.transcriptChunks ?? 0) > 0) {
    lines.push('', `Full conversation history is searchable with search_transcripts (thread: ${thread.id}).`)
  }
  return lines.join('\n')
}

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i

/** Asks the model for a JSON summary of the thread for this trigger; never throws for a bad answer. */
export async function forcedSummary($: Pick<CoreEngineInterface, 'model'>, trigger: Trigger): Promise<Summary> {
  const none = (reason: string): Summary => ({ summary: `(no summary: ${reason})`, reasoning: '' })
  const prompt =
    `Summarize the current thread's state for the team log. Trigger: ${trigger} ` +
    `(pr_open: a pull request is opened; waiting: blocked on a teammate; release: handing the thread back). ` +
    `Reply ONLY with JSON: {"summary": "<one line, at most 400 chars>", "reasoning": "<why it stands here, what comes next>"}`
  const r = await $.model.fork({ prompt, effort: 'low' })
  if (!r.isAnswered) return none(r.reason)
  const raw = r.text.trim()
  try {
    const parsed = JSON.parse(FENCE.exec(raw)?.[1] ?? raw) as { summary?: unknown; reasoning?: unknown }
    if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') return none('reply had no summary')
    return {
      summary: parsed.summary.trim().slice(0, 500),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  } catch {
    return none('reply was not JSON')
  }
}

/** "T-12", "t-12" or "12" -> 12; else null. */
export const parseThreadNo = (id: string): number | null => {
  const m = /^(?:T-)?(\d{1,9})$/i.exec(id.trim())
  return m ? Number(m[1]) : null
}

/** Looks the human number up in the project's thread list (server routes take the uuid). */
export async function resolveThread(
  $: Pick<CoreEngineInterface, 'process'>,
  opts: ApiOptions,
  binding: TeamProjectBinding,
  id: string,
): Promise<ThreadDto | null> {
  const no = parseThreadNo(id)
  if (no === null) return null
  const res = await apiGet($, opts, `${base(binding)}/threads`)
  if (res.status !== 200 || !Array.isArray(res.json)) throw new ApiUnavailable(`threads: HTTP ${res.status}`)
  return (res.json as ThreadDto[]).find(t => t.id === `T-${no}`) ?? null
}

/** `quoted "title" rest` or `word rest` -> [first, rest]. */
export function splitFirst(args: string): [string, string] {
  const s = args.trim()
  const q = /^"([^"]*)"\s*([\s\S]*)$/.exec(s)
  if (q) return [q[1] ?? '', (q[2] ?? '').trim()]
  const w = /^(\S+)\s*([\s\S]*)$/.exec(s)
  return w ? [w[1] ?? '', (w[2] ?? '').trim()] : ['', '']
}

const PICK_SEQ = { plugin: 'team-project', key: 'pickSeq' } as const

/** How many picks, releases and lost threads this session has seen: a turn that saw it change is not uploaded. */
export async function pickSeq($: Pick<CoreEngineInterface, 'state'>): Promise<number> {
  return (await $.state.get(PICK_SEQ)).value ?? 0
}

async function bumpPickSeq($: Pick<CoreEngineInterface, 'state'>): Promise<void> {
  await $.state.set(PICK_SEQ, (await pickSeq($)) + 1)
}

export async function pickedThread($: Pick<CoreEngineInterface, 'state'>): Promise<TeamProjectThread | null> {
  return ((await $.state.get(THREAD)).value ?? null) as TeamProjectThread | null
}

/**
 * The server says the picked thread is not ours (403) or gone (404): forget it,
 * restore the plain project status, and return the text to tell the person.
 */
export async function dropLostThread(
  $: Pick<CoreEngineInterface, 'state' | 'ui'>,
  thread: TeamProjectThread,
): Promise<string> {
  await $.state.set(THREAD, null)
  await bumpPickSeq($)
  const binding = await currentBinding($)
  $.ui.status(binding === null ? undefined : `👥 ${binding.name}`)
  return `You no longer own ${thread.id}; it was cleared. /team pick to continue.`
}

/** `/team pick T-12` */
export async function pickThread($: ThreadDollar, opts: ApiOptions, id: string): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  if (id.trim() === '') return { error: 'Usage: /team pick T-12' }
  try {
    const t = await resolveThread($, opts, binding, id)
    if (t === null) return { error: `No thread "${id.trim()}" in ${binding.name}.` }
    const res = await apiRequest($, opts, 'POST', `/threads/${t.threadId}/pick`)
    if (res.status === 401) throw new TokenRejected('pick: 401')
    if (res.status >= 500) throw new ApiUnavailable(`pick: HTTP ${res.status}`)
    if (res.status === 409) {
      const owner = (res.json as { owner?: MemberRef | null } | null)?.owner
      return { error: `${t.id} is owned by ${owner?.name ?? 'someone else'}` }
    }
    if (res.status !== 200 || res.json === null) return { error: unexpected('pick', res.status, res.json) }
    const me = await apiGet($, opts, '/me')
    const meId = String((me.json as { memberId?: unknown } | null)?.memberId ?? '')
    const detail = res.json as ThreadDetailDto
    // the context below shows the answers already given: they are not news later
    await markAnswersSeen($, t.threadId, Array.isArray(detail.worklog) ? detail.worklog : [])
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: threadContext(detail, meId) }] },
    })
    await $.state.set(THREAD, keep(t, detail.thread.status === 'waiting'))
    await bumpPickSeq($)
    await noteTouch($)
    $.ui.status(`👥 ${binding.name} · ${t.id}`)
    return { text: `Picked ${t.id}: ${t.title}` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** `/team release` */
export async function releaseThread($: ThreadDollar, opts: ApiOptions): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const thread = await pickedThread($)
  if (thread === null) return { error: NO_THREAD }
  try {
    const s = await forcedSummary($, 'release')
    const res = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/release`, s)
    if (res.status === 401) throw new TokenRejected('release: 401')
    if (res.status >= 500) throw new ApiUnavailable(`release: HTTP ${res.status}`)
    if (res.status === 403 || res.status === 404) return { error: await dropLostThread($, thread) }
    if (res.status !== 200) return { error: unexpected('release', res.status, res.json) }
    await $.state.set(THREAD, null)
    await bumpPickSeq($)
    $.ui.status(`👥 ${binding.name}`)
    return { text: `Released ${thread.id}. Summary: ${s.summary}` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** The picked thread as kept in state, with or without the `waiting` mark. */
const keep = (t: TeamProjectThread, waiting: boolean): TeamProjectThread =>
  waiting ? { threadId: t.threadId, id: t.id, title: t.title, waiting: true } : { threadId: t.threadId, id: t.id, title: t.title }

/** POSTs status `working`; resolves null, or the text of what went wrong ("lost thread" for 403/404, which clears it). */
async function setWorking($: ThreadDollar, opts: ApiOptions, thread: TeamProjectThread): Promise<string | null> {
  const res = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/status`, { status: 'working' })
  if (res.status === 401) throw new TokenRejected('status: 401')
  if (res.status >= 500) throw new ApiUnavailable(`status: HTTP ${res.status}`)
  if (res.status === 403 || res.status === 404) return dropLostThread($, thread)
  if (res.status !== 200) return unexpected('status', res.status, res.json)
  await $.state.set(THREAD, keep(thread, false))
  await noteTouch($)
  return null
}

/**
 * The thread `threadId` is no longer waiting (it went to review, or back to working): drop
 * its mark. A no-op when another thread is picked by now, so a slow read of one thread never
 * clears the mark of the next. Callers that may hold an undelivered answer use `stopWaiting`.
 */
export async function clearWaiting($: Pick<CoreEngineInterface, 'state'>, threadId: string): Promise<void> {
  const thread = await pickedThread($)
  if (thread?.waiting === true && thread.threadId === threadId) await $.state.set(THREAD, keep(thread, false))
}

/**
 * The thread as the server has it now, or `{ lost }` (404 clears the thread).
 * Throws for 401 and 5xx like the other calls.
 */
async function serverDetail($: ThreadDollar, opts: ApiOptions, thread: TeamProjectThread): Promise<ThreadDetailDto | { lost: string }> {
  const res = await apiGet($, opts, `/threads/${thread.threadId}`)
  if (res.status === 401) throw new TokenRejected('thread: 401')
  if (res.status >= 500) throw new ApiUnavailable(`thread: HTTP ${res.status}`)
  if (res.status === 404) return { lost: await dropLostThread($, thread) }
  const detail = res.json as ThreadDetailDto | null
  if (res.status !== 200 || typeof detail?.thread?.status !== 'string') throw new ApiUnavailable(`thread: HTTP ${res.status}`)
  return Array.isArray(detail.worklog) ? detail : { ...detail, worklog: [] }
}

/** What `resumeIfWaiting` did: `failed` is null when the thread is working, `answered` names who answered meanwhile. */
type Resumed = { failed: string | null; answered: string[] }

/**
 * Sets the thread working only if the server still has it waiting: never pulls a thread
 * out of review. When the server says it is not waiting, delivers any answer that moved it
 * (the 30 s poll may not have run yet) and clears the mark. `failed` is the lost-thread
 * text or "not waiting"; it is null when the thread is working, by us or by an answer.
 */
async function resumeIfWaiting($: ThreadDollar, opts: ApiOptions, thread: TeamProjectThread): Promise<Resumed> {
  const detail = await serverDetail($, opts, thread)
  if ('lost' in detail) return { failed: detail.lost, answered: [] }
  const status = detail.thread.status
  if (status !== 'waiting') {
    const answered = await stopWaiting($, opts, thread, detail)
    await $.state.set(THREAD, keep(thread, false))
    if (answered.length > 0 && status === 'working') return { failed: null, answered }
    return { failed: `${thread.id} is not waiting (status: ${status}); /team resume only resumes a waiting thread.`, answered }
  }
  return { failed: await setWorking($, opts, thread), answered: [] }
}

/**
 * Work logged on a thread marked waiting: it goes back to working. Best effort after the
 * worklog is saved; an outage leaves the mark, so the next entry tries again. Resolves the
 * "no longer own" text when the thread turned out lost (it is cleared), else null.
 */
async function resumeAfterWork($: ThreadDollar, opts: ApiOptions, thread: TeamProjectThread): Promise<string | null> {
  try {
    const { failed } = await resumeIfWaiting($, opts, thread)
    return (await pickedThread($)) === null ? failed : null
  } catch {
    return null // the worklog entry is saved; the status follows on a later entry or /team resume
  }
}

/**
 * `/team resume`: the picked thread goes back to working, only from waiting (ask_team set it).
 * A thread a teammate's answer already moved to working gets that answer delivered instead.
 */
export async function resumeThread($: ThreadDollar, opts: ApiOptions): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const thread = await pickedThread($)
  if (thread === null) return { error: NO_THREAD }
  try {
    const { failed, answered } = await resumeIfWaiting($, opts, thread)
    if (failed !== null) return { error: failed }
    const by = answered.length > 0 ? ` (${answered.join(', ')} answered)` : ''
    return { text: `${thread.id} is working again${by}.` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** `/team new "<title>" [goal]` and the create_thread tool. */
export async function createThread(
  $: ThreadDollar,
  opts: ApiOptions,
  title: string,
  goal: string,
  coordinator?: { session: string; run: string },
): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  if (title.trim() === '') return { error: 'A title is required.' }
  try {
    // the chat Coordinator creates under its lock run: the server refuses a run that has ended
    const res = coordinator === undefined
      ? await apiRequest($, opts, 'POST', `${base(binding)}/threads`, { title, goal })
      : await apiRequest($, opts, 'POST', `${base(binding)}/chat/threads`, { ...coordinator, title, goal })
    if (res.status === 401) throw new TokenRejected('create thread: 401')
    if (res.status >= 500) throw new ApiUnavailable(`create thread: HTTP ${res.status}`)
    if (res.status === 409 && coordinator !== undefined) return { error: 'This Coordinator run has ended; no thread was created.' }
    if (res.status !== 201 || res.json === null) return { error: unexpected('create thread', res.status, res.json) }
    const t = res.json as ThreadDto
    return { text: `Created ${t.id}: ${t.title}` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

const DECIDE_USAGE = 'Usage: /team decide "<title>" [supersedes D-7] [--ref <name>@v<n>]... <reasoning>'

/**
 * `/team decide "<title>" [supersedes D-7] [--ref <name>@v<n>]... <reasoning>`: a person typed it,
 * so it is active at once; `supersedes D-n` retires an active decision it replaces; each `--ref`
 * links a library file version.
 */
export async function decide($: ThreadDollar, opts: ApiOptions, title: string, rest: string): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const sup = /^supersedes\s+(\S+)\s*([\s\S]*)$/i.exec(rest.trim())
  const oldNo = sup ? /^(?:D-)?(\d{1,9})$/i.exec(sup[1] ?? '')?.[1] : undefined
  if (sup && oldNo === undefined) return { error: DECIDE_USAGE }
  // `--ref <name>@v<n>` (quoted when the name has spaces), repeatable, before the reasoning
  let reasoning = sup ? (sup[2] ?? '') : rest
  const refs: string[] = []
  while (/^--ref(?:\s|$)/.test(reasoning.trim())) {
    const [ref, after] = splitFirst(reasoning.trim().slice('--ref'.length))
    if (ref === '') return { error: DECIDE_USAGE }
    refs.push(ref)
    reasoning = after
  }
  if (title.trim() === '' || reasoning.trim() === '') return { error: DECIDE_USAGE }
  try {
    const res = await apiRequest($, opts, 'POST', `${base(binding)}/decisions`, {
      title,
      reasoning,
      ...(oldNo !== undefined ? { supersedes: Number(oldNo) } : {}),
      ...(refs.length > 0 ? { libraryRefs: refs } : {}),
    })
    if (res.status === 401) throw new TokenRejected('decide: 401')
    if (res.status >= 500) throw new ApiUnavailable(`decide: HTTP ${res.status}`)
    if (res.status !== 201 || res.json === null) return { error: unexpected('decide', res.status, res.json) }
    invalidateMemory(binding.projectId)
    const d = res.json as { id: string; title?: string; scope?: string | null }
    const retired = oldNo !== undefined ? `; D-${Number(oldNo)} was superseded by it and left the index` : ''
    await noteMemory($, `new decision ${decisionLine({ id: d.id, title: d.title ?? title, scope: d.scope ?? null })}${retired}`)
    const cites = refs.length > 0 ? ` citing ${refs.join(', ')}` : ''
    return { text: `Recorded ${d.id}: ${title}${oldNo !== undefined ? ` (supersedes D-${Number(oldNo)})` : ''}${cites}` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** `/team leave <yyyy-MM-dd|off>` */
export async function setLeave($: ThreadDollar, opts: ApiOptions, arg: string): Promise<Out> {
  const a = arg.trim()
  if (a !== 'off' && !/^\d{4}-\d{2}-\d{2}$/.test(a)) return { error: 'Usage: /team leave <yyyy-MM-dd|off>' }
  try {
    const res = await apiRequest($, opts, 'PUT', '/me/leave', { until: a === 'off' ? null : a })
    if (res.status === 401) throw new TokenRejected('leave: 401')
    if (res.status >= 500) throw new ApiUnavailable(`leave: HTTP ${res.status}`)
    if (res.status !== 204) return { error: unexpected('leave', res.status, res.json) }
    return { text: a === 'off' ? 'Leave cleared.' : `Marked on leave until ${a}.` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** `/team instructions revert <n>` */
export async function revertInstructions($: ThreadDollar, opts: ApiOptions, n: string): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  if (!/^\d{1,9}$/.test(n.trim())) return { error: 'Usage: /team instructions revert <version>' }
  try {
    const res = await apiRequest($, opts, 'POST', `${base(binding)}/instructions/revert`, { toVersion: Number(n) })
    if (res.status === 401) throw new TokenRejected('revert: 401')
    if (res.status >= 500) throw new ApiUnavailable(`revert: HTTP ${res.status}`)
    if (res.status === 404) return { error: `Instructions version ${n.trim()} not found.` }
    if (res.status === 409) return { error: 'Instructions changed meanwhile; try again.' }
    if (res.status !== 201 || res.json === null) return { error: unexpected('revert', res.status, res.json) }
    invalidateMemory(binding.projectId)
    const v = res.json as InstructionsDto
    await noteMemory($, `the team instructions are now v${v.version} (reverted to v${n.trim()}):\n${v.body}`)
    return { text: `Reverted to v${n.trim()} (now v${v.version}).` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

// ---- tools ----

const KINDS = ['decision', 'attempt_failed', 'blocker', 'direction_change', 'milestone']

export const logWorklogSpec: ToolSpec = {
  name: 'log_worklog',
  description:
    'Record an entry in the picked thread\'s team worklog. Call it when you: make a decision between alternatives ' +
    '(kind decision), try something that fails (attempt_failed), change direction (direction_change), or hit a ' +
    'blocker (blocker). Use milestone for finished steps. Give the reasoning, so a teammate can pick the thread up.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS },
      summary: { type: 'string', description: 'One line, at most 500 chars' },
      reasoning: { type: 'string', description: 'Why; what was weighed' },
      refs: { type: 'array', items: { type: 'string' }, description: 'Files, commits, URLs' },
      scope: { type: 'string', description: 'For a decision: the area it applies to' },
      alternatives: { type: 'string', description: 'For a decision: what else was considered' },
      libraryRefs: {
        type: 'array',
        items: { type: 'string' },
        description: 'For a decision: the team library file versions it rests on, as "<name>@v<n>" (at most 10)',
      },
    },
    required: ['kind', 'summary'],
  },
  isDeferred: false,
}

export const createThreadSpec: ToolSpec = {
  name: 'create_thread',
  description: 'Create a new open thread (a unit of work) in the team project. Call only when the person asks for one.',
  inputSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, goal: { type: 'string' } },
    required: ['title', 'goal'],
  },
  isDeferred: false,
}

export const askTeamSpec: ToolSpec = {
  name: 'ask_team',
  description:
    'Mark the picked thread as waiting on a teammate and log the question as a blocker. ' +
    'Call when you cannot go on without an answer from someone on the team.',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
  },
  isDeferred: false,
}

export const updateInstructionsSpec: ToolSpec = {
  name: 'update_instructions',
  description:
    'Replace the team\'s shared instructions with a new full body. Call only when the person asks to change ' +
    'the team\'s shared rules.',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'The whole new instructions text' },
      changeNote: { type: 'string', description: 'One line on what changed and why' },
    },
    required: ['body', 'changeNote'],
  },
  isDeferred: false,
}

export const threadToolSpecs: ToolSpec[] = [logWorklogSpec, createThreadSpec, askTeamSpec, updateInstructionsSpec]

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The tool `log_worklog`. */
export async function logWorklog($: ThreadDollar, opts: ApiOptions, input: Record<string, unknown>): Promise<Out> {
  const thread = await pickedThread($)
  if (thread === null) return { error: NO_THREAD }
  const kind = str(input.kind)
  const summary = str(input.summary)
  if (kind === undefined || !KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(', ')}` }
  if (summary === undefined || summary.trim() === '') return { error: 'summary is required' }
  const scope = str(input.scope)
  const alternatives = str(input.alternatives)
  const libraryRefs = Array.isArray(input.libraryRefs) ? input.libraryRefs.filter((r): r is string => typeof r === 'string') : []
  if (libraryRefs.length > 0 && kind !== 'decision') return { error: 'libraryRefs are only for kind decision' }
  const body = {
    kind,
    summary,
    reasoning: str(input.reasoning),
    refs: Array.isArray(input.refs) ? input.refs.filter((r): r is string => typeof r === 'string') : undefined,
    trigger: 'claude',
    decision: kind === 'decision' && (scope !== undefined || alternatives !== undefined) ? { scope, alternatives } : undefined,
    libraryRefs: libraryRefs.length > 0 ? libraryRefs : undefined,
  }
  try {
    const res = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/worklog`, body)
    if (res.status === 401) throw new TokenRejected('worklog: 401')
    if (res.status >= 500) throw new ApiUnavailable(`worklog: HTTP ${res.status}`)
    if (res.status === 403 || res.status === 404) return { error: await dropLostThread($, thread) }
    if (res.status !== 201 || res.json === null) return { error: unexpected('worklog', res.status, res.json) }
    await noteTouch($)
    // work going on again after ask_team: the thread is no longer waiting
    const lost = kind !== 'blocker' && thread.waiting === true ? await resumeAfterWork($, opts, thread) : null
    const id = (res.json as WorklogDto).decisionId
    const logged = `Logged [${kind}] on ${thread.id}${id ? ` (proposed ${id})` : ''}.`
    return { text: lost === null ? logged : `${logged} ${lost}` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** The tool `create_thread` (this session's Claude; the chat Coordinator calls `createThread` itself). */
export function createThreadTool($: ThreadDollar, opts: ApiOptions, input: Record<string, unknown>): Promise<Out> {
  return createThread($, opts, str(input.title) ?? '', str(input.goal) ?? '')
}

/** The tool `ask_team`: status waiting, then a blocker entry carrying the forced summary. */
export async function askTeam($: ThreadDollar, opts: ApiOptions, input: Record<string, unknown>): Promise<Out> {
  const thread = await pickedThread($)
  if (thread === null) return { error: NO_THREAD }
  const question = str(input.question)
  if (question === undefined || question.trim() === '') return { error: 'question is required' }
  try {
    const s = await forcedSummary($, 'waiting')
    const st = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/status`, { status: 'waiting' })
    if (st.status === 401) throw new TokenRejected('status: 401')
    if (st.status >= 500) throw new ApiUnavailable(`status: HTTP ${st.status}`)
    if (st.status === 403 || st.status === 404) return { error: await dropLostThread($, thread) }
    if (st.status !== 200) return { error: unexpected('status', st.status, st.json) }
    await $.state.set(THREAD, keep(thread, true))
    const res = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/worklog`, {
      kind: 'blocker',
      summary: question,
      reasoning: s.summary,
      trigger: 'waiting',
    })
    if (res.status === 401) throw new TokenRejected('worklog: 401')
    if (res.status >= 500) throw new ApiUnavailable(`worklog: HTTP ${res.status}`)
    if (res.status === 403 || res.status === 404) return { error: await dropLostThread($, thread) }
    if (res.status !== 201) return { error: unexpected('worklog', res.status, res.json) }
    return { text: `${thread.id} is now waiting on the team; the question is logged.` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** The tool `update_instructions`: reads the latest version, then writes on top of it. */
export async function updateInstructions(
  $: ThreadDollar,
  opts: ApiOptions,
  input: Record<string, unknown>,
): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const body = str(input.body)
  if (body === undefined || body.trim() === '') return { error: 'body is required and must not be empty' }
  // These instructions go into every teammate's prompt: a person confirms before they change.
  const preview = body.length > 400 ? `${body.slice(0, 400)}...` : body
  let answer: string
  try {
    answer = await $.ui.ask(
      `Replace the team's shared instructions for ${binding.name}? New text (${body.length} characters):\n${preview}`,
      { options: ['Replace', 'Cancel'], header: 'Team rules' },
    )
  } catch {
    return { error: 'The team instructions were not changed: no one confirmed the change.' }
  }
  if (answer !== 'Replace') return { error: 'The team instructions were not changed: the change was not confirmed.' }
  try {
    const cur = await apiGet($, opts, `${base(binding)}/instructions`)
    if (cur.status !== 200 || cur.json === null) return { error: unexpected('read instructions', cur.status, cur.json) }
    const res = await apiRequest($, opts, 'PUT', `${base(binding)}/instructions`, {
      body,
      changeNote: str(input.changeNote),
      baseVersion: (cur.json as InstructionsDto).version,
    })
    if (res.status === 401) throw new TokenRejected('instructions: 401')
    if (res.status >= 500) throw new ApiUnavailable(`instructions: HTTP ${res.status}`)
    if (res.status === 409) {
      const c = (res.json as { current?: InstructionsDto } | null)?.current
      return { error: `Instructions changed meanwhile (v${c?.version ?? '?'} by ${c?.editedBy.name ?? 'someone'}); re-read and retry` }
    }
    if (res.status !== 201 || res.json === null) return { error: unexpected('instructions', res.status, res.json) }
    invalidateMemory(binding.projectId)
    const v = res.json as InstructionsDto
    await noteMemory($, `the team instructions are now v${v.version}:\n${body}`)
    return { text: `Instructions updated to v${v.version}.` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}
