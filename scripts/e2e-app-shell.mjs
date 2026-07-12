import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const profile = await mkdtemp(join(tmpdir(), 'akorith-e2e-'))
const consoleErrors = []
let application

async function findAppWindow(electronApplication, timeoutMs = 30_000) {
  await electronApplication.firstWindow({ timeout: timeoutMs })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const candidate of electronApplication.windows()) {
      try {
        if (await candidate.locator('.app-chrome').count()) return candidate
      } catch {
        // The splash window is intentionally short-lived and may close here.
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error('Akorith main window did not become ready before the E2E timeout.')
}

try {
  application = await electron.launch({
    executablePath: electronPath,
    args: ['.', `--user-data-dir=${join(profile, 'user-data')}`],
    cwd: root,
    env: {
      ...process.env,
      APPDATA: profile,
      LOCALAPPDATA: profile,
      HOME: profile,
      AKORITH_SKIP_LEGACY_MIGRATION: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: 45_000
  })
  const page = await findAppWindow(application)
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.waitForSelector('.app-chrome')
  const startup = await page.evaluate(() => window.api.app.getStartupSnapshot({}))
  assert.ok(
    resolve(startup.app.userDataPath).toLowerCase().startsWith(resolve(profile).toLowerCase()),
    `E2E userData escaped its isolated profile: ${startup.app.userDataPath}`
  )
  assert.equal(startup.projects.length, 0, 'isolated E2E profile must not inherit user projects')
  const screenshotDir = process.env.AKORITH_E2E_SCREENSHOT_DIR
  const capture = async (name) => {
    if (!screenshotDir) return
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, name), fullPage: true })
  }
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
  await capture('sidebar-more.png')

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
  const dashboardLayout = await page.evaluate(() => {
    const content = document.querySelector('.app-content')
    const dashboard = document.querySelector('.telemetry-dashboard')
    const heading = document.querySelector('.td-page-heading')
    const refresh = document.querySelector('.td-refresh')
    const contentRect = content?.getBoundingClientRect()
    const dashboardRect = dashboard?.getBoundingClientRect()
    const headingRect = heading?.getBoundingClientRect()
    const refreshRect = refresh?.getBoundingClientRect()
    return {
      viewportWidth: window.innerWidth,
      contentWidth: content?.clientWidth ?? 0,
      dashboardWidth: dashboard?.clientWidth ?? 0,
      dashboardScrollWidth: dashboard?.scrollWidth ?? 0,
      contentRight: contentRect?.right ?? 0,
      dashboardRight: dashboardRect?.right ?? 0,
      headingRight: headingRect?.right ?? 0,
      refreshRight: refreshRect?.right ?? 0,
      dashboardPaddingRight: dashboard ? Number.parseFloat(getComputedStyle(dashboard).paddingRight) : 0
    }
  })
  assert.equal(
    dashboardLayout.dashboardScrollWidth,
    dashboardLayout.dashboardWidth,
    `Dashboard must not overflow its page container: ${JSON.stringify(dashboardLayout)}`
  )
  assert.ok(
    dashboardLayout.dashboardRight <= dashboardLayout.contentRight + 1
      && dashboardLayout.refreshRight <= dashboardLayout.dashboardRight - dashboardLayout.dashboardPaddingRight + 1,
    `Dashboard controls must remain inside the padded content area: ${JSON.stringify(dashboardLayout)}`
  )
  await capture('dashboard.png')
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
