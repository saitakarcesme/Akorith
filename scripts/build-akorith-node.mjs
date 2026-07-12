import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir('dist-node', { recursive: true })
await build({
  entryPoints: ['scripts/akorith-node.ts'],
  outfile: 'dist-node/akorith-node.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' }
})

console.log('Built dist-node/akorith-node.cjs')
