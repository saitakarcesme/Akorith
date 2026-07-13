import { getRuntimeStatus } from '../ollama-connection'
import type { RuntimeStatus } from '../ollama-connection'

// Phase 47: the shared local-runtime status — a thin passthrough to the existing
// resolver so Loop/Companions/Agents all report the same source/readiness.

export type { RuntimeStatus }

export async function localRuntimeStatus(): Promise<RuntimeStatus> {
  return getRuntimeStatus()
}

/** Quick boolean: is a local model endpoint usable right now? */
export async function isLocalRuntimeReady(): Promise<boolean> {
  try {
    const status = await getRuntimeStatus()
    return status.ok && status.modelCount > 0
  } catch {
    return false
  }
}
