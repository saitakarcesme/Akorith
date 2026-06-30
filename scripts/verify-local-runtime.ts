// Phase 47: verify the shared local-runtime JSON helpers + safety primitives.
// Pure functions only — no electron, no live Ollama required.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractJson, parseJsonLoose } from '../src/main/local-runtime/json.ts'
import { checkWritePath, isSecretFile } from '../src/main/safety/paths.ts'
import { checkCommand } from '../src/main/safety/commands.ts'
import { validatePatch } from '../src/main/safety/patch.ts'
import { checkGitPush } from '../src/main/safety/git.ts'

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const ROOT = join(tmpdir(), 'akorith-loop-root')

// --- JSON extraction ---
check('extractJson: fenced json block', () => {
  assert.equal(extractJson('here:\n```json\n{"a":1}\n```'), '{"a":1}')
})
check('extractJson: raw object', () => {
  assert.equal(extractJson('noise {"a": {"b": 2}} trailing'), '{"a": {"b": 2}}')
})
check('extractJson: braces inside strings ignored', () => {
  assert.equal(extractJson('{"s": "a } b"}'), '{"s": "a } b"}')
})
check('extractJson: no json returns null', () => {
  assert.equal(extractJson('just prose'), null)
})
check('parseJsonLoose: parses object', () => {
  assert.deepEqual(parseJsonLoose('```\n{"x":[1,2]}\n```'), { x: [1, 2] })
})
check('parseJsonLoose: invalid returns null', () => {
  assert.equal(parseJsonLoose('{bad json}'), null)
})

// --- path safety ---
check('checkWritePath: relative ok', () => {
  const r = checkWritePath(ROOT, 'src/index.ts')
  assert.equal(r.ok, true)
  assert.equal(r.relativePath, 'src/index.ts')
})
check('checkWritePath: absolute denied', () => {
  assert.equal(checkWritePath(ROOT, '/etc/passwd').ok, false)
})
check('checkWritePath: parent escape denied', () => {
  assert.equal(checkWritePath(ROOT, '../outside.txt').ok, false)
})
check('checkWritePath: .git denied', () => {
  assert.equal(checkWritePath(ROOT, '.git/config').ok, false)
})
check('checkWritePath: node_modules denied', () => {
  assert.equal(checkWritePath(ROOT, 'node_modules/x/index.js').ok, false)
})
check('isSecretFile: .env + pem', () => {
  assert.equal(isSecretFile('.env'), true)
  assert.equal(isSecretFile('certs/server.pem'), true)
  assert.equal(isSecretFile('src/app.ts'), false)
})

// --- command safety ---
check('checkCommand: typecheck allowed', () => {
  assert.equal(checkCommand('npm run typecheck').ok, true)
})
check('checkCommand: rm -rf denied', () => {
  assert.equal(checkCommand('rm -rf /').ok, false)
})
check('checkCommand: git push denied via allowlist', () => {
  assert.equal(checkCommand('git push origin main').ok, false)
})
check('checkCommand: install denied', () => {
  assert.equal(checkCommand('npm install left-pad').ok, false)
})
check('checkCommand: chaining denied', () => {
  assert.equal(checkCommand('ls && rm x').ok, false)
})

// --- patch safety ---
check('validatePatch: good create ok', () => {
  const v = validatePatch(ROOT, [{ operation: 'create', path: 'a.txt', content: 'hi' }])
  assert.equal(v.ok, true)
})
check('validatePatch: delete denied by default', () => {
  const v = validatePatch(ROOT, [{ operation: 'delete', path: 'a.txt' }])
  assert.equal(v.ok, false)
})
check('validatePatch: escaping path denied', () => {
  const v = validatePatch(ROOT, [{ operation: 'create', path: '../x', content: 'hi' }])
  assert.equal(v.ok, false)
})

// --- git push gate ---
check('checkGitPush: disabled denied', () => {
  assert.equal(checkGitPush(false, 'origin main').ok, false)
})
check('checkGitPush: enabled ok', () => {
  assert.equal(checkGitPush(true, 'origin main').ok, true)
})
check('checkGitPush: force denied even when enabled', () => {
  assert.equal(checkGitPush(true, 'origin main --force').ok, false)
})

if (failures > 0) {
  console.error(`\nverify-local-runtime: ${failures} failed`)
  process.exit(1)
}
console.log('\nverify-local-runtime: ok')
