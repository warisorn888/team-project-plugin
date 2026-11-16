import type { CoreEngineInterface } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet, apiRequest } from './api.ts'
import type { ApiOptions } from './api.ts'
import { currentBinding, isOnline, markOffline, markOnline } from './binding.ts'
import { NOT_BOUND, apiFailure } from './threads.ts'
import type { Out } from './threads.ts'
import { findCredentials } from './transcript-filter.ts'
import { runCoordinator } from './coordinator.ts'
import type { CoordinatorDollar } from './coordinator.ts'
import type { TeamProjectBinding, TeamProjectChatLog, TeamProjectChatMessage, TeamProjectChatPage } from '../types/index.d.ts'

export const CHAT_POLL_MS = 30_000
/** How often the pane re-reads the chat while its Chat tab shows. */
export const CHAT_PANE_MS = 3_000
export const SAY_USAGE = 'Usage: /team say <text>'

export type ChatMessage = TeamProjectChatMessage
export type ChatPage = TeamProjectChatPage

/** The part of `$` the chat code uses (and hands to the Coordinator). */
export type ChatDollar = CoordinatorDollar

// a human message unanswered this long, with the lock free, is taken over by any session
const TAKEOVER_AFTER_MS = 60_000
// how many messages the session keeps; also the page size it asks for
const KEEP = 200
// how many older messages one `Load older` reads
const OLDER_PAGE = 100

const CHAT_LOG = { plugin: 'team-project', key: 'chatLog' } as const
const readKey = (b: TeamProjectBinding) => `chatRead:${b.projectId}`
// the newest seq whose mentions were already toasted (any session): a mention toasts once
const mentionedKey = (b: TeamProjectBinding) => `chatMentioned:${b.projectId}`

/** Starts the Coordinator loop in the background; it never fails its caller. */
function startCoordinator($: ChatDollar, opts: ApiOptions): void {
  void runCoordinator($, opts).catch(() => undefined)
}

/** The server answered the chat read with a 4xx other than 401 (the project is gone, a bad query). */
export class ChatRefused extends Error {
  constructor(readonly status: number) {
    super(`chat: HTTP ${status}`)
    this.name = 'ChatRefused'
  }
}

const chatPath = (b: TeamProjectBinding) => `/projects/${encodeURIComponent(b.projectId)}/chat`

/**
 * One page of the project's chat, oldest first. Rejects `TokenRejected` (401), `ChatRefused`
 * (any other 4xx) and `ApiUnavailable` (5xx, unreachable, or an answer that is not a page).
 */
export async function fetchChat(
  $: Pick<CoreEngineInterface, 'process'>,
  opts: ApiOptions,
  binding: TeamProjectBinding,
  q: { after?: number; before?: number; limit?: number },
): Promise<ChatPage> {
  const params = new URLSearchParams()
  if (q.after !== undefined) params.set('after', String(q.after))
  if (q.before !== undefined) params.set('before', String(q.before))
  if (q.limit !== undefined) params.set('limit', String(q.limit))
  const query = params.toString()
  const res = await apiGet($, opts, `${chatPath(binding)}${query === '' ? '' : `?${query}`}`)
  const page = res.json as ChatPage | null
  if (res.status >= 400) throw new ChatRefused(res.status)
  if (
    res.status !== 200 || page === null || !Array.isArray(page.messages) || typeof page.lock !== 'object' || page.lock === null ||
    typeof page.handledThrough !== 'number'
  ) {
    throw new ApiUnavailable(`chat: HTTP ${res.status}`)
  }
  return page
}

/** `/team say <text>` (and the Chat tab): posts a message, then starts the Coordinator. Never sends a credential. */
export async function postChat($: ChatDollar, opts: ApiOptions, body: string): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  if (body.trim() === '') return { error: SAY_USAGE }
  const rules = findCredentials(body)
  if (rules.length > 0) {
    const text = `Not sent: looks like it contains a credential (${rules.join(', ')}).`
    try {
      $.ui.toast(text)
    } catch {
      // the refusal still reaches the caller
    }
    return { error: text }
  }
  let res
  try {
    res = await apiRequest($, opts, 'POST', chatPath(binding), { body })
    if (res.status === 401) throw new TokenRejected('chat: 401')
    if (res.status >= 500) throw new ApiUnavailable(`chat: HTTP ${res.status}`)
  } catch (err) {
    const msg = apiFailure(err)
    if (msg !== null) return { error: msg }
    throw err
  }
  const error = (res.json as { error?: unknown } | null)?.error
  if (res.status !== 201) {
    if (res.status === 400 && typeof error === 'string') return { error }
    return { error: `chat: the server answered HTTP ${res.status}${typeof error === 'string' ? ` (${error})` : ''}` }
  }
  startCoordinator($, opts)
  return { text: `Sent to ${binding.name} chat.` }
}

