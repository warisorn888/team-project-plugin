import type { Register } from 'claude-code'
import { bindSession, boundDirectory, currentBinding, currentLink, isOnline, markOffline, markOnline, rebindIfMoved, retryBind, useProject } from './binding.ts'
import type { BindingDollar } from './binding.ts'
import { ApiUnavailable, TokenRejected } from './api.ts'
import {
  askTeam, createThread, createThreadTool, decide, logWorklog, pickThread, releaseThread, revertInstructions,
  resumeThread, setLeave, splitFirst, threadToolSpecs, updateInstructions,
} from './threads.ts'
import type { Out, ThreadDollar } from './threads.ts'
import { ANSWER_POLL_MS, answerQuestion, pollAnswers } from './answers.ts'
import { PR_POLL_MS, heartbeat, onBashResult, pollReviewThreads } from './triggers.ts'
import { PANE_ID, PANE_REFRESH_MS, isPanePlaced, openPane, renderPane, tickChatPane, tickPane } from './pane.tsx'
import { noteCompaction, noteTurnStart, readTranscript, searchTranscripts, transcriptCommand, transcriptToolSpecs, uploadTurn } from './transcript.ts'
import type { TranscriptOptions } from './transcript.ts'
import { announceMemory, getDecision, getDecisionSpec, hasMemory, loadMemory } from './memory.ts'
import { LIBRARY_USAGE, libraryAdd, libraryAddCommand, libraryGet, librarySearch, libraryToolSpecs, parseGetArgs } from './library.ts'
import type { LibraryDollar } from './library.ts'
import { CHAT_PANE_MS, CHAT_POLL_MS, postChat, pollChat } from './chat.ts'
import type { ChatDollar } from './chat.ts'

const SUBCOMMANDS = [
  'use <name>',
  'pick T-12',
  'release',
  'resume',
  'answer T-3 <text>',
  'new "<title>" [goal]',
  'decide "<title>" [supersedes D-7] [--ref <name>@v<n>]... <reasoning>',
  'leave <yyyy-MM-dd|off>',
  'instructions revert <n>',
  'transcript on|off|status',
  'library add <path> [summary]',
  'library search <query>',
  'library get <name> [v<n>]',
  'say <text>',
  'status',
]

const asText = (o: Out): string => ('text' in o ? o.text : o.error)

// One `team` command for the whole plugin; later tasks add their
// subcommands here. `$` goes only to top-level functions, so this is a switch.
async function runProject(
  $: BindingDollar & ThreadDollar & LibraryDollar & ChatDollar,
  opts: TranscriptOptions,
  args: string,
): Promise<string> {
  const [sub, rest] = splitFirst(args)
  switch (sub) {
    case 'use':
      return useProject($, await $.session.cwd(), opts, rest)
    case 'pick':
      return asText(await pickThread($, opts, rest))
    case 'release':
      return asText(await releaseThread($, opts))
    case 'resume':
      return asText(await resumeThread($, opts))
    case 'answer': {
      const [thread, text] = splitFirst(rest)
      return asText(await answerQuestion($, opts, thread, text))
    }
    case 'new': {
      const [title, goal] = splitFirst(rest)
      return asText(await createThread($, opts, title, goal))
    }
    case 'decide': {
      const [title, more] = splitFirst(rest)
      return asText(await decide($, opts, title, more))
    }
    case 'leave':
      return asText(await setLeave($, opts, rest))
    case 'instructions': {
      const [verb, n] = splitFirst(rest)
      if (verb === 'revert') return asText(await revertInstructions($, opts, n))
      return 'Usage: /team instructions revert <n>'
    }
    case 'transcript':
      return asText(await transcriptCommand($, opts, rest))
    case 'library': {
      const [verb, more] = splitFirst(rest)
      if (verb === 'add') {
        const [path, summary] = splitFirst(more)
        return asText(await libraryAddCommand($, opts, path, summary))
      }
      if (verb === 'search' && more !== '') return asText(await librarySearch($, opts, { query: more }))
      const get = verb === 'get' ? parseGetArgs(more) : null
      if (get !== null) return asText(await libraryGet($, opts, get))
      return LIBRARY_USAGE
    }
    case 'say':
      return asText(await postChat($, opts, rest))
    default: {
      // free text after /team reads as a message for the team, not a subcommand
      const chatHint = rest !== '' || /[^\x00-\x7f]/.test(sub) ? `To post it to the team chat: /team say ${args}\nOr open the pane with /team and type in the Chat tab.\n\n` : ''
      return `${chatHint}Unknown subcommand${sub ? ` "${sub}"` : ''}. Available:\n${SUBCOMMANDS.map(s => `/team ${s}`).join('\n')}`
    }
  }
}

