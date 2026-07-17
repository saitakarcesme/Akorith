import type { ResearchClaim, ResearchJob, ResearchPlan, ResearchSource } from '../types'

export function buildResearchSynthesisPrompt(input: {
  job: ResearchJob
  plan: ResearchPlan
  findings: string
  claims: ResearchClaim[]
  sources: ResearchSource[]
}): string {
  const sourceLedger = input.sources.map((source, index) =>
    `[${index + 1}] ${source.title} · ${source.publisher ?? new URL(source.url).hostname} · ${source.url}`
  ).join('\n')
  const claimLedger = input.claims.map((claim) => {
    const sourceNumbers = claim.evidence.map((evidence) => {
      const index = input.sources.findIndex((source) => source.id === evidence.sourceId)
      return index >= 0 ? index + 1 : null
    }).filter((value): value is number => value !== null)
    return `- ${claim.status.toUpperCase()} (${claim.confidenceScore.toFixed(2)}): ${claim.text} [${sourceNumbers.join(', ')}]`
  }).join('\n')
  return `You are Akorith Research's final evidence editor. Write a polished, self-contained research report in Markdown. Do not ask questions. Use only the supplied findings, claims, and numbered source ledger. Never invent evidence, quotations, statistics, people, dates, social posts, or URLs.

Research request:
${input.job.prompt}

Plan title: ${input.plan.title}
Thesis: ${input.plan.thesis}
Definition of done: ${input.plan.deliverable}

Verified claim ledger:
${claimLedger || 'No claims passed evidence extraction. State that limitation clearly.'}

Cycle findings:
${input.findings.slice(-100_000)}

Numbered source ledger:
${sourceLedger}

Requirements:
- Start with one H1 title.
- Include an Executive summary.
- Follow the planned section order where evidence permits.
- Cite material factual claims inline with [1], [2], or [1, 3].
- Only use numbers that exist in the source ledger.
- Preserve conflicting evidence instead of averaging it away.
- Label community commentary as perspective, not fact.
- Include a Limitations and open questions section.
- Do not include a Sources section; Akorith appends the canonical source ledger during export.
- Do not wrap the report in a Markdown code fence.`
}

export function sanitizeResearchReportCitations(markdown: string, sourceCount: number): string {
  return markdown.replace(/\[([\d,\s]+)\]/g, (match, numbers: string) => {
    const parsed = numbers.split(',').map((value) => Number(value.trim()))
    if (parsed.length === 0 || parsed.some((value) => !Number.isInteger(value) || value < 1 || value > sourceCount)) {
      return '[unverified citation]'
    }
    return match
  })
}
