import type { CoreEngineInterface, RenderInput } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet, apiRequest } from './api.ts'
import type { ApiOptions } from './api.ts'
import { currentBinding, isOnline, markOffline, markOnline } from './binding.ts'
import type { BindingDollar } from './binding.ts'
import type { RecapDto } from './recap.ts'
import type { DecisionDto, InstructionsDto } from './memory.ts'
import { deliverAnswers, openQuestion, postAnswer } from './answers.ts'
import { apiFailure, orderWorklog, pickThread, pickedThread } from './threads.ts'
import type { ThreadDetailDto, ThreadDollar, ThreadDto, WorklogDto } from './threads.ts'
import type { TeamProjectBinding, TeamProjectPaneThread, TeamProjectThread } from '../types/index.d.ts'
import type { Link } from './binding.ts'
import { transcriptOff } from './transcript.ts'
import { cacheVersion, formatSize } from './library.ts'
import type { LibraryDetailDto, LibraryFileDto } from './library.ts'
import type { TranscriptOptions } from './transcript.ts'
import { ChatRefused, chatLog, loadOlderChat, markChatRead, postChat, readNewChat, shownChat, unreadCount } from './chat.ts'
import type { ChatDollar, ChatMessage } from './chat.ts'

export const PANE_ID = 'team-project'
export const PANE_REFRESH_MS = 5_000
export const HINT = 'No team project is bound to this repo. An admin binds repos to projects; /team use <name> only picks among the projects already bound to this remote.'

export const UNBOUND_OFFLINE = 'Team Project · offline: the server is unreachable, so this repo is not bound yet. It retries on the next prompt.'
export const UNBOUND_REJECTED = 'Team Project · token rejected: set a valid token with claude plugin configure team-project@team-project.'

export type PaneDollar = ThreadDollar & BindingDollar & ChatDollar & Pick<CoreEngineInterface, 'ui' | 'state'>

type Tab = 'chat' | 'threads' | 'memory' | 'library'

const base = (b: TeamProjectBinding) => `/projects/${encodeURIComponent(b.projectId)}`

async function getJson<T>($: PaneDollar, opts: ApiOptions, path: string): Promise<T> {
  const res = await apiGet($, opts, path)
  if (res.status !== 200 || res.json === null) throw new ApiUnavailable(`${path}: HTTP ${res.status}`)
  return res.json as T
}

/** The detail just fetched is the picked thread's: hand its answers to the session (no extra request). */
async function deliverPaneAnswers($: PaneDollar, detail: ThreadDetailDto | null): Promise<void> {
  if (detail === null || !Array.isArray(detail.worklog)) return
  try {
    const mine = await pickedThread($)
    if (mine !== null && mine.threadId === detail.thread.threadId) await deliverAnswers($, mine, detail)
  } catch {
    // delivery is a side effect of the refresh; the next refresh or poll retries what was not marked seen
  }
}

/**
 * Reloads what the pane draws from the server into state. Never rejects: an
 * API failure marks the session offline and leaves a readable note for the pane.
 */
export async function refreshPane($: PaneDollar, opts: ApiOptions): Promise<void> {
  try {
    const binding = await currentBinding($)
    if (binding === null) {
      await $.state.set({ plugin: 'team-project', key: 'paneNote' } as const, null)
      return
    }
    const tab = (await $.state.get({ plugin: 'team-project', key: 'tab' } as const)).value ?? 'chat'
    const threads = await getJson<ThreadDto[]>($, opts, `${base(binding)}/threads`)
    if (!Array.isArray(threads)) throw new ApiUnavailable('threads: not a list')
    await $.state.set({ plugin: 'team-project', key: 'threads' } as const, threads)

    const selected = (await $.state.get({ plugin: 'team-project', key: 'selected' } as const)).value ?? null
    const row = selected === null ? undefined : threads.find(t => t.id === selected)
    const detail = row === undefined ? null : await getJson<ThreadDetailDto>($, opts, `/threads/${row.threadId}`)
    await $.state.set({ plugin: 'team-project', key: 'detail' } as const, detail)
    await deliverPaneAnswers($, detail)

    if (tab === 'memory') {
      const [instructions, decisions] = await Promise.all([
        getJson<InstructionsDto>($, opts, `${base(binding)}/instructions`),
        getJson<DecisionDto[]>($, opts, `${base(binding)}/decisions`),
      ])
      await $.state.set({ plugin: 'team-project', key: 'memory' } as const, { instructions, decisions: Array.isArray(decisions) ? decisions : [] })
    }
    if (tab === 'library') await refreshLibrary($, opts, binding)
    if (tab === 'chat') await refreshChat($, opts, binding)
    await $.state.set({ plugin: 'team-project', key: 'paneNote' } as const, null)
    if ((await isOnline($)) === false) await markOnline($, binding)
  } catch (err) {
    await paneFailed($, err)
  }
}

