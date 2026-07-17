import { appendFileSync, writeFileSync } from 'fs'
import type { ParsedResearchCycle } from './prompts/cycle'
import type { ResearchPlan, ResearchPlanSection, ResearchSource } from './types'
import { RESEARCH_FINDINGS_FILE, safeResearchPath, writeResearchPlan } from './workspace'

export function appendResearchFindings(input: {
  workspaceDir: string
  section: ResearchPlanSection
  cycleIndex: number
  result: ParsedResearchCycle
  sources: ResearchSource[]
}): void {
  const lines = [
    `## ${input.section.title} · cycle ${input.cycleIndex}`,
    '',
    input.result.summary,
    ''
  ]
  if (input.result.claims.length > 0) {
    lines.push('### Claims', '')
    for (const claim of input.result.claims) {
      const urls = claim.sourceNumbers
        .map((sourceNumber) => input.sources[sourceNumber - 1]?.url)
        .filter(Boolean)
      lines.push(`- ${claim.text} (${claim.confidence.toFixed(2)}) ${urls.map((url) => `[source](${url})`).join(' ')}`)
    }
    lines.push('')
  }
  if (input.result.gaps.length > 0) {
    lines.push('### Open evidence gaps', '')
    for (const gap of input.result.gaps) lines.push(`- ${gap}`)
    lines.push('')
  }
  appendFileSync(
    safeResearchPath(input.workspaceDir, RESEARCH_FINDINGS_FILE),
    `${lines.join('\n').trim()}\n\n`,
    'utf8'
  )
}

export function resetResearchFindings(workspaceDir: string): void {
  writeFileSync(
    safeResearchPath(workspaceDir, RESEARCH_FINDINGS_FILE),
    '# Research findings\n\n',
    'utf8'
  )
}

export function setResearchPlanSectionStatus(
  workspaceDir: string,
  plan: ResearchPlan,
  sectionId: string,
  status: ResearchPlanSection['status']
): ResearchPlan {
  const next: ResearchPlan = {
    ...plan,
    sections: plan.sections.map((section) => section.id === sectionId ? { ...section, status } : section)
  }
  writeResearchPlan(workspaceDir, next)
  return next
}
