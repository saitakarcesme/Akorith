import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs'
import { basename, join, relative, resolve, sep } from 'path'
import type { ResearchPlan, ResearchWorkspaceState } from './types'

export const RESEARCH_PLAN_FILE = 'PLAN.json'
export const RESEARCH_FINDINGS_FILE = 'FINDINGS.md'
export const RESEARCH_SOURCES_FILE = 'SOURCES.json'
export const RESEARCH_REPORT_FILE = 'REPORT.md'
export const RESEARCH_STATE_FILE = 'RESEARCH_STATE.json'

export function researchRoot(): string {
  return join(app.getPath('userData'), 'research')
}

export function researchWorkspaceDir(jobId: string): string {
  if (!/^[\w-]{1,64}$/.test(jobId)) throw new Error('invalid research job id')
  return join(researchRoot(), jobId)
}

export function initializeResearchWorkspace(jobId: string): string {
  const workspaceDir = researchWorkspaceDir(jobId)
  mkdirSync(join(workspaceDir, 'artifacts'), { recursive: true })
  mkdirSync(join(workspaceDir, 'sources'), { recursive: true })
  const state: ResearchWorkspaceState = {
    version: 1,
    jobId,
    cycleCount: 0,
    currentPhase: 'understand',
    completedSections: [],
    openQuestions: [],
    sourceCount: 0,
    findingCount: 0,
    readyToSynthesize: false,
    updatedAt: Date.now()
  }
  if (!existsSync(join(workspaceDir, RESEARCH_STATE_FILE))) {
    writeJsonAtomic(join(workspaceDir, RESEARCH_STATE_FILE), state)
  }
  if (!existsSync(join(workspaceDir, RESEARCH_SOURCES_FILE))) {
    writeJsonAtomic(join(workspaceDir, RESEARCH_SOURCES_FILE), [])
  }
  if (!existsSync(join(workspaceDir, RESEARCH_FINDINGS_FILE))) {
    writeFileSync(join(workspaceDir, RESEARCH_FINDINGS_FILE), '# Research findings\n\n', 'utf8')
  }
  if (!existsSync(join(workspaceDir, RESEARCH_REPORT_FILE))) {
    writeFileSync(join(workspaceDir, RESEARCH_REPORT_FILE), '# Research report\n\n', 'utf8')
  }
  return workspaceDir
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.partial`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

export function readResearchState(workspaceDir: string): ResearchWorkspaceState | null {
  return readJson<ResearchWorkspaceState>(safeResearchPath(workspaceDir, RESEARCH_STATE_FILE))
}

export function writeResearchState(workspaceDir: string, state: ResearchWorkspaceState): void {
  writeJsonAtomic(safeResearchPath(workspaceDir, RESEARCH_STATE_FILE), state)
}

export function readResearchPlan(workspaceDir: string): ResearchPlan | null {
  return readJson<ResearchPlan>(safeResearchPath(workspaceDir, RESEARCH_PLAN_FILE))
}

export function writeResearchPlan(workspaceDir: string, plan: ResearchPlan): void {
  writeJsonAtomic(safeResearchPath(workspaceDir, RESEARCH_PLAN_FILE), plan)
}

export function readResearchMarkdown(workspaceDir: string, fileName: string): string {
  const path = safeResearchPath(workspaceDir, fileName)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function safeResearchPath(workspaceDir: string, ...parts: string[]): string {
  const root = resolve(workspaceDir)
  const candidate = resolve(root, ...parts)
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || rel === '..') {
    throw new Error('research path escapes its managed workspace')
  }
  return candidate
}

export function artifactFileName(title: string, extension: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'research-report'
  const ext = extension.replace(/^\./, '').toLowerCase()
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('invalid artifact extension')
  return `${slug}.${ext}`
}

export function isManagedResearchPath(workspaceDir: string, path: string): boolean {
  try {
    return safeResearchPath(workspaceDir, relative(workspaceDir, resolve(path))) === resolve(path)
  } catch {
    return false
  }
}

export function researchArtifactPath(workspaceDir: string, title: string, extension: string): string {
  return safeResearchPath(workspaceDir, 'artifacts', artifactFileName(title, extension))
}

export function researchArtifactLabel(path: string): string {
  return basename(path)
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
