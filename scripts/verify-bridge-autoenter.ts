import assert from 'node:assert/strict'
import { SUBMIT_KEY, encodeForPty, planBridgeWrites } from '../src/main/bridge-core.ts'

// --- single-line: paste is the raw text, no markers, no trailing Enter ---
assert.equal(encodeForPty('hello world'), 'hello world')
assert.equal(encodeForPty('hello world').endsWith(SUBMIT_KEY), false)

// --- multi-line: bracketed paste, inner newlines normalized to \r, no Enter ---
const multi = encodeForPty('line one\nline two')
assert.equal(multi, '\x1b[200~line one\rline two\x1b[201~')
assert.equal(multi.endsWith('\x1b[201~'), true)
assert.equal(multi.endsWith(`\x1b[201~${SUBMIT_KEY}`), false)

// trailing newlines are trimmed (no accidental blank submit)
assert.equal(encodeForPty('done\n\n'), 'done')

// --- Auto-Enter ON: the Enter is a SEPARATE write after the paste ---
const on = planBridgeWrites('run this', true)
assert.equal(on.length, 2)
assert.equal(on[0], 'run this')
assert.equal(on[1], SUBMIT_KEY)
// the paste write itself must NOT carry the Enter (the bug we fixed)
assert.equal(on[0].includes(SUBMIT_KEY), false)

const onMulti = planBridgeWrites('a\nb', true)
assert.equal(onMulti.length, 2)
assert.equal(onMulti[0], '\x1b[200~a\rb\x1b[201~')
assert.equal(onMulti[1], SUBMIT_KEY)

// --- Auto-Enter OFF: paste only, no submit write (manual Enter preserved) ---
const off = planBridgeWrites('run this', false)
assert.equal(off.length, 1)
assert.equal(off[0], 'run this')
assert.equal(
  off.some((w) => w === SUBMIT_KEY),
  false
)

// exactly one Enter when on; never double-submitted
assert.equal(planBridgeWrites('x', true).filter((w) => w === SUBMIT_KEY).length, 1)

console.log('verify-bridge-autoenter: ok')
