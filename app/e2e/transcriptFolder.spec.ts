import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fork addition: Settings › Save transcripts to a folder, and each finished meeting's transcript landing there.
const main = join(import.meta.dirname, '../out/main/index.js')
const shots = process.env.YOGURT_SHOTS

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData, YOGURT_FAKE_LLM_MS: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
/** the folder picker is the Mac's own panel: answer it from main instead */
const pickFolder = (app: ElectronApplication, dir: string) =>
  app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never }, dir)
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
const mds = (dir: string) => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { return [] } }

async function record(page: Page) {
  await page.getByTestId('nav-home').click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  const id = (await page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
  await expect.poll(async () => (await page.evaluate((id) => window.yogurt.transcript.get(id), id)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await page.getByTestId('note-stop').click()
  return id
}

test('a picked folder gets each meeting’s transcript, and waits out a share that is offline', async () => {
  const share = join(mkdtempSync(join(tmpdir(), 'yogurt-share-')), 'Team share')
  mkdirSync(share)
  const { app, page } = await launch()
  try {
    await page.getByTestId('settings-open').click()
    const row = page.getByTestId('transcript-folder')
    await expect(row).toContainText('Save transcripts to a folder')
    await row.scrollIntoViewIfNeeded()
    await shot(page, '01-settings-off')

    await pickFolder(app, share)
    await row.getByTestId('transcript-folder-choose').click()
    await expect(row.getByTestId('transcript-folder-path')).toHaveText(share)
    await expect(row.getByTestId('transcript-folder-choose')).toHaveText('Change folder…')
    await shot(page, '02-settings-folder')

    await record(page)
    await expect.poll(() => mds(share), { timeout: 30_000 }).toHaveLength(1)
    const md = readFileSync(join(share, mds(share)[0]), 'utf8')
    expect(md).toMatch(/^# /)
    expect(md).toContain('## Transcript')
    await shot(page, '03-after-meeting')

    // the share drops off the network
    rmSync(share, { recursive: true })
    await record(page)
    await page.getByTestId('settings-open').click()
    await expect(row.getByTestId('transcript-folder-offline')).toContainText("Can't reach this folder", { timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    await shot(page, '04-share-offline')

    // back again: picking it again (or the 5-minute retry) saves what waited
    mkdirSync(share)
    await row.getByTestId('transcript-folder-choose').click()
    await expect.poll(() => mds(share), { timeout: 30_000 }).toHaveLength(1)
    await expect(row.getByTestId('transcript-folder-offline')).toHaveCount(0)
    await shot(page, '05-share-back')
  } finally { await app.close() }
})
