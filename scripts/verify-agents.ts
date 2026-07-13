// Phase 52: verify agent permission policy, template safety, and file-op safety.
// Electron-free (permissions/templates/files import only safety + fs).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilitiesFor, describePermission, DEFAULT_PERMISSION_MODE } from '../src/main/action-agents/permissions.ts'
import { AGENT_TEMPLATES } from '../src/main/action-agents/templates.ts'
import { applyFileWrite, previewWrites, readWithinRoot } from '../src/main/action-agents/files.ts'

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

// --- permission capabilities ---
check('default permission is preview (safest)', () => assert.equal(DEFAULT_PERMISSION_MODE, 'preview'))
check('preview: no writes, no commands', () => {
  const c = capabilitiesFor('preview', true)
  assert.equal(c.canWriteFiles, false)
  assert.equal(c.canRunCommands, false)
})
check('safe_writes: writes yes, commands no', () => {
  const c = capabilitiesFor('safe_writes', true)
  assert.equal(c.canWriteFiles, true)
  assert.equal(c.canRunCommands, false)
})
check('safe_commands: commands only if allowCommands', () => {
  assert.equal(capabilitiesFor('safe_commands', false).canRunCommands, false)
  assert.equal(capabilitiesFor('safe_commands', true).canRunCommands, true)
})
check('ask_write + manual_each require step approval', () => {
  assert.equal(capabilitiesFor('ask_write', true).requiresStepApproval, true)
  assert.equal(capabilitiesFor('manual_each', true).requiresStepApproval, true)
})
check('describePermission is non-empty for all modes', () => {
  for (const m of ['preview', 'ask_write', 'safe_writes', 'safe_commands', 'manual_each'] as const) {
    assert.ok(describePermission(m).length > 10)
  }
})

// --- template safety ---
check('10 built-in templates', () => assert.equal(AGENT_TEMPLATES.length, 10))
check('no template defaults to an unsafe/no-preview mode without a reason', () => {
  const allowed = new Set(['preview', 'ask_write', 'safe_writes', 'safe_commands', 'manual_each'])
  for (const t of AGENT_TEMPLATES) assert.ok(allowed.has(t.defaultPermission), `${t.id} bad mode`)
})
check('pdf_summarizer honestly marks unsupported', () => {
  const t = AGENT_TEMPLATES.find((x) => x.id === 'pdf_summarizer')!
  assert.ok(t.note && /unsupported|not yet/i.test(t.note))
})

// --- file operation safety ---
const ROOT = mkdtempSync(join(tmpdir(), 'akorith-agent-'))
check('applyFileWrite: valid create writes within root', () => {
  const r = applyFileWrite(ROOT, { operation: 'create', path: 'reports/out.md', content: '# hi' })
  assert.equal(r.ok, true)
  assert.ok(existsSync(join(ROOT, 'reports', 'out.md')))
  assert.equal(readFileSync(join(ROOT, 'reports', 'out.md'), 'utf8'), '# hi')
})
check('applyFileWrite: delete always rejected', () => {
  assert.equal(applyFileWrite(ROOT, { operation: 'delete', path: 'reports/out.md' }).ok, false)
})
check('applyFileWrite: escaping path rejected', () => {
  assert.equal(applyFileWrite(ROOT, { operation: 'create', path: '../evil.txt', content: 'x' }).ok, false)
})
check('applyFileWrite: secret path rejected', () => {
  assert.equal(applyFileWrite(ROOT, { operation: 'create', path: '.env', content: 'SECRET=1' }).ok, false)
})
check('previewWrites: reports validity without writing', () => {
  const res = previewWrites(ROOT, [{ operation: 'create', path: 'ok.txt', content: 'a' }, { operation: 'create', path: '../bad', content: 'b' }])
  assert.equal(res[0].ok, true)
  assert.equal(res[1].ok, false)
  assert.ok(!existsSync(join(ROOT, 'ok.txt'))) // preview does not write
})
check('readWithinRoot: reads existing, refuses escape', () => {
  assert.equal(readWithinRoot(ROOT, 'reports/out.md'), '# hi')
  assert.equal(readWithinRoot(ROOT, '../../etc/hosts'), null)
})
rmSync(ROOT, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nverify-agents: ${failures} failed`)
  process.exit(1)
}
console.log('\nverify-agents: ok')
