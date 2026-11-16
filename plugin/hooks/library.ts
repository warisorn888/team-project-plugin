import type { CoreEngineInterface, ToolSpec } from 'claude-code'
import { ApiUnavailable, TokenRejected, apiDownload, apiGet, apiUpload } from './api.ts'
import type { ApiOptions } from './api.ts'
import { currentBinding } from './binding.ts'
import { invalidateMemory } from './memory.ts'
import type { MemberRef } from './memory.ts'
import { NOT_BOUND, apiFailure, pickedThread, splitFirst } from './threads.ts'
import type { Out } from './threads.ts'
import { findCredentials } from './transcript-filter.ts'
import type { TeamProjectBinding } from '../types/index.d.ts'

/** The part of `$` the library code uses. */
export type LibraryDollar = Pick<CoreEngineInterface, 'process' | 'state' | 'ui' | 'fs' | 'session'>

/** A row of `GET /projects/{pid}/library`: each file with its latest version. */
export type LibraryFileDto = {
  fileId: string
  name: string
  latestVersion: number
  sizeBytes: number
  contentType: string
  summary: string
  updatedBy: MemberRef
  updatedAt: string
}

/** What `POST /projects/{pid}/library` answers (201 a new version, 200 the latest when unchanged). */
export type LibraryUploadDto = {
  fileId: string
  name: string
  version: number
  sizeBytes: number
  sha256: string
  extractStatus: string
}

/** The server's `Library:MaxFileBytes` default. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** `$.fs.read` refuses more; larger text files are checked by gitleaks alone. */
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_NAME = 200
const MAX_SUMMARY = 2000
const MAX_NOTE = 500

export const LIBRARY_GITLEAKS_TIMEOUT_MS = 30_000
export const libraryGitleaksArgv = (absPath: string): string[] =>
  ['gitleaks', 'dir', absPath, '--report-format', 'json', '--report-path', '-', '--no-banner', '--exit-code', '0']

export const LIBRARY_USAGE = 'Usage: /team library add <path> [summary] | search <query> | get <name> [v<n>]'

const OFFICE = new Set(['pdf', 'docx', 'xlsx', 'pptx'])
/** Content types by extension (the server stores what is sent; its text extraction goes by the name). */
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  sql: 'application/sql',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
}

/** The last segment of a path or library name, `/` or `\` separated, trailing separators ignored. */
export const lastSegment = (p: string): string => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** The lowercase extension of a name's last segment, '' when it has none. */
const extensionOf = (name: string): string => {
  const seg = lastSegment(name)
  const dot = seg.lastIndexOf('.')
  return dot > 0 ? seg.slice(dot + 1).toLowerCase() : ''
}

/** `512 B`, `2.0 KiB`, `25.0 MiB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Rounded up, so a size just over the limit never reads as the limit itself. */
const overLimitSize = (bytes: number): string => `${(Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MiB`

/** The server's name rule (`LibraryName.Validate`): null when valid, else why not. */
export function libraryNameError(name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME) return 'must be 1-200 characters'
  if (/\p{Cc}/u.test(name)) return 'must not contain control characters'
  if (name.includes('\\')) return 'must not contain \\'
  if (name.startsWith('/') || name.endsWith('/')) return 'must not start or end with /'
  for (const seg of name.split('/')) {
    if (seg === '') return 'must not contain an empty folder (//)'
    if (seg === '.' || seg === '..') return 'must not contain . or .. as a folder'
  }
  return null
}

/** What the credential check found, whether any check ran, and the `Not scanned:` lines for what it could not look at. */
type Scan = { rules: string[]; checked: boolean; notScanned: string[] }

/**
 * Rule names in the report of a gitleaks run that finished (exit 0). A report that cannot be read
 * whole (truncated, not JSON, not an array of findings) fails closed: gitleaks ran and wrote more
 * than `[]`, so it is a finding. Its rules are the RuleIDs readable in the raw output, else
 * `gitleaks`.
 */
