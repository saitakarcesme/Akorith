import { posix } from 'path'
import { runInNewContext } from 'node:vm'
import type {
  AutoresearchCommand,
  AutoresearchExperimentConfig,
  AutoresearchExperimentStatus,
  AutoresearchMetricDirection,
  ResearchCycle
} from './types'

export const KARPATHY_AUTORESEARCH_REPOSITORY = 'https://github.com/karpathy/autoresearch.git'
export const KARPATHY_AUTORESEARCH_REF = '228791fb499afffb54b46200aca536f79142f117'
export const KARPATHY_AUTORESEARCH_METRIC_PATTERN = '^val_bpb:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$'
export const AUTORESEARCH_RESULTS_FILE = 'results.tsv'
export const AUTORESEARCH_PROGRAM_FILE = 'PROGRAM.md'
export const AUTORESEARCH_LOG_DIR = 'logs'

const MAX_COMMAND_LENGTH = 1_000
const MAX_METRIC_PATTERN_LENGTH = 240
const MAX_EDITABLE_PATHS = 32
const MAX_LOG_LINE_LENGTH = 2_000
const MAX_METRIC_LOG_LINES = 10_000
const METRIC_REGEX_TIMEOUT_MS = 50

export function parseAutoresearchCommand(input: string): AutoresearchCommand {
  const value = input.trim()
  if (!value || value.length > MAX_COMMAND_LENGTH || /[\0\r\n]/.test(value)) {
    throw new Error('Experiment command must be one non-empty line.')
  }

  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false
  for (const character of value) {
    if (escaping) {
      current += character
      escaping = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (escaping || quote) throw new Error('Experiment command contains an unfinished quote or escape.')
  if (current) tokens.push(current)
  if (tokens.length === 0 || tokens.length > 80) throw new Error('Experiment command is invalid.')
  const [executable, ...args] = tokens
  if (!/^[a-zA-Z0-9._+-]{1,80}$/.test(executable)) {
    throw new Error('Use an executable name from PATH; shell paths and operators are not allowed.')
  }
  if (args.some((argument) => argument.length > 500 || argument.includes('\0'))) {
    throw new Error('Experiment command contains an invalid argument.')
  }
  return { executable, args, display: renderCommand(executable, args) }
}

export function normalizeEditablePaths(input: string[]): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_EDITABLE_PATHS) {
    throw new Error('Choose between 1 and 32 editable files or directories.')
  }
  const normalized = [...new Set(input.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\0\r\n]/.test(value)) {
      throw new Error('Editable paths must be short relative paths.')
    }
    const forward = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
    const clean = posix.normalize(forward)
    if (
      !clean ||
      clean === '.' ||
      clean === '..' ||
      clean.startsWith('../') ||
      clean.startsWith('/') ||
      clean === '.git' ||
      clean.startsWith('.git/')
    ) {
      throw new Error(`Editable path is outside the experiment boundary: ${value}`)
    }
    return clean
  }))]
  if (normalized.length === 0) throw new Error('At least one editable path is required.')
  return normalized
}

