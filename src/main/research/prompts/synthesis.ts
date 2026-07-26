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
  return `You are Akorith Research's publication editor. Turn the private research record below into a polished, self-contained research essay in Markdown. Do not ask questions. Use only the supplied findings, claims, and numbered source ledger. Never invent evidence, quotations, statistics, people, dates, social posts, or URLs.

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
- Write in one confident, coherent editorial voice. The reader should receive a finished publication, not a transcript of the research process.
- Start with one strong H1 title.
- Follow it with a short "## Abstract" of two to four sentences.
- Include "## Introduction", natural topic-specific sections, a distinct analytical section, a fair account of meaningful disagreements or alternative interpretations when the evidence contains them, and "## Conclusion".
- Prefer descriptive, reader-facing section titles over the internal plan labels. Follow the planned coverage where evidence permits, but do not expose the plan itself.
- Merge repeated or paraphrased claims into one passage; do not restate the same verified point in multiple sections unless the later passage adds materially different analysis.
- Cite material factual claims inline with quiet numeric endnotes: [1], [2], or [1, 3].
- Treat any citation numbers embedded in cycle findings as private working notation; only the numbered source ledger and source numbers attached to the claim ledger are authoritative for the essay.
- Only use numbers that exist in the source ledger.
- Preserve exact quantitative values and units from the verified claim ledger so Akorith can render deterministic charts from cited evidence.
- Compare values only when their units and methodologies are genuinely compatible; otherwise state the comparability limitation instead of inventing a visual comparison.
- Do not claim that a retrieved-text snapshot is a screenshot or a live webpage. It is sanitized source text captured by Akorith, with its URL and access date retained.
- Preserve conflicting evidence instead of averaging it away.
- Distinguish sourced perspective from established fact without turning the essay into a confidence-score ledger.
- Discuss material limitations naturally where they affect the argument; do not add a boilerplate methodology or confidence section.
- Never include headings or blocks named Evidence ledger, Methodology, Verification criteria, Research log, Confidence, Claims, or Raw sources.
- Never mention cycles, internal working notes, source targets, retrieval mechanics, or Akorith's private editorial process in the essay.
- Do not include a Sources, References, or Bibliography section; Akorith appends the canonical bibliography during export.
- Do not wrap the report in a Markdown code fence.`
}

export function sanitizeResearchReportCitations(markdown: string, sourceCount: number): string {
  return markdown.replace(/\[\^?([\d,\s;-]+)\]/g, (_match, marker: string) => {
    const parsed: number[] = []
    for (const part of marker.split(/[,;]/)) {
      const value = part.trim()
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(value)
      if (range) {
        const start = Number(range[1])
        const end = Number(range[2])
        if (end < start || end - start > 50) return '[citation unavailable]'
        for (let number = start; number <= end; number += 1) parsed.push(number)
        continue
      }
      if (!/^\d+$/.test(value)) return '[citation unavailable]'
      parsed.push(Number(value))
    }
    if (parsed.length === 0 || parsed.some((value) => !Number.isInteger(value) || value < 1 || value > sourceCount)) {
      return '[citation unavailable]'
    }
    return `[${[...new Set(parsed)].join(', ')}]`
  })
}