/** A refresh failed: a readable note for the pane, and an outage or a rejected token marks the link. Never rejects. */
async function paneFailed($: PaneDollar, err: unknown): Promise<void> {
  try {
    await $.state.set({ plugin: 'team-project', key: 'paneNote' } as const, apiFailure(err) ?? 'The pane could not refresh.')
    if (err instanceof ApiUnavailable || err instanceof TokenRejected) await markOffline($, err)
  } catch {
    // a refresh never fails its caller
  }
}

/**
 * The Chat tab's data: the messages after the newest cached, then the status of each proposal card
 * not yet settled (`GET /decisions/{no}`). A refused read (4xx) leaves the tab as it was.
 */
async function refreshChat($: PaneDollar, opts: ApiOptions, binding: TeamProjectBinding): Promise<void> {
  try {
    await readNewChat($, opts, binding)
  } catch (err) {
    if (!(err instanceof ChatRefused)) throw err
  }
  const known = (await $.state.get({ plugin: 'team-project', key: 'chatDecisions' } as const)).value
  const statuses = known && known.projectId === binding.projectId ? { ...known.statuses } : {}
  const cards = new Set((await shownChat($, binding)).map(m => m.decisionNo).filter((no): no is number => no !== null))
  for (const no of cards) {
    if (statuses[no] !== undefined && statuses[no] !== 'proposed') continue
    const res = await apiGet($, opts, `${base(binding)}/decisions/${no}`)
    if (res.status === 401) throw new TokenRejected('decision: 401')
    if (res.status >= 500) throw new ApiUnavailable(`decision: HTTP ${res.status}`)
    const status = (res.json as { status?: unknown } | null)?.status
    if (res.status === 200 && typeof status === 'string') statuses[no] = status
  }
  await $.state.set({ plugin: 'team-project', key: 'chatDecisions' } as const, { projectId: binding.projectId, statuses })
}

/** The Chat tab's own timer tick (every 3 s): re-reads the chat while that tab shows. Resolves false once the pane is gone. */
export async function tickChatPane($: PaneDollar, opts: ApiOptions): Promise<boolean> {
  try {
    if (!(await isPanePlaced($))) return false
    const tab = (await $.state.get({ plugin: 'team-project', key: 'tab' } as const)).value ?? 'chat'
    const binding = await currentBinding($)
    if (tab !== 'chat' || binding === null) return true
    await refreshChat($, opts, binding)
    if ((await isOnline($)) === false) await markOnline($, binding)
  } catch (err) {
    await paneFailed($, err)
  }
  return true
}

/** The Library tab's files, and the versions of the file clicked (dropped once it is gone from the list). */
async function refreshLibrary($: PaneDollar, opts: ApiOptions, binding: TeamProjectBinding): Promise<void> {
  const files = await getJson<LibraryFileDto[]>($, opts, `${base(binding)}/library`)
  if (!Array.isArray(files)) throw new ApiUnavailable('library: not a list')
  await $.state.set({ plugin: 'team-project', key: 'library' } as const, files)
  const selected = (await $.state.get({ plugin: 'team-project', key: 'librarySelected' } as const)).value ?? null
  const row = selected === null ? undefined : files.find(f => f.fileId === selected)
  const detail = row === undefined ? null : await getJson<LibraryDetailDto>($, opts, `/library/${encodeURIComponent(row.fileId)}`)
  const ok = detail !== null && detail.fileId === row?.fileId && Array.isArray(detail.versions)
  await $.state.set({ plugin: 'team-project', key: 'libraryDetail' } as const, ok ? detail : null)
}

/** Whether the pane is open and placed; a failing lookup counts as placed (keeps the pane alive). */
export async function isPanePlaced($: Pick<CoreEngineInterface, 'ui'>): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE_ID && p.isPlaced)
  } catch {
    return true
  }
}

/** One timer tick: refreshes while the pane is placed. Never rejects; resolves false once the timer should stop. */
export async function tickPane($: PaneDollar, opts: ApiOptions): Promise<boolean> {
  try {
    if (!(await isPanePlaced($))) return false
    await refreshPane($, opts)
  } catch {
    // a tick never fails
  }
  return true
}

/** Opens the pane and loads it; resolves whether the surface placed it. Never rejects. */
export async function openPane($: PaneDollar, opts: ApiOptions): Promise<{ isPlaced: boolean; text: string }> {
  let opened: Awaited<ReturnType<PaneDollar['ui']['open']>>
  try {
    opened = await $.ui.open({ id: PANE_ID, title: '👥 Team Project' })
  } catch (err) {
    return { isPlaced: false, text: `Team Project pane could not be opened: ${err instanceof Error ? err.message : 'refused'}` }
  }
  await refreshPane($, opts)
  return opened.isPlaced
    ? { isPlaced: true, text: 'Team Project pane opened.' }
    : { isPlaced: false, text: `Team Project pane is waiting for room: ${opened.reason}` }
}

