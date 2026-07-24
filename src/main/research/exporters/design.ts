/**
 * Shared, deterministic layout helpers for Research deliverables.
 *
 * Office and PDF renderers do not agree on font metrics, so exporters must not
 * rely on viewer-specific "auto fit" behaviour. These conservative metrics are
 * used to wrap, fit, and (only as a last resort) ellipsize text before it is
 * written into a fixed page, slide, or worksheet region.
 */

export const RESEARCH_ARTIFACT_DESIGN = Object.freeze({
  fonts: {
    office: 'Arial',
    officeDisplay: 'Arial',
    monospace: 'Courier New'
  },
  colors: {
    ink: '171A18',
    canvas: '121513',
    surface: '1B1F1D',
    surfaceAlt: '202522',
    paper: 'F7F8F6',
    border: '343A36',
    text: 'F5F7F5',
    muted: 'A2AAA5',
    // 4.67:1 against the presentation canvas, so even 10–14pt metadata
    // clears WCAG's normal-text contrast threshold.
    dim: '7B827D',
    mint: '6FD1A4',
    mintDark: '2F6D55',
    violet: 'A985F8',
    warning: 'E3B65C'
  },
  geometry: {
    pageMarginPoints: 54,
    slideWidthInches: 13.333333,
    slideHeightInches: 7.5,
    slideSafeLeft: 0.78,
    slideSafeRight: 12.54,
    slideFooterTop: 6.58
  }
})

export interface FitTextBlockOptions {
  width: number
  maxHeight: number
  maxFontSize: number
  minFontSize: number
  maxLines: number
  lineHeight?: number
}

export interface FittedTextBlock {
  text: string
  lines: string[]
  fontSize: number
  lineHeight: number
  height: number
  truncated: boolean
}

export function normalizeArtifactText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compactArtifactText(value: string, maxCharacters: number): string {
  const clean = normalizeArtifactText(value)
  const limit = Math.max(0, Math.floor(maxCharacters))
  const characters = Array.from(clean)
  if (characters.length <= limit) return clean
  if (limit === 0) return ''
  if (limit === 1) return '\u2026'
  return `${characters.slice(0, limit - 1).join('').trimEnd()}\u2026`
}

export function estimatedTextWidth(value: string, fontSize: number): number {
  let units = 0
  for (const character of Array.from(value)) {
    if (/\s/u.test(character)) units += 0.3
    else if (/[ilI1|!.,:;'`]/u.test(character)) units += 0.31
    else if (/[mwMW@%&#QG]/u.test(character)) units += 0.82
    else if (/\p{Extended_Pictographic}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) units += 1
    else if (/\p{Lu}/u.test(character)) units += 0.64
    else if (/\p{N}/u.test(character)) units += 0.56
    else units += 0.52
  }
  return units * fontSize
}

export function wrapArtifactText(value: string, width: number, fontSize: number): string[] {
  const clean = normalizeArtifactText(value)
  if (!clean) return []
  const words = clean.split(' ')
  const lines: string[] = []
  let line = ''

  const pushLongWord = (word: string): string => {
    let fragment = ''
    for (const character of Array.from(word)) {
      const candidate = `${fragment}${character}`
      if (fragment && estimatedTextWidth(candidate, fontSize) > width) {
        lines.push(fragment)
        fragment = character
      } else {
        fragment = candidate
      }
    }
    return fragment
  }

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (estimatedTextWidth(candidate, fontSize) <= width) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    line = estimatedTextWidth(word, fontSize) <= width ? word : pushLongWord(word)
  }
  if (line) lines.push(line)
  return lines
}

export function fitArtifactText(value: string, options: FitTextBlockOptions): FittedTextBlock {
  const ratio = options.lineHeight ?? 1.14
  for (let fontSize = options.maxFontSize; fontSize >= options.minFontSize; fontSize -= 1) {
    const lines = wrapArtifactText(value, options.width, fontSize)
    const lineHeight = fontSize * ratio
    if (lines.length <= options.maxLines && lines.length * lineHeight <= options.maxHeight) {
      return {
        text: lines.join('\n'),
        lines,
        fontSize,
        lineHeight,
        height: lines.length * lineHeight,
        truncated: false
      }
    }
  }

  const fontSize = options.minFontSize
  const lineHeight = fontSize * ratio
  const allowedLines = Math.max(1, Math.min(options.maxLines, Math.floor(options.maxHeight / lineHeight)))
  const wrapped = wrapArtifactText(value, options.width, fontSize)
  const lines = wrapped.slice(0, allowedLines)
  const truncated = wrapped.length > allowedLines
  if (truncated && lines.length > 0) lines[lines.length - 1] = ellipsizeToWidth(lines[lines.length - 1], options.width, fontSize)
  return {
    text: lines.join('\n'),
    lines,
    fontSize,
    lineHeight,
    height: lines.length * lineHeight,
    truncated,
  }
}

export function estimateWrappedLineCount(value: string, width: number, fontSize: number): number {
  return Math.max(1, wrapArtifactText(value, width, fontSize).length)
}

export function estimateSpreadsheetRowHeight(
  value: string,
  columnWidthCharacters: number,
  fontSize = 10,
  minimum = 22,
  maximum = 132
): number {
  const widthPoints = Math.max(24, columnWidthCharacters * 5.25)
  const lines = estimateWrappedLineCount(value, widthPoints, fontSize)
  return Math.max(minimum, Math.min(maximum, Math.ceil(lines * fontSize * 1.35 + 8)))
}

export function markdownAnchor(value: string): string {
  const anchor = normalizeArtifactText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
  return anchor || 'section'
}

export function splitArtifactProse(value: string, maxCharacters = 680): string[] {
  const paragraphs = value.replace(/\r/g, '').split(/\n\s*\n/).map(normalizeArtifactText).filter(Boolean)
  const chunks: string[] = []
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu)?.map(normalizeArtifactText).filter(Boolean) ?? [paragraph]
    let chunk = ''
    for (const sentence of sentences) {
      const candidate = chunk ? `${chunk} ${sentence}` : sentence
      if (candidate.length <= maxCharacters) {
        chunk = candidate
        continue
      }
      if (chunk) chunks.push(chunk)
      if (sentence.length <= maxCharacters) {
        chunk = sentence
        continue
      }
      const words = sentence.split(' ')
      chunk = ''
      for (const word of words) {
        const wordCandidate = chunk ? `${chunk} ${word}` : word
        if (wordCandidate.length > maxCharacters && chunk) {
          chunks.push(chunk)
          chunk = word
        } else {
          chunk = wordCandidate
        }
      }
    }
    if (chunk) chunks.push(chunk)
  }
  return chunks
}

function ellipsizeToWidth(value: string, width: number, fontSize: number): string {
  const ellipsis = '\u2026'
  const characters = Array.from(value.replace(/\u2026$/u, '').trimEnd())
  while (characters.length > 0 && estimatedTextWidth(`${characters.join('')}${ellipsis}`, fontSize) > width) {
    characters.pop()
    while (characters.length > 0 && /\s/u.test(characters[characters.length - 1])) characters.pop()
  }
  const text = characters.join('')
  return `${text}${ellipsis}`
}
