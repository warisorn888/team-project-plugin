import type { SessionMessage } from 'claude-code'

export const FILTER_RULES_VERSION = 'tp-filter/2'

export class FilterFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilterFailed'
  }
}

const INPUT_MAX = 500
const RESULT_MAX = 2000

/** `$.session.messages()` returns at most this many, the newest: a full list may have lost its start. */
export const MESSAGES_CAP = 4096

const isTyped = (m: SessionMessage) => m.role === 'user' && !(m.toolResults && m.toolResults.length > 0)

/**
 * What identifies one message across two reads of the transcript: role, text and its tool calls'
 * ids (not their results, which are filled in once answered).
 */
function messageKey(m: SessionMessage): string {
  return JSON.stringify([
    m.role,
    m.text,
    (m.toolUses ?? []).map(t => [t.tool_use_id, t.tool]),
    (m.toolResults ?? []).map(r => r.tool_use_id),
  ])
}

/** Where the transcript stood at a turn's start: the last message before the turn and its index. */
export type TurnAnchor = { key: string; index: number }

/**
 * At a turn's start: the last message before the turn, or null when the turn opens the
 * conversation. `prompt` is the turn's typed text: a last message that is exactly that prompt
 * (the engine may record it before turn.start) belongs to the turn. The index is kept only
 * while the list is below the read cap (a full list is a window, its indexes shift).
 */
export function turnAnchor(messages: readonly SessionMessage[], prompt: string): TurnAnchor | null {
  let end = messages.length
  const last = messages[end - 1]
  if (last !== undefined && prompt !== '' && isTyped(last) && last.text === prompt) end--
  const before = messages[end - 1]
  if (before === undefined) return null
  return { key: messageKey(before), index: messages.length < MESSAGES_CAP ? end - 1 : -1 }
}

/**
 * At a turn's end: the messages after the anchor `turnAnchor` took, so only what the turn
 * produced. The anchor is looked for at its index, else at its last copy (a repeat inside the
 * turn only shortens what is sent). Null when it is no longer there (compacted away, or past
 * the read cap), or, for a turn that opened the conversation, when the list is full and may
 * have lost its start.
 */
export function turnSince(messages: readonly SessionMessage[], anchor: TurnAnchor | null): SessionMessage[] | null {
  if (anchor === null) return messages.length < MESSAGES_CAP ? [...messages] : null
  const at = messages[anchor.index]
  if (anchor.index >= 0 && messages.length < MESSAGES_CAP && at !== undefined && messageKey(at) === anchor.key) {
    return messages.slice(anchor.index + 1)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messageKey(messages[i]!) === anchor.key) return messages.slice(i + 1)
  }
  return null
}

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)

function json(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

/** The turn as text; NUL characters are dropped (the server's database cannot store them). */
export function renderTurn(messages: SessionMessage[]): string {
  const blocks: string[] = []
  for (const m of messages) {
    const lines: string[] = []
    if (m.text !== '') lines.push(`## ${m.role}\n${m.text}`)
    for (const t of m.toolUses ?? []) {
      lines.push(`→ ${t.tool} ${cut(json(t.input), INPUT_MAX)}`)
      if (t.text !== undefined) lines.push(`← ${cut(t.text, RESULT_MAX)}`)
    }
    if (lines.length > 0) blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n').replace(/\u0000/g, '')
}

const digitsOf = (s: string) => s.replace(/\D/g, '')

function thaiIdOk(d: string): boolean {
  if (d.length !== 13) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(d[12])
}

function luhnOk(d: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i])
    if (dbl) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    dbl = !dbl
  }
  return sum % 10 === 0
}

const tag = (name: string) => `[REDACTED:${name}]`

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g
const B64_RUN = /^[A-Za-z0-9+/=\\]*/
const B64_LINE = /^[ \t]*[A-Za-z0-9+/=\\]*[ \t\r]*$/
const B64_REST = /^[A-Za-z0-9+/=\\]*[ \t\r]*$/
// RFC 1421 header lines of an encrypted PEM
const PEM_HEADER = /^[ \t]*(?:Proc-Type|DEK-Info|Content-Domain|Key-Info|MIC-Info|Originator-[A-Za-z-]+|Recipient-[A-Za-z-]+|Issuer-Certificate):/

