import type { CoreEngineInterface } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet, apiRequest } from './api.ts'
import type { ApiOptions } from './api.ts'
import { currentBinding, markOffline } from './binding.ts'
import { decisionLine, invalidateMemory, noteMemory } from './memory.ts'
import { stopWaiting } from './answers.ts'
import { dropLostThread, forcedSummary, lastTouch, noteTouch, pickedThread } from './threads.ts'
import type { ThreadDto, ThreadDollar } from './threads.ts'

const HEARTBEAT_MS = 10 * 60_000
export const PR_POLL_MS = 10 * 60_000

const PR_CREATE = /\bgh\s+pr\s+create\b/
const PR_URL = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/

export type TriggerDollar = ThreadDollar & Pick<CoreEngineInterface, 'ui'>

/** A hook side-call must never fail its hook: an API outage marks the status offline, anything else is dropped. */
async function quiet($: Pick<CoreEngineInterface, 'state' | 'ui'>, err: unknown): Promise<void> {
  if (!(err instanceof ApiUnavailable || err instanceof TokenRejected)) return
  try {
    await markOffline($, err)
  } catch {
    // even the status write may not fail the hook
  }
}

/**
 * After a Bash call: if it was a successful `gh pr create` on a picked thread,
 * moves the thread to review with the PR url and logs a pr_open milestone.
 * Never throws for an API failure.
 */
export async function onBashResult(
  $: TriggerDollar,
  opts: ApiOptions,
  command: unknown,
  result: { isError?: boolean; deny?: string; text?: string },
): Promise<void> {
  if (typeof command !== 'string' || !PR_CREATE.test(command)) return
  if (result.isError === true || result.deny !== undefined) return
  const url = PR_URL.exec(result.text ?? '')?.[0]
  if (url === undefined) return
  try {
    const thread = await pickedThread($)
    if (thread === null) return
    const st = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/status`, { status: 'review', prUrl: url })
    if (st.status === 401) throw new TokenRejected('status: 401')
    if (st.status >= 500) throw new ApiUnavailable(`status: HTTP ${st.status}`)
    if (st.status !== 200) return // not the owner, or the server refused: leave the thread alone
    // in review now: a later worklog must not set it working. An answer may have moved it
    // first and the 30 s poll not run yet: deliver it before the mark goes
    if (thread.waiting === true) await stopWaiting($, opts, thread)
    await noteTouch($)
    const s = await forcedSummary($, 'pr_open')
    const log = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/worklog`, {
      kind: 'milestone',
      summary: s.summary,
      reasoning: s.reasoning,
      refs: [url],
      trigger: 'pr_open',
    })
    if (log.status >= 500) throw new ApiUnavailable(`worklog: HTTP ${log.status}`)
  } catch (err) {
    await quiet($, err)
  }
}

/** After a turn: touches the picked thread when the server last saw activity 10 minutes ago or more. */
export async function heartbeat($: TriggerDollar, opts: ApiOptions): Promise<void> {
  try {
    const thread = await pickedThread($)
    if (thread === null) return
    const last = await lastTouch($)
    const now = await $.clock.now()
    if (last !== undefined && now - last < HEARTBEAT_MS) return
    // throttle attempts, not successes: during an outage or a 403 this runs once per 10 minutes
    await noteTouch($)
    const res = await apiRequest($, opts, 'POST', `/threads/${thread.threadId}/touch`)
    if (res.status === 401) throw new TokenRejected('touch: 401')
    if (res.status >= 500) throw new ApiUnavailable(`touch: HTTP ${res.status}`)
    if (res.status === 403 || res.status === 404) $.ui.toast(await dropLostThread($, thread))
  } catch (err) {
    await quiet($, err)
  }
}

/** The state of a PR by `gh`, or null when gh is missing, fails, or says something else. */
async function prState($: Pick<CoreEngineInterface, 'process'>, url: string): Promise<'merged' | 'closed' | null> {
  try {
    const r = await $.process.run(['gh', 'pr', 'view', url, '--json', 'state', '-q', '.state'])
    if (r.exitCode !== 0) return null
    const s = r.stdout.trim()
    return s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : null
  } catch {
    return null
  }
}

/**
 * Every 10 minutes: for my threads in review, asks `gh` about the PR and posts
 * pr-state when it was merged or closed, with a toast naming the decisions
 * that became active. Never throws for an API failure.
 */
export async function pollReviewThreads($: TriggerDollar, opts: ApiOptions): Promise<void> {
  try {
    const binding = await currentBinding($)
    if (binding === null) return
    const pid = encodeURIComponent(binding.projectId)
    const me = await apiGet($, opts, '/me')
    const meId = (me.json as { memberId?: unknown } | null)?.memberId
    const list = await apiGet($, opts, `/projects/${pid}/threads`)
    if (me.status !== 200 || typeof meId !== 'string' || list.status !== 200 || !Array.isArray(list.json)) return
    const owned = (list.json as ThreadDto[]).filter(t => t.status === 'review' && t.prUrl !== null && t.owner?.memberId === meId)
    for (const t of owned) {
      const state = await prState($, t.prUrl ?? '')
      if (state === null) continue
      // the decisions this thread proposed: the server flips them with the PR state
      const props = await apiGet($, opts, `/projects/${pid}/decisions?status=proposed`)
      const mine = Array.isArray(props.json)
        ? (props.json as { id: string; title: string; scope: string | null; sourceThread: string | null }[])
            .filter(d => d.sourceThread === t.id)
        : []
      const ids = mine.map(d => d.id)
      const res = await apiRequest($, opts, 'POST', `/threads/${t.threadId}/pr-state`, { state })
      if (res.status >= 500) throw new ApiUnavailable(`pr-state: HTTP ${res.status}`)
      if (res.status !== 200) continue
      invalidateMemory(binding.projectId)
      if (state === 'merged' && mine.length > 0) {
        await noteMemory($, `${t.id} merged; now active:\n${mine.map(decisionLine).join('\n')}`)
      }
      $.ui.toast(
        state === 'merged'
          ? `${t.id} merged${ids.length > 0 ? `: ${ids.join(', ')} now active` : ''}`
          : `${t.id} closed${ids.length > 0 ? `: ${ids.join(', ')} rejected` : ''}`,
      )
    }
  } catch (err) {
    await quiet($, err)
  }
}
