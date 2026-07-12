import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const profile = await mkdtemp(join(tmpdir(), 'akorith-e2e-'))
const consoleErrors = []
let application

try {
  application = await electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      APPDATA: profile,
      LOCALAPPDATA: profile,
      HOME: profile,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: 45_000
  })
  const page = await application.firstWindow({ timeout: 30_000 })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.waitForSelector('.app-chrome')

  const layout = await page.evaluate(() => {
    const chrome = document.querySelector('.app-chrome')?.getBoundingClientRect()
    const content = document.querySelector('.app-content')?.getBoundingClientRect()
    const sidebarSegment = getComputedStyle(document.querySelector('.app-chrome-sidebar-segment'))
    const sidebar = getComputedStyle(document.querySelector('.sidebar-surface'))
    return {
      chromeBottom: chrome?.bottom ?? -1,
      contentTop: content?.top ?? -2,
      sidebarChromeBackground: sidebarSegment.backgroundImage,
      sidebarBackground: sidebar.backgroundImage
    }
  })
  assert.ok(layout.contentTop >= layout.chromeBottom - 0.5, 'main content must start below the title bar')
  assert.equal(layout.sidebarChromeBackground, layout.sidebarBackground, 'sidebar and title-bar segment share one background stack')

  const more = page.locator('.sidebar-more-trigger')
  await more.click()
  const destinations = await page.getByRole('menu', { name: 'More destinations' }).getByRole('menuitem').allTextContents()
  assert.deepEqual(destinations.map((value) => value.trim()), ['Loop', 'Benchmark', 'Plugins'])

  await page.getByRole('menuitem', { name: 'Loop' }).click()
  await page.getByRole('heading', { name: 'Loop', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Create Loop' }).click()
  await page.getByRole('dialog', { name: 'Create Loop' }).waitFor()
  assert.equal(await page.getByLabel(/task/i).count(), 0, 'Loop setup must not require a task prompt')
  await page.keyboard.press('Escape')

  await more.click()
  await page.getByRole('menuitem', { name: 'Benchmark' }).click()
  await page.getByRole('heading', { name: 'Benchmark', exact: true }).waitFor()

  await more.click()
  await page.getByRole('menuitem', { name: 'Plugins' }).click()
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
  const firstInstall = page.getByRole('button', { name: 'Install' }).first()
  if (await firstInstall.isVisible()) {
    await firstInstall.click()
    await page.getByText(/install completed/i).waitFor()
  }

  await page.getByRole('button', { name: 'Dashboard' }).click()
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor()
  await page.locator('button[title="Settings"]').click()
  await page.getByRole('button', { name: /^Updates/ }).click()
  await page.getByRole('heading', { name: 'Updates' }).waitFor()
  await page.getByText(/Development builds do not use the packaged updater|Portable builds do not self-update|Current version/i).first().waitFor()

  assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(' | ')}`)
  console.log('e2e-app-shell: launch, shell, Loop, Benchmark, Plugins, Dashboard, and Updates passed')
} finally {
  await application?.close().catch(() => undefined)
  await rm(profile, { recursive: true, force: true })
}