/**
 * Redact private key blocks. A block with its END line goes from BEGIN to END. One whose END was cut off
 * (the 2000-char tool-result cut) goes from BEGIN through the base64 lines that follow it, up to an END
 * fragment, the first line that is not base64, or the end of text. Linear: END is searched once per BEGIN
 * and never again after a miss.
 */
function redactPrivateKeys(text: string): string {
  let out = ''
  let pos = 0
  let endMissing = false
  KEY_BEGIN.lastIndex = 0
  for (;;) {
    KEY_BEGIN.lastIndex = pos
    const begin = KEY_BEGIN.exec(text)
    if (!begin) break
    const afterBegin = begin.index + begin[0].length
    let stop = -1
    if (!endMissing) {
      KEY_END.lastIndex = afterBegin
      const end = KEY_END.exec(text)
      if (end) stop = end.index + end[0].length
      else endMissing = true
    }
    if (stop < 0) {
      // unterminated: the rest of the BEGIN line (only a base64 run), then whole base64 / blank lines
      const first = B64_RUN.exec(text.slice(afterBegin, afterBegin + 100_000))![0]
      stop = afterBegin + first.length
      let lineStart = text.indexOf('\n', afterBegin)
      if (lineStart >= 0 && B64_REST.test(text.slice(afterBegin, lineStart))) {
        for (lineStart += 1; lineStart <= text.length; ) {
          let nl = text.indexOf('\n', lineStart)
          if (nl < 0) nl = text.length
          const line = text.slice(lineStart, nl)
          if (line.trimStart().startsWith('-----END')) {
            stop = nl
            break
          }
          if (PEM_HEADER.test(line)) stop = nl
          else if (!B64_LINE.test(line)) break
          else if (line.trim() !== '') stop = nl
          if (nl >= text.length) break
          lineStart = nl + 1
        }
      }
    }
    out += text.slice(pos, begin.index) + tag('private-key')
    pos = stop
  }
  return out + text.slice(pos)
}

/** Digit groups of 13-19 digits (single space/dash between chunks) that pass Luhn, aligned on chunk edges. */
function redactCards(text: string): string {
  return text.replace(/\d+(?:[ -]\d+)*/g, group => {
    const chunks = group.split(/[ -]/)
    if (chunks.length === 1 && (group.length < 13 || group.length > 19)) return group
    const seps = group.match(/[ -]/g) ?? []
    // best valid window end starting at chunk i, or -1
    const bestEnd = (i: number): number => {
      let digits = 0
      const lens: number[] = []
      for (let j = i; j < chunks.length && digits + chunks[j].length <= 19; j++) {
        digits += chunks[j].length
        lens.push(digits)
      }
      for (let k = lens.length - 1; k >= 0; k--) {
        if (lens[k] >= 13 && luhnOk(chunks.slice(i, i + k + 1).join(''))) return i + k
      }
      return -1
    }
    let out = ''
    let i = 0
    while (i < chunks.length) {
      let hit = bestEnd(i)
      // a window starting later may reach further: cover the whole card, never leave a trailing group
      for (let i2 = i + 1; hit >= 0 && i2 <= hit; i2++) hit = Math.max(hit, bestEnd(i2))
      if (hit >= 0) {
        out += tag('card') + (hit + 1 < chunks.length ? seps[hit] : '')
        i = hit + 1
      } else {
        out += chunks[i] + (i + 1 < chunks.length ? seps[i] : '')
        i++
      }
    }
    return out
  })
}

const NOT_WORD = '(?<![A-Za-z0-9_])'

/** The rules for secrets that open a system, in their order: the part of `redactRegex` `findCredentials` runs. */
export const CREDENTIAL_RULES = [
  'tp-token', 'github-token', 'anthropic-key', 'openai-key', 'aws-access-key', 'private-key', 'bearer', 'conn-password', 'jwt',
] as const

