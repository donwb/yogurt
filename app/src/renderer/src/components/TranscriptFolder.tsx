import { useEffect, useState } from 'react'
import { Folder } from 'lucide-react'
import type { TranscriptFolderStatus } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { osWords } from '../keys'

/**
 * Fork addition: the folder each finished meeting's transcript is saved to (a network share works). Says when the
 * folder could not be reached; those transcripts wait and are saved once it answers again.
 */
export function TranscriptFolder() {
  const [s, setS] = useState<TranscriptFolderStatus>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void window.yogurt.transcripts.status().then(v => { if (active) setS(v) })
    const off = window.yogurt.transcripts.onStatus(setS)
    return () => { active = false; off() }
  }, [])
  const act = async (f: () => Promise<TranscriptFolderStatus | null>) => {
    setBusy(true); setFailed(false)
    try { const v = await f(); if (v) setS(v) } catch { setFailed(true) } finally { setBusy(false) }
  }
  const folder = s?.folder
  return <div data-testid="transcript-folder" className="settings-row">
    <div className="settings-row-copy">
      <p className="settings-label">{t('Save transcripts to a folder')}</p>
      <p className="settings-description">{folder
        ? <span data-testid="transcript-folder-path" className="flex items-center gap-1.5 break-all"><Folder size={12} aria-hidden="true" className="shrink-0" />{folder}</span>
        : t('After each meeting, its transcript is saved there as a Markdown file. A network share works too.')}</p>
      {folder && s?.reachable === false && <p data-testid="transcript-folder-offline" role="status" className="text-danger text-xs">
        {t("Can't reach this folder. Transcripts will be saved once it's back.")}{s.waiting > 0 && ` (${s.waiting})`}</p>}
      {failed && <p role="alert" className="text-danger text-xs">{t("Couldn't save your changes")}</p>}
    </div>
    <div className="flex items-center gap-2 shrink-0">
      {folder && <button data-testid="transcript-folder-show" className="ghost-btn" disabled={busy} onClick={() => window.yogurt.transcripts.show()}>
        {osWords({ mac: t('Show in Finder'), windows: t('Show in File Explorer'), linux: t('Show in Files') })}</button>}
      {folder && <button data-testid="transcript-folder-clear" className="ghost-btn" disabled={busy} onClick={() => void act(() => window.yogurt.transcripts.clear())}>{t('Remove')}</button>}
      <button data-testid="transcript-folder-choose" className="workspace-button" disabled={busy} onClick={() => void act(() => window.yogurt.transcripts.choose())}>
        {folder ? t('Change folder…') : t('Choose folder…')}</button>
    </div>
  </div>
}
