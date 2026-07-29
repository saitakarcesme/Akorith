import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeLocalExecutorAttempt,
  parseLocalExecutorAction
} from '../src/main/local-executor.ts'
import {
  isAllowedLocalExecutorCommand,
  rollbackLocalExecutorPatch,
  sourceValidationCommands,
  validateLocalExecutorAction
} from '../src/main/local-executor-quality.ts'
import { commitPhase } from '../src/main/workspace.ts'

let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}

function jsonAction(input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'workspace_patch', summary: 'Add useful code', rationale: 'Improve the project safely.', ...input })
}

function materializeRawJsonControls(json: string): string {
  let output = json
  for (let code = 0; code <= 0x1f; code += 1) {
    const char = String.fromCharCode(code)
    const escaped = JSON.stringify(char).slice(1, -1)
    output = output.split(escaped).join(char)
  }
  return output
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'akorith-local-executor-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')
  await writeFile(join(dir, 'scripts', 'pass.js'), 'process.exit(0)\n', 'utf8')
  await writeFile(join(dir, 'scripts', 'fail.js'), 'process.exit(2)\n', 'utf8')
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'akorith@example.local'])
  git(dir, ['config', 'user.name', 'Akorith Test'])
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'Phase 0: scaffold project'])
  return dir
}

async function main(): Promise<void> {
  const everyRawControl = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('')
  const multilineFiles = [
    {
      path: 'index.html',
      operation: 'create',
      content: '<main>\n\t<h1>Local Frontline</h1>\n</main>'
    },
    {
      path: 'game.js',
      operation: 'create',
      content: `const state = {\n\tready: true\n};\n// raw controls:${everyRawControl}`
    }
  ]
  const strictMultilineJson = jsonAction({ files: multilineFiles, commands: [] })
  const repairedMultiline = parseLocalExecutorAction(
    materializeRawJsonControls(strictMultilineJson)
  )
  assert.equal(repairedMultiline.ok, true, 'raw controls inside JSON strings are repaired')
  assert.deepEqual(
    repairedMultiline.ok
      ? repairedMultiline.action.files.map((file) => ({
          path: file.path,
          operation: file.operation,
          content: file.content
        }))
      : [],
    multilineFiles,
    'multiline HTML/JS and every U+0000..U+001F character survive the scoped repair'
  )

  const strictEscapes = parseLocalExecutorAction(strictMultilineJson)
  assert.equal(strictEscapes.ok, true, 'strict JSON with valid escapes remains accepted')
  assert.equal(
    strictEscapes.ok ? strictEscapes.action.files[1]?.content : '',
    multilineFiles[1]?.content,
    'valid JSON escapes are not double-escaped'
  )

  const minimalJson = jsonAction({
    files: [{ path: 'safe.txt', operation: 'create', content: 'safe' }]
  })
  const malformedInputs = [
    minimalJson.slice(0, -2),
    minimalJson.replace(',"files":', '"files":'),
    minimalJson.replace(',"summary":', `\u0000"summary":`),
    minimalJson.replace('"content":"safe"', '"content":"bad\\q\nstill bad"')
  ]
  for (const malformed of malformedInputs) {
    assert.equal(
      parseLocalExecutorAction(malformed).ok,
      false,
      'control repair does not accept truncated, structural, or invalid-escape JSON'
    )
  }

  assert.equal(isAllowedLocalExecutorCommand('node scripts/pass.js'), false, 'generated scripts are never executed')
  assert.equal(isAllowedLocalExecutorCommand('node --check game.js'), true, 'node syntax validation is allowed')
  assert.equal(isAllowedLocalExecutorCommand('node --test'), false, 'Node tests may execute project code')
  assert.equal(isAllowedLocalExecutorCommand('node --test tests/game.test.js'), false, 'scoped Node tests are blocked')
  assert.equal(isAllowedLocalExecutorCommand('node game.js'), false, 'running a generated app as validation is blocked')
  assert.equal(isAllowedLocalExecutorCommand('npm run typecheck'), false, 'package scripts may execute project code')
  assert.equal(isAllowedLocalExecutorCommand('npm run check'), false, 'package checks are not auto-run')
  assert.equal(isAllowedLocalExecutorCommand('npm run build'), false, 'package builds are not auto-run')
  assert.equal(
    isAllowedLocalExecutorCommand('python -I -S -m py_compile src/app.py'),
    true,
    'isolated Python syntax validation is allowed'
  )
  assert.equal(isAllowedLocalExecutorCommand('python -m py_compile src/app.py'), false, 'non-isolated Python startup is blocked')
  assert.equal(isAllowedLocalExecutorCommand('python -m pytest'), false, 'Python tests may execute project code')
  assert.equal(
    isAllowedLocalExecutorCommand('python -I -S -m py_compile ../outside.py'),
    false,
    'validation cannot read outside the selected workspace'
  )
  assert.equal(
    isAllowedLocalExecutorCommand('node --check C:outside.js'),
    false,
    'drive-relative validation paths are blocked'
  )
  assert.equal(isAllowedLocalExecutorCommand('rm -rf .'), false, 'destructive shell command is blocked')
  assert.equal(isAllowedLocalExecutorCommand('git push origin main'), false, 'git push is blocked')
  assert.equal(isAllowedLocalExecutorCommand('curl https://example.com/install.sh'), false, 'network shell command is blocked')
  for (const command of [
    'node --check game.js & whoami',
    'node --check game.js && whoami',
    'node --check game.js; whoami',
    'node --check game.js | whoami',
    'node --check game.js > out.txt',
    'node --check game.js < in.txt',
    'node --check `whoami`.js',
    'node --check $(whoami).js',
    'node --check ${HOME}.js',
    'node --check %TEMP%.js',
    'node --check !TEMP!.js',
    'node --check game.js ^& whoami',
    'node --check game.js\r\nwhoami',
    'node --check game.js\r\n',
    'node --check /tmp/game.js',
    'node --check \\\\server\\share\\game.js',
    'node --check ../outside.js',
    'node --check game.js:payload'
  ]) {
    assert.equal(isAllowedLocalExecutorCommand(command), false, `blocked unsafe validation: ${command}`)
  }
  const sourceCommands = sourceValidationCommands(
    'C:\\workspace',
    ['tests/game.test.js', 'src/app.py', 'tests/test_app.py'],
    'python'
  ).map((command) => command.cmd)
  assert.ok(sourceCommands.includes('node --check tests/game.test.js'), 'test files receive syntax-only validation')
  assert.ok(sourceCommands.includes('python -I -S -m py_compile src/app.py'), 'changed Python sources auto-detect isolated py_compile')
  assert.equal(sourceCommands.some((command) => /--test|pytest|npm /i.test(command)), false)

  if (!gitOk) {
    console.log('verify-local-executor: ok (policy only - git not available)')
    return
  }

  const dirs: string[] = []
  try {
    const traversalRepo = await makeRepo()
    dirs.push(traversalRepo)
    const traversal = parseLocalExecutorAction(jsonAction({
      files: [{ path: '../outside.txt', operation: 'create', content: 'bad' }],
      commands: [{ cmd: 'node scripts/pass.js' }]
    }))
    assert.equal(traversal.ok, true)
    const traversalValidation = validateLocalExecutorAction(traversalRepo, traversal.ok ? traversal.action : neverAction())
    assert.equal(traversalValidation.ok, false, 'path traversal is blocked')

    const absoluteRepo = await makeRepo()
    dirs.push(absoluteRepo)
    const absolute = parseLocalExecutorAction(jsonAction({
      files: [{ path: join(absoluteRepo, 'evil.txt'), operation: 'create', content: 'bad' }],
      commands: [{ cmd: 'node scripts/pass.js' }]
    }))
    assert.equal(absolute.ok, true)
    const absoluteValidation = validateLocalExecutorAction(absoluteRepo, absolute.ok ? absolute.action : neverAction())
    assert.equal(absoluteValidation.ok, false, 'absolute paths are blocked')

    const protectedRepo = await makeRepo()
    dirs.push(protectedRepo)
    for (const unsafePath of [
      '.GIT/config',
      'NODE_MODULES/evil.js',
      'DIST/output.js',
      'safe.js:payload',
      'C:drive-relative.js',
      'credentials.ts',
      'secrets/config.ts',
      'service-account-prod.js'
    ]) {
      const parsed = parseLocalExecutorAction(jsonAction({
        files: [{ path: unsafePath, operation: 'create', content: 'bad' }]
      }))
      assert.equal(parsed.ok, true)
      const result = validateLocalExecutorAction(
        protectedRepo,
        parsed.ok ? parsed.action : neverAction()
      )
      assert.equal(result.ok, false, `${unsafePath} is blocked`)
    }
    if (process.platform === 'win32') {
      for (const unsafePath of ['.git./config', 'dist /output.js']) {
        const parsed = parseLocalExecutorAction(jsonAction({
          files: [{ path: unsafePath, operation: 'create', content: 'bad' }]
        }))
        assert.equal(parsed.ok, true)
        assert.equal(
          validateLocalExecutorAction(
            protectedRepo,
            parsed.ok ? parsed.action : neverAction()
          ).ok,
          false,
          `${unsafePath} cannot use a Windows path alias`
        )
      }
      const duplicateCase = parseLocalExecutorAction(jsonAction({
        files: [
          { path: 'src/Case.js', operation: 'create', content: 'export const one = 1\n' },
          { path: 'SRC/case.js', operation: 'create', content: 'export const two = 2\n' }
        ]
      }))
      assert.equal(duplicateCase.ok, true)
      assert.equal(
        validateLocalExecutorAction(
          protectedRepo,
          duplicateCase.ok ? duplicateCase.action : neverAction()
        ).ok,
        false,
        'case-colliding duplicate file actions are blocked on Windows'
      )
    }

    const junctionRepo = await makeRepo()
    const junctionOutside = await mkdtemp(join(tmpdir(), 'akorith-local-executor-outside-'))
    dirs.push(junctionRepo, junctionOutside)
    await writeFile(join(junctionOutside, 'canary.txt'), 'outside remains unchanged\n', 'utf8')
    await symlink(
      junctionOutside,
      join(junctionRepo, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const junctionAction = parseLocalExecutorAction(jsonAction({
      files: [{ path: 'linked/escape.txt', operation: 'create', content: 'escaped' }]
    }))
    assert.equal(junctionAction.ok, true)
    assert.equal(
      validateLocalExecutorAction(
        junctionRepo,
        junctionAction.ok ? junctionAction.action : neverAction()
      ).ok,
      false,
      'junction/symlink parents cannot escape the workspace'
    )
    assert.equal(existsSync(join(junctionOutside, 'escape.txt')), false)
    assert.equal(
      readFileSync(join(junctionOutside, 'canary.txt'), 'utf8'),
      'outside remains unchanged\n'
    )
    const danglingTarget = join(junctionOutside, 'missing-target')
    await symlink(
      danglingTarget,
      join(junctionRepo, 'dangling'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const danglingAction = parseLocalExecutorAction(jsonAction({
      files: [{ path: 'dangling/escape.txt', operation: 'create', content: 'escaped' }]
    }))
    assert.equal(danglingAction.ok, true)
    assert.equal(
      validateLocalExecutorAction(
        junctionRepo,
        danglingAction.ok ? danglingAction.action : neverAction()
      ).ok,
      false,
      'dangling junction/symlink targets are rejected before a write'
    )
    assert.equal(existsSync(join(danglingTarget, 'escape.txt')), false)

    const commitRepo = await makeRepo()
    dirs.push(commitRepo)
    await writeFile(join(commitRepo, 'user.txt'), 'user dirty work\n', 'utf8')
    const valid = await executeLocalExecutorAttempt({
      workspaceDir: commitRepo,
      goal: 'Add a useful TypeScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'src/app.ts', operation: 'modify', content: 'export const value = 2\nexport const doubled = value * 2\n' }],
        commands: [{ cmd: 'node scripts/pass.js', reason: 'smoke validation' }],
        expected_outcome: 'helper exists and validation passes'
      }),
      revertOnNoCommit: false
    })
    assert.equal(valid.score.shouldCommit, true, 'valid patch with passing validation can commit')
    const committed = await commitPhase(commitRepo, 'local executor helper', valid.changedFiles)
    assert.equal(committed.committed, true, 'valid local attempt commits')
    assert.match(committed.message ?? '', /^Phase 1: /)
    const committedFiles = git(commitRepo, ['show', '--name-only', '--pretty=', 'HEAD'])
    assert.match(committedFiles, /src\/app\.ts|src\\app\.ts/, 'local commit includes touched file')
    assert.doesNotMatch(committedFiles, /user\.txt/, 'local commit does not sweep unrelated dirty files')
    assert.match(git(commitRepo, ['status', '--porcelain', '--', 'user.txt']), /user\.txt/, 'unrelated dirty file remains uncommitted')

    const failedRepo = await makeRepo()
    dirs.push(failedRepo)
    const failedHead = git(failedRepo, ['rev-parse', 'HEAD'])
    const failed = await executeLocalExecutorAttempt({
      workspaceDir: failedRepo,
      goal: 'Repair a JavaScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'scripts/fail.js', operation: 'modify', content: 'const broken = ;\n' }],
        commands: []
      }),
      revertOnNoCommit: false
    })
    assert.equal(failed.score.shouldCommit, false, 'failed validation must not commit')
    if (!failed.score.shouldCommit) {
      const rollback = rollbackLocalExecutorPatch(failed.rollback)
      assert.equal(rollback.ok, true, 'manual rollback reports successful restoration')
    }
    assert.equal(git(failedRepo, ['rev-parse', 'HEAD']), failedHead, 'failed validation leaves git HEAD unchanged')
    assert.equal(
      readFileSync(join(failedRepo, 'scripts', 'fail.js'), 'utf8'),
      'process.exit(2)\n',
      'failed syntax validation is rolled back'
    )

    const automaticRollbackRepo = await makeRepo()
    dirs.push(automaticRollbackRepo)
    await writeFile(join(automaticRollbackRepo, 'user.txt'), 'pre-existing user work\n', 'utf8')
    const automaticRollback = await executeLocalExecutorAttempt({
      workspaceDir: automaticRollbackRepo,
      goal: 'Repair a JavaScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'scripts/fail.js', operation: 'modify', content: 'const broken = ;\n' }],
        commands: []
      }),
      revertOnNoCommit: true
    })
    assert.equal(automaticRollback.score.shouldCommit, false)
    assert.equal(automaticRollback.rolledBack, true, 'automatic rollback is confirmed before reporting success')
    assert.equal(automaticRollback.rollbackFailed, false)
    assert.equal(
      readFileSync(join(automaticRollbackRepo, 'scripts', 'fail.js'), 'utf8'),
      'process.exit(2)\n',
      'automatic rollback restores the exact pre-cycle file'
    )
    assert.equal(
      readFileSync(join(automaticRollbackRepo, 'user.txt'), 'utf8'),
      'pre-existing user work\n',
      'automatic rollback preserves unrelated dirty work'
    )

    const documentRepo = await makeRepo()
    dirs.push(documentRepo)
    const documentAttempt = await executeLocalExecutorAttempt({
      workspaceDir: documentRepo,
      goal: 'Write concise project documentation in notes.md.',
      rawOutput: jsonAction({
        files: [{
          path: 'notes.md',
          operation: 'create',
          content: '# Project notes\n\nThis workspace uses a deterministic local executor.\n'
        }],
        commands: []
      })
    })
    assert.equal(
      documentAttempt.score.shouldCommit,
      true,
      'a valid non-code artifact can pass when no deterministic command applies'
    )

    const packageValidationRepo = await makeRepo()
    dirs.push(packageValidationRepo)
    await writeFile(
      join(packageValidationRepo, 'package.json'),
      JSON.stringify({
        name: 'auto-validation-fixture',
        scripts: {
          check: 'node -e "require(\'fs\').writeFileSync(\'package-script-ran.txt\',\'bad\')"',
          build: 'node -e "require(\'fs\').writeFileSync(\'package-build-ran.txt\',\'bad\')"'
        }
      }),
      'utf8'
    )
    const packageValidation = await executeLocalExecutorAttempt({
      workspaceDir: packageValidationRepo,
      goal: 'Add a useful TypeScript release helper.',
      rawOutput: jsonAction({
        files: [{
          path: 'src/app.ts',
          operation: 'modify',
          content:
            'export const value = 2\n' +
            'export function describeRelease(version: string): string {\n' +
            '  return `Akorith ${version} is ready for validation.`\n' +
            '}\n'
        }],
        commands: []
      })
    })
    assert.equal(
      packageValidation.commandResults.some((result) => /^(?:npm|pnpm|yarn)\b/i.test(result.cmd)),
      false,
      'package scripts are never selected automatically'
    )
    assert.equal(existsSync(join(packageValidationRepo, 'package-script-ran.txt')), false)
    assert.equal(existsSync(join(packageValidationRepo, 'package-build-ran.txt')), false)
    assert.equal(packageValidation.score.shouldCommit, true)

    const syntaxOnlyRepo = await makeRepo()
    dirs.push(syntaxOnlyRepo)
    const nodeMarker = join(syntaxOnlyRepo, 'node-top-level-ran.txt')
    const pythonMarker = join(syntaxOnlyRepo, 'python-top-level-ran.txt')
    const nodeShimMarker = join(syntaxOnlyRepo, 'fake-node-shim-ran.txt')
    const pythonShimMarker = join(syntaxOnlyRepo, 'fake-python-shim-ran.txt')
    const npmShimMarker = join(syntaxOnlyRepo, 'fake-npm-shim-ran.txt')
    if (process.platform === 'win32') {
      await writeFile(join(syntaxOnlyRepo, 'node.cmd'), `@echo bad>"${nodeShimMarker}"\r\n`, 'utf8')
      await writeFile(join(syntaxOnlyRepo, 'python.cmd'), `@echo bad>"${pythonShimMarker}"\r\n`, 'utf8')
      await writeFile(join(syntaxOnlyRepo, 'npm.cmd'), `@echo bad>"${npmShimMarker}"\r\n`, 'utf8')
    }
    const priorPath = process.env.PATH
    process.env.PATH = `${syntaxOnlyRepo}${process.platform === 'win32' ? ';' : ':'}${priorPath ?? ''}`
    try {
      const syntaxOnly = await executeLocalExecutorAttempt({
        workspaceDir: syntaxOnlyRepo,
        goal: 'Add syntax-valid JavaScript and Python modules without executing them.',
        rawOutput: jsonAction({
          files: [
            {
              path: 'safe.js',
              operation: 'create',
              content:
                `import { writeFileSync } from 'node:fs'\n` +
                `writeFileSync(${JSON.stringify(nodeMarker)}, 'top level must not run')\n`
            },
            {
              path: 'safe.py',
              operation: 'create',
              content:
                'from pathlib import Path\n' +
                `Path(${JSON.stringify(pythonMarker.replace(/\\/g, '/'))}).write_text('top level must not run')\n`
            }
          ],
          commands: [
            { cmd: 'npm run test', reason: 'must be ignored' },
            { cmd: 'node safe.js', reason: 'must be ignored' }
          ]
        })
      })
      assert.equal(
        syntaxOnly.commandResults.some(
          (result) => result.cmd === 'node --check safe.js' && result.allowed && result.passed
        ),
        true,
        'trusted Node performs syntax parsing only'
      )
      const pythonResult = syntaxOnly.commandResults.find((result) =>
        / -I -S -m py_compile safe\.py$/.test(result.cmd)
      )
      if (pythonResult) {
        assert.equal(pythonResult.allowed && pythonResult.passed, true)
      }
      assert.equal(syntaxOnly.score.shouldCommit, true)
    } finally {
      process.env.PATH = priorPath
    }
    for (const marker of [
      nodeMarker,
      pythonMarker,
      nodeShimMarker,
      pythonShimMarker,
      npmShimMarker
    ]) {
      assert.equal(existsSync(marker), false, `${marker} was never executed`)
    }
    assert.equal(
      existsSync(join(syntaxOnlyRepo, '__pycache__')),
      false,
      'Python bytecode is redirected outside the workspace'
    )

    const ignoredBlockedExtraRepo = await makeRepo()
    dirs.push(ignoredBlockedExtraRepo)
    const ignoredBlockedExtra = await executeLocalExecutorAttempt({
      workspaceDir: ignoredBlockedExtraRepo,
      goal: 'Add a useful JavaScript helper.',
      rawOutput: jsonAction({
        files: [{
          path: 'helper.js',
          operation: 'create',
          content: 'export const doubled = (value) => value * 2\n'
        }],
        commands: [{ cmd: 'node helper.js', reason: 'Model suggested executing the artifact' }]
      })
    })
    assert.equal(
      ignoredBlockedExtra.commandResults.some((result) => !result.allowed),
      false,
      'model-suggested executable commands never enter the host validation queue'
    )
    assert.equal(
      ignoredBlockedExtra.commandResults.some(
        (result) => result.allowed && result.passed && result.cmd === 'node --check helper.js'
      ),
      true,
      'the auto-detected safe syntax check still runs'
    )
    assert.equal(
      ignoredBlockedExtra.score.shouldCommit,
      true,
      'a blocked extra suggestion does not discard a patch verified by a safe command'
    )

    const onlyBlockedValidationRepo = await makeRepo()
    dirs.push(onlyBlockedValidationRepo)
    const onlyBlockedValidation = await executeLocalExecutorAttempt({
      workspaceDir: onlyBlockedValidationRepo,
      goal: 'Write concise project documentation in blocked-notes.md.',
      rawOutput: jsonAction({
        files: [{
          path: 'blocked-notes.md',
          operation: 'create',
          content: '# Notes\n\nThis change has no applicable deterministic validator.\n'
        }],
        commands: [{ cmd: 'node blocked-notes.md', reason: 'Invalid model suggestion' }]
      })
    })
    assert.equal(
      onlyBlockedValidation.score.shouldCommit,
      true,
      'model command text is ignored when no deterministic syntax check applies'
    )
    assert.equal(
      onlyBlockedValidation.rolledBack,
      false,
      'a structurally valid non-code patch is retained'
    )
    assert.equal(existsSync(join(onlyBlockedValidationRepo, 'blocked-notes.md')), true)

    const blockedFloodRepo = await makeRepo()
    dirs.push(blockedFloodRepo)
    const blockedFlood = await executeLocalExecutorAttempt({
      workspaceDir: blockedFloodRepo,
      goal: 'Add a useful JavaScript helper despite noisy model validation suggestions.',
      rawOutput: jsonAction({
        files: [{
          path: 'flood-helper.js',
          operation: 'create',
          content: 'export const triple = (value) => value * 3\n'
        }],
        commands: Array.from({ length: 7 }, (_, index) => ({
          cmd: `node blocked-${index}.js`,
          reason: 'Blocked noisy suggestion'
        }))
      })
    })
    assert.equal(
      blockedFlood.commandResults.some(
        (result) =>
          result.allowed &&
          result.passed &&
          result.cmd === 'node --check flood-helper.js'
      ),
      true,
      'auto-detected validation is not crowded out by blocked model suggestions'
    )
    assert.equal(blockedFlood.score.shouldCommit, true)

    const realFailureWithBlockedExtraRepo = await makeRepo()
    dirs.push(realFailureWithBlockedExtraRepo)
    const realFailureWithBlockedExtra = await executeLocalExecutorAttempt({
      workspaceDir: realFailureWithBlockedExtraRepo,
      goal: 'Add a JavaScript helper and verify the project.',
      rawOutput: jsonAction({
        files: [{
          path: 'failure-helper.js',
          operation: 'create',
          content: 'const broken = ;\n'
        }],
        commands: [
          { cmd: 'node failure-helper.js', reason: 'Blocked extra suggestion' },
          { cmd: 'node scripts/fail.js', reason: 'Intentional allowed validation failure' }
        ]
      })
    })
    assert.equal(
      realFailureWithBlockedExtra.commandResults.some(
        (result) => result.allowed && !result.passed
      ),
      true,
      'a real allowlisted validation failure remains visible'
    )
    assert.equal(
      realFailureWithBlockedExtra.score.shouldCommit,
      false,
      'ignoring a blocked extra suggestion never masks a real validation failure'
    )

    const deleteRepo = await makeRepo()
    dirs.push(deleteRepo)
    const deleteAttempt = await executeLocalExecutorAttempt({
      workspaceDir: deleteRepo,
      goal: 'Remove the obsolete JavaScript validation script.',
      rawOutput: jsonAction({
        files: [{ path: 'scripts/pass.js', operation: 'delete' }],
        commands: []
      }),
      revertOnNoCommit: false
    })
    assert.equal(
      deleteAttempt.score.shouldCommit,
      true,
      'deleting JavaScript does not schedule node --check for the removed path'
    )
    assert.equal(existsSync(join(deleteRepo, 'scripts', 'pass.js')), false)

    const rollbackFailureRepo = await makeRepo()
    dirs.push(rollbackFailureRepo)
    const blockedRollbackPath = join(rollbackFailureRepo, 'rollback-target')
    await mkdir(blockedRollbackPath)
    const rollbackFailure = rollbackLocalExecutorPatch([
      { absolutePath: blockedRollbackPath, existed: true, content: 'cannot replace a directory with file content' }
    ])
    assert.equal(rollbackFailure.ok, false, 'rollback write failures are surfaced instead of reported as restored')
    assert.ok(rollbackFailure.errors.length > 0)

    const noopRepo = await makeRepo()
    dirs.push(noopRepo)
    const noopHead = git(noopRepo, ['rev-parse', 'HEAD'])
    const noop = await executeLocalExecutorAttempt({
      workspaceDir: noopRepo,
      goal: 'Add a useful TypeScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'src/app.ts', operation: 'modify', content: 'export const value = 1\n' }],
        commands: [{ cmd: 'node scripts/pass.js' }]
      }),
      revertOnNoCommit: false
    })
    assert.equal(noop.changedFiles.length, 0, 'no-op patch has no changed files')
    assert.equal(noop.score.shouldCommit, false, 'no-op patch must not commit')
    assert.equal(git(noopRepo, ['rev-parse', 'HEAD']), noopHead, 'no-op leaves git HEAD unchanged')
  } finally {
    await Promise.all(dirs.filter((dir) => existsSync(dir)).map((dir) => rm(dir, { recursive: true, force: true })))
  }
  console.log('verify-local-executor: ok')
}

function neverAction(): never {
  throw new Error('unreachable')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