async function showTab($: PaneDollar, opts: ApiOptions, tab: Tab): Promise<void> {
  await $.state.set({ plugin: 'team-project', key: 'tab' } as const, tab)
  await refreshPane($, opts)
}

async function selectThread($: PaneDollar, opts: ApiOptions, id: string): Promise<void> {
  const current = (await $.state.get({ plugin: 'team-project', key: 'selected' } as const)).value ?? null
  await $.state.set({ plugin: 'team-project', key: 'selected' } as const, current === id ? null : id)
  await $.state.set({ plugin: 'team-project', key: 'detail' } as const, null)
  await $.state.set({ plugin: 'team-project', key: 'answerNote' } as const, null)
  await refreshPane($, opts)
}

/**
 * Enter in a waiting thread's answer field: the same POST as `/team answer`, to the
 * question open in the detail shown. Notes `Answered.` or why not, then refreshes;
 * the answerer's own picked thread is left as it is.
 */
async function answerFromPane($: PaneDollar, opts: ApiOptions, threadId: string, text: string): Promise<void> {
  const note = (t: string) => $.state.set({ plugin: 'team-project', key: 'answerNote' } as const, { threadId, text: t })
  try {
    const detail = (await $.state.get({ plugin: 'team-project', key: 'detail' } as const)).value ?? null
    const question = detail?.thread.threadId === threadId ? openQuestion(detail.worklog) : null
    if (text.trim() === '') await note('Type an answer, then press Enter.')
    else if (question === null) await note(`${detail?.thread.id ?? 'This thread'} has no open question.`)
    else await note((await postAnswer($, opts, threadId, question.entryId, text)) ?? 'Answered.')
  } catch (err) {
    try {
      await note(apiFailure(err) ?? 'The answer could not be sent.')
      if (err instanceof ApiUnavailable || err instanceof TokenRejected) await markOffline($, err)
    } catch {
      // the field's handler never fails
    }
  }
  await refreshPane($, opts)
}

async function selectFile($: PaneDollar, opts: ApiOptions, fileId: string): Promise<void> {
  const current = (await $.state.get({ plugin: 'team-project', key: 'librarySelected' } as const)).value ?? null
  await $.state.set({ plugin: 'team-project', key: 'librarySelected' } as const, current === fileId ? null : fileId)
  await $.state.set({ plugin: 'team-project', key: 'libraryDetail' } as const, null)
  await refreshPane($, opts)
}

/** Typing in `Filter…`: kept in state and applied while drawing; no request. */
async function filterLibrary($: PaneDollar, text: string): Promise<void> {
  try {
    await $.state.set({ plugin: 'team-project', key: 'libraryFilter' } as const, text)
  } catch {
    // the field's handler never fails
  }
}

/** A version's Open button: the same cache as `library_get`; the path goes in a toast. */
async function openFromPane($: PaneDollar, opts: ApiOptions, fileId: string, version: number): Promise<void> {
  try {
    const binding = await currentBinding($)
    const detail = (await $.state.get({ plugin: 'team-project', key: 'libraryDetail' } as const)).value ?? null
    const v = detail?.fileId === fileId ? detail.versions.find(x => x.version === version) : undefined
    if (binding === null || detail === null || v === undefined) {
      $.ui.toast(`Could not open v${version}: the file is no longer shown.`)
      return
    }
    const out = await cacheVersion($, opts, binding, fileId, detail.name, v)
    $.ui.toast('path' in out ? `Saved to ${out.path}` : out.error)
  } catch (err) {
    try {
      $.ui.toast(apiFailure(err) ?? `Could not open v${version}.`)
      if (err instanceof ApiUnavailable || err instanceof TokenRejected) await markOffline($, err)
    } catch {
      // the button's handler never fails
    }
  }
}

/** Typing in the chat field: kept in state, so the field keeps it across redraws. */
async function draftChat($: PaneDollar, text: string): Promise<void> {
  try {
    await $.state.set({ plugin: 'team-project', key: 'chatDraft' } as const, text)
  } catch {
    // the field's handler never fails
  }
}

/**
 * Enter in the chat field: the same post as `/team say`. Sent → the field clears and the chat is
 * re-read; not sent → the text stays and a toast says why (the credential block toasts on its own).
 */
async function sendFromPane($: PaneDollar, opts: ApiOptions, text: string): Promise<void> {
  try {
    await $.state.set({ plugin: 'team-project', key: 'chatDraft' } as const, text)
    const out = await postChat($, opts, text)
    if ('error' in out) {
      if (!out.error.startsWith('Not sent:')) $.ui.toast(out.error)
      return
    }
    await $.state.set({ plugin: 'team-project', key: 'chatDraft' } as const, '')
  } catch {
    try {
      $.ui.toast('The message could not be sent.')
    } catch {
      // the field's handler never fails
    }
    return
  }
  await refreshPane($, opts)
}

