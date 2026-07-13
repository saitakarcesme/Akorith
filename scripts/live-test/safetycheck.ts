import { applyFileWrite } from '../../src/main/action-agents/files'
const root = process.env.HOME + '/Desktop/projects/business/aiarticle'
const cases: [string, any][] = [
  ['delete op', { operation: 'delete', path: 'README.md', content: '' }],
  ['secret .env', { operation: 'create', path: '.env', content: 'SECRET=1' }],
  ['secret id_rsa', { operation: 'create', path: 'id_rsa', content: 'key' }],
  ['secret cert.pem', { operation: 'create', path: 'certs/server.pem', content: 'x' }],
  ['.git write', { operation: 'create', path: '.git/hooks/pre-commit', content: 'x' }],
  ['node_modules write', { operation: 'create', path: 'node_modules/evil.js', content: 'x' }],
  ['normal file', { operation: 'create', path: 'SAFE_OK.md', content: 'ok' }]
]
for (const [label, f] of cases) {
  const r = applyFileWrite(root, f as never)
  console.log((r.ok ? 'WROTE ' : 'REJECT').padEnd(7), label.padEnd(20), '->', r.ok ? r.path : r.reason)
}
