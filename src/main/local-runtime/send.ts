import { sendMetaPrompt } from '../providers/registry'
import type { LocalRuntimeResult, LocalRuntimeSendOptions } from './types'

// Phase 47: send a single prompt to the local model. Local-first: this always
// targets the 'local' provider, which itself resolves the best reachable Ollama
// endpoint (local → LAN → Tailscale → Controller) via ollama-connection.

const LOCAL_PROVIDER_ID = 'local'

export async function sendLocal(prompt: string, opts: LocalRuntimeSendOptions = {}): Promise<LocalRuntimeResult> {
  const full = opts.system ? `${opts.system.trim()}\n\n${prompt}` : prompt
  try {
    const res = await sendMetaPrompt(LOCAL_PROVIDER_ID, opts.model, full, opts.signal)
    return {
      ok: true,
      text: res.text,
      model: res.model,
      usage: {
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        estimated: res.usage.estimated
      }
    }
  } catch (err) {
    return {
      ok: false,
      text: '',
      model: opts.model ?? 'local',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