/** `Load older`: the page before the first message shown. */
async function olderFromPane($: PaneDollar, opts: ApiOptions): Promise<void> {
  try {
    const binding = await currentBinding($)
    if (binding !== null) await loadOlderChat($, opts, binding)
  } catch (err) {
    await paneFailed($, err)
  }
}

/** A proposal card's Confirm or Reject: settles the decision, then re-reads the chat and the card's status. */
async function settleFromPane($: PaneDollar, opts: ApiOptions, no: number, verb: 'confirm' | 'reject'): Promise<void> {
  try {
    const binding = await currentBinding($)
    if (binding === null) return
    const res = await apiRequest($, opts, 'POST', `${base(binding)}/decisions/${no}/${verb}`, {})
    if (res.status === 401) throw new TokenRejected(`${verb}: 401`)
    if (res.status >= 500) throw new ApiUnavailable(`${verb}: HTTP ${res.status}`)
    if (res.status !== 200) {
      const error = (res.json as { error?: unknown } | null)?.error
      $.ui.toast(`D-${no} was not ${verb === 'confirm' ? 'confirmed' : 'rejected'}${typeof error === 'string' ? `: ${error}` : ` (HTTP ${res.status})`}.`)
    }
    const status = (res.json as { status?: unknown } | null)?.status
    const known = (await $.state.get({ plugin: 'team-project', key: 'chatDecisions' } as const)).value
    const statuses = known && known.projectId === binding.projectId ? { ...known.statuses } : {}
    // a refusal (it was settled meanwhile) is read again by the refresh
    if (res.status === 200 && typeof status === 'string') statuses[no] = status
    else delete statuses[no]
    await $.state.set({ plugin: 'team-project', key: 'chatDecisions' } as const, { projectId: binding.projectId, statuses })
  } catch (err) {
    try {
      $.ui.toast(apiFailure(err) ?? `Could not ${verb} D-${no}.`)
      if (err instanceof ApiUnavailable || err instanceof TokenRejected) await markOffline($, err)
    } catch {
      // the button's handler never fails
    }
  }
  await refreshPane($, opts)
}

const twoDigits = (n: number) => String(n).padStart(2, '0')

/** A chat message's speaker line: `name · HH:mm` (local time) for a member, `Claude via name` for the Coordinator. */
export function chatSpeaker(m: ChatMessage): string {
  if (m.kind === 'coordinator') return `Claude via ${m.author?.name ?? 'a teammate'}`
  const at = new Date(m.createdAt)
  const time = Number.isNaN(at.getTime()) ? '' : ` · ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`
  return `${m.author?.name ?? 'someone'}${time}`
}

/** the speaker's name and the time, apart, for a chat bubble's header row */
export function chatByline(m: ChatMessage): { who: string, time: string } {
  const who = m.kind === 'coordinator' ? `Claude · via ${m.author?.name ?? 'a teammate'}` : m.author?.name ?? 'someone'
  const at = new Date(m.createdAt)
  const time = Number.isNaN(at.getTime()) ? '' : `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`
  return { who, time }
}

export const CHAT_EMPTY = 'No messages yet. Type below, or /team say <text>.'

/** `<name> · v<n> · <size> · <who> · <date>` */
export const libraryRow = (f: LibraryFileDto): string =>
  `${f.name} · v${f.latestVersion} · ${formatSize(f.sizeBytes)} · ${f.updatedBy?.name ?? 'someone'} · ${String(f.updatedAt).slice(0, 10)}`

/** `v<n> · <note> · <who> · <date> · from T-n · D-<no>, …`, leaving out what a version lacks. */
export const versionLine = (v: LibraryDetailDto['versions'][number]): string =>
  [
    `v${v.version}`,
    ...(v.note ? [v.note] : []),
    v.uploadedBy?.name ?? 'someone',
    String(v.createdAt).slice(0, 10),
    ...(v.sourceThread ? [`from ${v.sourceThread}`] : []),
    ...(Array.isArray(v.decisions) && v.decisions.length > 0 ? [v.decisions.map(d => `D-${d}`).join(', ')] : []),
  ].join(' · ')

export const LIBRARY_EMPTY = 'No files yet. Ask Claude to add one with library_add.'

/** The Pick button: the same path as `/team pick`. */
async function pickFromPane($: PaneDollar, opts: ApiOptions, id: string): Promise<void> {
  try {
    const out = await pickThread($, opts, id)
    $.ui.toast('text' in out ? out.text : out.error)
  } catch {
    $.ui.toast(`Could not pick ${id}.`)
  }
  await refreshPane($, opts)
}

const STATUS_ORDER = ['active', 'proposed']
const statusRank = (s: string) => {
  const i = STATUS_ORDER.indexOf(s)
  return i < 0 ? STATUS_ORDER.length : i
}

/** Decisions grouped by status: active, proposed, then the rest (superseded, rejected) in name order. */
export function groupDecisions(decisions: DecisionDto[]): [string, DecisionDto[]][] {
  const groups = new Map<string, DecisionDto[]>()
  for (const d of decisions) groups.set(d.status, [...(groups.get(d.status) ?? []), d])
  return [...groups.entries()].sort(([a], [b]) => statusRank(a) - statusRank(b) || a.localeCompare(b))
}

