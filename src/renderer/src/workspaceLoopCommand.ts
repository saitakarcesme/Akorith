export type WorkspaceLoopCommand =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'command'; goal: string }

const TERMINAL_LOOP = /(?:^|\s)\/loop\s*$/i
const PARTIAL_LOOP = /(?:^|\s)\/l(?:o(?:o(?:p)?)?)?\s*$/i

function countUnescaped(value: string, token: string): number {
  let count = 0
  let cursor = 0
  while (cursor < value.length) {
    const index = value.indexOf(token, cursor)
    if (index < 0) break
    let slashes = 0
    for (let position = index - 1; position >= 0 && value[position] === '\\'; position -= 1) slashes += 1
    if (slashes % 2 === 0) count += 1
    cursor = index + token.length
  }
  return count
}

function isInsideCodeOrQuote(valueBeforeCommand: string): boolean {
  // A command-looking suffix inside an unfinished Markdown fence or inline-code
  // span is content, not an instruction to start autonomous work.
  if (countUnescaped(valueBeforeCommand, '```') % 2 === 1) return true
  if (countUnescaped(valueBeforeCommand, '~~~') % 2 === 1) return true

  const withoutFences = valueBeforeCommand.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
  if (countUnescaped(withoutFences, '`') % 2 === 1) return true

  // Double quotes are safe to identify without treating apostrophes in normal
  // prose (for example "don't") as an open quoted context.
  const currentLine = withoutFences.slice(withoutFences.lastIndexOf('\n') + 1)
  if (/^\s*>/.test(currentLine)) return true
  if (countUnescaped(currentLine, '"') % 2 === 1) return true
  if (/(?:^|\s)'[^']*$/.test(currentLine)) return true
  if (countUnescaped(currentLine, '‘') !== countUnescaped(currentLine, '’')) return true
  if (countUnescaped(currentLine, '“') !== countUnescaped(currentLine, '”')) return true
  return false
}

export function parseWorkspaceLoopCommand(input: string): WorkspaceLoopCommand {
  const match = TERMINAL_LOOP.exec(input)
  if (!match) return { kind: 'none' }

  const commandIndex = match.index + (match[0].length - match[0].trimStart().length)
  const beforeCommand = input.slice(0, commandIndex)
  if (isInsideCodeOrQuote(beforeCommand)) {
    return { kind: 'invalid', reason: 'Close the quote or code block before adding /loop.' }
  }

  const goal = beforeCommand.trim()
  if (!goal) return { kind: 'invalid', reason: 'Write a concrete task before /loop.' }
  return { kind: 'command', goal }
}

export function workspaceLoopHint(input: string): 'suggest' | 'armed' | null {
  const parsed = parseWorkspaceLoopCommand(input)
  if (parsed.kind === 'command' || parsed.kind === 'invalid') return 'armed'
  return PARTIAL_LOOP.test(input) ? 'suggest' : null
}

export function insertWorkspaceLoopCommand(input: string): string {
  const trimmedEnd = input.trimEnd()
  if (!trimmedEnd) return '/loop'
  if (PARTIAL_LOOP.test(trimmedEnd)) {
    return trimmedEnd.replace(PARTIAL_LOOP, (match) => `${match.match(/^\s+/)?.[0] ?? ''}/loop`)
  }
  return `${trimmedEnd} /loop`
}
