import type { CoreEngineInterface } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet, apiRequest } from './api.ts'
import type { ApiOptions } from './api.ts'
import { currentBinding, markOffline } from './binding.ts'
import { NOT_BOUND, apiFailure, clearWaiting, dropLostThread, pickedThread, resolveThread } from './threads.ts'
import type { Out, ThreadDetailDto, WorklogDto } from './threads.ts'
import type { TeamProjectThread } from '../types/index.d.ts'

export const ANSWER_POLL_MS = 30_000

const SEEN = { plugin: 'team-project', key: 'seenAnswers' } as const

export type AnswerDollar = Pick<CoreEngineInterface, 'process' | 'state' | 'ui' | 'session'>

async function seenOf($: Pick<CoreEngineInterface, 'state'>): Promise<Record<string, string[]>> {
  return (await $.state.get(SEEN)).value ?? {}
}

async function addSeen($: Pick<CoreEngineInterface, 'state'>, threadId: string, entryIds: string[]): Promise<void> {
  const all = await seenOf($)
  const had = all[threadId] ?? []
  const add = entryIds.filter(id => !had.includes(id))
  if (add.length === 0) return
  await $.state.set(SEEN, { ...all, [threadId]: [...had, ...add] })
}

/** Records every answer already in the worklog as delivered (a pick shows them in the thread context). */
export async function markAnswersSeen($: Pick<CoreEngineInterface, 'state'>, threadId: string, worklog: WorklogDto[]): Promise<void> {
  // through the delivery queue: a write between a delivery's read and its own write would be lost
  await serialized(threadId, () => addSeen($, threadId, worklog.filter(w => w.kind === 'answer').map(w => w.entryId)))
}

/** The session message for one answer (exact text from the spec). */
export function answerMessage(threadNo: string, answer: WorklogDto, question: WorklogDto | undefined): string {
  return (
    `Teammate ${answer.author.name} answered your question on ${threadNo}.\n` +
    `Question: ${question?.summary ?? '(question not found)'}\n` +
    `Answer: ${answer.reasoning ?? answer.summary}\n` +
    'The thread is working again. Wait for me before acting on it.'
  )
}

// Per thread uuid: the tail of the deliveries queued for it. The pane timer and the answer
// timer can both hold the same answer at once; deliveries for a thread run one at a time.
const delivering = new Map<string, Promise<unknown>>()

/** Runs `fn` after every earlier delivery for the thread has settled. */
function serialized<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const run = (delivering.get(threadId) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  delivering.set(threadId, tail)
  void tail.then(() => {
    if (delivering.get(threadId) === tail) delivering.delete(threadId)
  })
  return run
}

/**
 * Tells the session about each answer on the picked thread it has not seen yet:
 * a user-role row plus a toast, then drops the waiting mark. Each answer is marked
 * seen before its row is appended, so a failure never delivers it twice; deliveries
 * for one thread run one at a time and re-read the seen list, so two callers holding
 * the same answer deliver it once. Resolves how many answers it delivered.
 */
export async function deliverAnswers(
  $: Pick<CoreEngineInterface, 'state' | 'ui' | 'session'>,
  thread: TeamProjectThread,
  detail: ThreadDetailDto,
): Promise<number> {
  return (await deliverEach($, thread, detail)).length
}

/** Like `deliverAnswers`, resolving the answers it delivered. */
function deliverEach(
  $: Pick<CoreEngineInterface, 'state' | 'ui' | 'session'>,
  thread: TeamProjectThread,
  detail: ThreadDetailDto,
): Promise<WorklogDto[]> {
  if (detail.thread.threadId !== thread.threadId) return Promise.resolve([])
  return serialized(thread.threadId, () => deliverNow($, thread, detail))
}

async function deliverNow(
  $: Pick<CoreEngineInterface, 'state' | 'ui' | 'session'>,
  thread: TeamProjectThread,
  detail: ThreadDetailDto,
): Promise<WorklogDto[]> {
  const delivered: WorklogDto[] = []
  for (const answer of detail.worklog) {
    if (answer.kind !== 'answer') continue
    // read inside the critical section, per answer: another caller may have just delivered it
    if (((await seenOf($))[thread.threadId] ?? []).includes(answer.entryId)) continue
    await addSeen($, thread.threadId, [answer.entryId])
    const question = detail.worklog.find(w => w.entryId === answer.replyTo)
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: answerMessage(thread.id, answer, question) }] },
    })
    delivered.push(answer)
    try {
      $.ui.toast(`${thread.id}: ${answer.author.name} answered`)
    } catch {
      // the row reached the session; a toast never fails delivery
    }
  }
  if (delivered.length > 0) await clearWaiting($, thread.threadId)
  return delivered
}

/**
 * Drops the waiting mark of `thread` (only while it is still the picked thread), first
 * delivering the answers the session has not seen: from `detail`, or from one read of the
 * thread when none is given. Every path that ends the wait goes through here, so an answer
 * that came before the 30 s poll is never lost with the mark. When the read hits an outage
 * the mark stays: the answer poll delivers and drops it later. Resolves the names of the
 * teammates whose answers it delivered, in order, without repeats. Throws only what `$` throws.
 */
