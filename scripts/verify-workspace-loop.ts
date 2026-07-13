import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseHighestPhase,
  buildPhaseCommitMessage,
  deriveHeadline,
  slugify,
  parseProjectIdea,
  initWorkspace,
  nextPhaseNumber,
  commitPhase,
  inspectLoopWorkspace,
  isGitRepo,
  type ProjectIdea
} from '../src/main/workspace.ts'

// ---------- pure helpers ----------

assert.equal(parseHighestPhase(['Phase 1: a', 'Phase 2: b', 'misc']), 2)
assert.equal(parseHighestPhase(['Phase 18.2: x', 'Phase 7: y']), 18, 'handles "Phase N.M" and picks the max N')
assert.equal(parseHighestPhase(['initial commit', 'fix']), 0, 'no phases → 0')

assert.equal(buildPhaseCommitMessage(3, 'added a parser'), 'Phase 3: added a parser')
assert.equal(buildPhaseCommitMessage(1, '   '), 'Phase 1: autonomous change', 'blank headline gets a default')
assert.ok(buildPhaseCommitMessage(9, 'x'.repeat(200)).length <= 'Phase 9: '.length + 72, 'headline is length-bounded')

assert.equal(
  deriveHeadline({ criticRationale: 'Implemented the CLI flag. It works.', summaryStatus: 'done' }),
  'Implemented the CLI flag.',
  'prefers the first sentence of the critic rationale'
)
assert.equal(
  deriveHeadline({ criticRationale: '', summaryStatus: 'Added tests for the parser.' }),
  'Added tests for the parser.',
  'falls back to the summary status'
)
assert.ok(deriveHeadline({}).length > 0, 'always returns a non-empty headline')

assert.equal(slugify('My Cool Tool!!'), 'my-cool-tool')
assert.equal(slugify('   '), 'akorith-project', 'empty slug gets a default')

const idea = parseProjectIdea('```json\n{"name":"Tiny Timer","slug":"Tiny Timer","summary":"s","first_goal":"build it"}\n```')
assert.ok(idea, 'fenced idea JSON parses')
assert.equal(idea!.name, 'Tiny Timer')
assert.equal(idea!.slug, 'tiny-timer', 'slug is normalized')
assert.equal(idea!.firstGoal, 'build it')
assert.equal(parseProjectIdea('no json'), null, 'garbage → null')
assert.equal(parseProjectIdea('{"name":"x"}'), null, 'missing first_goal → null')

// ---------- real git: the Phase-N auto-commit loop ----------

let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}
async function main(): Promise<void> {
  if (!gitOk) {
    console.log('verify-workspace-loop: ok (pure only - git not available)')
    return
  }

  const dir = await mkdtemp(join(tmpdir(), 'akorith-ws-'))
  try {
    const sampleIdea: ProjectIdea = { name: 'Sample Tool', slug: 'sample-tool', summary: 'demo', firstGoal: 'build a demo' }

    const init = await initWorkspace(dir, sampleIdea)
    assert.equal(init.ok, true, 'workspace initializes')
    assert.equal(await isGitRepo(dir), true, 'directory is a git repo')

    // Scaffold commit is "Phase 0", so the loop's first commit is Phase 1.
    assert.equal(await nextPhaseNumber(dir), 1, 'next phase after scaffold is 1')

    // Nothing changed yet → a clean no-op, not an error.
    const noop = await commitPhase(dir, 'should not commit')
    assert.equal(noop.committed, false)
    assert.equal(noop.reason, 'no changes to commit')

    // Simulate the executor producing work across two loop turns.
    await writeFile(join(dir, 'index.js'), 'console.log("hello")\n', 'utf8')
    const c1 = await commitPhase(dir, 'add entry point')
    assert.equal(c1.committed, true)
    assert.equal(c1.phase, 1)
    assert.equal(c1.message, 'Phase 1: add entry point')

    await writeFile(join(dir, 'index.js'), 'console.log("hello world")\n', 'utf8')
    const c2 = await commitPhase(dir, 'expand greeting')
    assert.equal(c2.committed, true)
    assert.equal(c2.phase, 2, 'phase number advances from the git log')
    assert.equal(c2.message, 'Phase 2: expand greeting')

    // The git history is exactly the loop-commit chain, oldest→newest.
    const log = execFileSync('git', ['log', '--reverse', '--pretty=%s'], { cwd: dir }).toString()
    const subjects = log.trim().split('\n')
    assert.deepEqual(subjects, ['Phase 0: scaffold project', 'Phase 1: add entry point', 'Phase 2: expand greeting'])

    // Numbering continues correctly for the next turn.
    assert.equal(await nextPhaseNumber(dir), 3)

    const status = await inspectLoopWorkspace(dir)
    assert.equal(status.ok, true, 'workspace status inspection succeeds')
    assert.equal(status.commitCount, 3, 'path-scoped commit count is reported')
    assert.equal(status.lastPhase, 2, 'latest phase number is reported')
    assert.equal(status.syncState, 'no_remote', 'throwaway repos report missing AkorithLoop remote')

    console.log('verify-workspace-loop: ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
