import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileNameFor, toMarkdownFile } from '../shared/exportNotes'
import { loadSettings, updateSettings } from './settings'
import type { Meeting, Store } from './store'
import { t } from '../shared/i18n'
import type { TranscriptFolderStatus } from '../shared/types'

/**
 * Fork addition: after each meeting, its transcript goes to a folder the person picked (often a network share) as a
 * Markdown file. A share that is offline or asleep must never lose a transcript: the meeting waits in a small queue on
 * disk and is written once the folder answers again (retried on a timer, at launch, and when the folder changes).
 * Kept in its own file, wired from index.ts, so merging upstream Yogurt stays easy.
 */

/** id → the file written for it, so a resumed meeting replaces its own file and never another meeting's */
export type ExportState = { pending: string[]; written: Record<string, string> }
export type ExportResult = 'written' | 'skipped' | 'waiting' | 'unreachable'

/** how long speaker names from the call may hold the file back; notes use the same minute */
const NAMES_WAIT_MS = 60_000
const RETRY_MS = 5 * 60_000

export function loadState(path: string): ExportState {
  try {
    const s = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    return { pending: Array.isArray(s.pending) ? s.pending.filter((x: unknown) => typeof x === 'string') : [], written: s.written && typeof s.written === 'object' ? s.written : {} }
  } catch { return { pending: [], written: {} } }
}
function saveState(path: string, s: ExportState) {
  writeFileSync(path + '.tmp', JSON.stringify(s, null, 2))
  renameSync(path + '.tmp', path)
}

/** "<title> <day>.md", then "<title> <day> 2.md" and on, skipping names on disk that belong to someone else */
export async function freeName(folder: string, base: string, mine: string | undefined, taken: Set<string>): Promise<string> {
  for (let n = 1; ; n++) {
    const path = join(folder, n === 1 ? base : base.replace(/\.md$/, ` ${n}.md`))
    if (path === mine) return path
    if (taken.has(path)) continue
    if (!(await stat(path).then(() => true, () => false))) return path
  }
}

async function reachable(folder: string): Promise<boolean> {
  try { return (await stat(folder)).isDirectory() } catch { return false }
}

const upTo = async (wait: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([wait.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms) })])
  clearTimeout(timer)
}

