import { runCli } from '../providers/util'
import type { AgentDetectionResult, AgentId, AgentStatus } from './types'

function firstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function statusFromFailure(output: string): AgentStatus {
  return /\b(auth|authenticate|login|logged in|permission|unauthorized|forbidden)\b/i.test(output)
    ? 'unauthenticated'
    : 'error'
}

export async function detectCliAgent(args: {
  id: AgentId
  executableName: string
  versionArgs?: string[]
  timeoutMs?: number
}): Promise<AgentDetectionResult> {
  const checkedAt = Date.now()
  try {
    const result = await runCli(args.executableName, args.versionArgs ?? ['--version'], {
      timeoutMs: args.timeoutMs ?? 15_000
    })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    const version = firstMeaningfulLine(output)
    if (result.code === 0) {
      return {
        id: args.id,
        status: 'available',
        version,
        message: version ?? `${args.executableName} is available.`,
        checkedAt
      }
    }
    return {
      id: args.id,
      status: statusFromFailure(output),
      version,
      message: output || `${args.executableName} exited with code ${result.code}`,
      checkedAt
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: args.id,
      status: /timed out/i.test(message) ? 'error' : 'missing',
      message: /timed out/i.test(message) ? message : `${args.executableName} was not found on PATH.`,
      checkedAt
    }
  }
}

export function staticAgentDetection(
  id: AgentId,
  status: AgentStatus,
  message: string
): AgentDetectionResult {
  return {
    id,
    status,
    message,
    checkedAt: Date.now()
  }
}
