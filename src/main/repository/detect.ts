import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { classifyGitFailure } from './errors'
import { runGit, type CommandRunner } from './runner'
import type { DetectedCommand, RepositoryTechnologyProfile } from './types'

const MAX_FILES = 20_000
const MAX_PACKAGE_JSON = 512 * 1024

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.swift': 'Swift', '.cs': 'C#', '.c': 'C', '.h': 'C/C++', '.cc': 'C/C++', '.cpp': 'C/C++',
  '.hpp': 'C/C++', '.rb': 'Ruby', '.php': 'PHP', '.dart': 'Dart', '.sh': 'Shell', '.ps1': 'PowerShell',
  '.vue': 'Vue', '.svelte': 'Svelte'
}

function command(kind: DetectedCommand['kind'], label: string, executable: string, args: string[], source: string): DetectedCommand {
  return { kind, label, executable, args, source }
}

function addCommand(target: DetectedCommand[], candidate: DetectedCommand): void {
  const key = `${candidate.executable}\0${candidate.args.join('\0')}`
  if (!target.some((entry) => `${entry.executable}\0${entry.args.join('\0')}` === key)) target.push(candidate)
}

async function readPackageJson(repositoryPath: string): Promise<Record<string, unknown> | null> {
  const path = join(repositoryPath, 'package.json')
  try {
    if ((await stat(path)).size > MAX_PACKAGE_JSON) return null
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function javascriptRunner(packageManager: string): { executable: string; argsFor(script: string): string[] } {
  if (packageManager === 'yarn') return { executable: 'yarn', argsFor: (script) => [script] }
  return { executable: packageManager, argsFor: (script) => ['run', script] }
}

export async function detectRepositoryTechnology(
  runner: CommandRunner,
  repositoryPath: string
): Promise<RepositoryTechnologyProfile> {
  const listed = await runGit(runner, repositoryPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (!listed.ok) throw classifyGitFailure(listed, 'scan repository files')
  const allFiles = listed.stdout.split('\0').filter(Boolean)
  const truncated = allFiles.length > MAX_FILES
  const files = allFiles.slice(0, MAX_FILES).map((path) => path.replace(/\\/g, '/'))
  const fileSet = new Set(files)
  const baseSet = new Set(files.map((path) => basename(path)))

  const languageCounts = new Map<string, number>()
  for (const path of files) {
    const language = LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1)
  }
  const languages = [...languageCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language]) => language)

  const managers = new Set<string>()
  const manifests = new Set<string>()
  const mark = (file: string, manager: string): void => {
    if (fileSet.has(file) || baseSet.has(file)) {
      manifests.add(file)
      managers.add(manager)
    }
  }
  mark('package-lock.json', 'npm')
  mark('pnpm-lock.yaml', 'pnpm')
  mark('yarn.lock', 'yarn')
  mark('bun.lock', 'bun')
  mark('bun.lockb', 'bun')
  mark('requirements.txt', 'pip')
  mark('poetry.lock', 'Poetry')
  mark('uv.lock', 'uv')
  mark('Cargo.toml', 'Cargo')
  mark('go.mod', 'Go modules')
  mark('pom.xml', 'Maven')
  mark('build.gradle', 'Gradle')
  mark('build.gradle.kts', 'Gradle')
  mark('Gemfile', 'Bundler')
  mark('composer.json', 'Composer')
  mark('pubspec.yaml', 'Dart pub')
  mark('Package.swift', 'Swift Package Manager')
  if (files.some((path) => path.endsWith('.sln') || path.endsWith('.csproj'))) managers.add('NuGet/.NET')

  const scripts: Record<string, string> = {}
  const packageJson = fileSet.has('package.json') ? await readPackageJson(repositoryPath) : null
  if (packageJson) {
    manifests.add('package.json')
    const declaredManager = typeof packageJson.packageManager === 'string'
      ? packageJson.packageManager.split('@')[0].toLowerCase()
      : null
    if (declaredManager && ['npm', 'pnpm', 'yarn', 'bun'].includes(declaredManager)) managers.add(declaredManager)
    if (![...managers].some((manager) => ['npm', 'pnpm', 'yarn', 'bun'].includes(manager))) managers.add('npm')
    if (typeof packageJson.scripts === 'object' && packageJson.scripts !== null && !Array.isArray(packageJson.scripts)) {
      for (const [name, value] of Object.entries(packageJson.scripts as Record<string, unknown>).slice(0, 100)) {
        if (typeof value === 'string') scripts[name.slice(0, 100)] = value.slice(0, 2_000)
      }
    }
  }

  const commands: RepositoryTechnologyProfile['commands'] = { test: [], build: [], lint: [], typecheck: [] }
  const jsManager = ['pnpm', 'yarn', 'bun', 'npm'].find((manager) => managers.has(manager))
  if (jsManager) {
    const invocation = javascriptRunner(jsManager)
    for (const name of Object.keys(scripts)) {
      const kind = name === 'test' || name.startsWith('test:')
        ? 'test'
        : name === 'build' || name.startsWith('build:')
          ? 'build'
          : name === 'lint' || name.startsWith('lint:')
            ? 'lint'
            : ['typecheck', 'type-check', 'check-types'].includes(name) || name.startsWith('typecheck:')
              ? 'typecheck'
              : null
      if (kind) addCommand(commands[kind], command(kind, `${jsManager} ${name}`, invocation.executable, invocation.argsFor(name), `package.json#scripts.${name}`))
    }
  }

  const hasTestsDirectory = files.some((path) => path.startsWith('tests/') || path.startsWith('test/'))
  if (languages.includes('Python') && (hasTestsDirectory || baseSet.has('pytest.ini') || fileSet.has('pyproject.toml'))) {
    addCommand(commands.test, command('test', 'pytest', 'python', ['-m', 'pytest'], 'Python project files'))
  }
  if (fileSet.has('Cargo.toml')) {
    addCommand(commands.test, command('test', 'cargo test', 'cargo', ['test'], 'Cargo.toml'))
    addCommand(commands.build, command('build', 'cargo build', 'cargo', ['build'], 'Cargo.toml'))
    addCommand(commands.lint, command('lint', 'cargo clippy', 'cargo', ['clippy', '--all-targets'], 'Cargo.toml'))
    addCommand(commands.typecheck, command('typecheck', 'cargo check', 'cargo', ['check'], 'Cargo.toml'))
  }
  if (fileSet.has('go.mod')) {
    addCommand(commands.test, command('test', 'go test', 'go', ['test', './...'], 'go.mod'))
    addCommand(commands.build, command('build', 'go build', 'go', ['build', './...'], 'go.mod'))
  }
  if (fileSet.has('pom.xml')) {
    addCommand(commands.test, command('test', 'mvn test', 'mvn', ['test'], 'pom.xml'))
    addCommand(commands.build, command('build', 'mvn package', 'mvn', ['package', '-DskipTests'], 'pom.xml'))
  }
  if (fileSet.has('build.gradle') || fileSet.has('build.gradle.kts')) {
    const executable = process.platform === 'win32' && fileSet.has('gradlew.bat') ? 'gradlew.bat' : fileSet.has('gradlew') ? './gradlew' : 'gradle'
    addCommand(commands.test, command('test', 'Gradle test', executable, ['test'], 'Gradle build'))
    addCommand(commands.build, command('build', 'Gradle build', executable, ['build'], 'Gradle build'))
  }
  if (managers.has('NuGet/.NET')) {
    addCommand(commands.test, command('test', 'dotnet test', 'dotnet', ['test'], '.NET solution/project'))
    addCommand(commands.build, command('build', 'dotnet build', 'dotnet', ['build'], '.NET solution/project'))
  }

  return {
    languages,
    packageManagers: [...managers].sort(),
    manifests: [...manifests].sort(),
    scripts,
    commands,
    scannedFiles: files.length,
    truncated
  }
}
