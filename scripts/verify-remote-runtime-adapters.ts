import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  OllamaRemoteRuntimeAdapter,
  OpenAiCompatibleRemoteRuntimeAdapter,
  type AdapterGenerationChunk
} from '../src/main/remote-node/index.ts'

let assertions = 0
function equal<T>(actual: T, expected: T): void { assert.deepEqual(actual, expected); assertions += 1 }

async function collect(stream: AsyncIterable<AdapterGenerationChunk>): Promise<AdapterGenerationChunk[]> {
  const result: AdapterGenerationChunk[] = []
  for await (const value of stream) result.push(value)
  return result
}

async function main(): Promise<void> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'qwen:14b', details: { quantization_level: 'Q4_K_M' } }] }))
      return
    }
    if (request.url === '/api/chat') {
      response.write(`${JSON.stringify({ message: { content: 'hello' }, done: false })}\n`)
      response.end(`${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 4, eval_count: 2 })}\n`)
      return
    }
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'coder-fixture' }] }))
      return
    }
    if (request.url === '/v1/chat/completions') {
      response.setHeader('content-type', 'text/event-stream')
      response.write('data: {"choices":[{"delta":{"content":"open"}}]}\n\n')
      response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const signal = new AbortController().signal
    const ollama = new OllamaRemoteRuntimeAdapter(baseUrl)
    equal((await ollama.probe(signal)).available, true)
    const ollamaModels = await ollama.listModels(signal)
    equal(ollamaModels[0].id, 'qwen:14b')
    equal(ollamaModels[0].quantization, 'Q4_K_M')
    equal(ollamaModels[0].capabilities.codeEditing, 'unknown')
    const ollamaChunks = await collect(ollama.generate({
      generationId: 'fixture', modelId: 'qwen:14b', messages: [{ role: 'user', content: 'hello' }]
    }, signal))
    equal(ollamaChunks, [
      { type: 'delta', text: 'hello' },
      { type: 'usage', promptTokens: 4, completionTokens: 2 }
    ])

    const compatible = new OpenAiCompatibleRemoteRuntimeAdapter({
      id: 'fixture-openai', kind: 'lm_studio', label: 'LM Studio Fixture', baseUrl
    })
    equal((await compatible.probe(signal)).available, true)
    equal((await compatible.listModels(signal))[0].id, 'coder-fixture')
    const compatibleChunks = await collect(compatible.generate({
      generationId: 'fixture', modelId: 'coder-fixture', messages: [{ role: 'user', content: 'hello' }]
    }, signal))
    equal(compatibleChunks, [
      { type: 'delta', text: 'open' },
      { type: 'usage', promptTokens: 3, completionTokens: 1 }
    ])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  console.log(`verify-remote-runtime-adapters: ${assertions} assertions passed`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
