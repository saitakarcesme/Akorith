import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isCliTimeoutError,
  providerRuntimeWatchdog,
  resolveCliLaunch,
  runCli,
  type RunCliDiagnostic
} from '../src/main/providers/util.ts'
import {
  boundedCommandOutput,
  buildCodexExecArgs,
  WORKSPACE_CODEX_DISABLED_FEATURES,
  WORKSPACE_CODEX_PROJECT_ROOT_OVERRIDE,
  WORKSPACE_CODEX_WINDOWS_SANDBOX_OVERRIDE
} from '../src/main/providers/chatgpt.ts'
import {
  buildClaudeCliArgs,
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_PLAN_ALLOWED_TOOLS,
  CLAUDE_WORKSPACE_ALLOWED_TOOLS,
  CLAUDE_WORKSPACE_DISALLOWED_TOOLS,
  claudeRequestTimeoutMs
} from '../src/main/providers/claude.ts'
import {
  buildOllamaGenerationOptions,
  buildOllamaStructuredOutputOptions,
  formatOllamaHttpError
} from '../src/main/providers/local.ts'
import {
  buildOpenCodeRunArgs,
  OPENCODE_WORKSPACE_PERMISSION_CONFIG,
  OPENCODE_WORKSPACE_SHELL_PERMISSIONS
} from '../src/main/providers/opencode.ts'

const fixture = fileURLToPath(new URL('./fixtures/provider-runtime-child.cjs', import.meta.url))

