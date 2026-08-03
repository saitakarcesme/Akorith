import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatActivity } from '../src/preload/index.d'
import { buildWorkspaceActivityFeed } from '../src/renderer/src/workspaceActivityFeed'

(globalThis as typeof globalThis & { React: typeof React }).React = React
const WorkspaceActivity = require('../src/renderer/src/components/WorkspaceActivity').default as
  typeof import('../src/renderer/src/components/WorkspaceActivity').default

const root = join(__dirname, '..')
let passed = 0

function source(relativePath: string): string {
  const path = join(root, relativePath)
  assert.equal(existsSync(path), true, `${relativePath} must exist`)
  return readFileSync(path, 'utf8')
}

function test(name: string, run: () => void): void {
  try {
    run()
    passed += 1
    console.log(`[ok] ${name}`)
  } catch (error) {
    console.error(`[fail] ${name}`)
    throw error
  }
}

const activity = (
  id: string,
  kind: ChatActivity['kind'],
  label: string,
  status: NonNullable<ChatActivity['status']>,
  timestamp: number,
  detail?: string
): ChatActivity => ({ id, kind, label, status, timestamp, detail })

test('stable provider ids merge lifecycle updates without inventing events', () => {
  const feed = buildWorkspaceActivityFeed([
    activity('codex:cmd-1', 'command', 'npm test', 'running', 1_000),
    activity('codex:cmd-1', 'command', 'npm test', 'complete', 1_750, '18 tests passed'),
    activity('codex:file-1', 'file', 'src/App.tsx', 'complete', 2_000)
  ])
  assert.equal(feed.length, 2)
  assert.equal(feed[0].activity.status, 'complete')
  assert.equal(feed[0].activity.detail, '18 tests passed')
  assert.equal(feed[0].endedAt, 1_750)
})

test('Workspace renders exact provider commentary and the current real action', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkspaceActivity, {
    activities: [
      activity('codex:message-1', 'commentary', 'I found the state ownership bug; I am separating the scopes now.', 'complete', 1_100),
      activity('codex:cmd-1', 'command', 'npm run typecheck', 'running', 1_300, 'Validating renderer and main process types')
    ],
    startedAt: 1_000,
    active: true
  }))
  assert.match(markup, /I found the state ownership bug; I am separating the scopes now\./)
  assert.match(markup, /npm run typecheck/)
  assert.match(markup, /Validating renderer and main process types/)
  assert.doesNotMatch(markup, /Akorith is using|Akorith is reviewing|implementation path/i)
})

test('Workspace keeps boilerplate lifecycle labels out of the visible transcript', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkspaceActivity, {
    activities: [
      activity('codex:session', 'status', 'Codex session started', 'complete', 1_100),
      activity('codex:cmd-1', 'command', 'rg --files', 'complete', 1_200)
    ],
    startedAt: 1_000,
    endedAt: 2_000,
    active: false
  }))
  assert.doesNotMatch(markup, /Codex session started/)
  assert.match(markup, /Worked for 1s/)
})

test('Codex JSON events map commentary, commands, files, tools and failures', () => {
  const chatgpt = source('src/main/providers/chatgpt.ts')
  for (const contract of [
    "kind: 'commentary'",
    "itemType === 'command_execution'",
    "itemType === 'file_change'",
    "itemType === 'mcp_tool_call'",
    "type === 'turn.failed'",
    '--json',
    '--output-last-message'
  ]) assert.ok(chatgpt.includes(contract), `missing Codex event contract: ${contract}`)
  assert.match(chatgpt, /pendingAgentMessage/)
})

test('live activities are durably persisted during the turn', () => {
  const registry = source('src/main/providers/registry.ts')
  const db = source('src/main/db.ts')
  assert.match(registry, /updateChatTurnProgress\(assistantMessageId, requestActivities\)/)
  assert.match(db, /export function updateChatTurnProgress/)
  assert.match(db, /UPDATE messages SET metadata = \? WHERE id = \? AND role = \?/)
})

test('General Chat thinking decoration is not shown in Workspace', () => {
  const chatMessage = source('src/renderer/src/components/ChatMessageView.tsx')
  assert.match(chatMessage, /message\.status === 'streaming' && !isWorkspace/)
})

test('General Chat and every Workspace keep isolated model selections', () => {
  const chatPanel = source('src/renderer/src/components/ChatPanel.tsx')
  assert.match(chatPanel, /akorith\.chatSelections\.v1/)
  assert.match(chatPanel, /isWorkspace \? `workspace:\$\{activeProject\?\.id \?\? 'default'\}` : 'general'/)
  assert.match(chatPanel, /storeChatSelection\(selectionScope, providerId, model\)/)
  assert.match(chatPanel, /lastStoredModel/)
})

console.log(`\nWorkspace turn-flow verification passed (${passed} deterministic groups).`)