/**
 * The pane's header: the project, the picked thread and its status, and the link
 * when it is down. A headless session (the desktop app) has no status row, so this
 * line carries what the terminal's `👥 …` status shows.
 */
export function paneHeader(
  binding: TeamProjectBinding,
  mine: TeamProjectThread | null,
  threads: TeamProjectPaneThread[],
  link: Link | undefined,
  isTranscriptOff = false,
): string {
  // the local waiting mark is set at once; the listed status catches up on the next refresh
  const status = mine === null ? '' : mine.waiting ? 'waiting' : threads.find(t => t.id === mine.id)?.status ?? 'working'
  const thread = mine === null ? '' : ` · ${mine.id} (${status})`
  const down = link === 'offline' ? ' · offline' : link === 'rejected' ? ' · token rejected' : ''
  return `${binding.name}${thread}${down}${isTranscriptOff ? ' · transcript off' : ''}`
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The colors of the design in the "Team Project — Design v5" artifact (dark). */
export const PALETTE = {
  line: '#3a3833', panel: '#22211e', panel2: '#2a2925', text: '#ecebe6', muted: '#a5a39b', dim: '#77756e',
  accent: '#d97757', onAccent: '#1a1210', green: '#7fb069', blue: '#6fa8dc', amber: '#e0b04f', red: '#d98a7a',
  amberSoft: '#2f2a1d', greenSoft: '#232a1f', blueSoft: '#1f2630', redSoft: '#2f2321',
} as const

/** avatar colors for members, picked by name so a person keeps theirs */
const AVATARS = [
  { bg: '#3b2a22', fg: '#e8a184' },
  { bg: '#24303b', fg: '#8fbfe6' },
  { bg: '#2c3324', fg: '#a8cc8c' },
  { bg: '#3a2f3d', fg: '#d3a6e0' },
  { bg: '#3b3522', fg: '#e6cf8f' },
] as const

export function avatarFor(name: string): { bg: string, fg: string, glyph: string } {
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  const c = AVATARS[h % AVATARS.length]
  return { ...c, glyph: ([...name.trim()][0] ?? '?').toUpperCase() }
}

/** the recap card's headline with how long ago it was written */
export function recapLine(r: RecapDto, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(r.at).getTime()) / 60_000))
  const age = min < 1 ? 'just now' : min < 60 ? `${min}m ago` : min < 1440 ? `${Math.floor(min / 60)}h ago` : `${Math.floor(min / 1440)}d ago`
  return `${r.headline} · ${age}`
}

const recapColor = (state: RecapDto['state']): string =>
  state === 'needs_reply' ? PALETTE.amber : state === 'failed' ? PALETTE.red : PALETTE.muted

/** a thread or decision status, in the color the design gives it */
export function statusColor(status: string): string {
  switch (status) {
    case 'active': case 'done': return PALETTE.green
    case 'working': case 'review': case 'pr_open': return PALETTE.blue
    case 'waiting': case 'proposed': case 'stale': return PALETTE.amber
    case 'rejected': return PALETTE.red
    default: return PALETTE.muted
  }
}

const KIND_COLORS: Record<string, { fg: string, bg: string }> = {
  decision: { fg: PALETTE.green, bg: PALETTE.greenSoft },
  attempt_failed: { fg: PALETTE.red, bg: PALETTE.redSoft },
  milestone: { fg: PALETTE.blue, bg: PALETTE.blueSoft },
  blocker: { fg: PALETTE.amber, bg: PALETTE.amberSoft },
  direction_change: { fg: PALETTE.accent, bg: PALETTE.redSoft },
}

/** The header chip: whether the link to the server is up. */
export function headerChip(link: Link | undefined): { text: string, color: string } {
  if (link === 'offline') return { text: '● server down', color: PALETTE.red }
  if (link === 'rejected') return { text: '● token rejected', color: PALETTE.red }
  return { text: '● online', color: PALETTE.green }
}

/** The send button beside the chat field: sends what the field holds. */
async function sendDraftFromPane($: PaneDollar, opts: ApiOptions): Promise<void> {
  let draft = ''
  try {
    draft = (await $.state.get({ plugin: 'team-project', key: 'chatDraft' } as const)).value ?? ''
  } catch {
    return
  }
  if (draft.trim() === '') return
  await sendFromPane($, opts, draft)
}