function gitleaksRules(report: string, isTruncated: boolean): string[] {
  if (!isTruncated) {
    try {
      const parsed: unknown = JSON.parse(report)
      if (Array.isArray(parsed) && parsed.every(f => f !== null && typeof f === 'object')) {
        return parsed.map(f => {
          const id = (f as { RuleID?: unknown }).RuleID
          return typeof id === 'string' && id !== '' ? id : 'unknown'
        })
      }
    } catch {
      // unreadable: read what can be read below
    }
  }
  const readable = [...report.matchAll(/"RuleID"\s*:\s*"([^"\\]+)"/g)].map(m => m[1]!)
  return readable.length > 0 ? readable : ['gitleaks']
}

/**
 * Gitleaks reads the file itself (any size, any kind); the plugin's credential rules run too
 * when the file is UTF-8 text of at most 4 MiB. A gitleaks that is missing, exits non-zero or
 * times out counts as no gitleaks; one whose report cannot be read whole counts as a finding
 * (`gitleaksRules`). Never throws.
 */
async function scanFile($: LibraryDollar, absPath: string, size: number, ext: string): Promise<Scan> {
  let leaks: string[] | null = null
  try {
    const r = await $.process.run(libraryGitleaksArgv(absPath), { timeoutMs: LIBRARY_GITLEAKS_TIMEOUT_MS })
    if (r.exitCode === 0) leaks = gitleaksRules(r.stdout, r.isStdoutTruncated)
  } catch {
    leaks = null
  }

  let own: string[] | null = null
  if (size <= MAX_READ_BYTES) {
    try {
      const text = await $.fs.read(absPath)
      if (!text.includes('�')) own = findCredentials(text)
    } catch {
      own = null
    }
  }

  const rules: string[] = []
  for (const r of [...(leaks ?? []), ...(own ?? [])]) if (!rules.includes(r)) rules.push(r)

  const notScanned: string[] = []
  const office = OFFICE.has(ext)
  if (office) {
    notScanned.push(`Not scanned: the contents of this ${ext.toUpperCase()} file (it is compressed, so the check cannot see inside).`)
  }
  if (leaks === null) {
    notScanned.push(
      own !== null
        ? "Not scanned: gitleaks is not available, so only the plugin's own credential rules checked the file."
        : 'Not scanned: gitleaks is not available and the file is not UTF-8 text of at most 4 MiB, so nothing checked it for credentials.',
    )
  } else if (own === null && !office) {
    notScanned.push('Not scanned: the file is not UTF-8 text of at most 4 MiB, so only gitleaks checked it.')
  }
  return { rules, checked: leaks !== null || own !== null, notScanned }
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const unexpected = (what: string, status: number, json: unknown) => {
  const detail = (json as { error?: unknown } | null)?.error
  return `${what}: the server answered HTTP ${status}${typeof detail === 'string' ? ` (${detail})` : ''}`
}

const EXTRACT_FAILED = 'Its text could not be read, so it is found only by name and summary.'

/**
 * The tool `library_add` and `/team library add`: checks the local file for credentials, asks a
 * person to confirm, then uploads it as a new file or the next version. Nothing reaches the
 * server unless the person picks `Upload`.
 */
export async function libraryAdd(
  $: LibraryDollar,
  opts: ApiOptions,
  input: { path?: unknown; name?: unknown; summary?: unknown; note?: unknown },
): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const path = str(input.path)?.trim() ?? ''
  if (path === '') return { error: 'path is required' }
  const summary = str(input.summary) ?? ''
  if (summary.trim() === '') return { error: 'summary is required' }
  if (summary.length > MAX_SUMMARY) return { error: `summary must be at most ${MAX_SUMMARY} characters` }
  const note = str(input.note) ?? ''
  if (note.length > MAX_NOTE) return { error: `note must be at most ${MAX_NOTE} characters` }

  let stat: Awaited<ReturnType<LibraryDollar['fs']['stat']>>
  try {
    // relative to the session's working directory, as the person and the model see it
    const full = isAbsolute(path) ? path : `${(await $.session.cwd()).replace(/[\\/]+$/, '')}/${path}`
    stat = await $.fs.stat(full, { resolve: true })
  } catch {
    return { error: `No file at ${path}.` }
  }
  if (stat.kind === 'dir') return { error: `${path} is a folder; library_add takes one file.` }
  const abs = stat.realPath
  if (stat.kind !== 'file' || abs === undefined) return { error: `${path} is not a regular file.` }

  const name = str(input.name)?.trim() || lastSegment(path)
  const nameError = libraryNameError(name)
  if (nameError !== null) return { error: `Not uploaded: the name "${name}" ${nameError}.` }
  // before copying, so a huge file is never copied
  if (stat.size > MAX_FILE_BYTES) return { error: `Not uploaded: ${name} is ${overLimitSize(stat.size)}, over the 20 MiB limit.` }

  // The person may take any time to confirm: what is checked and sent is a private copy, so an
  // edit to the file meanwhile is never uploaded unchecked.
  const snapshot = await makeSnapshot($, abs)
  if ('error' in snapshot) {
    return { error: `Not uploaded: could not make a private copy of ${name} to check and send (${snapshot.error}).` }
  }
  try {
    return await addSnapshot($, opts, binding, { name, summary, note, original: abs, copy: snapshot.file })
  } finally {
    await removeSnapshot($, snapshot)
  }
}

