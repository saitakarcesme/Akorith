// Phase 50: verify companion boundaries + identity. Companions must declare they
// take NO actions, and Athena/Zeus must have distinct identities. Electron-free.
import assert from 'node:assert/strict'
import { BUILTIN_COMPANIONS, builtinById } from '../src/main/companions/prompts.ts'

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

check('two built-in companions: athena, zeus', () => {
  const ids = BUILTIN_COMPANIONS.map((c) => c.id).sort()
  assert.deepEqual(ids, ['athena', 'zeus'])
})

for (const c of BUILTIN_COMPANIONS) {
  check(`${c.id}: system prompt forbids actions`, () => {
    const p = c.systemPrompt.toLowerCase()
    assert.ok(p.includes('do not act') || p.includes('no actions') || p.includes('do not act on'))
    assert.ok(p.includes('never claim to have performed an action') || p.includes('never claim'))
    assert.ok(p.includes('command') && p.includes('file'))
  })
  check(`${c.id}: is local-first + honest`, () => {
    const p = c.systemPrompt.toLowerCase()
    assert.ok(p.includes('local-first') || p.includes('local'))
    assert.ok(p.includes('honest') || p.includes('never invent'))
    assert.ok(p.includes('remember'))
  })
}

check('athena identity distinct from zeus', () => {
  const a = builtinById('athena')!.systemPrompt.toLowerCase()
  const z = builtinById('zeus')!.systemPrompt.toLowerCase()
  assert.ok(a.includes('athena') && a.includes('strategic'))
  assert.ok(z.includes('zeus') && z.includes('decisive'))
  assert.notEqual(a, z)
})

if (failures > 0) {
  console.error(`\nverify-companions: ${failures} failed`)
  process.exit(1)
}
console.log('\nverify-companions: ok')
