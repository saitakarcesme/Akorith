import assert from 'node:assert/strict'
import { LocalProvider } from '../src/main/providers/local.ts'

const requests: Array<Record<string, unknown>> = []
const originalFetch = globalThis.fetch

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  if (url.endsWith('/api/tags')) {
    return Response.json({ models: [{ name: 'test-model' }] })
  }
  if (url.endsWith('/api/chat')) {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      `${JSON.stringify({
        model: 'test-model',
        message: { content: 'ok' },
        done: true,
        prompt_eval_count: 2,
        eval_count: 1
      })}\n`,
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
    )
  }
  throw new Error(`Unexpected LocalProvider request: ${url}`)
}) as typeof fetch

async function main(): Promise<void> {
  try {
    const provider = new LocalProvider({
      enabled: true,
      baseUrl: 'http://ollama.test',
      autoStart: false,
      lanDiscovery: false
    })

    await provider.send('background research', { model: 'test-model', background: true }, () => {})
    await provider.send('visible chat', { model: 'test-model' }, () => {})

    assert.equal(requests.length, 2, 'both LocalProvider sends must reach Ollama')
    assert.equal(requests[0].keep_alive, '30m', 'background Research must keep the model resident')
    assert.equal('keep_alive' in requests[1], false, 'visible chat must preserve Ollama default residency')
    assert.equal(requests[0].stream, true, 'background residency must preserve streaming')
    assert.equal(requests[1].stream, true, 'visible chat must preserve streaming')
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log('research LocalProvider verifier passed (background residency isolated from visible chat)')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
