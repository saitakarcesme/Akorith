import { applyFileWrite } from '../../src/main/action-agents/files'
const root = process.env.HOME + '/Desktop/projects/business/aiarticle'
const cases: [string, string][] = [
  ['absolute IN root (should WRITE)', root + '/F4_INROOT_TEST.md'],
  ['absolute OUTSIDE root (must REJECT)', process.env.HOME + '/Desktop/EVIL_F4.md'],
  ['traversal (must REJECT)', '../EVIL_TRAVERSAL.md'],
  ['absolute to /etc (must REJECT)', '/etc/evil_f4.md'],
  ['normal relative (should WRITE)', 'F4_RELATIVE_TEST.md']
]
for (const [label, p] of cases) {
  const r = applyFileWrite(root, { operation: 'create', path: p, content: 'f4 test\n' } as never)
  console.log((r.ok ? 'WROTE ' : 'REJECT').padEnd(7), '|', label, '->', r.ok ? r.path : r.reason)
}
