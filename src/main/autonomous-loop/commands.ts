import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'

const execFileAsync = promisify(execFile)
const SAFE_TOKEN = /^[A-Za-z0-9_./:@+=,-]{1,180}$/
const SHELL_META = /[;&|><`$\r\n\0]/

export interface ValidationCommandSpec {
  display: string
  executable: string
  args: string[]
}

export type ValidationCommandParseResult =
  | { ok: true; spec: ValidationCommandSpec }
  | { ok: false; error: string }

function commandTokens(command: string): string[] | null {
  const normalized = command.trim().replace(/\\/g, '/')
  if (!normalized || normalized.length > 500 || SHELL_META.test(normalized) || /["']/.test(normalized)) return null
  const tokens = normalized.split(/\s+/)
  return tokens.every((token) => SAFE_TOKEN.test(token)) ? tokens : null
}

function executableName(value: string): string {
  const base = basename(value).toLowerCase()
  return base.endsWith('.cmd') || base.endsWith('.bat') || base.endsWith('.exe') ? base.replace(/\.(cmd|bat|exe)$/, '') : base
}

function packageManagerAllowed(name: string, args: string[]): boolean {
  if (args[0] === 'test') return args.length === 1
  if (args[0] !== 'run' || !args[1] || !/^[A-Za-z0-9:_-]{1,80}$/.test(args[1])) return false
  return args.length === 2
}

function allowed(name: string, args: string[]): boolean {
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return packageManagerAllowed(name, args)
  if (name === 'python' || name === 'python3') return args[0] === '-m' && args[1] === 'pytest' && args.slice(2).every((arg) => SAFE_TOKEN.test(arg))
  if (name === 'pytest') return args.every((arg) => SAFE_TOKEN.test(arg))
  if (name === 'cargo') return ['test', 'build', 'check', 'clippy'].includes(args[0] ?? '') && args.slice(1).every((arg) => SAFE_TOKEN.test(arg))
  if (name === 'go') return ['test', 'build', 'vet'].includes(args[0] ?? '') && args.slice(1).every((arg) => SAFE_TOKEN.test(arg))
  if (name === 'mvn' || name === 'mvnw') return ['test', 'verify', 'package'].includes(args[0] ?? '') && args.slice(1).every((arg) => SAFE_TOKEN.test(arg))
  if (name === 'gradle' || name === 'gradlew') return ['test', 'build', 'check'].includes(args[0] ?? '') && args.slice(1).every((arg) => SAFE_TOKEN.test(arg))
  if (name === 'git') {
    return (args[0] === 'diff' && args.length === 2 && args[1] === '--check') ||
      (args[0] === 'status' && args.length === 2 && args[1] === '--porcelain')
  }
  return false
}

export function parseValidationCommand(command: string): ValidationCommandParseResult {
  const tokens = commandTokens(command)
  if (!tokens || tokens.length < 2) return { ok: false, error: 'Validation command is malformed or contains shell syntax.' }
  const [rawExecutable, ...args] = tokens
  const name = executableName(rawExecutable)
  if (!allowed(name, args)) return { ok: false, error: `Validation command ${name || '(unknown)'} is not allowlisted.` }
  const executable = process.platform === 'win32' && ['npm', 'pnpm', 'yarn', 'bun'].includes(name)
    ? `${name}.cmd`
    : rawExecutable
  return { ok: true, spec: { display: command.trim(), executable, args } }
}

export async function changedFilesForValidation(root: string): Promise<string[]> {
  try {
    const result = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1_000_000
    })
    return [...new Set(result.stdout.split(/\r?\n/).map((file) => file.trim().replace(/\\/g, '/')).filter(Boolean))].slice(0, 2_000)
  } catch {
    return []
  }
}
