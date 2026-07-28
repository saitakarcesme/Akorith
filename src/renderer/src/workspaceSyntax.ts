export type WorkspaceSyntaxKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'property'
  | 'tag'
  | 'type'
  | 'function'
  | 'operator'

export interface WorkspaceSyntaxToken {
  kind: WorkspaceSyntaxKind
  text: string
}

export interface WorkspaceCodeLine {
  number: number
  tokens: WorkspaceSyntaxToken[]
}

type WorkspaceLanguage = 'code' | 'data' | 'markup' | 'markdown' | 'python' | 'shell' | 'sql' | 'styles'

const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'def', 'default', 'delete', 'do', 'elif', 'else', 'enum', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let', 'match',
  'namespace', 'new', 'of', 'package', 'private', 'protected', 'public', 'readonly', 'return',
  'select', 'static', 'struct', 'switch', 'throw', 'trait', 'try', 'type', 'typeof', 'var',
  'where', 'while', 'with', 'yield'
])

const LITERALS = new Set([
  'False', 'None', 'True', 'false', 'null', 'self', 'super', 'this', 'true', 'undefined'
])

const EXTENSION_LANGUAGE: Record<string, WorkspaceLanguage> = {
  bash: 'shell', c: 'code', cc: 'code', cpp: 'code', cs: 'code', cts: 'code', css: 'styles',
  go: 'code', h: 'code', hpp: 'code', htm: 'markup', html: 'markup', java: 'code', js: 'code',
  json: 'data', jsonc: 'data', jsx: 'code', md: 'markdown', mdx: 'markdown', mjs: 'code',
  mts: 'code', php: 'markup', ps1: 'shell', py: 'python', rb: 'code', rs: 'code', sass: 'styles',
  scss: 'styles', sh: 'shell', sql: 'sql', svelte: 'markup', toml: 'data', ts: 'code',
  tsx: 'code', vue: 'markup', xml: 'markup', yaml: 'data', yml: 'data', zsh: 'shell'
}

function languageForPath(path: string): WorkspaceLanguage {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGE[extension] ?? 'code'
}

function push(tokens: WorkspaceSyntaxToken[], kind: WorkspaceSyntaxKind, text: string): void {
  if (!text) return
  const previous = tokens.at(-1)
  if (previous?.kind === kind) previous.text += text
  else tokens.push({ kind, text })
}

function lineCommentMarker(language: WorkspaceLanguage): string | null {
  if (language === 'python' || language === 'shell') return '#'
  if (language === 'sql') return '--'
  if (language === 'code' || language === 'styles') return '//'
  return null
}

function tokenizeLine(
  line: string,
  language: WorkspaceLanguage,
  state: { blockComment: boolean }
): WorkspaceSyntaxToken[] {
  const tokens: WorkspaceSyntaxToken[] = []
  const marker = lineCommentMarker(language)
  const markup = language === 'markup'
  let index = 0
  let inTag = false

  while (index < line.length) {
    if (state.blockComment) {
      const close = markup ? '-->' : '*/'
      const end = line.indexOf(close, index)
      if (end < 0) {
        push(tokens, 'comment', line.slice(index))
        return tokens
      }
      push(tokens, 'comment', line.slice(index, end + close.length))
      state.blockComment = false
      index = end + close.length
      continue
    }

    const rest = line.slice(index)
    const blockOpen = markup ? '<!--' : '/*'
    if ((markup || language === 'code' || language === 'styles') && rest.startsWith(blockOpen)) {
      const close = markup ? '-->' : '*/'
      const end = line.indexOf(close, index + blockOpen.length)
      if (end < 0) {
        state.blockComment = true
        push(tokens, 'comment', rest)
        return tokens
      }
      push(tokens, 'comment', line.slice(index, end + close.length))
      index = end + close.length
      continue
    }

    if (marker && rest.startsWith(marker)) {
      push(tokens, 'comment', rest)
      return tokens
    }

    const char = line[index]
    if (char === '"' || char === "'" || char === '`') {
      let end = index + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === char) {
          end += 1
          break
        }
        end += 1
      }
      const value = line.slice(index, end)
      const after = line.slice(end)
      push(tokens, language === 'data' && /^\s*:/.test(after) ? 'property' : 'string', value)
      index = end
      continue
    }

    const number = rest.match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)?.[0]
    if (number) {
      push(tokens, 'number', number)
      index += number.length
      continue
    }

    const word = rest.match(/^[A-Za-z_$][\w$-]*/)?.[0]
    if (word) {
      const after = rest.slice(word.length)
      const kind: WorkspaceSyntaxKind = KEYWORDS.has(word)
        ? 'keyword'
        : LITERALS.has(word)
          ? 'literal'
          : inTag
            ? tokens.some((token) => token.kind === 'tag') ? 'property' : 'tag'
            : (language === 'data' || language === 'styles') && /^\s*:/.test(after)
              ? 'property'
              : /^\s*\(/.test(after)
                ? 'function'
                : /^[A-Z]/.test(word)
                  ? 'type'
                  : 'plain'
      push(tokens, kind, word)
      index += word.length
      continue
    }

    if (markup && char === '<') inTag = true
    const operator = rest.match(/^(?:<\/|=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|[{}[\]().,:;+\-*/%=<>!?&#|@]+)/)?.[0]
    if (operator) {
      push(tokens, 'operator', operator)
      if (markup && operator.includes('>')) inTag = false
      index += operator.length
      continue
    }

    const whitespace = rest.match(/^\s+/)?.[0]
    if (whitespace) {
      push(tokens, 'plain', whitespace)
      index += whitespace.length
      continue
    }

    push(tokens, 'plain', char)
    index += 1
  }

  return tokens
}

export function highlightWorkspaceCode(content: string, path: string): WorkspaceCodeLine[] {
  const language = languageForPath(path)
  const state = { blockComment: false }
  return content.replace(/\r\n?/g, '\n').split('\n').map((line, index) => ({
    number: index + 1,
    tokens: tokenizeLine(line, language, state)
  }))
}
