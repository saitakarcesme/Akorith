import { renameSync, writeFileSync } from 'fs'
import type { ResearchDocument } from '../document'
import { renderResearchVisualSvg, researchVisualCitationNumbers } from '../visual-evidence'
import { researchArtifactPath } from '../workspace'
import { publicationVisuals } from './publication'

export function renderResearchHtml(document: ResearchDocument): string {
  const visuals = publicationVisuals(document)
  const sectionIds = document.sections.map((section, index) =>
    `section-${index + 1}-${htmlId(section.title)}`
  )
  const lang = inferHtmlLanguage([
    document.title,
    document.abstract,
    document.introduction,
    ...document.sections.flatMap((section) => [section.title, section.body]),
    document.conclusion
  ].join(' '))
  const contents = [
    ['abstract', 'Abstract'],
    ['introduction', 'Introduction'],
    ...document.sections.map((section, index) => [sectionIds[index], section.title]),
    ...(visuals.length > 0 ? [['figures', 'Figures']] : []),
    ['conclusion', 'Conclusion'],
    ['bibliography', 'Bibliography']
  ]

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="description" content="${escapeHtml(compactPlainText(document.abstract.replace(/<[^>]*>/g, ' '), 280))}">
  <meta name="generator" content="Akorith Research">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --canvas: #090909;
      --surface: #0f0f0f;
      --text: #ededed;
      --muted: #a2a2a2;
      --faint: #777;
      --border: #262626;
      --link: #d7d7d7;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.65;
      background: var(--canvas);
      color: var(--text);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--canvas); }
    a { color: var(--link); text-underline-offset: .2em; }
    a:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .skip-link {
      position: fixed; left: 1rem; top: 1rem; z-index: 2; padding: .5rem .75rem;
      transform: translateY(-180%); background: var(--text); color: var(--canvas);
    }
    .skip-link:focus { transform: none; }
    .page { width: min(100% - 2rem, 760px); margin-inline: auto; }
    header { padding: clamp(4rem, 12vw, 8rem) 0 3rem; border-bottom: 1px solid var(--border); }
    .eyebrow, .meta { color: var(--faint); font-size: .76rem; letter-spacing: .11em; text-transform: uppercase; }
    h1 { max-width: 18ch; margin: .8rem 0 1rem; font-size: clamp(2.5rem, 8vw, 5rem); line-height: 1.02; letter-spacing: -.045em; }
    .dek { max-width: 62ch; margin: 0; color: var(--muted); font-size: clamp(1.05rem, 2.5vw, 1.3rem); }
    nav { margin: 2.5rem 0 1rem; padding: 1.2rem 1.3rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    nav h2 { margin: 0 0 .75rem; color: var(--muted); font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; }
    nav ol { columns: 2; margin: 0; padding-left: 1.35rem; }
    nav li { break-inside: avoid; padding: .15rem .5rem .15rem 0; }
    article { padding-bottom: 5rem; }
    section { padding: 3rem 0; border-bottom: 1px solid var(--border); scroll-margin-top: 1rem; }
    h2 { margin: 0 0 1.25rem; font-size: clamp(1.65rem, 4vw, 2.3rem); line-height: 1.18; letter-spacing: -.025em; }
    h3 { margin: 2rem 0 .75rem; font-size: 1.18rem; }
    h4 { margin: 1.5rem 0 .6rem; font-size: 1rem; }
    p, ul, ol, blockquote, pre { margin: 0 0 1.15rem; }
    p, li { max-width: 72ch; }
    ul, ol { padding-left: 1.4rem; }
    blockquote { padding-left: 1rem; border-left: 2px solid var(--border); color: var(--muted); }
    pre { overflow-x: auto; padding: 1rem; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
    code { font: .92em ui-monospace, SFMono-Regular, Consolas, monospace; }
    .abstract { color: var(--muted); font-size: 1.08rem; }
    .citation { white-space: nowrap; text-decoration: none; }
    figure { margin: 2rem 0 0; padding: 1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    figure img { display: block; width: 100%; height: auto; }
    figcaption { margin-top: .8rem; color: var(--muted); font-size: .9rem; }
    .bibliography { padding-left: 1.5rem; }
    .bibliography li { margin-bottom: 1rem; padding-left: .35rem; overflow-wrap: anywhere; }
    footer { padding: 1.4rem 0 3rem; color: var(--faint); font-size: .82rem; }
    @media (max-width: 560px) { nav ol { columns: 1; } }
    @media print {
      :root { color-scheme: light; --canvas: #fff; --surface: #fff; --text: #111; --muted: #444; --faint: #666; --border: #ddd; --link: #111; }
      .page { width: auto; max-width: none; }
      nav, .skip-link { display: none; }
      section, figure { break-inside: avoid; }
      a { text-decoration: none; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to article</a>
  <header class="page">
    <div class="eyebrow">Akorith Research</div>
    <h1>${escapeHtml(document.title)}</h1>
    <p class="dek">${renderInline(document.abstract, document.sources.length)}</p>
  </header>
  <main id="main-content" class="page">
    <nav aria-label="Article contents">
      <h2>Contents</h2>
      <ol>
        ${contents.map(([id, label]) => `<li><a href="#${id}">${escapeHtml(label)}</a></li>`).join('\n        ')}
      </ol>
    </nav>
    <article aria-labelledby="article-title">
      <span id="article-title" hidden>${escapeHtml(document.title)}</span>
      <section id="abstract" aria-labelledby="abstract-heading">
        <h2 id="abstract-heading">Abstract</h2>
        <div class="abstract">${renderRichText(document.abstract, document.sources.length)}</div>
      </section>
      <section id="introduction" aria-labelledby="introduction-heading">
        <h2 id="introduction-heading">Introduction</h2>
        ${renderRichText(document.introduction, document.sources.length)}
      </section>
      ${document.sections.map((section, index) => `
      <section id="${sectionIds[index]}" aria-labelledby="${sectionIds[index]}-heading">
        <h2 id="${sectionIds[index]}-heading">${escapeHtml(section.title)}</h2>
        ${renderRichText(section.body, document.sources.length)}
      </section>`).join('')}
      ${visuals.length > 0 ? `
      <section id="figures" aria-labelledby="figures-heading">
        <h2 id="figures-heading">Figures</h2>
        ${visuals.map((visual, index) => {
          const refs = researchVisualCitationNumbers(visual.provenance.sourceIds, document.sources)
          const citations = refs.map((ref) => `<a class="citation" href="#source-${ref}"><sup>[${ref}]</sup></a>`).join(' ')
          const encoded = Buffer.from(renderResearchVisualSvg(visual), 'utf8').toString('base64')
          return `<figure>
          <img src="data:image/svg+xml;base64,${encoded}" alt="${escapeHtml(visual.altText)}">
          <figcaption><strong>Figure ${index + 1}.</strong> ${escapeHtml(visual.caption)}${citations ? ` ${citations}` : ''}</figcaption>
        </figure>`
        }).join('\n        ')}
      </section>` : ''}
      <section id="conclusion" aria-labelledby="conclusion-heading">
        <h2 id="conclusion-heading">Conclusion</h2>
        ${renderRichText(document.conclusion, document.sources.length)}
      </section>
      <section id="bibliography" aria-labelledby="bibliography-heading">
        <h2 id="bibliography-heading">Bibliography</h2>
        <ol class="bibliography">
          ${document.sources.map((source, index) => {
            const publisher = source.publisher || safeHostname(source.url)
            const publication = source.publishedAt ? ` Published ${escapeHtml(source.publishedAt)}.` : ''
            const accessed = new Date(source.accessedAt).toISOString().slice(0, 10)
            const href = safeExternalHref(source.url)
            const linkedTitle = href
              ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(source.title)}</a>`
              : escapeHtml(source.title)
            return `<li id="source-${index + 1}">${escapeHtml(publisher)}. ${linkedTitle}.${publication} Accessed ${accessed}.</li>`
          }).join('\n          ')}
        </ol>
      </section>
    </article>
  </main>
  <footer class="page">
    Published by Akorith Research · ${new Date(document.generatedAt).toISOString().slice(0, 10)}
  </footer>
</body>
</html>
`
}

export function exportResearchHtml(
  workspaceDir: string,
  document: ResearchDocument,
  outputPath?: string
): string {
  const path = outputPath ?? researchArtifactPath(workspaceDir, document.title, 'html')
  const partial = `${path}.partial`
  writeFileSync(partial, renderResearchHtml(document), 'utf8')
  renameSync(partial, path)
  return path
}

function renderRichText(markdown: string, sourceCount: number): string {
  const lines = markdown.replace(/\r/g, '').split('\n')
  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (/^```/.test(line.trim())) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++])
      if (index < lines.length) index += 1
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{3,4})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2], sourceCount)}</h${level}>`)
      index += 1
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*[-*+]\s+/, ''), sourceCount)}</li>`)
        index += 1
      }
      blocks.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*\d+[.)]\s+/, ''), sourceCount)}</li>`)
        index += 1
      }
      blocks.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push(`<blockquote>${renderInline(quote.join(' '), sourceCount)}</blockquote>`)
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length
      && lines[index].trim()
      && !/^```/.test(lines[index].trim())
      && !/^(#{3,4})\s+/.test(lines[index])
      && !/^\s*[-*+]\s+/.test(lines[index])
      && !/^\s*\d+[.)]\s+/.test(lines[index])
      && !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push(`<p>${renderInline(paragraph.join(' '), sourceCount)}</p>`)
  }
  return blocks.join('\n        ')
}

function renderInline(value: string, sourceCount: number): string {
  const plain = value
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)]\((?:https?:\/\/)?[^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
  return escapeHtml(plain).replace(
    /\[([0-9]+(?:\s*[,;]\s*[0-9]+)*)\]/g,
    (full, marker: string) => {
      const numbers = (marker.match(/\d+/g) ?? []).map(Number)
      if (
        numbers.length === 0
        || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > sourceCount)
      ) return full
      return numbers
        .map((number) => `<a class="citation" href="#source-${number}"><sup>[${number}]</sup></a>`)
        .join(', ')
    }
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname } catch { return 'Source' }
}

function htmlId(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')
  return normalized || 'topic'
}

function compactPlainText(value: string, limit: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
}

function inferHtmlLanguage(value: string): string {
  if ((value.match(/[çğıöşüİÇĞÖŞÜ]/gu)?.length ?? 0) >= 2) return 'tr'
  if ((value.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/gu)?.length ?? 0) >= 2) return 'pl'
  if (/[\p{Script=Arabic}]/u.test(value)) return 'ar'
  if (/[\p{Script=Hebrew}]/u.test(value)) return 'he'
  if (/[\p{Script=Greek}]/u.test(value)) return 'el'
  if (/[\p{Script=Han}]/u.test(value)) return 'zh'
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) return 'ja'
  if (/[\p{Script=Hangul}]/u.test(value)) return 'ko'
  return 'en'
}
