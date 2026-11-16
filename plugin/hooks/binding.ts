import type { CoreEngineInterface } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiGet } from './api.ts'
import type { ApiOptions } from './api.ts'
import type { TeamProjectBinding } from '../types/index.d.ts'

export type Binding = TeamProjectBinding

export type BindingDollar = Pick<CoreEngineInterface, 'process' | 'state' | 'store' | 'ui' | 'clock'>

const BINDING = { plugin: 'team-project', key: 'binding' } as const
const ONLINE = { plugin: 'team-project', key: 'online' } as const
const LINK = { plugin: 'team-project', key: 'link' } as const

/** How the session last reached the API: answered, unreachable, or answered 401. */
export type Link = 'online' | 'offline' | 'rejected'

export const STATUS_OFFLINE = '👥 offline'
export const STATUS_REJECTED = '👥 token rejected'
export const STATUS_CHOOSE = '👥 choose: /team use <name>'

export const TOAST_OFFLINE = 'Team Project server unreachable: working offline. It retries on its own.'
export const TOAST_REJECTED = 'Team Project server rejected the token. Set a valid one: claude plugin configure team-project@team-project'
export const toastOnline = (name: string | undefined) => `Team Project back online${name ? `: ${name}` : ''}.`

const BIND_RETRY_MS = 15_000
// When the last bind failed because the API was unavailable or the token was rejected.
let bindFailedAt: number | null = null
// The working directory the last bind ran for. The desktop app starts a parked spare in a neutral
// directory and moves it into the session's folder when claimed (and set_cwd moves a running session),
// so the directory `session.start` saw may not be the session's: a different one binds again.
let boundCwd: string | null = null

const choiceKey = (remote: string) => `team-project:choice:${remote}`

/** The binding the session holds now, or null. */
export async function currentBinding($: Pick<CoreEngineInterface, 'state'>): Promise<Binding | null> {
  const { value } = await $.state.get(BINDING)
  return value ?? null
}

/** Whether the last API call answered; undefined before any. */
export async function isOnline($: Pick<CoreEngineInterface, 'state'>): Promise<boolean | undefined> {
  const { value } = await $.state.get(ONLINE)
  return value
}

/** How the session last reached the API; undefined before any call. */
export async function currentLink($: Pick<CoreEngineInterface, 'state'>): Promise<Link | undefined> {
  const { value } = await $.state.get(LINK)
  return value
}

/**
 * Records the link and raises a toast only when it changed: going offline, the
 * token rejected, or answering again after either. The first answer of a session
 * raises none. Toasts show on every surface, so a headless session (the desktop
 * app, which has no status row) still hears of it. Never rejects for the toast.
 */
async function setLink($: Pick<CoreEngineInterface, 'state' | 'ui'>, next: Link, name?: string): Promise<void> {
  const prev = await currentLink($)
  await $.state.set(ONLINE, next === 'online')
  if (prev === next) return
  await $.state.set(LINK, next)
  if (next === 'online' && prev === undefined) return
  try {
    $.ui.toast(next === 'offline' ? TOAST_OFFLINE : next === 'rejected' ? TOAST_REJECTED : toastOnline(name))
  } catch {
    // a toast never fails its caller
  }
}

/** The API answered again: back online, and the status shows the project. */
export async function markOnline($: Pick<CoreEngineInterface, 'state' | 'ui'>, binding: Binding): Promise<void> {
  await setLink($, 'online', binding.name)
  const thread = (await $.state.get({ plugin: 'team-project', key: 'thread' })).value
  $.ui.status(thread ? `👥 ${binding.name} · ${thread.id}` : `👥 ${binding.name}`)
}

/** The working directory the last bind ran for, or null before any. */
export const boundDirectory = (): string | null => boundCwd

/** Binds again when the session now runs in another directory than the last bind's. Resolves whether it did. */
export async function rebindIfMoved($: BindingDollar, cwd: string, opts: ApiOptions): Promise<boolean> {
  if (cwd === '' || cwd === boundCwd) return false
  await bindSession($, cwd, opts)
  return true
}

/**
 * Called when the session is unbound: re-runs `bindSession` if the last bind
 * failed on the API (not for no remote / no matching project), at most once
 * per BIND_RETRY_MS.
 */
