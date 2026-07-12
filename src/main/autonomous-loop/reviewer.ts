import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LoopPlannedTask, LoopReviewResult, LoopValidationResult } from './types'

const execFileAsync = promisify(execFile)
const MAX_DIFF_CHARS = 220_000
const SECRET_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', pattern: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/ },
  { label: 'generic bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/i }
]
const PLACEHOLDER_PATTERN = /\b(?:TODO|FIXME|not implemented|placeholder implementation|return null;?\s*\/\/)/i

export interface LoopDiffInspection {
  changedFiles: string[]
  deletedFiles: string[]
  addedDiff: string
  truncated: boolean
}

function normalizeFile(value: string): string {
  return value.trim().replace(/\\/g, '/')
}

export async function inspectLoopDiff(root: string): Promise<LoopDiffInspection> {
  const [names, diff] = await Promise.all([
    execFileAsync('git', ['diff', '--name-status', '--no-renames', 'HEAD'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2_000_000
    }),
    execFileAsync('git', ['diff', '--no-ext-diff', '--unified=1', '--no-color', 'HEAD'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: MAX_DIFF_CHARS * 2
    })
  ])
  const changedFiles: string[] = []
  const deletedFiles: string[] = []
  for (const line of names.stdout.split(/\r?\n/)) {
    const [status, ...pathParts] = line.split('\t')
    const path = normalizeFile(pathParts.join('\t'))
    if (!path) continue
    changedFiles.push(path)
    if (status === 'D') deletedFiles.push(path)
  }
  const addedDiff = diff.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n')
  return {
    changedFiles: [...new Set(changedFiles)].slice(0, 2_000),
    deletedFiles: [...new Set(deletedFiles)].slice(0, 2_000),
    addedDiff: addedDiff.slice(0, MAX_DIFF_CHARS),
    truncated: addedDiff.length > MAX_DIFF_CHARS
  }
}

function likelyRelevant(task: LoopPlannedTask, files: readonly string[]): boolean {
  if (files.length === 0) return false
  const areas = task.likelyAreas.map((area) => normalizeFile(area).toLowerCase())
  if (areas.some((area) => area === 'repository root')) return true
  return files.some((file) => {
    const normalized = file.toLowerCase()
    return areas.some((area) => normalized === area || normalized.startsWith(`${area.replace(/\/$/, '')}/`) || area.includes(normalized))
  })
}

export function deterministicLoopReview(input: {
  task: LoopPlannedTask
  validation: LoopValidationResult
  diff: LoopDiffInspection
}): LoopReviewResult {
  const secretFindings = SECRET_PATTERNS
    .filter((entry) => entry.pattern.test(input.diff.addedDiff))
    .map((entry) => entry.label)
  const placeholdersDetected = input.diff.addedDiff
    .split(/\r?\n/)
    .filter((line) => PLACEHOLDER_PATTERN.test(line))
    .slice(0, 30)
    .map((line) => line.slice(0, 300))
  const deletedTestsDetected = input.diff.deletedFiles.filter((file) =>
    /(?:^|\/)(?:(?:test|tests|__tests__|spec)(?:\/|$)|[^/]+\.(?:test|spec)\.[^/]+$)/i.test(file)
  )
  const generatedFilesReviewed = input.diff.changedFiles.filter((file) =>
    /(?:^|\/)(?:dist|out|build|coverage|vendor|node_modules)(?:\/|$)|\.(?:min\.js|map)$/i.test(file)
  )
  const relevantDiff = likelyRelevant(input.task, input.diff.changedFiles)
  const unrelatedFiles = relevantDiff
    ? []
    : input.diff.changedFiles.filter((file) => !input.task.likelyAreas.some((area) => file.includes(area))).slice(0, 100)
  const accepted =
    input.validation.passed &&
    input.diff.changedFiles.length > 0 &&
    relevantDiff &&
    secretFindings.length === 0 &&
    deletedTestsDetected.length === 0 &&
    placeholdersDetected.length === 0 &&
    generatedFilesReviewed.length === 0
  const missed: string[] = []
  if (!input.validation.passed) missed.push('Validation commands pass.')
  if (input.diff.changedFiles.length === 0) missed.push('The task produces a meaningful repository change.')
  if (!relevantDiff) missed.push('The diff is relevant to the planned files or areas.')
  if (secretFindings.length > 0) missed.push('No secrets are introduced.')
  if (deletedTestsDetected.length > 0) missed.push('Tests are not deleted to force a pass.')
  if (placeholdersDetected.length > 0) missed.push('No obvious placeholders remain.')
  if (generatedFilesReviewed.length > 0) missed.push('Generated output is intentional and excluded from the commit.')

  return {
    accepted,
    acceptanceCriteriaMet: accepted ? [...input.task.acceptanceCriteria] : [],
    acceptanceCriteriaMissed: missed,
    relevantDiff,
    placeholdersDetected,
    deletedTestsDetected,
    secretFindings,
    unrelatedFiles,
    generatedFilesReviewed,
    rationale: accepted
      ? 'Deterministic review found a relevant, validated diff with no secret, test-deletion, placeholder, or generated-output violations.'
      : `Deterministic review rejected the attempt: ${missed.join(' ')}`.slice(0, 4_000)
  }
}