/** The session's member, read once from `/me`; null when the server gave none. */
export async function currentMember($: ChatDollar, opts: ApiOptions): Promise<{ id: string; name: string } | null> {
  const cached = (await $.state.get({ plugin: 'team-project', key: 'me' })).value
  if (cached) return cached
  const res = await apiGet($, opts, '/me')
  const json = res.json as { memberId?: unknown; name?: unknown } | null
  if (res.status !== 200 || typeof json?.memberId !== 'string' || typeof json.name !== 'string') return null
  const m = { id: json.memberId, name: json.name }
  await $.state.set({ plugin: 'team-project', key: 'me' }, m)
  return m
}

/** The session's cached chat for `binding`'s project, or null (none yet, or another project's). */
export async function chatLog($: Pick<CoreEngineInterface, 'state'>, binding: TeamProjectBinding): Promise<TeamProjectChatLog | null> {
  const log = (await $.state.get(CHAT_LOG)).value
  return log && log.projectId === binding.projectId ? log : null
}

/** Whether `m` is the session member's own message (a human message they wrote). */
const isOwn = (m: ChatMessage, meId: string | undefined) => m.kind === 'human' && m.author !== null && m.author.memberId === meId

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `body` holds `@name` (any case), not as part of a longer name. */
export function mentions(body: string, name: string): boolean {
  if (name.trim() === '') return false
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(body)
}

const mentioner = (m: ChatMessage) => (m.kind === 'coordinator' ? `Claude via ${m.author?.name ?? 'a teammate'}` : (m.author?.name ?? 'Someone'))

async function storedSeq($: Pick<CoreEngineInterface, 'store'>, key: string): Promise<number> {
  const v = await $.store.get(key)
  return typeof v === 'number' ? v : 0
}

/**
 * Toasts each unread message from someone else that mentions the member, once per message. The very
 * first read (nothing read or toasted yet for this project) only marks the history as seen: a member
 * new to a busy project is not shown every old mention at once.
 */
function toastMentions($: ChatDollar, binding: TeamProjectBinding, messages: ChatMessage[], self: { id: string; name: string }): Promise<void> {
  // the pane's refreshes and the poll can read at once; one project's toasts run one batch at a time
  const run = (toasting.get(binding.projectId) ?? Promise.resolve()).then(() => toastMentionsNow($, binding, messages, self))
  const tail = run.catch(() => undefined)
  toasting.set(binding.projectId, tail)
  void tail.then(() => {
    if (toasting.get(binding.projectId) === tail) toasting.delete(binding.projectId)
  })
  return run
}

const toasting = new Map<string, Promise<unknown>>()

async function toastMentionsNow($: ChatDollar, binding: TeamProjectBinding, messages: ChatMessage[], self: { id: string; name: string }): Promise<void> {
  const newestSeq = messages[messages.length - 1]?.seq ?? 0
  // checked before the empty return: an empty first read still marks the start, so the first
  // real mention after it toasts
  if ((await $.store.get(readKey(binding))) === undefined && (await $.store.get(mentionedKey(binding))) === undefined) {
    await $.store.set(mentionedKey(binding), newestSeq)
    return
  }
  if (messages.length === 0) return
  const after = Math.max(await storedSeq($, readKey(binding)), await storedSeq($, mentionedKey(binding)))
  for (const m of messages) {
    if (m.seq <= after || m.kind === 'system' || isOwn(m, self.id) || !mentions(m.body, self.name)) continue
    try {
      $.ui.toast(`${mentioner(m)} mentioned you in Team chat`)
    } catch {
      // a toast never fails the poll
    }
  }
  if (newestSeq > after) await $.store.set(mentionedKey(binding), newestSeq)
}

/**
 * The chat timer's tick: reads the messages after the session's newest, keeps the last
 * 200 with the lock and `handledThrough` (toasting unread mentions), then takes over an
 * unanswered human message (older than 60 s, the lock free or lapsed) by starting the
 * Coordinator. An outage marks the link offline; a refused read (4xx) changes nothing. Never throws.
 */
export async function pollChat($: ChatDollar, opts: ApiOptions): Promise<void> {
  try {
    const binding = await currentBinding($)
    if (binding === null) return
    const { messages, page } = await readNewChat($, opts, binding)
    if ((await isOnline($)) === false) await markOnline($, binding)

    if (await shouldTakeOver($, messages, page)) startCoordinator($, opts)
  } catch (err) {
    if (!(err instanceof ApiUnavailable || err instanceof TokenRejected)) return
    try {
      await markOffline($, err)
    } catch {
      // a tick never fails
    }
  }
}

