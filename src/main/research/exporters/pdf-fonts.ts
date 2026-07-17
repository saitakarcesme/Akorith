import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(__filename)

const REGULAR_FILE = 'DejaVuSans.ttf'
const BOLD_FILE = 'DejaVuSans-Bold.ttf'

export const RESEARCH_PDF_FONTS = {
  regular: 'AkorithResearchRegular',
  bold: 'AkorithResearchBold'
} as const

export interface ResearchPdfFontPaths {
  regular: string
  bold: string
}

interface PdfFontRegistry {
  registerFont(name: string, src: string): unknown
}

/**
 * Registers an embedded Unicode font pair for every Research PDF.
 *
 * PDFKit's built-in Helvetica/Courier fonts use a legacy WinAnsi encoding and
 * corrupt text such as "İnci Aral", "Oğuz Atay" and "Nâzım Hikmet". DejaVu
 * Sans is freely redistributable and covers Latin Extended, Greek, Cyrillic,
 * Arabic and Hebrew. The selected files and license are copied into the
 * packaged app through electron-builder's extraResources.
 */
export function registerResearchPdfFonts(doc: PdfFontRegistry): typeof RESEARCH_PDF_FONTS {
  const paths = resolveResearchPdfFontPaths()
  doc.registerFont(RESEARCH_PDF_FONTS.regular, paths.regular)
  doc.registerFont(RESEARCH_PDF_FONTS.bold, paths.bold)
  return RESEARCH_PDF_FONTS
}

export function resolveResearchPdfFontPaths(resourcesPathOverride?: string): ResearchPdfFontPaths {
  const resourcesPath = resourcesPathOverride
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath
    ? {
        regular: join(resourcesPath, 'research-fonts', REGULAR_FILE),
        bold: join(resourcesPath, 'research-fonts', BOLD_FILE)
      }
    : undefined

  if (packaged && existsSync(packaged.regular) && existsSync(packaged.bold)) return packaged

  try {
    const dependency = {
      regular: require.resolve(`dejavu-fonts-ttf/ttf/${REGULAR_FILE}`),
      bold: require.resolve(`dejavu-fonts-ttf/ttf/${BOLD_FILE}`)
    }
    if (existsSync(dependency.regular) && existsSync(dependency.bold)) return dependency
  } catch {
    // Packaged builds intentionally omit this development-only dependency.
  }

  throw new Error('Research PDF Unicode fonts are missing from the application package.')
}
