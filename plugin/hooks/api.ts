import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

/** The part of `$` the client needs: a plugin's `$` satisfies it. */
export type ProcessRunner = {
  process: { run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult> }
}

export type ApiOptions = { baseUrl: string; token: string }
export type ApiMethod = 'GET' | 'POST' | 'PUT'
export type ApiResponse = { status: number; json: unknown }

/** The server could not be reached, or curl gave no usable answer. */
export class ApiUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiUnavailable'
  }
}

/**
 * Escapes a value for a double-quoted curl config value: `\` then `"`, and
 * CR/LF as `\r`/`\n` so a value can never break onto a new config line.
 */
export const configEscape = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')

const line = (key: string, value: string) => `${key} = "${configEscape(value)}"`

const joinUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

/** Runs curl with `config` on stdin (never argv); resolves its stdout, rejects `ApiUnavailable` when it fails. */
async function runCurl($: ProcessRunner, what: string, config: string[], timeoutMs: number): Promise<string> {
  let ran: ProcessRunResult
  try {
    ran = await $.process.run(['curl', '-sS', '-K', '-'], { stdin: [...config, ''].join('\n'), timeoutMs })
  } catch {
    throw new ApiUnavailable(`${what}: curl did not run to completion`)
  }
  if (ran.exitCode !== 0) {
    const reason = ran.stderr.trim().split('\n')[0] || `exit code ${ran.exitCode}`
    throw new ApiUnavailable(`${what}: ${reason}`)
  }
  return ran.stdout
}

/** An HTTP status curl wrote, or `ApiUnavailable` when there is none (000: no response). */
function statusOf(what: string, text: string): number {
  const t = text.trim()
  const status = /^\d{3}$/.test(t) ? Number(t) : NaN
  if (!Number.isInteger(status) || status === 0) {
    throw new ApiUnavailable(`${what}: no HTTP response (status ${JSON.stringify(t)})`)
  }
  return status
}

/** The body and the status `write-out = "\\n%{http_code}"` appended to it. */
function bodyAndStatus(what: string, stdout: string): ApiResponse {
  const cut = stdout.lastIndexOf('\n')
  if (cut < 0) throw new ApiUnavailable(`${what}: no HTTP status in curl output`)
  const status = statusOf(what, stdout.slice(cut + 1))
  const text = stdout.slice(0, cut)
  let json: unknown = null
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status, json }
}

const auth = (opts: ApiOptions) => line('header', `Authorization: Bearer ${opts.token}`)

/**
 * Calls the Team Project API through curl. The token travels only in the
 * config curl reads from stdin, never in argv. Resolves `{ status, json }`
 * for any HTTP status (5xx included; `json` null for a non-JSON body);
 * rejects `ApiUnavailable` when curl fails or gives no status.
 */
export async function apiRequest(
  $: ProcessRunner,
  opts: ApiOptions,
  method: ApiMethod,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const what = `${method} ${path}`
  const stdout = await runCurl($, what, [
    line('url', joinUrl(opts.baseUrl, path)),
    line('request', method),
    auth(opts),
    line('header', 'Content-Type: application/json'),
    ...(body === undefined ? [] : [line('data-binary', JSON.stringify(body))]),
    'max-time = 10',
    'write-out = "\\n%{http_code}"',
  ], 12000)
  return bodyAndStatus(what, stdout)
}

// Uploads and downloads: the server extracts a file's text inside the upload request.
const TRANSFER_MAX_TIME = 'max-time = 120'
const TRANSFER_TIMEOUT_MS = 125_000

/**
 * POSTs the local file `filePath` (absolute) as the request body: curl reads it
 * from disk (`data-binary = "@<path>"`), so its bytes never pass through the
 * plugin. Same answers and errors as `apiRequest`.
 */
export async function apiUpload(
  $: ProcessRunner,
  opts: ApiOptions,
  path: string,
  filePath: string,
  contentType: string,
): Promise<ApiResponse> {
  const what = `POST ${path}`
  const stdout = await runCurl($, what, [
    line('url', joinUrl(opts.baseUrl, path)),
    line('request', 'POST'),
    auth(opts),
    line('header', `Content-Type: ${contentType}`),
    line('data-binary', `@${filePath}`),
    TRANSFER_MAX_TIME,
    'write-out = "\\n%{http_code}"',
  ], TRANSFER_TIMEOUT_MS)
  return bodyAndStatus(what, stdout)
}

/**
 * GETs `path` into the file `outPath` (absolute; folders created), resolving the
 * status and the `X-Sha256` header (null when absent). Curl writes whatever body
 * came, so on any status but 200 `outPath` holds an error body (or nothing) and
 * the caller removes it. Rejects `ApiUnavailable` like `apiRequest`.
 */
export async function apiDownload(
  $: ProcessRunner,
  opts: ApiOptions,
  path: string,
  outPath: string,
): Promise<{ status: number; sha256: string | null }> {
  const what = `GET ${path}`
  const stdout = await runCurl($, what, [
    line('url', joinUrl(opts.baseUrl, path)),
    line('request', 'GET'),
    auth(opts),
    line('output', outPath),
    'create-dirs',
    TRANSFER_MAX_TIME,
    'write-out = "%{http_code}\\n%header{x-sha256}"',
  ], TRANSFER_TIMEOUT_MS)
  const cut = stdout.indexOf('\n')
  const status = statusOf(what, cut < 0 ? stdout : stdout.slice(0, cut))
  const sha = cut < 0 ? '' : stdout.slice(cut + 1).trim()
  return { status, sha256: sha === '' ? null : sha }
}

/** The server answered 401: the token is bad or revoked. */
export class TokenRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenRejected'
  }
}

/**
 * GET that must succeed: resolves `{ status, json }` for 2xx and 4xx other
 * than 401 (callers read 400/404 themselves); rejects `TokenRejected` on 401
 * and `ApiUnavailable` on 5xx or when the server cannot be reached.
 */
export async function apiGet($: ProcessRunner, opts: ApiOptions, path: string): Promise<ApiResponse> {
  const res = await apiRequest($, opts, 'GET', path)
  if (res.status === 401) throw new TokenRejected(`GET ${path}: 401`)
  if (res.status >= 500) throw new ApiUnavailable(`GET ${path}: HTTP ${res.status}`)
  return res
}
