export type TeamProjectBinding = { projectId: string; name: string }
// `waiting`: set by ask_team (or a pick of a waiting thread) until the thread is working again
export type TeamProjectThread = { threadId: string; id: string; title: string; waiting?: true }

// The pane's data. The contract must be self-contained (no imports), so these
// repeat the shapes of ThreadDto, ThreadDetailDto, InstructionsDto, DecisionDto,
// LibraryFileDto and LibraryDetailDto in hooks/; the hooks check them structurally.
export type TeamProjectMember = { memberId: string; name: string }
export type TeamProjectPaneThread = {
  id: string
  threadId: string
  title: string
  goal: string
  status: string
  owner: TeamProjectMember | null
  prUrl: string | null
  lastActivityAt: string
}
export type TeamProjectPaneDetail = {
  thread: TeamProjectPaneThread
  worklog: {
    entryId: string
    author: TeamProjectMember
    kind: string
    summary: string
    reasoning: string | null
    refs: string[]
    trigger: string
    decisionId: string | null
    replyTo: string | null
    createdAt: string
  }[]
}
export type TeamProjectPaneMemory = {
  instructions: { version: number; body: string; changeNote: string | null; editedBy: TeamProjectMember; editedAt: string }
  decisions: {
    id: string
    title: string
    reasoning: string
    alternatives: string | null
    scope: string | null
    status: string
    sourceThread: string | null
    prUrl: string | null
    supersededBy: string | null
    createdBy: TeamProjectMember
    createdAt: string
  }[]
}
// a row of the Library tab: a file with its latest version
export type TeamProjectPaneLibraryFile = {
  fileId: string
  name: string
  latestVersion: number
  sizeBytes: number
  contentType: string
  summary: string
  updatedBy: TeamProjectMember
  updatedAt: string
}
// the file clicked in the Library tab, its versions newest first
export type TeamProjectPaneLibraryDetail = {
  fileId: string
  projectId: string
  name: string
  versions: {
    version: number
    sizeBytes: number
    sha256: string
    contentType: string
    summary: string
    note: string | null
    extractStatus: string
    sourceThread: string | null
    uploadedBy: TeamProjectMember
    createdAt: string
    decisions: number[]
  }[]
}

// the main chat: a message, a page of `GET /projects/{pid}/chat`, and what the session keeps of it
export type TeamProjectChatMessage = {
  seq: number
  kind: 'human' | 'coordinator' | 'system'
  author: { memberId: string; name: string } | null
  body: string
  handledThrough: number | null
  threadNo: number | null
  decisionNo: number | null
  createdAt: string
}
export type TeamProjectChatLock = { holder: { memberId: string; name: string } | null; leaseUntil: string | null }
export type TeamProjectChatPage = { messages: TeamProjectChatMessage[]; lock: TeamProjectChatLock; handledThrough: number }
// the last 200 messages of the bound project, oldest first, with the lock and handledThrough of the last read
export type TeamProjectChatLog = { projectId: string } & TeamProjectChatPage

declare module 'claude-code' {
  interface PluginState {
    'team-project': {
      binding: TeamProjectBinding | null
      thread: TeamProjectThread | null
      // bumped by every pick, release and lost thread: a turn that saw it change is not uploaded
      pickSeq: number
      online: boolean
      // how the API last answered: 'rejected' is a 401; the pane header shows it
      link: 'online' | 'offline' | 'rejected'
      lastTouch: number
      // the pane
      tab: 'chat' | 'threads' | 'memory' | 'library'
      selected: string | null
      threads: TeamProjectPaneThread[]
      detail: TeamProjectPaneDetail | null
      memory: TeamProjectPaneMemory | null
      paneNote: string | null
      // the Library tab: the files, the name filter (applied locally) and the file shown with its versions
      library: TeamProjectPaneLibraryFile[] | null
      libraryFilter: string
      librarySelected: string | null
      libraryDetail: TeamProjectPaneLibraryDetail | null
      // what the last answer typed in the pane came to, shown under that thread's worklog
      answerNote: { threadId: string; text: string } | null
      // per thread uuid: the answer entryIds already put in front of the model
      seenAnswers: Record<string, string[]>
      // transcript upload: the session switch (`/team transcript on|off`), the gitleaks check
      // (cached after the first `gitleaks version`; null until then) and the once-per-session toast
      transcriptSession: 'on' | 'off'
      transcriptFilter: { ok: true; version: string } | { ok: false } | null
      transcriptWarned: boolean
      // the last chunk was dropped because the scan failed; cleared by the next good scan
      transcriptFailed: boolean
      // $HOME as `printenv HOME` gave it, for the library cache
      libraryHome: string
      // the main chat: the session's cache of the bound project's chat, and the member (from /me)
      chatLog: TeamProjectChatLog | null
      me: { id: string; name: string } | null
      // the Chat tab: older pages loaded by `Load older` (outside the 200 kept), the field's text,
      // and the status of each proposal card's decision (by number, from GET /decisions/{no})
      chatOlder: { projectId: string; messages: TeamProjectChatMessage[] } | null
      chatDraft: string
      chatDecisions: { projectId: string; statuses: Record<string, string> } | null
    }
  }
}