// A value that only stands for a password, as docs and examples write one: `...`, `<secret>`, `***`,
// `${DB_PASSWORD}`, `$DB_PASSWORD`, `%DB_PASSWORD%`, `{password}`. Not a secret, so not redacted or refused.
const PLACEHOLDER = /^(?:\.{3,}|…|<[^<>]*>|\*+|x{3,}|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\{[^{}]*\})[.,:)\]`]*$/i
const isPlaceholder = (value: string) => PLACEHOLDER.test(value)

function redactCredentials(text: string): string {
  let t = text
  t = t.replace(new RegExp(`${NOT_WORD}tp_[A-Za-z0-9_-]{20,}`, 'g'), tag('tp-token'))
  t = t.replace(new RegExp(`${NOT_WORD}gh[pousr]_[A-Za-z0-9]{30,}`, 'g'), tag('github-token'))
  t = t.replace(new RegExp(`${NOT_WORD}sk-ant-[A-Za-z0-9_-]{20,}`, 'g'), tag('anthropic-key'))
  t = t.replace(new RegExp(`${NOT_WORD}sk-[A-Za-z0-9]{20,}`, 'g'), tag('openai-key'))
  t = t.replace(new RegExp(`${NOT_WORD}AKIA[0-9A-Z]{16}`, 'g'), tag('aws-access-key'))
  t = redactPrivateKeys(t)
  t = t.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, tag('bearer'))
  t = t.replace(/(password|pwd)(\s*=\s*["']?)([^;\s"']+)/gi, (m, k: string, eq: string, v: string) =>
    isPlaceholder(v) ? m : `${k}${eq}${tag('conn-password')}`)
  t = t.replace(new RegExp(`${NOT_WORD}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, 'g'), tag('jwt'))
  return t
}

/** The spec's own rules, in the listed order. */
export function redactRegex(text: string): string {
  let t = redactCredentials(text)
  // a match can only start at the beginning of a run of local-part characters, so a long run without '@' is scanned once
  t = t.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g, tag('email'))
  t = t.replace(/(?<!\d)(?:\d{13}|\d-\d{4}-\d{5}-\d{2}-\d)(?!\d)/g, m => (thaiIdOk(digitsOf(m)) ? tag('thai-id') : m))
  t = redactCards(t)
  t = t.replace(/(?<!\d)(?:0[689]\d{8}|0[689]\d-\d{3}-\d{4})(?!\d)/g, tag('thai-phone'))
  return t
}

const countOf = (text: string, s: string) => text.split(s).length - 1

/**
 * The credential rules (`CREDENTIAL_RULES`, not the personal-data ones) that match `text`, each
 * once, in rule order: the same patterns `redactRegex` applies, run the same way. A rule matched
 * when its tag appears more often after redacting than before, so a tag already in the text is
 * not a finding.
 */
export function findCredentials(text: string): string[] {
  const redacted = redactCredentials(text)
  if (redacted === text) return []
  return CREDENTIAL_RULES.filter(rule => countOf(redacted, tag(rule)) > countOf(text, tag(rule)))
}

/** Replace every gitleaks `Secret` with its rule's token. Throws FilterFailed on an unreadable report. */
export function applyGitleaks(text: string, reportJson: string): string {
  let findings: unknown
  try {
    findings = JSON.parse(reportJson)
  } catch {
    throw new FilterFailed('gitleaks report is not JSON')
  }
  if (!Array.isArray(findings)) throw new FilterFailed('gitleaks report is not an array')
  const found: { secret: string; rule: string }[] = []
  for (const f of findings) {
    if (f === null || typeof f !== 'object') throw new FilterFailed('gitleaks finding is not an object')
    const { Secret, RuleID } = f as { Secret?: unknown; RuleID?: unknown }
    if (typeof Secret === 'string' && Secret !== '') {
      found.push({ secret: Secret, rule: typeof RuleID === 'string' && RuleID !== '' ? RuleID : 'unknown' })
    }
  }
  found.sort((a, b) => b.secret.length - a.secret.length)
  let t = text
  for (const { secret, rule } of found) t = t.split(secret).join(tag(rule))
  return t
}

/** Pieces of at most `max` UTF-16 units; never cuts between a surrogate pair. */
export function splitChunks(text: string, max = 200_000): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + max, text.length)
    if (end < text.length && end - i > 1) {
      const c = text.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff) end--
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

/** FNV-1a 64-bit over the UTF-16 code units, as 16 hex chars. */
export function fnv1a64Hex(s: string): string {
  const mask = (1n << 64n) - 1n
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * 0x100000001b3n) & mask
  }
  return h.toString(16).padStart(16, '0')
}
