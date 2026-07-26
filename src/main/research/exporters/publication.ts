import type { ResearchDocument } from '../document'
import type { ResearchSource } from '../types'
import type { ResearchVisualEvidence } from '../visual-evidence'

/**
 * Publication formats deliberately exclude diagnostic visuals. A chart is
 * eligible only when it contains at least two comparable, finite data points.
 * The evidence workbook remains the place for provenance tables and other
 * operational material.
 */
export function publicationVisuals(document: ResearchDocument): ResearchVisualEvidence[] {
  return document.visuals
    .filter((visual) =>
      visual.kind === 'quantitative-chart'
      && (visual.points?.length ?? 0) >= 2
      && visual.points!.every((point) => Number.isFinite(point.value))
    )
    .slice(0, 2)
}

/**
 * Presentations carry a selected bibliography instead of reproducing the full
 * evidence store. Prefer sources cited in the public essay, then fill any
 * remaining slots in canonical source order.
 */
export function selectedPublicationSources(
  document: ResearchDocument,
  limit = 6
): ResearchSource[] {
  const publicText = [
    document.abstract,
    document.introduction,
    ...document.sections.flatMap((section) => [section.title, section.body]),
    document.conclusion
  ].join('\n')
  const citedIndexes = [...publicText.matchAll(/\[([0-9]+(?:\s*[,;]\s*[0-9]+)*)\]/g)]
    .flatMap((match) => match[1].match(/\d+/g) ?? [])
    .map((numberText) => Number(numberText) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < document.sources.length)
  const selected = new Set<number>(citedIndexes)
  for (let index = 0; index < document.sources.length && selected.size < limit; index += 1) {
    selected.add(index)
  }
  return [...selected]
    .slice(0, Math.max(0, limit))
    .map((index) => document.sources[index])
}