export function validateMetricPattern(pattern: string): string {
  const value = pattern.trim()
  if (!value || value.length > MAX_METRIC_PATTERN_LENGTH || /[\0\r\n]/.test(value)) {
    throw new Error('Metric pattern must be one short regular expression.')
  }
  if (/\\[1-9]|\\k<|(\(\?<[=!])|(\(\?[=!])/.test(value)) {
    throw new Error('Metric pattern cannot use backreferences or lookaround.')
  }
  if (/\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)[*+{]/.test(value)) {
    throw new Error('Metric pattern contains unsafe nested repetition.')
  }
  let expression: RegExp
  try {
    expression = new RegExp(value)
  } catch {
    throw new Error('Metric pattern is not a valid regular expression.')
  }
  if (expression.exec('metric: 1.25')?.length === 1 && !value.includes('(')) {
    throw new Error('Metric pattern must contain one numeric capture group.')
  }
  return value
}

export function extractMetric(output: string, pattern: string): number | undefined {
  const safePattern = validateMetricPattern(pattern)
  const lines = output
    .replace(/\r/g, '')
    .split('\n')
    .slice(-MAX_METRIC_LOG_LINES)
    .map((line) => line.slice(0, MAX_LOG_LINE_LENGTH))
  try {
    const result = runInNewContext(
      `(() => {
        const expression = new RegExp(pattern)
        let metric
        for (const line of lines) {
          const match = expression.exec(line)
          if (!match || match.length < 2) continue
          const candidate = Number(match[1])
          if (Number.isFinite(candidate)) metric = candidate
        }
        return metric
      })()`,
      { pattern: safePattern, lines },
      { timeout: METRIC_REGEX_TIMEOUT_MS }
    ) as unknown
    return typeof result === 'number' && Number.isFinite(result) ? result : undefined
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    ) {
      throw new Error(`Metric pattern exceeded the ${METRIC_REGEX_TIMEOUT_MS} ms safety budget.`)
    }
    throw error
  }
}

export function extractPeakMemoryGb(output: string): number | undefined {
  const lines = output.replace(/\r/g, '').split('\n')
  let memory: number | undefined
  for (const line of lines) {
    const match = /^peak_vram_mb:\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line.trim())
    if (!match) continue
    const value = Number(match[1]) / 1_024
    if (Number.isFinite(value)) memory = value
  }
  return memory
}

export function metricImproved(
  candidate: number,
  best: number,
  direction: AutoresearchMetricDirection
): boolean {
  return direction === 'minimize' ? candidate < best : candidate > best
}

export function pathAllowed(path: string, editablePaths: string[]): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '')
  return editablePaths.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`))
}

export function starterExperimentConfig(): AutoresearchExperimentConfig {
  return {
    version: 1,
    target: {
      kind: 'karpathy-starter',
      repositoryUrl: KARPATHY_AUTORESEARCH_REPOSITORY,
      repositoryRef: KARPATHY_AUTORESEARCH_REF
    },
    command: parseAutoresearchCommand('uv run train.py'),
    metric: {
      name: 'val_bpb',
      pattern: KARPATHY_AUTORESEARCH_METRIC_PATTERN,
      direction: 'minimize'
    },
    editablePaths: ['train.py'],
    experimentTimeoutMs: 10 * 60_000
  }
}

export interface StoredAutoresearchResult {
  version: 1
  kind: 'baseline' | 'candidate'
  status: AutoresearchExperimentStatus
  description: string
  commit?: string
  metric?: number
  previousBest?: number
  memoryGb?: number
  durationMs: number
  changedFiles: string[]
  logFile?: string
  error?: string
}

export function parseStoredAutoresearchResult(cycle: ResearchCycle): StoredAutoresearchResult | null {
  if (!cycle.result) return null
  try {
    const value = JSON.parse(cycle.result) as Partial<StoredAutoresearchResult>
    if (
      value.version !== 1 ||
      (value.kind !== 'baseline' && value.kind !== 'candidate') ||
      (value.status !== 'keep' && value.status !== 'discard' && value.status !== 'crash') ||
      typeof value.description !== 'string' ||
      typeof value.durationMs !== 'number' ||
      !Array.isArray(value.changedFiles)
    ) return null
    return {
      version: 1,
      kind: value.kind,
      status: value.status,
      description: value.description.slice(0, 2_000),
      commit: cleanCommit(value.commit),
      metric: finiteNumber(value.metric),
      previousBest: finiteNumber(value.previousBest),
      memoryGb: finiteNumber(value.memoryGb),
      durationMs: Math.max(0, value.durationMs),
      changedFiles: value.changedFiles
        .filter((path): path is string => typeof path === 'string')
        .map((path) => path.slice(0, 500))
        .slice(0, 100),
      logFile: typeof value.logFile === 'string' ? value.logFile.slice(0, 500) : undefined,
      error: typeof value.error === 'string' ? value.error.slice(0, 20_000) : undefined
    }
  } catch {
    return null
  }
}

function renderCommand(executable: string, args: string[]): string {
  return [executable, ...args.map((argument) =>
    /^[a-zA-Z0-9_./:=+-]+$/.test(argument)
      ? argument
      : `"${argument.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  )].join(' ')
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cleanCommit(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value) ? value : undefined
}
