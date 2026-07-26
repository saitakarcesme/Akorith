import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { ResearchDocument } from '../document'
import { sourceCitationLabel } from '../document'
import {
  renderResearchVisualSvg,
  researchVisualCitationNumbers
} from '../visual-evidence'
import { researchArtifactPath } from '../workspace'
import { markdownAnchor } from './design'
import { publicationVisuals } from './publication'

export function renderResearchMarkdown(
  document: ResearchDocument,
  visualAssetPrefix?: string
): string {
  const visuals = publicationVisuals(document)
  const reservedAnchors = [
    'abstract',
    'introduction',
    'figures',
    'conclusion',
    'bibliography',
    ...document.sources.map((_, index) => `source-${index + 1}`)
  ]
  const sectionAnchors = uniqueSectionAnchors(
    document.sections.map((section) => section.title),
    reservedAnchors
  )
  const lines: string[] = [
    `# ${document.title}`,
    '',
    '## Contents',
    '',
    '- [Abstract](#abstract)',
    '- [Introduction](#introduction)',
    ...document.sections.map((section, index) => `- [${section.title}](#${sectionAnchors[index]})`),
    ...(visuals.length > 0 ? ['- [Figures](#figures)'] : []),
    '- [Conclusion](#conclusion)',
    '- [Bibliography](#bibliography)',
    '',
    '<a id="abstract"></a>',
    '',
    '## Abstract',
    '',
    linkMarkdownCitations(document.abstract, document.sources.length),
    '',
    '<a id="introduction"></a>',
    '',
    '## Introduction',
    '',
    linkMarkdownCitations(document.introduction, document.sources.length),
    ''
  ]

  for (const [sectionIndex, section] of document.sections.entries()) {
    lines.push(
      `<a id="${sectionAnchors[sectionIndex]}"></a>`,
      '',
      `## ${section.title}`,
      '',
      linkMarkdownCitations(section.body.trim(), document.sources.length),
      ''
    )
  }

  if (visuals.length > 0) {
    lines.push('<a id="figures"></a>', '', '## Figures', '')
    visuals.forEach((visual, index) => {
      const citations = researchVisualCitationNumbers(visual.provenance.sourceIds, document.sources)
      const refs = citations.map((number) => `[${number}](#source-${number})`).join(', ')
      lines.push(`### Figure ${index + 1}. ${visual.title}`, '')
      if (visualAssetPrefix) {
        lines.push(`![${escapeMarkdownAlt(visual.altText)}](${visualAssetPrefix}/${visual.id}.svg)`, '')
      }
      lines.push(`*${visual.caption}${refs ? ` Sources: ${refs}.` : ''}*`, '')
    })
  }

  lines.push(
    '<a id="conclusion"></a>',
    '',
    '## Conclusion',
    '',
    linkMarkdownCitations(document.conclusion, document.sources.length),
    '',
    '<a id="bibliography"></a>',
    '',
    '## Bibliography',
    ''
  )
  document.sources.forEach((source, index) => {
    lines.push(`<a id="source-${index + 1}"></a>`)
    const citation = sourceCitationLabel(source, index).replace(/^\[\d+\]\s*/, '')
    lines.push(
      `${index + 1}. ${citation}${source.publishedAt ? ` Published ${source.publishedAt}.` : ''} Accessed ${new Date(source.accessedAt).toISOString().slice(0, 10)}.`
    )
    lines.push('')
  })
  return `${lines.join('\n').trim()}\n`
}

function uniqueSectionAnchors(titles: string[], reservedAnchors: string[]): string[] {
  const used = new Set(reservedAnchors)
  return titles.map((title) => {
    const base = markdownAnchor(title)
    let anchor = base
    let suffix = 2
    while (used.has(anchor)) anchor = `${base}-${suffix++}`
    used.add(anchor)
    return anchor
  })
}

export function exportResearchMarkdown(
  workspaceDir: string,
  document: ResearchDocument,
  outputPath?: string
): string {
  const path = outputPath ?? researchArtifactPath(workspaceDir, document.title, 'md')
  const partial = `${path}.partial`
  const visuals = publicationVisuals(document)
  const assetDirName = `${basename(path, extname(path))}-assets`
  if (visuals.length > 0) {
    const assetDir = join(dirname(path), assetDirName)
    mkdirSync(assetDir, { recursive: true })
    for (const visual of visuals) {
      writeFileSync(join(assetDir, `${visual.id}.svg`), renderResearchVisualSvg(visual), 'utf8')
    }
  }
  writeFileSync(
    partial,
    renderResearchMarkdown(document, visuals.length > 0 ? `./${assetDirName}` : undefined),
    'utf8'
  )
  renameSync(partial, path)
  return path
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim()
}

function linkMarkdownCitations(value: string, sourceCount: number): string {
  return value.replace(
    /\[([0-9]+(?:\s*[,;]\s*[0-9]+)*)\](?!\()/g,
    (full, marker: string) => {
      const numbers = (marker.match(/\d+/g) ?? []).map(Number)
      if (
        numbers.length === 0
        || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > sourceCount)
      ) return full
      return numbers.map((number) => `[${number}](#source-${number})`).join(', ')
    }
  )
}