/** The private copy `library_add` checks and uploads: `file` inside the folder `dir` `mktemp -d` made (mode 700). */
type Snapshot = { dir: string; file: string }

/** Removes the copy, then its folder (never recursively); never throws. */
async function removeSnapshot($: Pick<CoreEngineInterface, 'process'>, snap: Snapshot): Promise<void> {
  try {
    await $.process.run(['rm', '-f', '--', snap.file], { timeoutMs: 10_000 })
  } catch {
    // best effort: the folder below then stays, in the system's temp folder
  }
  try {
    await $.process.run(['rmdir', '--', snap.dir], { timeoutMs: 10_000 })
  } catch {
    // best effort
  }
}

/** Copies `abs` into a new private temp folder; the reason when it cannot (anything made is removed). */
async function makeSnapshot($: Pick<CoreEngineInterface, 'process'>, abs: string): Promise<Snapshot | { error: string }> {
  const reason = (r: { exitCode: number; stderr: string }) => r.stderr.trim().split('\n')[0] || `exit code ${r.exitCode}`
  let dir: string
  try {
    const r = await $.process.run(['mktemp', '-d'], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) return { error: `mktemp: ${reason(r)}` }
    dir = r.stdout.trim().replace(/\/+$/, '')
  } catch {
    return { error: 'mktemp did not run' }
  }
  if (!dir.startsWith('/') || dir.includes('\n') || dir.split('/').length < 3) return { error: `mktemp gave "${dir}"` }
  const snap = { dir, file: `${dir}/${lastSegment(abs) || 'file'}` }
  try {
    const r = await $.process.run(['cp', '--', abs, snap.file], { timeoutMs: 60_000 })
    if (r.exitCode === 0) return snap
    await removeSnapshot($, snap)
    return { error: `cp: ${reason(r)}` }
  } catch {
    await removeSnapshot($, snap)
    return { error: 'cp did not finish' }
  }
}