export async function renderPane($: PaneDollar, e: RenderInput<'Pane'>, opts: TranscriptOptions) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const P = PALETTE
  const binding = (await $.state.get({ plugin: 'team-project', key: 'binding' } as const)).value ?? null
  const link = (await $.state.get({ plugin: 'team-project', key: 'link' } as const)).value
  if (binding === null) {
    // unbound because the API is down: say so rather than the no-project hint
    if (link === 'offline') return <Text bold>{UNBOUND_OFFLINE}</Text>
    if (link === 'rejected') return <Text bold>{UNBOUND_REJECTED}</Text>
    return <Text>{HINT}</Text>
  }

  const tab = (await $.state.get({ plugin: 'team-project', key: 'tab' } as const)).value ?? 'chat'
  // drawing the Chat tab reads what it shows; the count on its label is what arrived since
  if (tab === 'chat') await markChatRead($, binding)
  const unread = await unreadCount($, binding)
  const note = (await $.state.get({ plugin: 'team-project', key: 'paneNote' } as const)).value ?? null
  // read while drawn, so a pick, release or link change redraws the header
  const mine = (await $.state.get({ plugin: 'team-project', key: 'thread' } as const)).value ?? null
  const threads = (await $.state.get({ plugin: 'team-project', key: 'threads' } as const)).value ?? []
  const chip = headerChip(link)
  const title = paneHeader(binding, mine, threads, link, await transcriptOff($, opts))

  /** a bordered card on the panel color, its left edge a strip of `accent` */
  const card = (key: string, accent: string, body: unknown, border: string = P.line) => (
    <Box key={key} flexDirection="row" borderStyle="round" borderColor={border} backgroundColor={P.panel} overflow="hidden">
      <Box width={1} backgroundColor={accent} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={1} gap="xs">{body}</Box>
    </Box>
  )
  const tabButton = (id: Tab, text: string) => (
    <Box key={`tabbox-${id}`} backgroundColor={tab === id ? P.panel2 : undefined} paddingX={1}>
      <Button key={`tab-${id}`} plain onPress={() => showTab($, opts, id)}>
        <Text color={tab === id ? P.text : P.muted} weight={tab === id ? 'semibold' : 'regular'} size="footnote">{text}</Text>
      </Button>
    </Box>
  )
  const head = (
    <Box flexDirection="column" gap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Text bold color={P.text}>{title}</Text>
        <Box borderStyle="round" borderColor={P.line} paddingX={1}>
          <Text color={chip.color} size="caption">{chip.text}</Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap="xs">
        {tabButton('chat', unread > 0 ? `แชทหลัก (${unread})` : 'แชทหลัก')}
        {tabButton('threads', 'Threads')}
        {tabButton('memory', 'Memory')}
        {tabButton('library', 'Library')}
      </Box>
      {note !== null && <Text color={P.red} size="footnote">{`offline: ${note}`}</Text>}
    </Box>
  )
  const sectionTitle = (text: string) => <Text color={P.dim} size="caption" weight="semibold">{text.toUpperCase()}</Text>
  const dimText = (text: string) => <Text color={P.dim} size="footnote">{text}</Text>

  if (tab === 'chat') {
    const log = await chatLog($, binding)
    const shown = await shownChat($, binding)
    const draft = (await $.state.get({ plugin: 'team-project', key: 'chatDraft' } as const)).value ?? ''
    const known = (await $.state.get({ plugin: 'team-project', key: 'chatDecisions' } as const)).value
    const statuses = known && known.projectId === binding.projectId ? known.statuses : {}
    // the server keeps a lapsed holder until the next acquire: a run out lease is nobody answering
    const until = log?.lock.leaseUntil ? Date.parse(log.lock.leaseUntil) : NaN
    const holder = log?.lock.holder && !(until <= (await $.clock.now())) ? log.lock.holder : null

    const avatar = (bg: string, fg: string, glyph: string) => (
      <Box width={3} minWidth={3} backgroundColor={bg} justifyContent="center" alignItems="center">
        <Text color={fg} bold size="footnote">{glyph}</Text>
      </Box>
    )
    const message = (m: ChatMessage) => {
      const { time } = chatByline(m)
      const isCoordinator = m.kind === 'coordinator' || m.decisionNo !== null
      const isSystem = m.kind === 'system'
      const name = isSystem ? 'ระบบ' : isCoordinator ? 'Coordinator' : m.author?.name ?? 'someone'
      const av = isSystem ? { bg: P.panel2, fg: P.muted, glyph: '•' }
        : isCoordinator ? { bg: P.accent, fg: P.onAccent, glyph: '✳' }
        : avatarFor(name)
      const status = m.decisionNo === null ? undefined : statuses[m.decisionNo]
      return (
        <Box key={`msg-${m.seq}`} flexDirection="row" gap={1}>
          {avatar(av.bg, av.fg, av.glyph)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} gap="xs">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text bold color={P.text} size="footnote">{name}</Text>
              {isCoordinator && m.author?.name && <Text color={P.dim} size="footnote">{`· ตอบโดย Claude ของ ${m.author.name}`}</Text>}
              {time !== '' && <Text color={P.dim} size="footnote">{time}</Text>}
            </Box>
            {isSystem ? card(`card-${m.seq}`, P.dim, <Text color={P.muted} size="footnote">{m.body}</Text>)
              : m.decisionNo !== null ? card(`card-${m.seq}`, P.green, [
                <Text key="d-body" color={P.text}>{m.body}</Text>,
                status === 'proposed' ? (
                  <Box key="d-act" flexDirection="row" gap={1}>
                    <Button key={`confirm-D-${m.decisionNo}`} variant="primary" onPress={() => settleFromPane($, opts, m.decisionNo ?? 0, 'confirm')}>Confirm</Button>
                    <Button key={`reject-D-${m.decisionNo}`} variant="secondary" onPress={() => settleFromPane($, opts, m.decisionNo ?? 0, 'reject')}>Reject</Button>
                  </Box>
                ) : status !== undefined && (
                  <Text key="d-status" size="footnote" color={statusColor(status)}>{`D-${m.decisionNo} ${status}`}</Text>
                ),
              ])
              : <Text color={P.text}>{m.body}</Text>}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="md">
        {head}
        {log === null ? dimText('No chat loaded yet.') : shown.length === 0 && dimText(CHAT_EMPTY)}
        {(shown[0]?.seq ?? 1) > 1 && <Button key="chat-older" plain onPress={() => olderFromPane($, opts)}><Text color={P.muted} size="footnote">Load older</Text></Button>}
        {shown.map(message)}
        {holder !== null && (
          <Box borderStyle="round" borderColor={P.amber} backgroundColor={P.amberSoft} paddingX={1}>
            <Text color={P.amber} size="footnote">{`Claude (via ${holder.name}) is answering…`}</Text>
          </Box>
        )}
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1}>
            <Input key="chat-input" placeholder="พิมพ์ลงแชทกลาง (ทุกคนเห็น)" value={draft} submitLabel="ส่ง"
              onInput={(value: string) => void draftChat($, value)}
              onSubmit={(value: string) => sendFromPane($, opts, value)} />
          </Box>
          <Button key="chat-send" variant="primary" onPress={() => sendDraftFromPane($, opts)}>ส่ง</Button>
        </Box>
      </Box>
    )
  }

  if (tab === 'memory') {
    const memory = (await $.state.get({ plugin: 'team-project', key: 'memory' } as const)).value ?? null
    return (
      <Box flexDirection="column" gap="md">
        {head}
        {memory === null ? dimText('No memory loaded yet.') : (
          <Box flexDirection="column" gap="sm">
            {sectionTitle(`Instructions · v${memory.instructions.version}`)}
            <Box borderStyle="round" borderColor={P.line} backgroundColor={P.panel} paddingX={1}>
              <Text color={P.text} size="footnote">{memory.instructions.body}</Text>
            </Box>
            {sectionTitle('Decisions')}
            {memory.decisions.length === 0 && dimText('(none yet)')}
            {groupDecisions(memory.decisions).map(([status, list]) => (
              <Box key={`group-${status}`} flexDirection="column" gap="xs">
                <Text color={statusColor(status)} size="footnote" weight="semibold">{`${label(status)} (${list.length})`}</Text>
                {list.map(d => (
                  <Box key={`dec-${d.id}`} borderStyle="round" borderColor={P.line} backgroundColor={P.panel} paddingX={1} flexDirection="column">
                    <Text color={status === 'superseded' || status === 'rejected' ? P.muted : P.text} size="footnote">{`${d.id} · ${d.title}${d.scope ? ` · ${d.scope}` : ''}`}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  }

  if (tab === 'library') {
    const files = (await $.state.get({ plugin: 'team-project', key: 'library' } as const)).value ?? null
    const filter = (await $.state.get({ plugin: 'team-project', key: 'libraryFilter' } as const)).value ?? ''
    const picked = (await $.state.get({ plugin: 'team-project', key: 'librarySelected' } as const)).value ?? null
    const shown = (await $.state.get({ plugin: 'team-project', key: 'libraryDetail' } as const)).value ?? null
    const needle = filter.trim().toLowerCase()
    const rows = (files ?? []).filter(f => needle === '' || f.name.toLowerCase().includes(needle))
    return (
      <Box flexDirection="column" gap="md">
        {head}
        {files === null ? dimText('No library loaded yet.') : files.length === 0 ? dimText(LIBRARY_EMPTY) : (
          <Box flexDirection="column" gap="sm">
            <Input key="library-filter" label="Filter…" value={filter} submitLabel="filter"
              onInput={(value: string) => void filterLibrary($, value)}
              onSubmit={(value: string) => filterLibrary($, value)} />
            {rows.length === 0 && dimText(`No files match "${filter.trim()}".`)}
            {rows.map(f => (
              <Box key={`lib-${f.fileId}`} flexDirection="column" borderStyle="round" borderColor={picked === f.fileId ? P.accent : P.line} backgroundColor={P.panel} paddingX={1}>
                <Button key={`file-${f.fileId}`} plain onPress={() => selectFile($, opts, f.fileId)}>
                  <Text color={P.text} size="footnote">{`${picked === f.fileId ? '▾' : '▸'} ${libraryRow(f)}`}</Text>
                </Button>
                {shown !== null && picked === f.fileId && shown.fileId === f.fileId && (
                  <Box flexDirection="column" paddingLeft={2} gap="xs">
                    <Text color={P.muted} size="footnote">{`Summary: ${shown.versions[0]?.summary ?? f.summary}`}</Text>
                    {shown.versions.map(v => (
                      <Box key={`ver-${f.fileId}-${v.version}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
                        <Text color={P.muted} size="footnote">{versionLine(v)}</Text>
                        <Button key={`open-${f.fileId}-v${v.version}`} variant="secondary" onPress={() => openFromPane($, opts, f.fileId, v.version)}>Open</Button>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  }

  const selected = (await $.state.get({ plugin: 'team-project', key: 'selected' } as const)).value ?? null
  const detail = (await $.state.get({ plugin: 'team-project', key: 'detail' } as const)).value ?? null
  const answerNote = (await $.state.get({ plugin: 'team-project', key: 'answerNote' } as const)).value ?? null
  // a waiting thread takes an answer to its open question, from anyone on the team
  const asking = detail !== null && detail.thread.status === 'waiting' ? openQuestion(detail.worklog) : null
  return (
    <Box flexDirection="column" gap="md">
      {head}
      {threads.length === 0 && dimText('No threads yet.')}
      <Box flexDirection="column" gap="sm">
        {threads.map(t => (
          <Box key={`row-${t.id}`} flexDirection="column" borderStyle="round" borderColor={selected === t.id ? P.accent : P.line} backgroundColor={P.panel} paddingX={1}>
            <Box flexDirection="row" gap={1} justifyContent="space-between" alignItems="center">
              <Button key={`thread-${t.id}`} plain onPress={() => selectThread($, opts, t.id)}>
                <Text color={P.text} size="footnote">{`${selected === t.id ? '▾' : '▸'} ${t.id} · ${t.title}`}</Text>
              </Button>
              <Box flexDirection="row" gap={1} alignItems="center">
                {t.status === 'waiting' && <Text color={P.amber} size="footnote">❓ needs answer</Text>}
                <Text color={statusColor(t.status)} size="footnote">{t.status}</Text>
                {(t.status === 'open' || t.status === 'stale') && (
                  <Button key={`pick-${t.id}`} variant="primary" onPress={() => pickFromPane($, opts, t.id)}>Pick</Button>
                )}
              </Box>
            </Box>
            <Text color={P.dim} size="caption">{`${t.owner?.name ?? 'unowned'}${mine?.id === t.id ? ' (yours)' : ''}`}</Text>
            {t.recap != null && <Text color={recapColor(t.recap.state)} size="caption">{recapLine(t.recap, new Date())}</Text>}
            {t.recap != null && (t.recap.state === 'needs_reply' || t.recap.state === 'failed') && t.recap.needsYou && (
              <Text color={recapColor(t.recap.state)} size="caption">{`↳ ${t.recap.needsYou}`}</Text>
            )}
          </Box>
        ))}
      </Box>
      {detail !== null && detail.thread.id === selected && (
        <Box flexDirection="column" gap="xs" borderStyle="round" borderColor={P.line} paddingX={1}>
          <Text bold color={P.text} size="footnote">{`Worklog · ${detail.thread.id}`}</Text>
          {dimText(`Goal: ${detail.thread.goal || '(none)'}`)}
          {detail.worklog.length === 0 && dimText('(empty)')}
          {orderWorklog(detail.worklog).map((w: WorklogDto) => w.kind === 'answer' ? (
            <Box key={`entry-${w.entryId}`} paddingLeft={2}>
              <Text color={P.text} size="footnote">{`↳ ${w.author.name}: ${w.reasoning ?? w.summary}`}</Text>
            </Box>
          ) : (
            <Box key={`entry-${w.entryId}`} flexDirection="column" gap="xs">
              <Box flexDirection="row" gap={1}>
                <Text color={(KIND_COLORS[w.kind] ?? { fg: P.muted }).fg} backgroundColor={(KIND_COLORS[w.kind] ?? { bg: P.panel2 }).bg} size="caption">{` ${w.kind} `}</Text>
                <Box flexDirection="column" flexShrink={1}>
                  <Text color={P.text} size="footnote">{`${w.author.name}: ${w.summary}`}</Text>
                  {w.reasoning ? dimText(w.reasoning) : null}
                </Box>
              </Box>
              {asking !== null && asking.entryId === w.entryId && (
                <Input
                  key={`answer-${detail.thread.threadId}`}
                  label="Answer…"
                  submitLabel="answer"
                  onSubmit={(value: string) => answerFromPane($, opts, detail.thread.threadId, value)}
                />
              )}
            </Box>
          ))}
          {answerNote !== null && answerNote.threadId === detail.thread.threadId && <Text color={P.text} size="footnote">{answerNote.text}</Text>}
        </Box>
      )}
    </Box>
  )
}