export async function stopWaiting(
  $: AnswerDollar,
  opts: ApiOptions,
  thread: TeamProjectThread,
  detail?: ThreadDetailDto,
): Promise<string[]> {
  let d = detail
  if (d === undefined) {
    try {
      const res = await apiGet($, opts, `/threads/${thread.threadId}`)
      if (res.status === 401 || res.status >= 500) return []
      const json = res.json as ThreadDetailDto | null
      if (res.status === 200 && json !== null && Array.isArray(json.worklog)) d = json
    } catch {
      return [] // outage: keep the mark
    }
  }
  const delivered = d === undefined ? [] : await deliverEach($, thread, d)
  await clearWaiting($, thread.threadId)
  return [...new Set(delivered.map(a => a.author.name))]
}

/**
 * The answer timer's tick: while the picked thread waits on the team, reads it and
 * delivers new answers. An outage marks the link offline (one toast, as elsewhere);
 * a thread now owned by someone else, or gone, is cleared. Never throws.
 */
export async function pollAnswers($: AnswerDollar, opts: ApiOptions): Promise<void> {
  try {
    const thread = await pickedThread($)
    if (thread?.waiting !== true) return
    const res = await apiGet($, opts, `/threads/${thread.threadId}`)
    if (res.status === 401) throw new TokenRejected('thread: 401')
    if (res.status >= 500) throw new ApiUnavailable(`thread: HTTP ${res.status}`)
    if (res.status === 403 || res.status === 404) {
      $.ui.toast(await dropLostThread($, thread))
      return
    }
    const detail = res.json as ThreadDetailDto | null
    if (res.status !== 200 || detail === null || !Array.isArray(detail.worklog)) throw new ApiUnavailable(`thread: HTTP ${res.status}`)
    const me = await apiGet($, opts, '/me')
    if (me.status === 401) throw new TokenRejected('me: 401')
    const meId = (me.json as { memberId?: unknown } | null)?.memberId
    if (me.status !== 200 || typeof meId !== 'string') throw new ApiUnavailable(`me: HTTP ${me.status}`)
    if (detail.thread.owner?.memberId !== meId) {
      $.ui.toast(await dropLostThread($, thread))
      return
    }
    const delivered = await deliverAnswers($, thread, detail)
    // no longer waiting on the server (and nothing new to say): stop polling it
    if (delivered === 0 && detail.thread.status !== 'waiting') await clearWaiting($, thread.threadId)
  } catch (err) {
    if (!(err instanceof ApiUnavailable || err instanceof TokenRejected)) return
    try {
      await markOffline($, err)
    } catch {
      // a tick never fails
    }
  }
}

// ---- answering a teammate's question ----

export const ANSWER_USAGE = 'Usage: /team answer T-3 <text>'

/** The latest question (a `blocker` logged by `ask_team`) that no answer replies to yet, or null. */
export function openQuestion(worklog: WorklogDto[]): WorklogDto | null {
  const answered = new Set(worklog.filter(w => w.kind === 'answer').map(w => w.replyTo))
  for (let i = worklog.length - 1; i >= 0; i--) {
    const w = worklog[i]
    if (w !== undefined && w.kind === 'blocker' && w.trigger === 'waiting' && !answered.has(w.entryId)) return w
  }
  return null
}

/**
 * POSTs an answer to the question; resolves null when saved, or the readable reason it
 * was not (the server's own words for a 400). Throws for 401 and 5xx like the other calls.
 */
export async function postAnswer(
  $: Pick<CoreEngineInterface, 'process'>,
  opts: ApiOptions,
  threadId: string,
  questionId: string,
  text: string,
): Promise<string | null> {
  const res = await apiRequest($, opts, 'POST', `/threads/${threadId}/answers`, { questionId, text })
  if (res.status === 401) throw new TokenRejected('answer: 401')
  if (res.status >= 500) throw new ApiUnavailable(`answer: HTTP ${res.status}`)
  if (res.status === 201) return null
  const error = (res.json as { error?: unknown } | null)?.error
  if (res.status === 400 && typeof error === 'string') return error
  if (res.status === 404) return 'That thread no longer exists.'
  return `answer: the server answered HTTP ${res.status}${typeof error === 'string' ? ` (${error})` : ''}`
}

/** `/team answer T-3 <text>`: answers the thread's open question; the answerer need not have picked it. */
export async function answerQuestion(
  $: Pick<CoreEngineInterface, 'process' | 'state'>,
  opts: ApiOptions,
  threadKey: string,
  text: string,
): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  if (threadKey.trim() === '' || text.trim() === '') return { error: ANSWER_USAGE }
  try {
    const t = await resolveThread($, opts, binding, threadKey)
    if (t === null) return { error: `No thread "${threadKey.trim()}" in ${binding.name}.` }
    const res = await apiGet($, opts, `/threads/${t.threadId}`)
    if (res.status === 401) throw new TokenRejected('thread: 401')
    if (res.status === 404) return { error: `No thread "${t.id}" in ${binding.name}.` }
    const detail = res.json as ThreadDetailDto | null
    if (res.status !== 200 || detail === null || !Array.isArray(detail.worklog)) throw new ApiUnavailable(`thread: HTTP ${res.status}`)
    const question = openQuestion(detail.worklog)
    if (question === null) return { error: `${t.id} has no open question.` }
    const failed = await postAnswer($, opts, t.threadId, question.entryId, text)
    return failed === null ? { text: `Answered ${t.id}.` } : { error: failed }
  } catch (err) {
    const msg = apiFailure(err)
    if (msg !== null) return { error: msg }
    throw err
  }
}
