import assert from 'node:assert/strict'
import type { MessageRow } from '../src/preload/index.d'
import { hydrateStoredChatMessages } from '../src/renderer/src/components/chat-history'

const row = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  metadata: MessageRow['metadata'] = null
): MessageRow => ({
  id,
  sessionId: 'session-1',
  role,
  content,
  providerId: 'claude',
  model: 'default',
  attachments: [],
  metadata,
  createdAt: 100
})

const legacy = hydrateStoredChatMessages([
  row('u1', 'user', 'first request'),
  row('u2', 'user', 'second request'),
  row('a2', 'assistant', 'second result')
], true)
assert.deepEqual(legacy.map((message) => message.id), [
  'u1',
  'legacy-recovery:u1',
  'u2',
  'a2'
])
assert.equal(legacy[1].status, 'error')
assert.equal(legacy[1].taskPrompt, 'first request')
assert.equal(legacy[3].taskPrompt, 'second request')

const trailing = hydrateStoredChatMessages([row('u3', 'user', 'unfinished')], false)
assert.deepEqual(trailing.map((message) => message.id), ['u3', 'legacy-recovery:u3'])

const interrupted = hydrateStoredChatMessages([
  row('u4', 'user', 'running request'),
  row('a4', 'assistant', 'working', {
    startedAt: 100,
    chatLifecycle: { requestId: 'request-4', state: 'running' }
  })
], true)
assert.equal(interrupted.length, 2)
assert.equal(interrupted[1].status, 'streaming')
assert.equal(interrupted[1].text, 'working')

const recoveredAfterRestart = hydrateStoredChatMessages([
  row('u4b', 'user', 'interrupted request'),
  row('a4b', 'assistant', 'stale working text', {
    startedAt: 100,
    endedAt: 200,
    chatLifecycle: { requestId: 'request-4b', state: 'interrupted' }
  })
], true)
assert.equal(recoveredAfterRestart[1].status, 'error')
assert.match(recoveredAfterRestart[1].text, /interrupted/i)

const completed = hydrateStoredChatMessages([
  row('u5', 'user', 'finished request'),
  row('a5', 'assistant', 'finished result', {
    startedAt: 100,
    endedAt: 200,
    chatLifecycle: { requestId: 'request-5', state: 'completed' }
  })
], true)
assert.equal(completed[1].status, 'done')
assert.equal(completed[1].text, 'finished result')

console.log('chat lifecycle verification passed')
