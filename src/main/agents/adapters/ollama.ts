import { loadConfig } from '../../config'
import type { AgentAdapter, AgentAdapterMetadata, AgentDetectionResult } from '../types'

const DEFAULT_BASE_URL = 'http://localhost:11434'

function cleanBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BASE_URL
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return DEFAULT_BASE_URL
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : DEFAULT_BASE_URL
  } catch {
    return DEFAULT_BASE_URL
  }
}

async function detectOllama(): Promise<AgentDetectionResult> {
  const checkedAt = Date.now()
  const entry = loadConfig().providers.local
  if (entry?.enabled === false) {
    return {
      id: 'ollama',
      status: 'disabled',
      message: 'Local provider is disabled in loopex.config.json.',
      checkedAt
    }
  }

  const baseUrl = cleanBaseUrl(entry?.baseUrl)
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) {
      return {
        id: 'ollama',
        status: 'error',
        message: `Ollama responded with HTTP ${response.status} at ${baseUrl}.`,
        checkedAt
      }
    }
    const body = (await response.json()) as { models?: { name?: string }[] }
    const modelCount = Array.isArray(body.models) ? body.models.length : 0
    return {
      id: 'ollama',
      status: 'available',
      message: `Ollama is reachable at ${baseUrl} with ${modelCount} model${modelCount === 1 ? '' : 's'}.`,
      checkedAt
    }
  } catch (err) {
    return {
      id: 'ollama',
      status: 'missing',
      message: `Ollama is not reachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt
    }
  }
}

const metadata: AgentAdapterMetadata = {
  id: 'ollama',
  displayName: 'Ollama / Local Models',
  kind: 'local',
  executableName: 'ollama',
  status: 'unknown',
  description: 'Local model integration used by the Local provider, router classifier, Benchmark, and autonomous execution.',
  capabilities: ['chat', 'streaming', 'file_patch', 'test_generation', 'mission_planning'],
  currentIntegrationNotes: [
    'Provider runtime lives in src/main/providers/local.ts.',
    'Connection and LAN sharing controls live in src/main/ollama-connection.ts.',
    'Local executor support validates structured workspace patch attempts before applying them.'
  ],
  safetyNotes: [
    'Detection only probes the configured local HTTP endpoint and does not auto-start Ollama.',
    'Structured file patch execution remains guarded by src/main/local-executor.ts.'
  ]
}

export const ollamaAgentAdapter: AgentAdapter = {
  metadata,
  detect: detectOllama
}
