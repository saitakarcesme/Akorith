import assert from 'node:assert/strict'
import { normalizeStoredOpenCodeMessage, parseOpenCodeJson } from '../src/shared/opencode-output.ts'

const textOutput = [
  JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello ' } }),
  JSON.stringify({ type: 'text', part: { type: 'text', text: 'workspace.' } }),
  JSON.stringify({ type: 'step_finish', part: { type: 'step-finish' } })
].join('\n')

const parsedText = parseOpenCodeJson(textOutput)
assert.equal(parsedText.text, 'Hello workspace.')
assert.equal(parsedText.eventCount, 4)
assert.deepEqual(parsedText.toolErrors, [])

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

console.log('verify-opencode-output: ok')
