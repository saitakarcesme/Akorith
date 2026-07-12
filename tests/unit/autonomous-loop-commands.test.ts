import { describe, expect, it } from 'vitest'
import { parseValidationCommand } from '../../src/main/autonomous-loop/commands'

describe('Loop validation command policy', () => {
  it.each([
    'npm test',
    'npm run typecheck',
    'pnpm run lint',
    'python -m pytest',
    'cargo test',
    'go test ./...',
    'mvn verify',
    './gradlew test',
    'git diff --check'
  ])('allows fixed validation command %s', (command) => {
    expect(parseValidationCommand(command).ok).toBe(true)
  })

  it.each([
    'npm install',
    'npm test && rm -rf .',
    'node -e process.exit(0)',
    'python -c print(1)',
    'git push --force',
    'bash -lc whoami',
    'curl https://example.com'
  ])('rejects non-validation command %s', (command) => {
    expect(parseValidationCommand(command).ok).toBe(false)
  })
})