export function buildLoopReviewerPrompt(input: {
  task: LoopPlannedTask
  validation: LoopValidationResult
  deterministic: LoopReviewResult
  diff: LoopDiffInspection
}): string {
  return `You are Akorith's repository change reviewer. Verify observable acceptance criteria; do not reveal chain-of-thought.

Deterministic safety checks are authoritative and cannot be overruled. Review relevance and task completion.
Return strict JSON:
{
  "accepted": true,
  "acceptance_criteria_met": [],
  "acceptance_criteria_missed": [],
  "relevant_diff": true,
  "placeholders_detected": [],
  "deleted_tests_detected": [],
  "secret_findings": [],
  "unrelated_files": [],
  "generated_files_reviewed": [],
  "rationale": "concise operational rationale"
}

Task:
${JSON.stringify(input.task, null, 2)}

Validation:
${JSON.stringify({ passed: input.validation.passed, commands: input.validation.commands.map((command) => ({
  command: command.command, exitCode: command.exitCode, timedOut: command.timedOut
})) }, null, 2)}

Deterministic checks:
${JSON.stringify(input.deterministic, null, 2)}

Changed files:
${JSON.stringify(input.diff.changedFiles)}

Added diff excerpt:
${input.diff.addedDiff.slice(0, 90_000)}`
}

export function mergeLoopReviews(deterministic: LoopReviewResult, reasoned: LoopReviewResult | null): LoopReviewResult {
  if (!reasoned) return deterministic
  const safetyVeto =
    !deterministic.accepted ||
    deterministic.secretFindings.length > 0 ||
    deterministic.deletedTestsDetected.length > 0 ||
    deterministic.placeholdersDetected.length > 0 ||
    deterministic.generatedFilesReviewed.length > 0
  return {
    accepted: !safetyVeto && reasoned.accepted,
    acceptanceCriteriaMet: reasoned.acceptanceCriteriaMet,
    acceptanceCriteriaMissed: [...new Set([...deterministic.acceptanceCriteriaMissed, ...reasoned.acceptanceCriteriaMissed])],
    relevantDiff: deterministic.relevantDiff && reasoned.relevantDiff,
    placeholdersDetected: [...new Set([...deterministic.placeholdersDetected, ...reasoned.placeholdersDetected])],
    deletedTestsDetected: [...new Set([...deterministic.deletedTestsDetected, ...reasoned.deletedTestsDetected])],
    secretFindings: [...new Set([...deterministic.secretFindings, ...reasoned.secretFindings])],
    unrelatedFiles: [...new Set([...deterministic.unrelatedFiles, ...reasoned.unrelatedFiles])],
    generatedFilesReviewed: [...new Set([...deterministic.generatedFilesReviewed, ...reasoned.generatedFilesReviewed])],
    rationale: `${deterministic.rationale} Reasoning review: ${reasoned.rationale}`.slice(0, 4_000)
  }
}
