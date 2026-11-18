import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const dialogState = { canceled: false, filePaths: [] as string[] }
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: (...a: unknown[]) => unknown) => { handlers.set(c, f) }, on: () => {} },
  dialog: { showOpenDialog: async () => dialogState },
  shell: { openPath: async () => '' },
}))

import { hookTranscriptExport } from '../src/main/transcriptExport'

type M = { id: string; title: string; startedAt: number; endedAt: number | null; eventId: null; app: null; attendees: Array<{ name: string; email: string | null }>; state: string; transcriptionPending?: boolean; trashedAt?: number }
const day = new Date(2026, 10, 18, 9, 30).getTime()
let dir: string, share: string, settingsFile: string, stateFile: string
let meetings: Record<string, M>, segs: Record<string, Array<{ id: number; meetingId: string; track: 'me' | 'them'; startMs: number; endMs: number; text: string; speaker: string | null }>>
let stopHooks: Array<(m: M) => void>
let hooks: ReturnType<typeof hookTranscriptExport>[]

const store = { meeting: (id: string) => meetings[id], segments: (id: string) => segs[id] ?? [] }
const said = (meetingId: string, text: string, track: 'me' | 'them' = 'them', speaker: string | null = 'Ana') => ({ id: Math.random(), meetingId, track, startMs: 1000, endMs: 2000, text, speaker })
const setFolder = (f: string | undefined) => writeFileSync(settingsFile, JSON.stringify(f ? { transcriptFolder: f } : {}))
const hook = () => {
  const h = hookTranscriptExport({ store: store as never, settingsFile, stateFile, onStop: (fn) => { stopHooks.push(fn as never) }, transcribed: async () => {}, retryMs: 60_000 })
  hooks.push(h)
  return h
}
const stop = async (m: M) => { for (const f of stopHooks) f(m); await vi.waitFor(() => expect(readState().pending.includes(m.id) || Object.keys(readState().written).includes(m.id)).toBe(true)) }
const readState = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { pending: [], written: {} }
const mds = () => readdirSync(share).filter((f) => f.endsWith('.md')).sort()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yogurt-transcripts-'))
  share = join(dir, 'share'); mkdirSync(share)
  settingsFile = join(dir, 'settings.json'); stateFile = join(dir, 'transcript-exports.json')
  meetings = { a: { id: 'a', title: 'Weekly sync', startedAt: day, endedAt: day + 60_000, eventId: null, app: null, attendees: [{ name: 'Ana', email: null }], state: 'stopped' } }
  segs = { a: [said('a', 'Ship it on Friday.')] }
  stopHooks = []; hooks = []; handlers.clear()
  setFolder(share)
})
afterEach(() => { for (const h of hooks) h.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('transcript export', () => {
  it('saves the transcript as Markdown in the folder once the meeting stops', async () => {
    const h = hook()
    await stop(meetings.a); await h.flush()
    expect(mds()).toEqual(['Weekly sync 2026-11-18.md'])
    const md = readFileSync(join(share, 'Weekly sync 2026-11-18.md'), 'utf8')
    expect(md).toContain('# Weekly sync')
    expect(md).toContain('Ana')
    expect(md).toContain('Ship it on Friday.')
    // no staging folders left behind on the share
    expect(readdirSync(share).filter((f) => f.startsWith('.'))).toEqual([])
    expect(readState().pending).toEqual([])
  })

  it('does nothing while no folder is picked', async () => {
    setFolder(undefined)
    hook()
    for (const f of stopHooks) f(meetings.a)
    await new Promise((r) => setTimeout(r, 20))
    expect(mds()).toEqual([])
    expect(readState().pending).toEqual([])
  })

  it('keeps the meeting waiting while the share is offline and saves it once it is back', async () => {
    rmSync(share, { recursive: true })
    const h = hook()
    await stop(meetings.a); await h.flush()
    expect(readState().pending).toEqual(['a'])
    expect(h.status()).toMatchObject({ reachable: false, waiting: 1 })
    mkdirSync(share)
    await h.flush()
    expect(mds()).toEqual(['Weekly sync 2026-11-18.md'])
    expect(h.status()).toMatchObject({ reachable: true, waiting: 0 })
  })

  it('picks the queue up again after a restart', async () => {
    rmSync(share, { recursive: true })
    const first = hook()
    await stop(meetings.a); await first.flush()
    first.stop()
    mkdirSync(share)
    const second = hook()
    await vi.waitFor(() => expect(mds()).toEqual(['Weekly sync 2026-11-18.md']))
    await second.flush()
    expect(readState().pending).toEqual([])
  })

  it('replaces its own file when a meeting is resumed, and never another meeting’s', async () => {
    meetings.b = { ...meetings.a, id: 'b', startedAt: day + 3_600_000 }
    segs.b = [said('b', 'Second meeting.')]
    const h = hook()
    await stop(meetings.a); await h.flush()
    await stop(meetings.b); await h.flush()
    expect(mds()).toEqual(['Weekly sync 2026-11-18 2.md', 'Weekly sync 2026-11-18.md'])
    segs.a.push(said('a', 'Added after resuming.'))
    await h.queue('a')
    expect(mds()).toHaveLength(2)
    expect(readFileSync(join(share, 'Weekly sync 2026-11-18.md'), 'utf8')).toContain('Added after resuming.')
    expect(readFileSync(join(share, 'Weekly sync 2026-11-18 2.md'), 'utf8')).toContain('Second meeting.')
  })

  it('does not overwrite a file someone else put there', async () => {
    writeFileSync(join(share, 'Weekly sync 2026-11-18.md'), 'not ours')
    const h = hook()
    await stop(meetings.a); await h.flush()
    expect(readFileSync(join(share, 'Weekly sync 2026-11-18.md'), 'utf8')).toBe('not ours')
    expect(mds()).toContain('Weekly sync 2026-11-18 2.md')
  })

  it('waits for a meeting still to be transcribed from its recording', async () => {
    segs.a = []
    meetings.a.transcriptionPending = true
    const h = hook()
    await h.queue('a')
    expect(readState().pending).toEqual(['a'])
    segs.a = [said('a', 'Transcribed later.')]
    meetings.a.transcriptionPending = false
    await h.queue('a')
    expect(mds()).toEqual(['Weekly sync 2026-11-18.md'])
  })

  it('skips meetings in the Trash or with nothing said', async () => {
    meetings.a.trashedAt = Date.now()
    const h = hook()
    await h.queue('a')
    segs.a = []; delete meetings.a.trashedAt
    await h.queue('a')
    expect(mds()).toEqual([])
    expect(readState().pending).toEqual([])
  })

  it('choosing a folder saves it and sends what waited to it', async () => {
    rmSync(share, { recursive: true })
    const h = hook()
    await stop(meetings.a); await h.flush()
    const other = join(dir, 'other'); mkdirSync(other)
    dialogState.filePaths = [other]
    const s = await handlers.get('transcripts:choose')!({}) as { folder: string; reachable: boolean }
    expect(s).toMatchObject({ folder: other, reachable: true, waiting: 0 })
    expect(readdirSync(other)).toEqual(['Weekly sync 2026-11-18.md'])
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).transcriptFolder).toBe(other)
  })

  it('removing the folder stops saving and drops the queue', async () => {
    rmSync(share, { recursive: true })
    const h = hook()
    await stop(meetings.a); await h.flush()
    const s = await handlers.get('transcripts:clear')!({})
    expect(s).toMatchObject({ folder: null, waiting: 0 })
    expect(readState().pending).toEqual([])
  })
})