export function hookTranscriptExport(d: {
  store: Pick<Store, 'meeting' | 'segments'>
  settingsFile: string
  stateFile: string
  /** called once the stopped state is saved (onMeetingStopSaved) */
  onStop: (fn: (m: Meeting) => void) => unknown
  /** resolves when the recording and its transcript are final */
  transcribed: (id: string) => Promise<void>
  /** resolves when the call's speaker names are in */
  named?: (id: string) => Promise<void>
  window?: () => BrowserWindow | undefined
  retryMs?: number
  namesWaitMs?: number
}) {
  const folderOf = () => loadSettings(d.settingsFile).transcriptFolder?.trim() || null
  let state = loadState(d.stateFile)
  let lastReachable: boolean | null = null
  let last: TranscriptFolderStatus['last'] = null
  let timer: NodeJS.Timeout | undefined
  let chain: Promise<unknown> = Promise.resolve()

  const persist = () => { try { saveState(d.stateFile, state) } catch (e) { console.error('EXPORT could not save its queue', e) } }
  const status = (): TranscriptFolderStatus => ({ folder: folderOf(), reachable: lastReachable, waiting: state.pending.length, last })
  const tell = () => { const w = d.window?.(); if (w && !w.isDestroyed()) w.webContents.send('transcripts:status', status()) }

  async function writeOne(id: string): Promise<ExportResult> {
    const folder = folderOf()
    if (!folder) return 'skipped'
    const m = d.store.meeting(id)
    if (!m || m.trashedAt != null) return 'skipped'
    if (m.state === 'recording' || m.state === 'prepared') return 'waiting'
    const segments = d.store.segments(id)
    // recorded before the speech model was in: transcribed from its audio later, which queues it again
    if (!segments.length) return m.transcriptionPending ? 'waiting' : 'skipped'
    if (!(await reachable(folder))) return 'unreachable'
    const mine = state.written[id]
    const taken = new Set(Object.entries(state.written).filter(([k]) => k !== id).map(([, v]) => v))
    const path = await freeName(folder, fileNameFor(m.title, m.startedAt), mine && dirname(mine) === folder ? mine : undefined, taken)
    let staging: string | undefined
    try {
      // staged beside the file, on the share itself: a dropped connection never leaves half a transcript under its name
      staging = await mkdtemp(join(folder, '.yogurt-transcript-'))
      const file = join(staging, 'transcript.md')
      await writeFile(file, toMarkdownFile(m, '', segments), 'utf8')
      await rename(file, path)
      state.written[id] = path
      last = { title: m.title, at: Date.now() }
      console.info('EXPORT', `saved the transcript of ${id}`)
      return 'written'
    } catch (e) {
      console.warn('EXPORT could not write the transcript', id, e)
      return 'unreachable'
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** one pass over the queue at a time; what could not be written stays for the next */
  const flush = (): Promise<void> => {
    const run = chain.then(async () => {
      const batch = [...state.pending], keep: string[] = []
      let sawUnreachable = false, wrote = false
      for (const id of batch) {
        // the share is down: don't knock on it once per meeting
        if (sawUnreachable) { keep.push(id); continue }
        const r = await writeOne(id)
        if (r === 'written') wrote = true
        if (r === 'unreachable') sawUnreachable = true
        if (r === 'waiting' || r === 'unreachable') keep.push(id)
      }
      // a meeting queued while this pass ran is kept; its own flush is chained after this one
      const added = state.pending.filter((id) => !batch.includes(id))
      state.pending = [...new Set([...keep, ...added])]
      if (folderOf() && (wrote || sawUnreachable)) lastReachable = !sawUnreachable
      persist()
      schedule()
      tell()
    })
    chain = run.catch((e) => console.error('EXPORT pass failed', e))
    return chain as Promise<void>
  }

  const schedule = () => {
    clearTimeout(timer); timer = undefined
    if (state.pending.length && folderOf()) {
      timer = setTimeout(() => void flush(), d.retryMs ?? RETRY_MS)
      timer.unref?.()
    }
  }

  /** queue a meeting whose transcript is final (or is being redone), then try at once */
  const queue = (id: string): Promise<void> => {
    if (!folderOf()) return Promise.resolve()
    if (!state.pending.includes(id)) state.pending.push(id)
    persist()
    return flush()
  }

  d.onStop((m) => {
    if (!folderOf()) return
    void (async () => {
      await d.transcribed(m.id)
      if (d.named) await upTo(d.named(m.id), d.namesWaitMs ?? NAMES_WAIT_MS)
      await queue(m.id)
    })().catch((e) => console.error('EXPORT after the meeting failed', e))
  })

  ipcMain.handle('transcripts:status', () => status())
  ipcMain.handle('transcripts:choose', async (): Promise<TranscriptFolderStatus | null> => {
    const opts = { title: t('Save transcripts to a folder'), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, ...(folderOf() ? { defaultPath: folderOf()! } : {}) }
    const win = d.window?.()
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    updateSettings(d.settingsFile, { transcriptFolder: r.filePaths[0] })
    lastReachable = await reachable(r.filePaths[0])
    // anything that waited for the old folder goes to the new one
    await flush()
    return status()
  })
  ipcMain.handle('transcripts:clear', () => {
    updateSettings(d.settingsFile, { transcriptFolder: undefined })
    state.pending = []; lastReachable = null; persist(); schedule()
    return status()
  })
  ipcMain.on('transcripts:show', () => { const f = folderOf(); if (f) void shell.openPath(f) })

  // what was waiting when the app last quit
  if (state.pending.length) void flush()

  return { queue, flush, status, stop: () => { clearTimeout(timer); timer = undefined } }
}
