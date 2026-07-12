import assert from 'node:assert/strict'
import { validateExternalUrl } from '../src/main/security/external-url'

assert.equal(validateExternalUrl('https://github.com/saitakarcesme/Akorith').allowed, true)
assert.equal(validateExternalUrl('http://127.0.0.1:11434/api/tags').allowed, true)
assert.equal(validateExternalUrl('mailto:hello@example.com').allowed, true)
assert.equal(validateExternalUrl('javascript:alert(1)').allowed, false)
assert.equal(validateExternalUrl('file:///C:/Windows/System32/calc.exe').allowed, false)
assert.equal(validateExternalUrl('data:text/html,unsafe').allowed, false)
assert.equal(validateExternalUrl('not a url').allowed, false)
assert.equal(validateExternalUrl('https://' + 'a'.repeat(4096)).allowed, false)

process.stdout.write('verify-external-url: ok\n')
