import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  insertWorkspaceLoopCommand,
  parseWorkspaceLoopCommand,
  workspaceLoopHint
} from '../src/renderer/src/workspaceLoopCommand'

const root = join(__dirname, '..')
const failures: string[] = []

function check(value: unknown, label: string): void {
  if (value) {
    console.log(`[ok] ${label}`)
    return
  }
  failures.push(label)
  console.error(`[fail] ${label}`)
}

function read(relativePath: string): string {
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath} exists`)
    return ''
  }
  return readFileSync(absolutePath, 'utf8')
}

function constFunction(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`)
  if (start < 0) return ''
  const next = source.indexOf('\n  const ', start + name.length + 8)
  return source.slice(start, next < 0 ? source.length : next)
}

const direct = parseWorkspaceLoopCommand('Implement the project export flow /loop')
check(
  direct.kind === 'command' && direct.goal === 'Implement the project export flow',
  'terminal /loop suffix activates a concrete goal'
)

const caseAndWhitespace = parseWorkspaceLoopCommand('  Verify the Windows release\n   /LoOp   ')
check(
  caseAndWhitespace.kind === 'command' && caseAndWhitespace.goal === 'Verify the Windows release',
  '/loop accepts surrounding whitespace and case variations'
)

check(
  parseWorkspaceLoopCommand('/loop').kind === 'invalid' &&
    parseWorkspaceLoopCommand('   /LOOP   ').kind === 'invalid',
  'empty /loop goals are rejected'
)

check(
  parseWorkspaceLoopCommand('Explain what /loop means in this prompt.').kind === 'none' &&
    parseWorkspaceLoopCommand('Run /loop and then describe it').kind === 'none',
  'embedded /loop text remains an ordinary message'
)

check(
  parseWorkspaceLoopCommand('Explain this literal: "/loop').kind !== 'command' &&
    parseWorkspaceLoopCommand("Explain this literal: '/loop").kind !== 'command' &&
    parseWorkspaceLoopCommand('Show this unfinished fence:\n```text\n/loop').kind !== 'command' &&
    parseWorkspaceLoopCommand('Explain the inline literal `/loop').kind !== 'command' &&
    parseWorkspaceLoopCommand('> Keep this example literal /loop').kind !== 'command',
  'quoted, fenced, and blockquoted /loop text never activates autonomous work'
)

check(
  workspaceLoopHint('Finish the benchmark /lo') === 'suggest' &&
    workspaceLoopHint('Finish the benchmark /loop') === 'armed',
  'composer hint distinguishes partial and armed /loop commands'
)

check(
  insertWorkspaceLoopCommand('Finish the benchmark /lo') === 'Finish the benchmark /loop' &&
    insertWorkspaceLoopCommand('Finish the benchmark') === 'Finish the benchmark /loop',
  'suggestion insertion completes or appends the terminal command'
)

const chat = read('src/renderer/src/components/ChatPanel.tsx')
const workspaceGoals = read('src/main/project-loop/workspace-goals.ts')
const database = read('src/main/db.ts')
const registry = read('src/main/providers/registry.ts')
const runner = read('src/main/project-loop/runner.ts')
const writerLease = read('src/main/workspace-writer-lease.ts')

const sendOrQueue = constFunction(chat, 'sendOrQueue')
check(
  sendOrQueue.includes('const loopCommand = isWorkspace ? parseWorkspaceLoopCommand(draft)') &&
    sendOrQueue.includes("loopCommand.kind === 'command'"),
  '/loop dispatch is gated to the Workspace composer'
)

const startWorkspaceLoopGoal = constFunction(chat, 'startWorkspaceLoopGoal')
const ensureSession = constFunction(chat, 'ensureSession')
const attachmentGuard = startWorkspaceLoopGoal.indexOf('attachments.length')
const startCall = startWorkspaceLoopGoal.indexOf('window.api.projectLoop.startWorkspaceGoal')
const clearComposer = startWorkspaceLoopGoal.indexOf('clearComposerTurn()')
check(
  attachmentGuard >= 0 &&
    startCall > attachmentGuard &&
    clearComposer > startCall,
  '/loop rejects attachments before starting or clearing the composer'
)
check(
  startCall >= 0 && !startWorkspaceLoopGoal.includes('window.api.chat.send'),
  '/loop uses the durable Workspace goal API instead of normal chat send'
)
check(
  chat.includes('activeSessionProviderRef') &&
    ensureSession.includes('activeSessionProviderRef.current === turnProviderId') &&
    ensureSession.includes('window.api.history.create(turnProviderId'),
  'changing providers starts a matching provider-bound session before /loop dispatch'
)

const metadataFor = workspaceGoals.slice(
  workspaceGoals.indexOf('function metadataFor('),
  workspaceGoals.indexOf('function statusContent(')
)
check(
  metadataFor.includes("final: status === 'completed'") &&
    workspaceGoals.includes("final: row.state === 'completed'") &&
    workspaceGoals.includes("if (result.status === 'completed')") &&
    workspaceGoals.includes("updateBinding(loopId, 'completed'"),
  'backend marks a Workspace goal final only after completed status'
)

check(
  database.includes('CREATE TABLE IF NOT EXISTS workspace_goal_bindings') &&
    workspaceGoals.includes('INSERT INTO workspace_goal_bindings') &&
    (workspaceGoals.match(/\baddMessage\(/g) ?? []).length >= 2 &&
    workspaceGoals.includes('updateMessage('),
  'backend durably binds the goal and persists its user and assistant messages'
)

check(
  writerLease.includes('export function acquireWorkspaceWriterLease') &&
    registry.includes('workspaceWriterLease = acquireWorkspaceWriterLease') &&
    registry.includes('releaseWorkspaceWriterLease()') &&
    workspaceGoals.includes('acquireBindingLease(binding)') &&
    workspaceGoals.includes('releaseBindingLease(loopId)') &&
    workspaceGoals.includes('acquireBindingLease(row)'),
  'ordinary Workspace sends and durable /loop runs share the canonical writer lease'
)

check(
  workspaceGoals.includes("typeof input.requestId !== 'string'") &&
    workspaceGoals.includes("typeof input.providerId !== 'string'") &&
    workspaceGoals.includes("typeof input.model !== 'string'") &&
    workspaceGoals.includes('assertMatchingRequest(duplicate, input, goal, workspace.path)'),
  '/loop runtime fields and transaction-time request id duplicates are validated'
)

check(
  runner.includes('revertOnNoCommit: true') &&
    runner.includes('attempt.score.shouldCommit') &&
    runner.includes('attempt.rollbackFailed') &&
    runner.includes('The Workspace /loop host path does not initialize, stage, commit, or push.'),
  'rejected local patches require confirmed rollback and the host runner avoids git or remote writes'
)

if (failures.length > 0) {
  console.error(`\nWorkspace /loop verification failed (${failures.length} check${failures.length === 1 ? '' : 's'}).`)
  process.exit(1)
}

console.log('\nWorkspace /loop verification passed.')