/** `libraryAdd` past the copy: checks the copy, asks, uploads the copy. The dialog names the original. */
async function addSnapshot(
  $: LibraryDollar,
  opts: ApiOptions,
  binding: TeamProjectBinding,
  f: { name: string; summary: string; note: string; original: string; copy: string },
): Promise<Out> {
  const { name, summary, note, original: abs, copy } = f
  let stat: Awaited<ReturnType<LibraryDollar['fs']['stat']>>
  try {
    stat = await $.fs.stat(copy)
  } catch {
    return { error: `Not uploaded: could not make a private copy of ${name} to check and send (the copy is gone).` }
  }
  if (stat.size > MAX_FILE_BYTES) return { error: `Not uploaded: ${name} is ${overLimitSize(stat.size)}, over the 20 MiB limit.` }
  if (stat.size === 0) return { error: `Not uploaded: ${name} is empty.` }

  const ext = extensionOf(name) || extensionOf(abs)
  const scan = await scanFile($, copy, stat.size, ext)
  if (scan.rules.length > 0) {
    return { error: `Not uploaded: ${name} looks like it contains credentials (${scan.rules.join(', ')}). Remove them and try again.` }
  }

  try {
    const list = await apiGet($, opts, `/projects/${encodeURIComponent(binding.projectId)}/library`)
    if (list.status !== 200 || !Array.isArray(list.json)) return { error: unexpected('library', list.status, list.json) }
    const lower = name.toLowerCase()
    const existing = (list.json as LibraryFileDto[]).find(f => typeof f.name === 'string' && f.name.toLowerCase() === lower)
    const thread = await pickedThread($)

    const lines = [
      `Upload this file to the ${binding.name} team library?`,
      `Name: ${name}`,
      `Path: ${abs}`,
      `Size: ${formatSize(stat.size)}`,
      `Version: ${existing ? `v${existing.latestVersion + 1} (the latest now is v${existing.latestVersion}, by ${existing.updatedBy?.name ?? 'someone'})` : 'v1, a new file'}`,
      `Summary: ${summary}`,
      ...(note !== '' ? [`Note: ${note}`] : []),
      ...(thread !== null ? [`Thread: ${thread.id}`] : []),
      scan.checked ? 'Credential check: nothing found.' : 'Credential check: none could run.',
      ...scan.notScanned,
      'Everyone on the team can search and read this file, including any personal data in it.',
    ]
    let answer: string
    try {
      answer = await $.ui.ask(lines.join('\n'), { options: ['Upload', 'Cancel'], header: 'Team library' })
    } catch {
      answer = ''
    }
    if (answer !== 'Upload') return { error: `Not uploaded: the upload of ${name} was not confirmed.` }

    const q = new URLSearchParams({ name, summary })
    if (note !== '') q.set('note', note)
    if (thread !== null) q.set('thread', thread.id)
    // as shown: 0 for a new name, so a teammate creating it meanwhile gives a 409, not a silent v2
    q.set('expectVersion', String(existing?.latestVersion ?? 0))
    const query = q.toString().replace(/\+/g, '%20')
    const res = await apiUpload($, opts, `/projects/${encodeURIComponent(binding.projectId)}/library?${query}`, copy, CONTENT_TYPES[ext] ?? 'application/octet-stream')
    if (res.status === 401) throw new TokenRejected('library add: 401')
    if (res.status >= 500) throw new ApiUnavailable(`library add: HTTP ${res.status}`)
    if (res.status === 409) {
      const cur = (res.json as { current?: { version?: unknown; uploadedBy?: { name?: unknown } } | null } | null)?.current
      const v = typeof cur?.version === 'number' ? cur.version : '?'
      const who = typeof cur?.uploadedBy?.name === 'string' ? cur.uploadedBy.name : 'someone'
      return {
        error: existing
          ? `${name} got a new version (v${v} by ${who}) meanwhile; try again.`
          : `${name} was added by ${who} (v${v}) meanwhile; try again.`,
      }
    }
    if (res.status === 413) {
      // passed the local 20 MiB check: the server's limit is lower, or the file grew since
      const limit = /at most (\d+) bytes/.exec(String((res.json as { error?: unknown } | null)?.error ?? ''))?.[1]
      return {
        error: limit !== undefined
          ? `Not uploaded: ${name} is ${formatSize(stat.size)}, over the server's ${formatSize(Number(limit))} limit.`
          : `Not uploaded: the server refused ${name} (${formatSize(stat.size)}) as too large.`,
      }
    }
    const dto = res.json as LibraryUploadDto | null
    if ((res.status !== 201 && res.status !== 200) || typeof dto?.version !== 'number') {
      return { error: unexpected('library add', res.status, res.json) }
    }
    const shown = typeof dto.name === 'string' && dto.name !== '' ? dto.name : name
    const head = res.status === 201
      ? `Added ${shown} v${dto.version} to the ${binding.name} library.`
      : `${shown} is unchanged (same content as v${dto.version}).`
    if (res.status === 201) invalidateMemory(binding.projectId)
    return { text: dto.extractStatus === 'ok' ? head : `${head}\n${EXTRACT_FAILED}` }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** `/team library add <path> [summary…]`: with no summary, `Added by <name>`. */
export async function libraryAddCommand($: LibraryDollar, opts: ApiOptions, path: string, summary: string): Promise<Out> {
  if ((await currentBinding($)) === null) return { error: NOT_BOUND }
  if (path.trim() === '') return { error: LIBRARY_USAGE }
  let text = summary.trim()
  if (text === '') {
    try {
      const me = await apiGet($, opts, '/me')
      const who = (me.json as { name?: unknown } | null)?.name
      if (me.status !== 200 || typeof who !== 'string') return { error: unexpected('me', me.status, me.json) }
      text = `Added by ${who}`
    } catch (err) {
      const failed = apiFailure(err)
      if (failed !== null) return { error: failed }
      throw err
    }
  }
  return libraryAdd($, opts, { path, summary: text })
}

export const libraryAddSpec: ToolSpec = {
  name: 'library_add',
  description:
    "Add a local file to the team's project library as a new file or a new version. Call only when the person asks " +
    'to share or keep a file for the team. A person must confirm the upload; files with credentials are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The local file: relative to the working directory, or absolute' },
      name: {
        type: 'string',
        description: 'Its name in the library, `/` between folders (default: the file name). Same name = a new version',
      },
      summary: { type: 'string', description: 'What the file is and why the team keeps it, at most 2000 chars' },
      note: { type: 'string', description: 'What changed in this version, at most 500 chars' },
    },
    required: ['path', 'summary'],
  },
  isDeferred: false,
}