async function main(): Promise<void> {
  const sanitized = boundedCommandOutput(`\u001b[32mok\u001b[0m\nAuthorization: secret-value\n${'x'.repeat(600)}`)
  assert.ok(sanitized)
  assert.ok(!sanitized.includes('\u001b'))
  assert.ok(!sanitized.includes('secret-value'))
  assert.ok(sanitized.length <= 480)

  const executeArgs = buildCodexExecArgs('result.txt', {
    workingDirectory: 'C:\\workspace',
    intent: 'execute',
    model: 'gpt-5.4-mini',
    attachments: []
  })
  const workspaceDisabledFeatures = [
    'hooks',
    'plugins',
    'plugin_sharing',
    'remote_plugin',
    'apps',
    'enable_mcp_apps',
    'skill_mcp_dependency_install',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'computer_use',
    'in_app_browser'
  ]
  assert.deepEqual(
    WORKSPACE_CODEX_DISABLED_FEATURES,
    workspaceDisabledFeatures,
    'the tested isolation boundary must cover every Workspace-disabled Codex feature'
  )
  const projectRootOverrideIndex = executeArgs.indexOf(WORKSPACE_CODEX_PROJECT_ROOT_OVERRIDE)
  assert.ok(
    projectRootOverrideIndex > executeArgs.indexOf('--ignore-user-config'),
    'writable Workspace Codex must prevent parent project config discovery after ignoring user config'
  )
  assert.equal(executeArgs[projectRootOverrideIndex - 1], '-c')
  assert.ok(
    !executeArgs.some((arg) => arg.includes('.trust_level=')),
    'writable Workspace Codex must not force the selected cwd into a read-only trust profile'
  )
  const windowsSandboxOverrideIndex = executeArgs.indexOf(WORKSPACE_CODEX_WINDOWS_SANDBOX_OVERRIDE)
  if (process.platform === 'win32') {
    assert.equal(
      executeArgs[windowsSandboxOverrideIndex - 1],
      '-c',
      'Windows Workspace Codex must select the writable sandbox backend explicitly'
    )
    assert.ok(
      windowsSandboxOverrideIndex > projectRootOverrideIndex,
      'the Windows sandbox backend must be selected after config discovery is isolated'
    )
  } else {
    assert.equal(
      windowsSandboxOverrideIndex,
      -1,
      'the Windows sandbox backend override must not leak to other platforms'
    )
  }
  assert.ok(
    !executeArgs.includes('mcp_servers={}'),
    'an empty MCP table override is not an isolation boundary because Codex recursively merges tables'
  )
  for (const feature of workspaceDisabledFeatures) {
    const featureIndex = executeArgs.findIndex(
      (arg, index) => arg === feature && executeArgs[index - 1] === '--disable'
    )
    assert.ok(featureIndex > 0, `writable Workspace Codex must disable ${feature}`)
    assert.ok(
      featureIndex > executeArgs.indexOf('--ignore-user-config'),
      `${feature} must be applied after user configuration is ignored`
    )
  }
  const reasoningOverrideIndex = executeArgs.indexOf('model_reasoning_effort="medium"') - 1
  assert.ok(reasoningOverrideIndex >= 0, 'writable Workspace Codex must bound inherited reasoning effort')
  assert.equal(
    executeArgs[reasoningOverrideIndex + 1],
    'model_reasoning_effort="medium"',
    'Workspace Codex should stay responsive without inheriting an unbounded xhigh profile'
  )
  assert.ok(
    reasoningOverrideIndex > executeArgs.indexOf('--ignore-user-config'),
    'the Workspace reasoning override must be applied after user configuration is ignored'
  )
  assert.deepEqual(
    executeArgs.slice(executeArgs.indexOf('exec') - 2, executeArgs.indexOf('exec') + 1),
    ['--ask-for-approval', 'never', 'exec'],
    'headless Workspace execution must resolve approvals before the exec subcommand'
  )
  assert.ok(executeArgs.includes('workspace-write'))
  assert.ok(executeArgs.includes('--cd'))
  assert.equal(
    executeArgs[executeArgs.indexOf('--cd') + 1],
    '.',
    'the validated cwd must not be repeated as user-controlled Windows shell argv'
  )
  assert.ok(
    !executeArgs.includes('C:\\workspace'),
    'the absolute workspace path stays in spawn cwd, not the shell command'
  )
  assert.ok(
    executeArgs.includes('--ignore-user-config'),
    'writable Codex turns must not inherit user MCP servers, hooks, plugins, or apps'
  )
  assert.ok(
    executeArgs.indexOf('--ignore-user-config') < executeArgs.indexOf('--sandbox'),
    'Akorith must apply its explicit workspace-write sandbox after config isolation'
  )
  assert.ok(
    projectRootOverrideIndex < executeArgs.indexOf('--sandbox'),
    'project config discovery must be isolated before the writable sandbox is selected'
  )
  if (process.platform === 'win32') {
    assert.ok(
      windowsSandboxOverrideIndex < executeArgs.indexOf('--sandbox'),
      'the writable Windows backend must be selected before the workspace-write policy'
    )
  }

  const planArgs = buildCodexExecArgs('result.txt', {
    workingDirectory: 'C:\\workspace',
    intent: 'plan',
    attachments: []
  })
  assert.ok(planArgs.includes('read-only'))
  assert.ok(planArgs.includes('--ignore-user-config'))
  assert.ok(
    !planArgs.includes('--disable'),
    'read-only plan calls must retain their existing feature behavior'
  )
  assert.ok(
    !planArgs.includes(WORKSPACE_CODEX_PROJECT_ROOT_OVERRIDE),
    'read-only plan calls must retain their existing project-config behavior'
  )

  const chatArgs = buildCodexExecArgs('result.txt', {
    intent: 'execute',
    attachments: []
  })
  assert.ok(chatArgs.includes('--ignore-user-config'))
  assert.ok(
    !chatArgs.includes('--disable'),
    'non-Workspace chat calls must retain their existing feature behavior'
  )
  assert.ok(
    !chatArgs.includes(WORKSPACE_CODEX_PROJECT_ROOT_OVERRIDE),
    'non-Workspace chat calls must retain their existing project-config behavior'
  )

  assert.equal(
    claudeRequestTimeoutMs({ workingDirectory: 'C:\\workspace', intent: 'execute' }),
    600_000,
    'Claude Workspace execution must outlive the former five-minute cap'
  )
  assert.equal(
    claudeRequestTimeoutMs({ workingDirectory: 'C:\\workspace', intent: 'plan' }),
    300_000,
    'Claude planning keeps the existing bounded timeout'
  )
  assert.equal(
    claudeRequestTimeoutMs({}),
    300_000,
    'ordinary Claude chat keeps the existing bounded timeout'
  )
  const claudeExecuteArgs = buildClaudeCliArgs({
    workingDirectory: 'C:\\workspace',
    intent: 'execute',
    model: 'default',
    attachments: []
  })
  assert.deepEqual(
    claudeExecuteArgs.slice(
      claudeExecuteArgs.indexOf('--permission-mode'),
      claudeExecuteArgs.indexOf('--permission-mode') + 2
    ),
    ['--permission-mode', 'acceptEdits'],
    'Claude Workspace keeps scoped edit approval rather than bypassing permissions'
  )
  const allowedToolsIndex = claudeExecuteArgs.indexOf('--allowedTools')
  assert.ok(allowedToolsIndex >= 0, 'headless Claude Workspace receives a narrow tool allowlist')
  const allowedTools = claudeExecuteArgs[allowedToolsIndex + 1].split(',')
  assert.deepEqual(
    allowedTools,
    [...CLAUDE_WORKSPACE_ALLOWED_TOOLS],
    'Claude Workspace allows only native project file tools'
  )
  assert.equal(
    allowedTools.some((tool) => tool.startsWith('Bash')),
    false,
    'no package, test, validation, or inspection shell reaches Claude'
  )
  const disallowedToolsIndex = claudeExecuteArgs.indexOf('--disallowedTools')
  assert.ok(disallowedToolsIndex >= 0)
  const disallowedTools = claudeExecuteArgs[disallowedToolsIndex + 1].split(',')
  assert.deepEqual(disallowedTools, [...CLAUDE_WORKSPACE_DISALLOWED_TOOLS])
  assert.ok(disallowedTools.includes('Bash(*)'), 'all Claude Workspace shell commands are denied')
  assert.ok(claudeExecuteArgs.includes('--setting-sources='))
  assert.ok(claudeExecuteArgs.includes('--strict-mcp-config'))
  assert.equal(
    claudeExecuteArgs[claudeExecuteArgs.indexOf('--mcp-config') + 1],
    CLAUDE_EMPTY_MCP_CONFIG,
    'Claude Workspace receives an explicit empty strict MCP registry'
  )
  assert.ok(claudeExecuteArgs.includes('--disable-slash-commands'))
  assert.ok(
    !claudeExecuteArgs.some((arg) => /bypassPermissions|dangerously-skip-permissions/i.test(arg)),
    'Claude Workspace must never bypass its permission boundary'
  )
  const claudePlanArgs = buildClaudeCliArgs({
    workingDirectory: 'C:\\workspace',
    intent: 'plan',
    attachments: []
  })
  assert.ok(claudePlanArgs.includes('plan'))
  assert.deepEqual(
    claudePlanArgs[claudePlanArgs.indexOf('--allowedTools') + 1].split(','),
    [...CLAUDE_PLAN_ALLOWED_TOOLS],
    'read-only Claude planning receives only native read/search tools'
  )
  assert.deepEqual(
    claudePlanArgs[claudePlanArgs.indexOf('--disallowedTools') + 1].split(','),
    [...CLAUDE_WORKSPACE_DISALLOWED_TOOLS]
  )
  assert.ok(claudePlanArgs.includes('--setting-sources='))
  assert.ok(claudePlanArgs.includes('--strict-mcp-config'))

  const metacharWorkspace = 'C:\\Projects\\Call of Duty & QA'
  const openCodeArgs = buildOpenCodeRunArgs({
    workingDirectory: metacharWorkspace,
    model: 'default',
    attachments: []
  })
  assert.equal(
    openCodeArgs[openCodeArgs.indexOf('--dir') + 1],
    '.',
    'OpenCode binds to spawn.cwd without repeating a shell-sensitive absolute Windows path'
  )
  assert.ok(
    !openCodeArgs.includes(metacharWorkspace),
    'OpenCode absolute workspace paths remain out of shell argv'
  )
  assert.ok(openCodeArgs.includes('--pure'), 'OpenCode Workspace skips external plugins')
  const openCodePermissions = JSON.parse(OPENCODE_WORKSPACE_PERMISSION_CONFIG) as {
    mcp: Record<string, unknown>
    plugin: unknown[]
    instructions: unknown[]
    permission: {
      '*': string
      external_directory: string
      bash: Record<string, string>
      lsp?: string
    }
  }
  assert.equal(openCodePermissions.permission['*'], 'deny')
  assert.equal(openCodePermissions.permission.external_directory, 'deny')
  assert.deepEqual(openCodePermissions.permission.bash, { '*': 'deny' })
  assert.deepEqual(OPENCODE_WORKSPACE_SHELL_PERMISSIONS, { '*': 'deny' })
  assert.equal(openCodePermissions.permission.lsp, undefined, 'project LSP processes are not allowed')
  assert.deepEqual(openCodePermissions.mcp, {})
  assert.deepEqual(openCodePermissions.plugin, [])
  assert.deepEqual(openCodePermissions.instructions, [])

  assert.deepEqual(
    buildOllamaGenerationOptions({
      workingDirectory: 'C:\\workspace',
      intent: 'execute',
      generation: { maxTokens: 8_192, temperature: 0.2 }
    }),
    { num_predict: 8_192, temperature: 0.2, num_ctx: 8_192 },
    'Local Workspace turns must bound Ollama context allocation as well as output'
  )
  assert.deepEqual(
    buildOllamaGenerationOptions({
      intent: 'plan',
      generation: { maxTokens: 256 }
    }),
    { num_predict: 256 },
    'ordinary Local chat should retain the selected model context default'
  )
  assert.deepEqual(
    buildOllamaGenerationOptions({
      workingDirectory: 'C:\\workspace',
      intent: 'execute',
      generation: { maxTokens: 512 }
    }),
    { num_predict: 512, temperature: 0, num_ctx: 8_192 },
    'Local Workspace execution should default to deterministic generation'
  )
  const structuredOutput = buildOllamaStructuredOutputOptions({
    workingDirectory: 'C:\\workspace',
    intent: 'execute'
  })
  assert.equal(
    structuredOutput.think,
    false,
    'Local Workspace execution should reserve output for deliverable files'
  )
  assert.equal(
    (structuredOutput.format as { properties?: { type?: { const?: string } } })
      .properties?.type?.const,
    'workspace_patch',
    'Local Workspace execution should enforce the workspace patch schema'
  )
  assert.deepEqual(
    buildOllamaStructuredOutputOptions({ intent: 'plan' }),
    {},
    'ordinary Local chat and planning should remain unconstrained'
  )
  assert.match(
    formatOllamaHttpError(
      500,
      '{"error":"model requires more system memory (9.4 GiB) than is available (7.7 GiB)"}'
    ),
    /HTTP 500.*requires more system memory.*available/,
    'Ollama failures must expose their actionable local runtime detail'
  )

  const providerWatchdog = providerRuntimeWatchdog('opencode', 'OpenCode')
  assert.equal(providerWatchdog.inactivityWarningMs, 20_000)
  assert.ok(
    !('inactivityTimeoutMs' in providerWatchdog),
    'provider silence must remain observable without killing valid long reasoning'
  )

  const fakeWorkspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'akorith-cli-shims-'))
  try {
    const commandNames = ['node', 'python', 'npm', 'codex', 'claude', 'opencode']
    const markers = new Map<string, string>()
    for (const command of commandNames) {
      const marker = join(fakeWorkspace, `${command}-shim-ran.txt`)
      markers.set(command, marker)
      const shim = join(
        fakeWorkspace,
        process.platform === 'win32' ? `${command}.cmd` : command
      )
      writeFileSync(
        shim,
        process.platform === 'win32'
          ? `@echo fake>"${marker}"\r\n`
          : `#!/bin/sh\nprintf fake > ${JSON.stringify(marker)}\n`,
        'utf8'
      )
      if (process.platform !== 'win32') chmodSync(shim, 0o755)
    }
    const fakeFirstEnv = {
      ...process.env,
      PATH: `${fakeWorkspace}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
    }
    const resolvedCommands: string[] = []
    for (const command of commandNames) {
      try {
        const launch = resolveCliLaunch(command, fakeFirstEnv, fakeWorkspace)
        resolvedCommands.push(command)
        const actualArgv = [launch.executable, ...launch.prefixArgs, '--version']
        assert.ok(isAbsolute(launch.executable), `${command} resolves to an absolute executable`)
        assert.ok(isAbsolute(launch.source), `${command} records an absolute source`)
        for (const value of [launch.executable, launch.source, ...launch.prefixArgs]) {
          const rel = relative(fakeWorkspace, value)
          assert.ok(
            rel.startsWith('..') || isAbsolute(rel),
            `${command} executable/argv stays outside the workspace: ${actualArgv.join(' ')}`
          )
        }
        assert.ok(
          actualArgv.every((value) => !value.includes(`${command}.cmd`) || !value.startsWith(fakeWorkspace)),
          `${command} actual spawn argv excludes the fake shim: ${actualArgv.join(' ')}`
        )
      } catch (error) {
        assert.notEqual(command, 'node', `Node must resolve for provider runtime tests: ${String(error)}`)
      }
    }
    assert.ok(resolvedCommands.includes('node'))
    const safeNode = await runCli('node', [fixture, 'pulse'], {
      cwd: fakeWorkspace,
      env: fakeFirstEnv,
      timeoutMs: 1_000
    })
    assert.equal(safeNode.code, 0)
    for (const marker of markers.values()) {
      assert.equal(existsSync(marker), false, `${marker} proves the workspace shim never ran`)
    }
  } finally {
    rmSync(fakeWorkspace, { recursive: true, force: true })
  }

  const stalledDiagnostics: RunCliDiagnostic[] = []

  await assert.rejects(
    runCli('node', [fixture, 'stall'], {
      timeoutMs: 2_000,
      inactivityWarningMs: 150,
      inactivityTimeoutMs: 300,
      onDiagnostic: (diagnostic) => stalledDiagnostics.push(diagnostic)
    }),
    (error: unknown) => {
      assert.ok(isCliTimeoutError(error))
      assert.equal(error.timeoutKind, 'inactivity')
      assert.equal(error.thresholdMs, 300)
      return true
    }
  )
  assert.ok(
    stalledDiagnostics.some((diagnostic) => diagnostic.kind === 'inactive'),
    'a silent live process must emit an inactivity warning before termination'
  )
  assert.ok(
    stalledDiagnostics.some((diagnostic) => diagnostic.kind === 'timed_out'),
    'a silent live process must emit a typed timeout diagnostic'
  )
  for (const diagnostic of stalledDiagnostics) {
    const keys = Object.keys(diagnostic)
    assert.ok(!keys.includes('args'))
    assert.ok(!keys.includes('stdin'))
    assert.ok(!keys.includes('cwd'))
    assert.ok(!keys.includes('stdout'))
    assert.ok(!keys.includes('stderr'))
  }

  const healthyDiagnostics: RunCliDiagnostic[] = []
  const healthy = await runCli('node', [fixture, 'pulse'], {
    timeoutMs: 1_000,
    inactivityWarningMs: 200,
    inactivityTimeoutMs: 300,
    onDiagnostic: (diagnostic) => healthyDiagnostics.push(diagnostic)
  })
  assert.equal(healthy.code, 0)
  assert.match(healthy.stdout, /pulse-5/)
  assert.ok(
    !healthyDiagnostics.some((diagnostic) => diagnostic.kind === 'inactive' || diagnostic.kind === 'timed_out'),
    'regular output must reset both inactivity timers'
  )
  assert.ok(
    healthyDiagnostics.some((diagnostic) => diagnostic.kind === 'exited'),
    'a clean process exit must be observable'
  )

  const resumedDiagnostics: RunCliDiagnostic[] = []
  const resumed = await runCli('node', [fixture, 'resume'], {
    timeoutMs: 1_500,
    inactivityWarningMs: 120,
    inactivityTimeoutMs: 700,
    onDiagnostic: (diagnostic) => resumedDiagnostics.push(diagnostic)
  })
  assert.equal(resumed.code, 0)
  assert.ok(resumedDiagnostics.some((diagnostic) => diagnostic.kind === 'inactive'))
  assert.ok(
    resumedDiagnostics.some((diagnostic) => diagnostic.kind === 'activity'),
    'output after an inactivity warning must emit a recovery diagnostic'
  )

  const heartbeatDiagnostics: RunCliDiagnostic[] = []
  await assert.rejects(
    runCli('node', [fixture, 'stall'], {
      timeoutMs: 650,
      inactivityWarningMs: 120,
      onDiagnostic: (diagnostic) => heartbeatDiagnostics.push(diagnostic)
    }),
    (error: unknown) => {
      assert.ok(isCliTimeoutError(error))
      assert.equal(error.timeoutKind, 'total')
      return true
    }
  )
  assert.ok(
    heartbeatDiagnostics.filter((diagnostic) => diagnostic.kind === 'inactive').length >= 3,
    'a silent provider must refresh its visible heartbeat while the total request remains alive'
  )

  const registrySource = readFileSync(new URL('../src/main/providers/registry.ts', import.meta.url), 'utf8')
  assert.ok(
    (registrySource.match(/activities:\s*requestActivities/g) ?? []).length >= 2,
    'completed and failed turns must both persist normalized activity metadata'
  )
  assert.match(
    registrySource,
    /If the selected directory is empty, scaffold or create the requested project/,
    'Workspace execute mode must treat an empty directory as a scaffold target'
  )
  assert.match(
    registrySource,
    /If one command is rejected by policy,[\s\S]{0,180}workspace is read-only/,
    'a rejected Windows command must not make providers abandon a writable workspace'
  )
  assert.match(
    registrySource,
    /requestTimedOut \|\| providerTimedOut[\s\S]*?'timed_out'/,
    'provider watchdog errors must become the durable timed_out lifecycle'
  )

  console.log('verify-provider-runtime: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
