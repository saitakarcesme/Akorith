import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  detectWorkspaceBrowserAction,
  runWorkspaceBrowserAction,
  type WorkspacePreviewOpenInput
} from '../src/main/workspace-actions.ts'

async function verify(): Promise<void> {
  assert.deepEqual(
    detectWorkspaceBrowserAction('Build the game, then open the site in Chrome.', 'execute'),
    { type: 'open_project_preview', browser: 'chrome' },
    'an explicit English Chrome request must produce a Chrome preview action'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction("Siteyi Chrome'da aç.", 'execute'),
    { type: 'open_project_preview', browser: 'chrome' },
    'a Turkish Chrome request with diacritics must produce a Chrome preview action'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction("Siteyi Chrome'da ac.", 'execute'),
    { type: 'open_project_preview', browser: 'chrome' },
    'a Turkish Chrome request without diacritics must produce a Chrome preview action'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction("Siteyi Chrome'da açmasını istiyorum.", 'execute'),
    { type: 'open_project_preview', browser: 'chrome' },
    'a natural Turkish request with a conjugated action must produce a Chrome preview action'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction("Chrome'da siteyi açar mısın?", 'execute'),
    { type: 'open_project_preview', browser: 'chrome' },
    'a polite Turkish Chrome request must produce a Chrome preview action'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction('Open the website in the browser when it is ready.', 'execute'),
    { type: 'open_project_preview', browser: 'default' },
    'a generic browser request must use the default browser'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction('Run the app so I can see it.', 'execute'),
    { type: 'open_project_preview', browser: 'default' },
    'an explicit app run request must start the trusted project preview'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction('I want you to start this app.', 'execute'),
    { type: 'open_project_preview', browser: 'default' },
    'a natural app start request must start the trusted project preview'
  )
  assert.deepEqual(
    detectWorkspaceBrowserAction('Uygulamayı çalıştır.', 'execute'),
    { type: 'open_project_preview', browser: 'default' },
    'a Turkish app run request must start the trusted project preview'
  )
  assert.equal(
    detectWorkspaceBrowserAction('Do not run the app yet.', 'execute'),
    null,
    'a negated app run request must not start the preview'
  )
  assert.equal(
    detectWorkspaceBrowserAction('Open this file and fix the type error.', 'execute'),
    null,
    'ordinary file actions must not be mistaken for a project preview request'
  )
  assert.equal(
    detectWorkspaceBrowserAction('Run the unit tests.', 'execute'),
    null,
    'validation commands must not be mistaken for a project preview request'
  )
  assert.equal(
    detectWorkspaceBrowserAction('Open the site in Chrome.', 'plan'),
    null,
    'a planning turn must never trigger a browser action'
  )

  const manualCommandOnly = [
    'Example:',
    '```',
    'open -a "Google Chrome" /Users/example/project/index.html',
    '```'
  ].join('\n')
  assert.equal(
    detectWorkspaceBrowserAction(manualCommandOnly, 'execute'),
    null,
    'a manual browser command shown as an example must not be mistaken for user intent'
  )
  assert.equal(
    detectWorkspaceBrowserAction(
      'Chrome restriction: I cannot open the site in Chrome from this environment.',
      'execute'
    ),
    null,
    'a browser-restriction explanation must not be mistaken for user intent'
  )

  const trustedWorkspace = '/Users/example/Trusted Workspace'
  const openerCalls: WorkspacePreviewOpenInput[] = []
  const success = await runWorkspaceBrowserAction(
    {
      prompt: 'Please open the site in Chrome.',
      intent: 'execute',
      workspacePath: trustedWorkspace
    },
    {
      opener: async (input) => {
        openerCalls.push(input)
        return { url: 'http://127.0.0.1:43123/' }
      }
    }
  )
  assert.deepEqual(
    openerCalls,
    [{ workspacePath: trustedWorkspace, browser: 'chrome' }],
    'the broker must pass only the trusted workspace and detected browser to its opener'
  )
  assert.deepEqual(
    success,
    {
      type: 'open_project_preview',
      browser: 'chrome',
      url: 'http://127.0.0.1:43123/',
      label: 'Opened project preview in Chrome'
    },
    'a successful opener must produce a stable user-facing receipt'
  )

  const openerFailure = await runWorkspaceBrowserAction(
    {
      prompt: 'Open the project in the browser.',
      intent: 'execute',
      workspacePath: trustedWorkspace
    },
    {
      opener: async () => {
        throw new Error('Chrome could not be started')
      }
    }
  )
  assert.deepEqual(
    openerFailure,
    {
      error: 'Chrome could not be started',
      label: 'Could not open project preview in the default browser'
    },
    'opener failures must be returned as error receipts instead of escaping as exceptions'
  )

  const openCodeSource = readFileSync(
    new URL('../src/main/providers/opencode.ts', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(
    openCodeSource,
    /['"]open(?:\s+\*)?['"]\s*:\s*['"]allow['"]/i,
    'OpenCode must not gain a generic browser-launch shell permission'
  )

  const registrySource = readFileSync(
    new URL('../src/main/providers/registry.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    registrySource,
    /WORKSPACE_BROWSER_ACTION_INSTRUCTION/,
    'Workspace providers must be told that Akorith owns explicit browser launches'
  )
  assert.match(
    registrySource,
    /workspacePath:\s*workspaceContext\.projectPath[\s\S]*?result,\s*[\r\n]+\s*emit:\s*emitActivity/,
    'chat actions must use the persisted session project path and publish activity'
  )
  assert.match(
    registrySource,
    /sendWorkspacePrompt[\s\S]*?completeWorkspaceBrowserAction/,
    'headless Workspace and Loop execution must share the browser action broker'
  )
  assert.match(
    registrySource,
    /activity\.surface\s*\?\?\s*\(activity\.kind\s*===\s*['"]file['"]\s*\?\s*['"]files['"]/,
    'structured file activity must target the Files workspace tool'
  )
  assert.match(
    registrySource,
    /Opening the project preview[\s\S]{0,180}surface:\s*['"]browser['"]/,
    'trusted preview actions must target the Browser workspace tool'
  )

  const previewMainSource = readFileSync(
    new URL('../src/main/project-preview.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    previewMainSource,
    /process\.env\.ComSpec \|\| ['"]cmd\.exe['"][\s\S]{0,120}args:\s*\[['"]\/d['"], ['"]\/s['"], ['"]\/c['"], manager, \.\.\.runnerArgs\]/,
    'Windows preview runners must resolve npm command shims through the trusted command interpreter'
  )
  assert.match(
    previewMainSource,
    /shell:\s*false,[\s\S]{0,80}windowsHide:\s*true/,
    'Windows preview runners must not open a visible terminal window'
  )

  const previewPanelSource = readFileSync(
    new URL('../src/renderer/src/components/ProjectPreviewPanel.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    previewPanelSource,
    /\[active,\s*projectPath,\s*refreshKey\]/,
    'the preview panel must re-inspect after a turn creates a runnable entry point'
  )

  console.log('verify-workspace-actions: ok')
}

void verify().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
