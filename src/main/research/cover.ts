import { writeFileSync } from 'fs'
import { createHash } from 'crypto'
import type { ResearchDocument } from './document'
import { safeResearchPath } from './workspace'

const PALETTES = [
  ['#111315', '#78D6AA', '#8A72D8'],
  ['#121315', '#A3D4C2', '#6F64B9'],
  ['#151416', '#82CDA9', '#9C78CA'],
  ['#101416', '#67C8B1', '#7565B7']
] as const

export function createResearchCoverSvg(document: ResearchDocument): string {
  const palette = paletteFor(document.title)
  const titleLines = wrapCoverTitle(document.title, 24)
  const subtitleLines = wrapCoverTitle(document.subtitle, 44).slice(0, 4)
  const title = titleLines.map((line, index) =>
    `<text x="72" y="${300 + index * 74}" fill="#F4F4F2" font-family="-apple-system,BlinkMacSystemFont,Inter,sans-serif" font-size="58" font-weight="680">${escapeXml(line)}</text>`
  ).join('\n')
  const subtitleStart = 350 + titleLines.length * 74
  const subtitle = subtitleLines.map((line, index) =>
    `<text x="74" y="${subtitleStart + index * 34}" fill="#B9BAB7" font-family="-apple-system,BlinkMacSystemFont,Inter,sans-serif" font-size="22">${escapeXml(line)}</text>`
  ).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123" viewBox="0 0 794 1123">
  <defs>
    <radialGradient id="glowA" cx="0" cy="0" r="1" gradientTransform="translate(668 220) rotate(127) scale(430 480)" gradientUnits="userSpaceOnUse">
      <stop stop-color="${palette[1]}" stop-opacity=".36"/><stop offset="1" stop-color="${palette[1]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0" cy="0" r="1" gradientTransform="translate(96 994) rotate(-45) scale(430 510)" gradientUnits="userSpaceOnUse">
      <stop stop-color="${palette[2]}" stop-opacity=".30"/><stop offset="1" stop-color="${palette[2]}" stop-opacity="0"/>
    </radialGradient>
    <filter id="noise"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .035 0"/></filter>
  </defs>
  <rect width="794" height="1123" rx="26" fill="${palette[0]}"/>
  <rect width="794" height="1123" rx="26" fill="url(#glowA)"/>
  <rect width="794" height="1123" rx="26" fill="url(#glowB)"/>
  <rect x="36" y="36" width="722" height="1051" rx="18" fill="none" stroke="#FFFFFF" stroke-opacity=".10"/>
  <rect x="72" y="88" width="44" height="5" rx="2.5" fill="${palette[1]}"/><text x="128" y="99" fill="#CDCFCC" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="14" letter-spacing="3">AKORITH RESEARCH</text>
  ${title}
  ${subtitle}
  <line x1="72" y1="920" x2="722" y2="920" stroke="#FFFFFF" stroke-opacity=".12"/>
  <text x="72" y="970" fill="#E8E9E6" font-family="-apple-system,BlinkMacSystemFont,Inter,sans-serif" font-size="18">${escapeXml(document.depthLabel.toUpperCase())} · ${escapeXml(document.modelLabel)}</text>
  <text x="72" y="1010" fill="#8E918D" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="13">${escapeXml(new Date(document.generatedAt).toLocaleDateString('en-CA'))} · ${document.sources.length} SOURCES</text>
  <circle cx="704" cy="990" r="18" fill="${palette[1]}" fill-opacity=".16" stroke="${palette[1]}" stroke-opacity=".55"/><path d="M697 990l5 5 10-12" fill="none" stroke="${palette[1]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <rect width="794" height="1123" rx="26" filter="url(#noise)" opacity=".30"/>
</svg>`
}

export function writeResearchCover(workspaceDir: string, document: ResearchDocument): string {
  const path = safeResearchPath(workspaceDir, 'artifacts', 'cover.svg')
  writeFileSync(path, createResearchCoverSvg(document), 'utf8')
  return path
}

function paletteFor(title: string): (typeof PALETTES)[number] {
  const digest = createHash('sha256').update(title).digest()
  return PALETTES[digest[0] % PALETTES.length]
}

function wrapCoverTitle(value: string, maxChars: number): string[] {
  const words = value.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length > maxChars && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 6)
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[char]!)
}
