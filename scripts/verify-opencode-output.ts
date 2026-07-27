import assert from 'node:assert/strict'
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
      type: 'tool',
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: 'C:\\Users\\example\\Project\\src\\App.tsx' }
      }
    }
  }, 'C:\\Users\\example\\Project'),
  {
    kind: 'file',
    label: 'Reading src/App.tsx',
    detail: undefined,
    status: 'complete'
  }
)
assert.deepEqual(
  normalizeOpenCodeActivityEvent({
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'npm run typecheck' },
        output: 'typecheck: ok'
      }
    }
  }),
  {
    kind: 'command',
    label: 'npm run typecheck',
    detail: 'typecheck: ok',
    status: 'complete'
  }
)
assert.equal(
  normalizeOpenCodeActivityEvent({ type: 'step_start', part: { type: 'step-start' } }),
  null,
  'generic OpenCode step envelopes must not become repetitive user-facing activity'
)

console.log('verify-opencode-output: ok')