export async function retryBind($: BindingDollar, cwd: string, opts: ApiOptions): Promise<Binding | null> {
  if (bindFailedAt === null) return null
  if ((await $.clock.now()) - bindFailedAt < BIND_RETRY_MS) return null
  return bindSession($, cwd, opts)
}

/** Records that the API did (or did not) answer and shows the matching status. */
export async function markOffline($: Pick<CoreEngineInterface, 'state' | 'ui'>, err: unknown): Promise<void> {
  await setLink($, err instanceof TokenRejected ? 'rejected' : 'offline')
  $.ui.status(err instanceof TokenRejected ? STATUS_REJECTED : STATUS_OFFLINE)
}

type Candidates =
  | { kind: 'ok'; remote: string; projects: Binding[] }
  | { kind: 'no-remote' }
  | { kind: 'failed'; error: unknown }

async function candidates($: BindingDollar, cwd: string, opts: ApiOptions): Promise<Candidates> {
  let remote = ''
  try {
    const git = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd })
    if (git.exitCode === 0) remote = git.stdout.trim()
  } catch {
    // git missing or not runnable: same as no remote
  }
  if (remote === '') return { kind: 'no-remote' }
  try {
    const res = await apiGet($, opts, `/bindings?remote=${encodeURIComponent(remote)}`)
    if (res.status !== 200 || !Array.isArray(res.json)) {
      return { kind: 'failed', error: new ApiUnavailable(`bindings: HTTP ${res.status}`) }
    }
    return { kind: 'ok', remote, projects: res.json as Binding[] }
  } catch (err) {
    if (err instanceof ApiUnavailable || err instanceof TokenRejected) return { kind: 'failed', error: err }
    throw err
  }
}

/**
 * Binds the session to the team project of this repo's `origin`. Writes the
 * `binding` and `online` state and the status line; never throws for a
 * missing repo or an unreachable API.
 */
export async function bindSession($: BindingDollar, cwd: string, opts: ApiOptions): Promise<Binding | null> {
  boundCwd = cwd
  const found = await candidates($, cwd, opts)
  bindFailedAt = found.kind === 'failed' ? await $.clock.now() : null
  if (found.kind === 'no-remote') {
    await $.state.set(BINDING, null)
    // no API call was made: drop a stale offline/rejected mark (quietly, no toast)
    // so the pane shows the no-project hint, not an outage
    const prev = await currentLink($)
    if (prev === 'offline' || prev === 'rejected') {
      await $.state.set(LINK, 'online')
      await $.state.set(ONLINE, true)
    }
    $.ui.status(undefined)
    return null
  }
  if (found.kind === 'failed') {
    await $.state.set(BINDING, null)
    await markOffline($, found.error)
    return null
  }

  const { projects } = found
  let bound: Binding | null = null
  if (projects.length === 1) {
    bound = projects[0] ?? null
  } else if (projects.length > 1) {
    const chosen = await $.store.get(choiceKey(found.remote))
    bound = projects.find(p => p.projectId === chosen) ?? null
  }
  await $.state.set(BINDING, bound)
  await setLink($, 'online', bound?.name)
  $.ui.status(bound ? `👥 ${bound.name}` : projects.length > 1 ? STATUS_CHOOSE : undefined)
  return bound
}

/** `/team use <name>`: stores the choice for this remote and re-binds. Resolves the reply text. */
export async function useProject($: BindingDollar, cwd: string, opts: ApiOptions, name: string): Promise<string> {
  if (name.trim() === '') return 'Usage: /team use <name>'
  const found = await candidates($, cwd, opts)
  if (found.kind === 'no-remote') return 'This directory has no git remote "origin", so no team project can be matched.'
  if (found.kind === 'failed') {
    await markOffline($, found.error)
    return found.error instanceof TokenRejected
      ? 'The Team Project server rejected the token. Check the plugin token.'
      : 'The Team Project server is unreachable. Try again later.'
  }
  const list = found.projects.map(p => `- ${p.name}`).join('\n')
  const match = found.projects.find(p => p.name.toLowerCase() === name.trim().toLowerCase())
  if (match === undefined) {
    return found.projects.length === 0
      ? 'No team project is linked to this repository.'
      : `No project named "${name.trim()}" for this repository. Candidates:\n${list}`
  }
  await $.store.set(choiceKey(found.remote), match.projectId)
  await $.state.set(BINDING, match)
  await setLink($, 'online', match.name)
  $.ui.status(`👥 ${match.name}`)
  return `Bound this session to ${match.name}.`
}
