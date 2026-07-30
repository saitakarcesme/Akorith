import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatActivity } from '../src/preload/index.d'
import {
  buildWorkspaceActivityEventNarrative
} from '../src/renderer/src/workspaceActivityNarrative'
import {
  buildWorkspaceActivityFeed,
  workspaceActivityDurationMs
} from '../src/renderer/src/workspaceActivityFeed'
import { workspaceRequestTimeoutMs } from '../src/renderer/src/workspaceRequestTimeout'

(globalThis as typeof globalThis & { React: typeof React }).React = React
const WorkspaceActivity = require('../src/renderer/src/components/WorkspaceActivity').default as
  typeof import('../src/renderer/src/components/WorkspaceActivity').default
const { createElement } = React

const root = join(__dirname, '..')
let passed = 0
const failures: string[] = []

function test(name: string, run: () => void): void {
  try {
    run()
    passed += 1
    console.log(`[ok] ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`[fail] ${name}`)
    console.error(error instanceof Error ? `       ${error.message}` : `       ${String(error)}`)
  }
}

function source(relativePath: string): string {
  const path = join(root, relativePath)
  assert.equal(existsSync(path), true, `${relativePath} must exist`)
  return readFileSync(path, 'utf8')
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function sentenceCount(value: string): number {
  return (value.match(/[.!?](?:\s|$)/g) ?? []).length
}

function selectorBlocks(css: string, selectorFragment: string): string[] {
  const blocks: string[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of css.matchAll(pattern)) {
    if (match[1].includes(selectorFragment)) blocks.push(match[2])
  }
  return blocks
}

const activity = (
  kind: ChatActivity['kind'],
  label: string,
  status: NonNullable<ChatActivity['status']>,
  timestamp: number,
  detail?: string
): ChatActivity => ({ kind, label, status, timestamp, detail })

test('feed sorts events chronologically and merges matching lifecycle updates', () => {
  const feed = buildWorkspaceActivityFeed([
    activity('command', 'npm run typecheck', 'complete', 3_900, 'Typecheck passed'),
    activity('file', 'Created src/App.tsx', 'complete', 2_500, 'Detected in Git changes'),
    activity('plan', 'Plan the implementation', 'complete', 1_700, 'The implementation order is ready'),
    activity('command', 'npm run typecheck', 'running', 3_000),
    activity('plan', 'Plan the implementation', 'running', 1_000)
  ])

  assert.deepEqual(feed.map((item) => item.startedAt), [1_000, 2_500, 3_000])
  assert.deepEqual(feed.map((item) => item.phase), ['plan', 'actions', 'actions'])
  assert.equal(feed[0].activity.status, 'complete')
  assert.equal(feed[0].endedAt, 1_700)
  assert.equal(feed[2].activity.status, 'complete')
  assert.equal(feed[2].activity.detail, 'Typecheck passed')
  assert.equal(feed[2].endedAt, 3_900)
})

test('normalized labels pair a running event with its terminal update', () => {
  const events = [
    activity('command', '  npm   run TEST  ', 'running', 100),
    activity('command', 'NPM run test', 'complete', 425, '18 tests passed')
  ]
  const feed = buildWorkspaceActivityFeed(events)

  assert.equal(feed.length, 1)
  assert.equal(normalized(feed[0].activity.label), 'npm run test')
  assert.equal(feed[0].activity.status, 'complete')
  assert.equal(workspaceActivityDurationMs(feed[0], 9_999), 325)
})

test('repeated calls with the same label remain separate after completion', () => {
  const feed = buildWorkspaceActivityFeed([
    activity('command', 'npm test', 'running', 1_000),
    activity('command', 'npm test', 'complete', 1_800, 'First validation passed'),
    activity('command', 'npm test', 'running', 2_500),
    activity('command', 'npm test', 'error', 4_000, 'Regression detected')
  ])

  assert.equal(feed.length, 2)
  assert.notEqual(feed[0].id, feed[1].id)
  assert.deepEqual(feed.map((item) => item.activity.status), ['complete', 'error'])
  assert.deepEqual(feed.map((item) => workspaceActivityDurationMs(item, 8_000)), [800, 1_500])
})

test('feed ids and chronology are stable across identical derivations', () => {
  const events = [
    activity('reasoning', 'Choose a safe implementation', 'complete', 200),
    activity('file', 'Reading src/App.tsx', 'running', 300),
    activity('file', 'Reading src/App.tsx', 'complete', 450)
  ]
  const first = buildWorkspaceActivityFeed(events)
  const second = buildWorkspaceActivityFeed(events.map((item) => ({ ...item })))

  assert.deepEqual(
    first.map((item) => ({ id: item.id, phase: item.phase, startedAt: item.startedAt, endedAt: item.endedAt })),
    second.map((item) => ({ id: item.id, phase: item.phase, startedAt: item.startedAt, endedAt: item.endedAt }))
  )
  assert.ok(first.every((item, index) => index === 0 || first[index - 1].startedAt <= item.startedAt))
})

test('live event duration uses the injected clock and never becomes negative', () => {
  const [live] = buildWorkspaceActivityFeed([
    activity('tool', 'Searching for workspace components', 'running', 5_000)
  ])

  assert.equal(workspaceActivityDurationMs(live, 7_750), 2_750)
  assert.equal(workspaceActivityDurationMs(live, 4_000), 0)
})

test('plan, action, and final status events retain explicit phases', () => {
  const feed = buildWorkspaceActivityFeed([
    activity('reasoning', 'Understand the request', 'complete', 10),
    activity('file', 'Updating src/App.tsx', 'complete', 20),
    activity('status', 'Workspace task complete', 'complete', 30)
  ])

  assert.deepEqual(feed.map((item) => item.phase), ['plan', 'actions', 'result'])
})

const narrativeCases: Array<{
  name: string
  item: ChatActivity
  evidence: RegExp[]
}> = [
  {
    name: 'search',
    item: activity(
      'tool',
      'Searching for **/*.tsx',
      'running',
      1,
      'Looking for the components that render the current workspace state'
    ),
    evidence: [/search|look|component/i, /Nebula/i]
  },
  {
    name: 'file read',
    item: activity(
      'file',
      'Reading src/App.tsx',
      'complete',
      2,
      'This file owns the Workspace transcript'
    ),
    evidence: [/App\.tsx/i, /existing implementation|Workspace transcript/i, /Nebula/i]
  },
  {
    name: 'command result',
    item: activity(
      'command',
      'npm run typecheck',
      'complete',
      3,
      'Typecheck completed without errors'
    ),
    evidence: [/typecheck|without errors/i, /Nebula/i]
  },
  {
    name: 'created file',
    item: activity(
      'file',
      'Created src/Market.tsx',
      'complete',
      4,
      "Detected in this task's Git working-tree changes"
    ),
    evidence: [/Market\.tsx/i, /Nebula|working changes|review/i]
  },
  {
    name: 'recoverable error',
    item: activity(
      'warning',
      'A workspace tool was blocked',
      'error',
      5,
      'The selected CLI policy prevented this specific call'
    ),
    evidence: [/blocked|prevent|could not/i, /Nebula/i]
  }
]

for (const fixture of narrativeCases) {
  test(`narrative explains the ${fixture.name} event instead of echoing it`, () => {
    const text = buildWorkspaceActivityEventNarrative(fixture.item, 'Nebula')
    assert.ok(text.length >= 45, `expected explanatory copy, received ${text.length} characters: ${text}`)
    assert.ok(text.length <= 240, `narrative must stay compact: ${text.length} characters`)
    assert.ok(sentenceCount(text) >= 1 && sentenceCount(text) <= 2, `expected one compact explanation: ${text}`)
    for (const evidence of fixture.evidence) assert.match(text, evidence)
    assert.doesNotMatch(text, /^Akorith is using that result for the next step\.?$/i)
  })
}

test('no-output commands still explain what ran and how Akorith proceeds', () => {
  const text = buildWorkspaceActivityEventNarrative(
    activity('command', 'git status --short', 'complete', 6, '(no output)'),
    'Nebula'
  )
  assert.match(text, /Nebula/i)
  assert.match(text, /without output/i)
  assert.equal(sentenceCount(text), 1)
})

test('run duration renders stable running, completed, and stopped states', () => {
  const completed = renderToStaticMarkup(createElement(WorkspaceActivity, {
    activities: [],
    startedAt: 1_000,
    endedAt: 93_000,
    active: false,
    projectName: 'Nebula'
  }))
  const stopped = renderToStaticMarkup(createElement(WorkspaceActivity, {
    activities: [],
    startedAt: 1_000,
    endedAt: 13_000,
    active: false,
    failed: true,
    projectName: 'Nebula'
  }))
  const originalNow = Date.now
  let running = ''
  try {
    Date.now = () => 133_000
    running = renderToStaticMarkup(createElement(WorkspaceActivity, {
      activities: [],
      startedAt: 1_000,
      active: true,
      projectName: 'Nebula'
    }))
  } finally {
    Date.now = originalNow
  }

  assert.match(completed, /Worked for 1m 32s/)
  assert.match(completed, /aria-expanded="false"/)
  assert.match(stopped, /Stopped after 12s/)
  assert.match(running, /Working for 2m 12s/)
  assert.match(running, /aria-expanded="false"/)
  assert.match(running, /workspace-activity-narrative/)
})

test('streaming UI uses the named Akorithing label and no square pseudo-cursor', () => {
  const chatMessage = source('src/renderer/src/components/ChatMessageView.tsx')
  const css = [
    source('src/renderer/src/styles.css'),
    source('src/renderer/src/product-polish.css'),
    source('src/renderer/src/replica-ui.css')
  ].join('\n')

  assert.match(chatMessage, /chat-thinking/)
  assert.match(chatMessage, /chat-thinking-label/)
  assert.match(chatMessage, /Akorithing(?:…|\\u2026|\.{3})/)
  assert.doesNotMatch(
    css,
    /\.chat-msg\.assistant\.streaming\s+\.chat-msg-text::after\s*\{[^}]*\bcontent\s*:/s
  )

  const labelStyles = selectorBlocks(css, '.chat-thinking-label')
  assert.ok(labelStyles.some((block) =>
    /linear-gradient/.test(block) &&
    /background-clip\s*:\s*text/.test(block) &&
    /animation\s*:/.test(block)
  ), 'Akorithing label must keep its restrained animated color treatment')
})

test('activity source exposes a flat iconless transcript with subtle durations', () => {
  const workspaceActivity = source('src/renderer/src/components/WorkspaceActivity.tsx')
  const css = source('src/renderer/src/product-polish.css')
  for (const contract of [
    'workspace-activity-event-line',
    '<time>',
    'workspace-activity-event-detail'
  ]) {
    assert.match(workspaceActivity, new RegExp(contract))
  }
  assert.doesNotMatch(workspaceActivity, /ActivityIcon|workspace-activity-event-icon|workspace-activity-event-badge/)
  assert.doesNotMatch(workspaceActivity, /workspace-activity-phase|collapsedEvents/)
  assert.match(workspaceActivity, /aria-expanded=/)
  assert.ok(selectorBlocks(css, '.workspace-activity-event').some((block) =>
    /background\s*:\s*transparent/.test(block)
  ))
  assert.ok(selectorBlocks(css, '.workspace-activity-event-line strong').some((block) =>
    /font-size\s*:\s*14px/.test(block) &&
    /font-weight\s*:\s*600/.test(block)
  ))
  assert.ok(selectorBlocks(css, '.workspace-activity-event-detail').some((block) =>
    /padding\s*:\s*0/.test(block) &&
    /font-size\s*:\s*14px/.test(block)
  ))
})

test('workflow steps live in the workspace tools and wait for real provider actions', () => {
  const chatPanel = source('src/renderer/src/components/ChatPanel.tsx')
  const stepPanel = source('src/renderer/src/components/WorkspaceStepsPanel.tsx')
  const toolsPanel = source('src/renderer/src/components/WorkspaceToolsPanel.tsx')
  const activity = source('src/renderer/src/components/WorkspaceActivity.tsx')

  assert.doesNotMatch(chatPanel, /<WorkspaceStepDock/)
  assert.match(toolsPanel, /\{ id: 'steps', label: 'Steps'/)
  assert.match(toolsPanel, /tab\.tool === 'steps'/)
  assert.match(toolsPanel, /<WorkspaceStepsPanel/)
  assert.match(stepPanel, /Thinking before opening steps/)
  assert.match(stepPanel, /snapshot\.steps\.map/)
  assert.match(activity, /workspace-activity-narrative/)
})

test('stopped tasks expose Resume task while the composer remains writable', () => {
  const chatPanel = source('src/renderer/src/components/ChatPanel.tsx')
  const chatMessage = source('src/renderer/src/components/ChatMessageView.tsx')
  const textareaStart = chatPanel.indexOf('<textarea')
  const textareaEnd = chatPanel.indexOf('/>', textareaStart)
  const textarea = chatPanel.slice(textareaStart, textareaEnd)

  assert.ok(textareaStart >= 0 && textareaEnd > textareaStart)
  assert.doesNotMatch(textarea, /\bdisabled\s*=/)
  assert.match(`${chatPanel}\n${chatMessage}`, /Resume task/)
})

test('local Workspace keeps enough time for its bounded corrective attempt', () => {
  assert.equal(workspaceRequestTimeoutMs('local'), 22 * 60 * 1_000)
  assert.equal(workspaceRequestTimeoutMs('chatgpt'), 12 * 60 * 1_000)
  assert.equal(workspaceRequestTimeoutMs('claude'), 12 * 60 * 1_000)
  assert.equal(workspaceRequestTimeoutMs('opencode'), 12 * 60 * 1_000)
})

if (failures.length > 0) {
  console.error(`\nWorkspace activity verification failed (${failures.length}/${passed + failures.length}).`)
  process.exit(1)
}

console.log(`\nWorkspace activity verification passed (${passed} deterministic groups).`)