/**
 * Reads the messages after the session's newest into its cache, which keeps the last 200 with the
 * lock and `handledThrough` (what drops out of it joins the older pages `Load older` read, if any).
 * The new messages' mentions toast first, before the write that lets the Chat tab mark them read:
 * whichever reader (the 30 s poll, the pane) sees a message first raises its toast.
 * Rejects as `fetchChat` does.
 */
export async function readNewChat(
  $: ChatDollar,
  opts: ApiOptions,
  binding: TeamProjectBinding,
): Promise<{ fresh: ChatMessage[]; messages: ChatMessage[]; page: ChatPage }> {
  const log = await chatLog($, binding)
  const lastSeq = log?.messages[log.messages.length - 1]?.seq
  const page = await fetchChat($, opts, binding, lastSeq === undefined ? { limit: KEEP } : { after: lastSeq, limit: KEEP })
  const fresh = page.messages.filter(m => lastSeq === undefined || m.seq > lastSeq)
  try {
    const self = await currentMember($, opts)
    if (self !== null) await toastMentions($, binding, fresh, self)
  } catch {
    // a mention toast never fails the read
  }
  const all = [...(log?.messages ?? []), ...fresh]
  const messages = all.slice(-KEEP)
  await $.state.set(CHAT_LOG, { projectId: binding.projectId, messages, lock: page.lock, handledThrough: page.handledThrough })
  const dropped = all.slice(0, all.length - messages.length)
  const older = await olderChat($, binding)
  if (dropped.length > 0 && older.length > 0) {
    await $.state.set({ plugin: 'team-project', key: 'chatOlder' } as const, { projectId: binding.projectId, messages: [...older, ...dropped] })
  }
  return { fresh, messages, page }
}

/** The older pages `Load older` read this session for `binding`'s project, oldest first. */
export async function olderChat($: Pick<CoreEngineInterface, 'state'>, binding: TeamProjectBinding): Promise<ChatMessage[]> {
  const older = (await $.state.get({ plugin: 'team-project', key: 'chatOlder' } as const)).value
  return older && older.projectId === binding.projectId ? older.messages : []
}

/** What the Chat tab shows: the older pages, then the cache, oldest first. */
export async function shownChat($: Pick<CoreEngineInterface, 'state'>, binding: TeamProjectBinding): Promise<ChatMessage[]> {
  const kept = (await chatLog($, binding))?.messages ?? []
  const first = kept[0]?.seq ?? Infinity
  return [...(await olderChat($, binding)).filter(m => m.seq < first), ...kept]
}

/** `Load older`: the page before the first message shown. Rejects as `fetchChat` does. */
export async function loadOlderChat($: Pick<CoreEngineInterface, 'process' | 'state'>, opts: ApiOptions, binding: TeamProjectBinding): Promise<void> {
  const shown = await shownChat($, binding)
  const first = shown[0]?.seq
  if (first === undefined || first <= 1) return
  const page = await fetchChat($, opts, binding, { before: first, limit: OLDER_PAGE })
  const added = page.messages.filter(m => m.seq < first)
  await $.state.set({ plugin: 'team-project', key: 'chatOlder' } as const, {
    projectId: binding.projectId,
    messages: [...added, ...(await olderChat($, binding))],
  })
}

/** The newest human message is unanswered, older than 60 s, and nobody holds a live lease. */
async function shouldTakeOver($: Pick<CoreEngineInterface, 'clock'>, messages: ChatMessage[], page: ChatPage): Promise<boolean> {
  const human = messages.filter(m => m.kind === 'human').pop()
  if (human === undefined || human.seq <= page.handledThrough) return false
  const now = await $.clock.now()
  const at = Date.parse(human.createdAt)
  if (!Number.isFinite(at) || now - at <= TAKEOVER_AFTER_MS) return false
  if (page.lock.holder === null) return true
  const until = page.lock.leaseUntil === null ? NaN : Date.parse(page.lock.leaseUntil)
  return !Number.isFinite(until) || until <= now
}

/** Messages in the session's cache the member has not read: newer than the last read, not their own. */
export async function unreadCount($: Pick<CoreEngineInterface, 'state' | 'store'>, binding: TeamProjectBinding): Promise<number> {
  const log = await chatLog($, binding)
  if (log === null) return 0
  const read = await storedSeq($, readKey(binding))
  const self = (await $.state.get({ plugin: 'team-project', key: 'me' })).value
  const meId = self?.id
  return log.messages.filter(m => m.seq > read && !isOwn(m, meId)).length
}

/** Marks every message in the session's cache read (the Chat tab was opened). */
export async function markChatRead($: Pick<CoreEngineInterface, 'state' | 'store'>, binding: TeamProjectBinding): Promise<void> {
  const log = await chatLog($, binding)
  const newest = log?.messages[log.messages.length - 1]?.seq
  if (newest === undefined) return
  if (newest > (await storedSeq($, readKey(binding)))) await $.store.set(readKey(binding), newest)
}