/** The session moved since it was bound (a claimed desktop spare, set_cwd): binds for where it is now. Never throws. */
async function followCwd(
  $: BindingDollar & { session: { cwd(): Promise<string> } },
  opts: TranscriptOptions,
): Promise<void> {
  try {
    await rebindIfMoved($, await $.session.cwd(), opts)
  } catch {
    // the old binding stays; the next prompt or tick tries again
  }
}

// `.catch` for our tools: a throw becomes a readable refusal, never a skipped hook.
const toolFailed = () => ({ deny: 'Team Project failed to run this tool; try again, or check /team' })

const toolReply = (o: Out) => ('text' in o ? { result: o.text } : { deny: o.error })

export const register: Register = (on, options) => {
  const opts: TranscriptOptions = {
    baseUrl: String(options.apiBaseUrl),
    token: String(options.token),
    uploadTranscript: options.uploadTranscript !== false,
  }
  const TOOL = 'mcp__team-project__'
  let pollTimer: { cancel: () => void } | undefined
  let answerTimer: { cancel: () => void } | undefined
  let chatTimer: { cancel: () => void } | undefined
  let paneTimer: { cancel: () => void } | undefined
  let chatPaneTimer: { cancel: () => void } | undefined
  // The memory rides beside a prompt (`prompt.submit` context), not in the system prompt: on Team and
  // Enterprise machines the built-in security plugin passes user plugins over at `prompt.compose`.
  // The prompt it last rode with, so the next prompt can tell it is still in the conversation.
  let memoryPrompt: string | undefined
  // What the memory hook did at the last typed prompt, for `/team status` (desktop keeps no plugin log)
  let memoryLast = 'no prompt typed yet in this session'
  const stopPaneTimer = () => {
    paneTimer?.cancel()
    paneTimer = undefined
    chatPaneTimer?.cancel()
    chatPaneTimer = undefined
  }

  on('session.start', async ($, e, next) => {
    memoryPrompt = undefined // a new conversation: its first prompt carries the memory
    memoryLast = 'no prompt typed yet in this session'
    await $.command.register({
      name: 'team',
      description: 'Team Project: open the threads and memory pane; bind this repo, manage threads and decisions',
      argumentHint: '[(none: open pane) | use <name> | pick T-12 | release | resume | answer T-3 <text> | new | decide | leave | instructions revert <n> | transcript on|off|status | library add <path> [summary] | library search <query> | library get <name> [v<n>] | say <text>]',
    })
    await $.tool.register(getDecisionSpec)
    for (const spec of threadToolSpecs) await $.tool.register(spec)
    for (const spec of transcriptToolSpecs) await $.tool.register(spec)
    for (const spec of libraryToolSpecs) await $.tool.register(spec)
    await bindSession($, e.cwd, opts)
    pollTimer?.cancel()
    pollTimer = $.clock.every(PR_POLL_MS, () => void pollReviewThreads($, opts))
    answerTimer?.cancel()
    answerTimer = $.clock.every(ANSWER_POLL_MS, () => void pollAnswers($, opts))
    chatTimer?.cancel()
    chatTimer = $.clock.every(CHAT_POLL_MS, () => void followCwd($, opts).then(() => pollChat($, opts)))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    await onBashResult($, opts, e.command, result)
    return result
  }).catch((_$, e, next) => next(e)) // a failed trigger never blocks or alters the Bash call

  on('turn.start', async ($, e, next) => {
    await noteTurnStart($, opts, e) // the thread picked as the turn begins: only its turns are uploaded
    return next(e)
  })

  on('session.compact', async (_$, e, next) => {
    const result = await next(e)
    // a compaction mid-turn: that turn is not uploaded (the summary is the whole session's)
    if (result.skip === undefined) noteCompaction(e)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await heartbeat($, opts)
    // after the heartbeat: a thread it found lost is no longer picked, so nothing is sent for it.
    // Reads the turn, then filters and sends it in the background: the turn ends at once
    await uploadTurn($, opts, e)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // a slash command's line is not a prompt to the model; the next typed prompt carries the memory
    if (e.command !== undefined) return next(e)
    await followCwd($, opts)
    const binding = (await currentBinding($)) ?? (await retryBind($, await $.session.cwd(), opts))
    if (binding === null) {
      memoryLast = 'skipped: this session is not bound to a project'
      return next(e)
    }
    let text: string
    try {
      text = await loadMemory($, opts, binding)
      if ((await isOnline($)) === false) await markOnline($, binding)
    } catch (err) {
      if (err instanceof ApiUnavailable || err instanceof TokenRejected) {
        await markOffline($, err)
        memoryLast = `skipped: the server did not answer (${err instanceof TokenRejected ? 'token rejected' : 'unavailable'})`
        return next(e)
      }
      throw err
    }
    // already in the conversation (and not compacted away): not sent again
    if (await hasMemory($, binding, memoryPrompt)) {
      memoryLast = 'not sent again: the conversation already holds it'
      return next(e)
    }
    const result = await next({ ...e, context: [...(e.context ?? []), text] })
    if (result.drop === undefined) memoryPrompt = e.text
    memoryLast = result.drop === undefined ? `attached (${text.length} characters) beside the prompt` : 'attached, but the prompt was dropped'
    return result
  }).catch((_$, e, next) => {
    // a memory failure never stops or alters the prompt
    memoryLast = `failed: ${next.error instanceof Error ? next.error.message : String(next.error)}`
    return next(e)
  })

  on('tool.call', { tool: `${TOOL}get_decision` }, async ($, e) => {
    const input = e as unknown as { id?: unknown }
    const out = await getDecision($, opts, await currentBinding($), input.id)
    return 'error' in out ? { deny: out.error } : { result: out.text }
  }).catch(toolFailed)

  on('tool.call', { tool: `${TOOL}log_worklog` }, async ($, e) => toolReply(await logWorklog($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}create_thread` }, async ($, e) =>
    toolReply(await createThreadTool($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}ask_team` }, async ($, e) => toolReply(await askTeam($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}search_transcripts` }, async ($, e) =>
    toolReply(await searchTranscripts($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}read_transcript` }, async ($, e) =>
    toolReply(await readTranscript($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}update_instructions` }, async ($, e) =>
    toolReply(await updateInstructions($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)

  on('tool.call', { tool: `${TOOL}library_add` }, async ($, e) =>
    toolReply(await libraryAdd($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}library_search` }, async ($, e) =>
    toolReply(await librarySearch($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)
  on('tool.call', { tool: `${TOOL}library_get` }, async ($, e) =>
    toolReply(await libraryGet($, opts, e as unknown as Record<string, unknown>))).catch(toolFailed)

  on('command.run', { command: 'team' }, async ($, e) => {
    await followCwd($, opts)
    if (e.args.trim() === 'status') {
      const binding = await currentBinding($)
      const link = await currentLink($)
      return {
        text: [
          `Project: ${binding === null ? 'not bound' : binding.name} (directory: ${boundDirectory() ?? 'none yet'})`,
          `Server: ${opts.baseUrl} (${link ?? 'not called yet'})`,
          'Team memory: rides beside the prompt (prompt.submit)',
          `Last prompt: ${memoryLast}`,
        ].join('\n'),
      }
    }
    if (e.args.trim() !== '') {
      const before = await currentBinding($)
      const text = await runProject($, opts, e.args)
      // `/team use` bound a project whose memory the thread's prompt does not carry
      const after = await currentBinding($)
      if (splitFirst(e.args)[0] === 'use' && after !== null && after.projectId !== before?.projectId) {
        await announceMemory($, opts, after)
      }
      return { text }
    }
    // The pane refreshes on a timer only while it is placed (and so only then costs API calls).
    stopPaneTimer()
    const opened = await openPane($, opts)
    if (opened.isPlaced) {
      paneTimer = $.clock.every(PANE_REFRESH_MS, () =>
        void tickPane($, opts).then(isAlive => {
          if (!isAlive) stopPaneTimer()
        }))
      // the Chat tab reads the chat more often, and only while it shows
      chatPaneTimer = $.clock.every(CHAT_PANE_MS, () =>
        void tickChatPane($, opts).then(isAlive => {
          if (!isAlive) stopPaneTimer()
        }))
    }
    return { text: opened.text }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    // a hook beneath may refuse the close: stop only when the pane is really gone
    if (!(await isPanePlaced($))) stopPaneTimer()
    return closed
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => renderPane($, e, opts))
}
