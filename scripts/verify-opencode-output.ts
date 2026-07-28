import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeOpenCodeActivityEvent,
  normalizeStoredOpenCodeMessage,
  parseOpenCodeJson
} from '../src/shared/opencode-output.ts'

const textOutput = [
  JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello ' } }),
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'workspace.' } }),
  JSON.stringify({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      tokens: { total: 34_212, input: 154, output: 65, reasoning: 0, cache: { write: 0, read: 33_993 } }
    }
  })
].join('\n')

const parsedText = parseOpenCodeJson(textOutput)
assert.equal(parsedText.text, 'Hello workspace.')
assert.equal(parsedText.eventCount, 4)
assert.deepEqual(parsedText.toolErrors, [])
assert.deepEqual(parsedText.usage, {
  promptTokens: 154,
  completionTokens: 65,
  cacheReadTokens: 33_993,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 34_212
})

const deniedOutput = [
  JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
  JSON.stringify({
    type: 'tool_use',
    part: { type: 'tool', tool: 'read', state: { status: 'error', error: 'The user rejected permission to use this specific tool call.' } }
  }),
  JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } })
].join('\n')

const parsedDenied = parseOpenCodeJson(deniedOutput)
assert.equal(parsedDenied.text, '')
assert.equal(parsedDenied.eventCount, 3)
assert.deepEqual(parsedDenied.toolErrors, ['The user rejected permission to use this specific tool call.'])
assert.ok(!parsedDenied.text.includes('step_start'), 'event envelopes are never rendered as assistant text')
assert.equal(
  normalizeStoredOpenCodeMessage(deniedOutput),
  'OpenCode could not complete the workspace action: The user rejected permission to use this specific tool call.'
)

const plainOutput = parseOpenCodeJson('A formatted response from an older CLI.')
assert.equal(plainOutput.eventCount, 0)
assert.equal(plainOutput.text, '')

assert.deepEqual(
  normalizeOpenCodeActivityEvent({
    type: 'tool_use',
    part: {
      id: 'part-read-1',
      callID: 'call-read-1',
      type: 'tool',
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: 'C:\\Users\\example\\Project\\src\\App.tsx' },
        time: { start: 1_720_000_000_000, end: 1_720_000_000_250 }
      }
    }
  }, 'C:\\Users\\example\\Project'),
  {
    id: 'call-read-1',
    kind: 'file',
    label: 'Reading src/App.tsx',
    detail: undefined,
    status: 'complete',
    surface: 'files',
    timestamp: 1_720_000_000_250,
    startedAt: 1_720_000_000_000,
    endedAt: 1_720_000_000_250
  }
)
assert.deepEqual(
  normalizeOpenCodeActivityEvent({
    type: 'tool_use',
    part: {
      callID: 'call-command-1',
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'npm run typecheck' },
        output: 'typecheck: ok',
        time: { start: 1_720_000_001_000, end: 1_720_000_001_500 }
      }
    }
  }),
  {
    id: 'call-command-1',
    kind: 'command',
    label: 'npm run typecheck',
    detail: 'typecheck: ok',
    status: 'complete',
    surface: 'terminal',
    timestamp: 1_720_000_001_500,
    startedAt: 1_720_000_001_000,
    endedAt: 1_720_000_001_500
  }
)
assert.equal(
  normalizeOpenCodeActivityEvent({ type: 'step_start', part: { type: 'step-start' } }),
  null,
  'generic OpenCode step envelopes must not become repetitive user-facing activity'
)

const providerSource = readFileSync(join(__dirname, '..', 'src', 'main', 'providers', 'opencode.ts'), 'utf8')
const sendSource = providerSource.slice(providerSource.indexOf('async send('))
assert.match(
  sendSource,
  /runCli\('opencode',\s*args,\s*\{[\s\S]{0,600}?stdin:\s*workspacePrompt/,
  'OpenCode must receive the complete multiline prompt over stdin'
)
assert.doesNotMatch(
  sendSource,
  /args\.push\(workspacePrompt\)/,
  'OpenCode prompts must never travel through Windows shell argv'
)
assert.match(
  providerSource,
  /'Get-ChildItem -Force':\s*'allow'/,
  'OpenCode must allow the exact safe Windows hidden-file inspection command'
)
assert.doesNotMatch(
  providerSource,
  /'Get-ChildItem \*':\s*'allow'/,
  'OpenCode must not allow arbitrary Get-ChildItem argument chains'
)
assert.match(
  providerSource,
  /Do not chain commands with semicolons/,
  'OpenCode must tell the model to keep safe Windows inspection commands separate'
)
assert.match(
  sendSource,
  /\.\.\.providerRuntimeWatchdog\('opencode',\s*'OpenCode',\s*opts\.onActivity\)/,
  'OpenCode workspace sends must use the shared inactivity watchdog'
)

console.log('verify-opencode-output: ok')