/** A hit of `GET /projects/{pid}/library/search`. */
export type LibraryHitDto = { fileId: string; name: string; version: number; matchedIn: string; snippet: string }

/** A version in `GET /library/{fileId}` (newest first). */
export type LibraryVersionDto = {
  version: number
  sizeBytes: number
  sha256: string
  contentType: string
  summary: string
  note: string | null
  extractStatus: string
  sourceThread: string | null
  uploadedBy: MemberRef
  createdAt: string
  decisions: number[]
}
export type LibraryDetailDto = { fileId: string; projectId: string; name: string; versions: LibraryVersionDto[] }

/** `GET /library/{fileId}/versions/{n}/text`. */
type LibraryTextDto = { text: string; totalLength: number; extractStatus: string }

/** How much text one `library_get` returns. */
export const TEXT_PAGE = 20_000

/** The tool `library_search`: one block per hit (`<name> v<n> · <matchedIn>` and the snippet). */
export async function librarySearch($: LibraryDollar, opts: ApiOptions, input: { query?: unknown }): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const query = str(input.query)?.trim() ?? ''
  if (query.length < 2 || query.length > 200) return { error: 'query must be 2-200 characters' }
  try {
    const q = new URLSearchParams({ q: query }).toString().replace(/\+/g, '%20')
    const res = await apiGet($, opts, `/projects/${encodeURIComponent(binding.projectId)}/library/search?${q}`)
    if (res.status !== 200 || !Array.isArray(res.json)) return { error: unexpected('library search', res.status, res.json) }
    const hits = res.json as LibraryHitDto[]
    if (hits.length === 0) return { text: `No library matches "${query}".` }
    return { text: hits.map(h => `${h.name} v${h.version} · ${h.matchedIn}\n${h.snippet}`).join('\n\n') }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

const HOME = { plugin: 'team-project', key: 'libraryHome' } as const

/** `$HOME`, from `printenv HOME` once per session; null when it cannot be had. */
async function homeDir($: Pick<CoreEngineInterface, 'process' | 'state'>): Promise<string | null> {
  const known = (await $.state.get(HOME)).value
  if (typeof known === 'string' && known !== '') return known
  try {
    const r = await $.process.run(['printenv', 'HOME'], { timeoutMs: 5000 })
    const home = r.stdout.trim().replace(/\/+$/, '')
    if (r.exitCode !== 0 || !home.startsWith('/')) return null
    await $.state.set(HOME, home)
    return home
  } catch {
    return null
  }
}

/** The sha256 of a local file (`shasum -a 256`), or null when it is missing or cannot be read. */
async function sha256Of($: Pick<CoreEngineInterface, 'process'>, path: string): Promise<string | null> {
  try {
    const r = await $.process.run(['shasum', '-a', '256', path], { timeoutMs: 60_000 })
    const sha = /^([0-9a-fA-F]{64}|\S+)\s/.exec(r.stdout)?.[1]
    return r.exitCode === 0 && sha !== undefined ? sha.toLowerCase() : null
  } catch {
    return null
  }
}

/** Removes a cache file; never throws (a left-over file fails its sha256 check next time). */
async function removeFile($: Pick<CoreEngineInterface, 'process'>, path: string): Promise<void> {
  try {
    await $.process.run(['rm', '-f', path], { timeoutMs: 10_000 })
  } catch {
    // best effort
  }
}

/** A cache file name: the last segment of the library name, never a path step of its own. */
const cacheFileName = (name: string): string => {
  const seg = lastSegment(name)
  return seg === '' || seg === '.' || seg === '..' ? 'file' : seg
}

const SAFE_ID = /^[0-9A-Za-z-]+$/

/**
 * Puts one version into the cache, at
 * `$HOME/.cache/team-project/library/<projectId>/<fileId>/v<n>/<last segment of the name>`:
 * kept when its sha256 already matches (versions never change), else downloaded and checked,
 * and deleted again on a mismatch. Rejects `TokenRejected` / `ApiUnavailable` as `apiGet` does.
 */
export async function cacheVersion(
  $: Pick<CoreEngineInterface, 'process' | 'state'>,
  opts: ApiOptions,
  binding: { projectId: string },
  fileId: string,
  name: string,
  v: { version: number; sha256: string },
): Promise<{ path: string } | { error: string }> {
  const n = v.version
  if (!SAFE_ID.test(binding.projectId) || !SAFE_ID.test(fileId)) {
    return { error: `library get: unexpected ids from the server (${binding.projectId}, ${fileId})` }
  }
  const home = await homeDir($)
  if (home === null) return { error: 'library get: cannot find the home folder (printenv HOME gave nothing)' }
  const path = `${home}/.cache/team-project/library/${binding.projectId}/${fileId}/v${n}/${cacheFileName(name)}`

  const expected = String(v.sha256).toLowerCase()
  if ((await sha256Of($, path)) !== expected) {
    const got = await apiDownload($, opts, `/library/${encodeURIComponent(fileId)}/versions/${n}/content`, path)
    if (got.status !== 200) {
      await removeFile($, path) // curl wrote the error body there
      if (got.status === 401) throw new TokenRejected('library get: 401')
      if (got.status >= 500) throw new ApiUnavailable(`library get: HTTP ${got.status}`)
      return { error: unexpected('library get', got.status, null) }
    }
    if ((await sha256Of($, path)) !== expected) {
      await removeFile($, path)
      return { error: `Download of ${name} v${n} was corrupted; try again.` }
    }
  }
  return { path }
}

/**
 * The tool `library_get`: downloads a version (the latest unless given) into
 * `$HOME/.cache/team-project/library/<projectId>/<fileId>/v<n>/<last segment of the name>`
 * (kept when its sha256 already matches; versions never change), then answers its
 * details and up to 20,000 characters of its text from `offset`.
 */
export async function libraryGet(
  $: LibraryDollar,
  opts: ApiOptions,
  input: { name?: unknown; version?: unknown; offset?: unknown },
): Promise<Out> {
  const binding = await currentBinding($)
  if (binding === null) return { error: NOT_BOUND }
  const name = str(input.name)?.trim() ?? ''
  if (name === '') return { error: 'name is required' }
  const version = input.version
  if (version !== undefined && version !== null && !(Number.isInteger(version) && (version as number) >= 1)) {
    return { error: 'version must be a whole number of at least 1' }
  }
  const offset = input.offset ?? 0
  if (!(Number.isInteger(offset) && (offset as number) >= 0)) return { error: 'offset must be a whole number of at least 0' }
  const from = offset as number

  try {
    const list = await apiGet($, opts, `/projects/${encodeURIComponent(binding.projectId)}/library`)
    if (list.status !== 200 || !Array.isArray(list.json)) return { error: unexpected('library', list.status, list.json) }
    const lower = name.toLowerCase()
    const row = (list.json as LibraryFileDto[]).find(f => typeof f.name === 'string' && f.name.toLowerCase() === lower)
    if (row === undefined) return { error: `No file "${name}" in the ${binding.name} library.` }

    const res = await apiGet($, opts, `/library/${encodeURIComponent(row.fileId)}`)
    const detail = res.json as LibraryDetailDto | null
    if (res.status !== 200 || !Array.isArray(detail?.versions) || detail.versions.length === 0) return { error: unexpected('library get', res.status, res.json) }
    const shown = typeof detail.name === 'string' && detail.name !== '' ? detail.name : row.name
    const latest = Math.max(...detail.versions.map(v => v.version))
    const n = typeof version === 'number' ? version : latest
    const v = detail.versions.find(x => x.version === n)
    if (v === undefined) return { error: `${shown} has no v${n} (latest is v${latest}).` }

    const cached = await cacheVersion($, opts, binding, row.fileId, shown, v)
    if ('error' in cached) return cached
    const path = cached.path

    const isPdf = extensionOf(shown) === 'pdf'
    const lines = [
      `${shown} v${n} ${n === latest ? '(latest)' : `(latest is v${latest})`} · ${formatSize(v.sizeBytes)} · by ${v.uploadedBy?.name ?? 'someone'}, ${String(v.createdAt).slice(0, 10)}`,
      `Path: ${path}`,
      `Summary: ${v.summary}`,
      ...(v.note ? [`Note: ${v.note}`] : []),
      ...(v.sourceThread ? [`Thread: ${v.sourceThread}`] : []),
      ...(Array.isArray(v.decisions) && v.decisions.length > 0 ? [`Cited by: ${v.decisions.map(d => `D-${d}`).join(', ')}`] : []),
    ]
    const noText = `No text was extracted from this file. Open it with the Read tool: ${path}`
    if (v.extractStatus !== 'ok') return { text: [...lines, '', noText].join('\n') }

    const page = await apiGet($, opts,
      `/library/${encodeURIComponent(row.fileId)}/versions/${n}/text?offset=${from}&limit=${TEXT_PAGE}`)
    const t = page.json as LibraryTextDto | null
    if (page.status !== 200 || typeof t?.text !== 'string' || typeof t.totalLength !== 'number') {
      return { error: unexpected('library text', page.status, page.json) }
    }
    if (t.totalLength === 0) return { text: [...lines, '', noText].join('\n') }
    if (isPdf) lines.push('The Read tool can also open the PDF at that path.')
    if (from >= t.totalLength) {
      return { text: [...lines, '', `No text after offset ${from}; the text is ${t.totalLength} characters.`].join('\n') }
    }
    const next = from + t.text.length
    const remaining = t.totalLength - next
    const whole = from === 0 && remaining <= 0
    return {
      text: [
        ...lines,
        '',
        whole ? 'Text:' : `Text, characters ${from}-${next} of ${t.totalLength}:`,
        t.text,
        ...(remaining > 0 ? [`[${remaining} more characters: call library_get with offset ${next}]`] : []),
      ].join('\n'),
    }
  } catch (err) {
    const text = apiFailure(err)
    if (text !== null) return { error: text }
    throw err
  }
}

/** `/team library get <name> [v<n>]` (quote a name with spaces). Null: the arguments do not parse. */
export function parseGetArgs(args: string): { name: string; version?: number } | null {
  const [name, more] = splitFirst(args)
  if (name === '') return null
  if (more === '') return { name }
  const m = /^v?([1-9]\d{0,8})$/i.exec(more)
  return m ? { name, version: Number(m[1]) } : null
}

export const librarySearchSpec: ToolSpec = {
  name: 'library_search',
  description: "Search the team's project library by file name, summary or text inside files.",
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to look for, 2-200 characters' } },
    required: ['query'],
  },
  isDeferred: false,
}

export const libraryGetSpec: ToolSpec = {
  name: 'library_get',
  description: 'Fetch a library file (latest version unless given) into the local cache and return its details and text.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The file\'s name in the library, as library_search shows it' },
      version: { type: 'integer', minimum: 1, description: 'A version number (default: the latest)' },
      offset: { type: 'integer', minimum: 0, description: 'Where the returned text starts, to read past the first 20,000 characters' },
    },
    required: ['name'],
  },
  isDeferred: false,
}

export const libraryToolSpecs: ToolSpec[] = [libraryAddSpec, librarySearchSpec, libraryGetSpec]
